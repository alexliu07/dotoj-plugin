'use strict';

const path = require('path');
const vscode = require('vscode');
const { DotOjClient, ApiError } = require('./api');
const { verdictInfo, verdictLabel, isPending, isAccepted } = require('./verdicts');
const { problemToMarkdown, decodeBase64, stripAnsi } = require('./markdown');

const TOKEN_KEY = 'dotoj.token';
const STATE_USER = 'dotoj.username';
const STATE_CURRENT = 'dotoj.currentProblem';
const STATE_FILE_MAP = 'dotoj.fileProblemMap';
const SIGNED_IN_CONTEXT = 'dotoj.signedIn';

let activeApi;

function activate(context) {
  const output = vscode.window.createOutputChannel('dotOJ');
  context.subscriptions.push(output);

  const state = {
    token: undefined,
    username: context.globalState.get(STATE_USER, ''),
    languages: null,
    contests: null,
    contestDetails: new Map(),
    problems: new Map(),
  };

  const config = () => vscode.workspace.getConfiguration('dotoj');
  const baseUrl = () => String(config().get('baseUrl', 'http://njuoj.skylare.me:9036')).replace(/\/+$/, '');
  const pollInterval = () => Math.max(200, Number(config().get('pollIntervalMs', 800)) || 800);

  const client = new DotOjClient({
    getBaseUrl: baseUrl,
    getToken: () => state.token,
    getTimeout: () => Number(config().get('requestTimeoutMs', 20000)) || 20000,
  });

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  const treeEmitter = new vscode.EventEmitter();

  // Remember where the user's code lives: the webview panel steals focus and
  // leaves `activeTextEditor` undefined, but downloads should still land next
  // to the file that was being edited.
  let lastFileDirectory = '';
  const rememberActiveEditor = (editor) => {
    if (editor && editor.document && !editor.document.isUntitled && editor.document.uri.scheme === 'file') {
      lastFileDirectory = path.dirname(editor.document.uri.fsPath);
    }
  };
  rememberActiveEditor(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(rememberActiveEditor));

  // ---------------------------------------------------------------- items

  class ActionItem extends vscode.TreeItem {
    constructor(label, command, icon) {
      super(label, vscode.TreeItemCollapsibleState.None);
      this.command = { command, title: label };
      this.iconPath = new vscode.ThemeIcon(icon || 'account');
      this.contextValue = 'dotoj.action';
    }
  }

  class ContestItem extends vscode.TreeItem {
    constructor(contest) {
      super(contest.title, vscode.TreeItemCollapsibleState.Collapsed);
      this.contest = contest;
      this.id = 'contest:' + contest.id;
      this.contextValue = 'dotoj.contest';
      this.iconPath = new vscode.ThemeIcon('calendar');
      this.description = '#' + contest.id;
      this.tooltip = new vscode.MarkdownString(
        '**' + contest.title + '**\n\n#' + contest.id + '\n\n' + formatRange(contest.beginTime, contest.endTime)
      );
    }
  }

  class ProblemItem extends vscode.TreeItem {
    constructor(problem) {
      super(problem.title, vscode.TreeItemCollapsibleState.None);
      this.problem = problem;
      this.id = 'problem:' + problem.id;
      this.contextValue = 'dotoj.problem';
      this.iconPath = problem.solved
        ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
        : new vscode.ThemeIcon('symbol-method');
      this.description = problem.section || '';
      this.tooltip = new vscode.MarkdownString(
        '**' + problem.title + '**\n\n#' + problem.id + (problem.section ? ' · ' + problem.section : '')
      );
      this.command = { command: 'dotoj.openProblem', title: '打开题目', arguments: [problem.id] };
    }
  }

  // ---------------------------------------------------------------- tree

  const tree = {
    onDidChangeTreeData: treeEmitter.event,
    getTreeItem: (item) => item,
    getChildren: async (element) => {
      if (!state.token) {
        return [new ActionItem('登录 dotOJ…', 'dotoj.login', 'account')];
      }
      try {
        if (!element) {
          if (!state.contests) {
            state.contests = await client.getContests();
          }
          return state.contests.map((contest) => new ContestItem(contest));
        }
        if (element instanceof ContestItem) {
          let detail = state.contestDetails.get(element.contest.id);
          if (!detail) {
            detail = await client.getContest(element.contest.id);
            state.contestDetails.set(element.contest.id, detail);
          }
          const problems = detail.problems || [];
          if (problems.length === 0) {
            return [new ActionItem('（本次作业暂无题目）', 'dotoj.refresh', 'info')];
          }
          return problems.map((problem) => new ProblemItem(problem));
        }
        return [];
      } catch (error) {
        reportError(error, '加载题目列表');
        return [new ActionItem('加载失败，点击刷新', 'dotoj.refresh', 'refresh')];
      }
    },
  };

  const treeView = vscode.window.createTreeView('dotoj.contests', { treeDataProvider: tree });
  context.subscriptions.push(treeView);

  // ------------------------------------------------------------- helpers

  function refresh() {
    state.contests = null;
    state.contestDetails.clear();
    state.problems.clear();
    treeEmitter.fire();
  }

  function setSignedIn(value) {
    vscode.commands.executeCommand('setContext', SIGNED_IN_CONTEXT, !!value);
  }

  function currentProblem() {
    return context.workspaceState.get(STATE_CURRENT);
  }

  function setCurrentProblem(problem) {
    return context.workspaceState.update(STATE_CURRENT, problem || undefined).then(updateStatusBar);
  }

  function fileBindings() {
    return context.workspaceState.get(STATE_FILE_MAP, {});
  }

  function bindFile(uri, problem) {
    const map = Object.assign({}, fileBindings());
    if (problem) {
      map[uri.toString()] = problem;
    } else {
      delete map[uri.toString()];
    }
    return context.workspaceState.update(STATE_FILE_MAP, map);
  }

  function updateStatusBar() {
    const problem = currentProblem();
    if (!state.token) {
      statusBar.text = '$(account) dotOJ 登录';
      statusBar.command = 'dotoj.login';
      statusBar.tooltip = '登录 dotOJ';
    } else if (problem) {
      statusBar.text = '$(cloud-upload) ' + truncate(problem.title, 26);
      statusBar.command = 'dotoj.submit';
      statusBar.tooltip = '提交当前文件到：' + problem.title;
    } else {
      statusBar.text = '$(cloud-upload) dotOJ 提交';
      statusBar.command = 'dotoj.submit';
      statusBar.tooltip = '选择题目并提交当前文件';
    }
    statusBar.show();
  }

  function describeError(error) {
    if (error instanceof ApiError) {
      return error.message;
    }
    return error && error.message ? error.message : String(error);
  }

  async function handleUnauthorized() {
    state.token = undefined;
    await context.secrets.delete(TOKEN_KEY);
    setSignedIn(false);
    updateStatusBar();
    refresh();
    const choice = await vscode.window.showWarningMessage('dotOJ 登录已过期，需要重新登录。', '登录');
    if (choice === '登录') {
      await login();
    }
  }

  function reportError(error, prefix) {
    const text = (prefix ? prefix + '：' : '') + describeError(error);
    output.appendLine('[' + new Date().toLocaleString() + '] ' + text);
    if (error instanceof ApiError && error.isUnauthorized) {
      handleUnauthorized();
      return;
    }
    vscode.window.showErrorMessage('dotOJ ' + text);
  }

  // --------------------------------------------------------------- login

  async function login() {
    const username = await vscode.window.showInputBox({
      title: '登录 dotOJ',
      prompt: '用户名 / 学号',
      value: state.username || '',
      ignoreFocusOut: true,
    });
    if (!username) {
      return;
    }
    const password = await vscode.window.showInputBox({
      title: '登录 dotOJ',
      prompt: '密码（保存在 VS Code 的安全存储中）',
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) {
      return;
    }
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在登录 dotOJ…' },
        () => client.login(username.trim(), password)
      );
      if (!result || !result.token) {
        throw new Error('登录响应中没有 token');
      }
      state.token = result.token;
      state.username = result.username || username.trim();
      await context.secrets.store(TOKEN_KEY, result.token);
      await context.globalState.update(STATE_USER, state.username);
      setSignedIn(true);
      updateStatusBar();
      refresh();
      vscode.window.showInformationMessage('已登录 dotOJ：' + (result.fullName || state.username));
    } catch (error) {
      reportError(error, '登录失败');
    }
  }

  async function loginWithToken() {
    const token = await vscode.window.showInputBox({
      title: '使用 Token 登录 dotOJ',
      prompt: '粘贴 token（浏览器 localStorage 里 dotoj-auth 的 token 字段）',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) {
      return;
    }
    state.token = token.trim();
    try {
      await client.getContests();
      await context.secrets.store(TOKEN_KEY, state.token);
      setSignedIn(true);
      updateStatusBar();
      refresh();
      vscode.window.showInformationMessage('dotOJ token 已保存。');
    } catch (error) {
      state.token = undefined;
      reportError(error, 'Token 登录失败');
    }
  }

  async function logout() {
    state.token = undefined;
    await context.secrets.delete(TOKEN_KEY);
    setSignedIn(false);
    refresh();
    updateStatusBar();
    vscode.window.showInformationMessage('已退出 dotOJ。');
  }

  // ------------------------------------------------------------- problems

  async function getLanguages() {
    if (!state.languages) {
      state.languages = await client.getLanguages();
    }
    return state.languages || [];
  }

  async function allProblemPicks() {
    const contests = state.contests || (state.contests = await client.getContests());
    const picks = [];
    for (const contest of contests) {
      let detail = state.contestDetails.get(contest.id);
      if (!detail) {
        detail = await client.getContest(contest.id);
        state.contestDetails.set(contest.id, detail);
      }
      for (const problem of detail.problems || []) {
        picks.push({
          label: problem.title,
          description: '#' + problem.id + (problem.section ? ' · ' + problem.section : ''),
          detail: contest.title,
          problem,
        });
      }
    }
    return picks;
  }

  async function pickProblem() {
    if (!state.token) {
      await login();
    }
    if (!state.token) {
      return undefined;
    }
    const picks = await allProblemPicks();
    if (picks.length === 0) {
      vscode.window.showWarningMessage('dotOJ：没有可选的题目。');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(picks, {
      title: '选择题目',
      placeHolder: '输入题目标题筛选',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) {
      return undefined;
    }
    return picked.problem;
  }

  async function renderMarkdownHtml(markdown) {
    try {
      const markdownExtension = vscode.extensions.getExtension('vscode.markdown-language-features');
      if (markdownExtension && !markdownExtension.isActive) {
        await markdownExtension.activate();
      }
      const html = await vscode.commands.executeCommand('markdown.api.render', markdown);
      if (typeof html === 'string' && html.length > 0) {
        return html;
      }
    } catch (error) {
      output.appendLine('markdown 渲染失败，已降级为纯文本：' + describeError(error));
    }
    return '<pre class="raw">' + escapeHtml(markdown) + '</pre>';
  }

  async function buildProblemHtml(webview, problem, markdown) {
    const body = await renderMarkdownHtml(markdown);
    const nonce = makeNonce();
    const katexCss = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'media', 'katex', 'katex.min.css')
    );
    const previewCss = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'media', 'preview.css')
    );
    const csp = [
      "default-src 'none'",
      'img-src ' + webview.cspSource + ' https: http: data:',
      'style-src ' + webview.cspSource + " 'unsafe-inline'",
      'font-src ' + webview.cspSource,
      "script-src 'nonce-" + nonce + "'",
    ].join('; ');

    return [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="UTF-8">',
      '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
      '<link rel="stylesheet" href="' + katexCss + '">',
      '<link rel="stylesheet" href="' + previewCss + '">',
      '</head>',
      '<body>',
      '<div class="toolbar">',
      '<button id="submit">提交当前文件</button>',
      '<button id="browser" class="secondary">在浏览器中打开</button>',
      '<button id="download" class="secondary">下载题面</button>',
      '<span class="meta">#' + problem.id + ' · ' + escapeHtml(problem.title) + '</span>',
      '</div>',
      '<main class="markdown-body">',
      body,
      '</main>',
      '<script nonce="' + nonce + '">',
      'const vscode = acquireVsCodeApi();',
      "document.getElementById('submit').addEventListener('click', () => vscode.postMessage({ type: 'submit' }));",
      "document.getElementById('browser').addEventListener('click', () => vscode.postMessage({ type: 'browser' }));",
      "document.getElementById('download').addEventListener('click', () => vscode.postMessage({ type: 'download' }));",
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  // ------------------------------------------------------ problem view

  let problemView;
  let shownProblem;
  let lastProblemHtml = '';

  async function handleProblemMessage(message, target) {
    if (!message || typeof message !== 'object' || !target) {
      return;
    }
    if (message.type === 'submit') {
      await submit(target);
    } else if (message.type === 'browser') {
      const url = baseUrl() + '/contest/' + target.contestId + '/problem/' + target.id;
      vscode.env.openExternal(vscode.Uri.parse(url));
    } else if (message.type === 'download') {
      await downloadProblem(target);
    }
  }

  function wireProblemView(view) {
    problemView = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    };
    view.webview.onDidReceiveMessage((message) => handleProblemMessage(message, shownProblem));
    view.onDidDispose(() => {
      problemView = undefined;
    }, null, context.subscriptions);
    if (lastProblemHtml) {
      view.webview.html = lastProblemHtml;
    }
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'dotoj.problemView',
      { resolveWebviewView: (view) => wireProblemView(view) },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  function whenProblemViewReady(timeoutMs) {
    if (problemView) {
      return Promise.resolve(problemView);
    }
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (problemView || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(problemView);
        }
      }, 30);
    });
  }

  function openFallbackPanel(problem) {
    const panel = vscode.window.createWebviewPanel(
      'dotoj.problemView',
      problem.id + '. ' + problem.title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );
    panel.webview.onDidReceiveMessage((message) => handleProblemMessage(message, problem));
    return panel;
  }

  async function openProblem(problemId) {
    try {
      if (!state.token) {
        await login();
      }
      if (!state.token) {
        return;
      }
      let id = problemId;
      if (!id) {
        const picked = await pickProblem();
        if (!picked) {
          return;
        }
        id = picked.id;
      }
      let problem = state.problems.get(id);
      if (!problem) {
        problem = await client.getProblem(id);
        state.problems.set(id, problem);
      }
      const contest = state.contestDetails.get(problem.contestId);
      const markdown = problemToMarkdown(problem, {
        baseUrl: baseUrl(),
        contestTitle: contest && contest.title,
      });

      const current = { id: problem.id, title: problem.title, contestId: problem.contestId };
      shownProblem = current;

      // The statement lives in its own webview *view* in the right-hand side
      // bar, so it never takes over an editor group.
      try {
        await vscode.commands.executeCommand('dotoj.problemView.focus');
      } catch (error) {
        output.appendLine('无法聚焦题目视图：' + describeError(error));
      }
      const view = await whenProblemViewReady(2000);
      if (view) {
        const html = await buildProblemHtml(view.webview, problem, markdown);
        lastProblemHtml = html;
        try {
          view.title = problem.title;
          view.description = '#' + problem.id;
        } catch (error) {
          // cosmetic only
        }
        view.webview.html = html;
      } else {
        output.appendLine('[' + new Date().toLocaleString() + '] 题目视图未就绪，改用编辑器面板显示。');
        const panel = openFallbackPanel(problem);
        panel.webview.html = await buildProblemHtml(panel.webview, problem, markdown);
      }
      await setCurrentProblem(current);
    } catch (error) {
      reportError(error, '打开题目');
    }
  }

  async function resolveLanguage(document) {
    const languages = await getLanguages();
    const ext = path.extname(document.fileName || '').toLowerCase();
    const matches = languages.filter((item) => String(item.sourceSuffix || '').toLowerCase() === ext);
    if (matches.length === 1) {
      return matches[0];
    }
    const items = languages.map((item) => ({
      label: item.name,
      description: [item.compilerStandardName, item.compilerVersion].filter(Boolean).join(' · '),
      language: item,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: '选择提交语言',
      placeHolder: matches.length > 1 ? '该扩展名对应多个语言，请选择' : '无法根据扩展名判断语言，请选择',
    });
    return picked && picked.language;
  }

  // ---------------------------------------------------------------- submit

  function problemFromArg(arg) {
    if (!arg) {
      return undefined;
    }
    if (arg.problem) {
      return arg.problem;
    }
    if (arg.id && arg.title) {
      return arg;
    }
    return undefined;
  }

  async function submit(argument) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('dotOJ：请先打开要提交的代码文件。');
      return;
    }
    const document = editor.document;
    if (document.isUntitled) {
      vscode.window.showWarningMessage('dotOJ：请先保存文件再提交。');
      return;
    }
    if (document.isDirty) {
      await document.save();
    }
    if (!state.token) {
      await login();
      if (!state.token) {
        return;
      }
    }

    let problem = problemFromArg(argument);
    if (!problem) {
      problem = fileBindings()[document.uri.toString()] || currentProblem() || undefined;
    }
    if (!problem) {
      const picked = await pickProblem();
      if (!picked) {
        return;
      }
      problem = { id: picked.id, title: picked.title, contestId: picked.contestId };
    }

    let language;
    try {
      language = await resolveLanguage(document);
    } catch (error) {
      reportError(error, '获取语言列表');
      return;
    }
    if (!language) {
      return;
    }

    await bindFile(document.uri, { id: problem.id, title: problem.title, contestId: problem.contestId });
    await setCurrentProblem({ id: problem.id, title: problem.title, contestId: problem.contestId });

    const code = document.getText();
    let submissionId;
    try {
      const created = await client.submit(problem.id, language.id, code);
      submissionId = created && created.id;
      if (!submissionId) {
        throw new Error('服务器没有返回提交 ID');
      }
    } catch (error) {
      reportError(error, '提交失败');
      return;
    }

    output.appendLine(
      '[' + new Date().toLocaleString() + '] 提交 #' + submissionId + ' → ' + problem.title +
        '（' + language.name + '，' + code.length + ' 字符）'
    );

    const waiting = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'dotOJ 评测 #' + submissionId + '：' + problem.title,
        cancellable: true,
      },
      async (progress, cancellation) => {
        for (;;) {
          if (cancellation.isCancellationRequested) {
            return { cancelled: true };
          }
          let submission;
          try {
            submission = await client.getSubmission(submissionId);
          } catch (error) {
            return { error };
          }
          if (submission && !isPending(submission.verdict)) {
            return { submission };
          }
          progress.report({ message: verdictInfo(submission ? submission.verdict : 0).label + '…' });
          await sleep(pollInterval());
        }
      }
    );

    if (waiting.cancelled) {
      vscode.window.showInformationMessage('已停止等待，提交 #' + submissionId + ' 仍在后台评测。');
      return;
    }
    if (waiting.error) {
      reportError(waiting.error, '查询评测结果');
      return;
    }
    await reportSubmission(problem, language, waiting.submission);
  }

  async function reportSubmission(problem, language, submission) {
    const info = verdictInfo(submission.verdict);
    output.appendLine(
      '  结果：' + verdictLabel(submission.verdict) +
        '　分数：' + submission.score +
        '　时间：' + submission.time + ' ms' +
        '　内存：' + submission.memory + ' KB'
    );

    let detailText = '';
    if (submission.hasMessage) {
      try {
        const detail = await client.getSubmissionDetail(submission.id);
        detailText = stripAnsi(decodeBase64(detail && detail.message)).trim();
      } catch (error) {
        output.appendLine('  读取编译/运行信息失败：' + describeError(error));
      }
    }
    if (detailText) {
      output.appendLine('');
      output.appendLine(detailText);
    }
    output.show(true);

    const summary = submission.score + ' 分 ｜ ' + submission.time + ' ms ｜ ' + submission.memory + ' KB';
    if (isAccepted(submission.verdict)) {
      const choice = await vscode.window.showInformationMessage(
        info.label + '：' + problem.title + '（' + summary + '）',
        '查看输出'
      );
      if (choice === '查看输出') {
        output.show(true);
      }
    } else {
      const choice = await vscode.window.showWarningMessage(
        info.label + '：' + problem.title + '（' + summary + '）',
        '查看输出',
        '打开题目'
      );
      if (choice === '查看输出') {
        output.show(true);
      } else if (choice === '打开题目') {
        await openProblem(problem.id);
      }
    }
  }

  // ------------------------------------------------------------- download

  function resolveDownloadDirectory() {
    const configured = String(config().get('downloadDirectory', '') || '').trim();
    if (configured) {
      return configured;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.document.isUntitled && editor.document.uri.scheme === 'file') {
      return path.dirname(editor.document.uri.fsPath);
    }
    if (lastFileDirectory) {
      return lastFileDirectory;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return '';
  }

  function buildFileName(problem) {
    const template = String(config().get('downloadFileNameTemplate', '{stem}') || '{stem}');
    const stem = englishStem(problem.title) || safeFileName(problem.title);
    const name = template
      .replace(/\{stem\}/g, stem)
      .replace(/\{id\}/g, String(problem.id))
      .replace(/\{title\}/g, safeFileName(problem.title));
    const cleaned = safeFileName(name) || 'problem-' + problem.id;
    return /\.md$/i.test(cleaned) ? cleaned : cleaned + '.md';
  }

  async function downloadProblem(argument) {
    if (!state.token) {
      await login();
    }
    if (!state.token) {
      return;
    }
    const chosen = problemFromArg(argument) || currentProblem() || (await pickProblem());
    if (!chosen) {
      return;
    }

    let problem = state.problems.get(chosen.id);
    try {
      if (!problem) {
        problem = await client.getProblem(chosen.id);
        state.problems.set(problem.id, problem);
      }
    } catch (error) {
      reportError(error, '获取题目');
      return;
    }

    let contest = state.contestDetails.get(problem.contestId);
    if (!contest) {
      try {
        contest = await client.getContest(problem.contestId);
        state.contestDetails.set(contest.id, contest);
      } catch (error) {
        contest = undefined;
      }
    }
    const markdown = problemToMarkdown(problem, {
      baseUrl: baseUrl(),
      contestTitle: contest && contest.title,
    });

    const directory = resolveDownloadDirectory();
    if (!directory) {
      vscode.window.showWarningMessage('dotOJ：找不到保存目录，请先打开一个文件或工作区。');
      return;
    }

    const fileName = buildFileName(problem);
    const directoryUri = vscode.Uri.file(directory);
    const fileUri = vscode.Uri.joinPath(directoryUri, fileName);

    try {
      await vscode.workspace.fs.createDirectory(directoryUri);
      let exists = false;
      try {
        await vscode.workspace.fs.stat(fileUri);
        exists = true;
      } catch (error) {
        exists = false;
      }
      if (exists) {
        const answer = await vscode.window.showWarningMessage('文件已存在：' + fileName, { modal: true }, '覆盖');
        if (answer !== '覆盖') {
          return;
        }
      }
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(markdown, 'utf8'));
      output.appendLine('[' + new Date().toLocaleString() + '] 题面已保存：' + fileUri.fsPath);
      const action = await vscode.window.showInformationMessage(
        '题面已保存到 ' + fileUri.fsPath,
        '打开文件',
        '打开所在文件夹'
      );
      if (action === '打开文件') {
        const document = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(document, { preview: false });
      } else if (action === '打开所在文件夹') {
        await vscode.commands.executeCommand('revealFileInOS', fileUri);
      }
    } catch (error) {
      reportError(error, '保存题面');
    }
  }
  // ------------------------------------------------------------- commands

  context.subscriptions.push(
    vscode.commands.registerCommand('dotoj.login', login),
    vscode.commands.registerCommand('dotoj.loginWithToken', loginWithToken),
    vscode.commands.registerCommand('dotoj.logout', logout),
    vscode.commands.registerCommand('dotoj.refresh', () => {
      refresh();
    }),
    vscode.commands.registerCommand('dotoj.openProblem', (argument) => {
      const problem = problemFromArg(argument);
      return openProblem(problem ? problem.id : typeof argument === 'number' ? argument : undefined);
    }),
    vscode.commands.registerCommand('dotoj.submit', submit),
    vscode.commands.registerCommand('dotoj.downloadProblem', downloadProblem),
    vscode.commands.registerCommand('dotoj.setCurrentProblem', async (argument) => {
      const problem = problemFromArg(argument) || (await pickProblem());
      if (!problem) {
        return;
      }
      await setCurrentProblem({ id: problem.id, title: problem.title, contestId: problem.contestId });
      vscode.window.showInformationMessage('当前题目：' + problem.title);
    }),
    vscode.commands.registerCommand('dotoj.openInBrowser', (argument) => {
      const item = argument;
      const problem = problemFromArg(item);
      const url = problem
        ? baseUrl() + '/contest/' + problem.contestId + '/problem/' + problem.id
        : item && item.contest
          ? baseUrl() + '/contest/' + item.contest.id
          : baseUrl() + '/contests';
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('dotoj.showOutput', () => output.show(true))
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dotoj.baseUrl')) {
        state.languages = null;
        refresh();
      }
    })
  );

  // ------------------------------------------------------------- start up

  activeApi = { client, state, refresh, updateStatusBar };

  context.secrets.get(TOKEN_KEY).then((token) => {
    if (token) {
      state.token = token;
      setSignedIn(true);
      treeEmitter.fire();
    }
    updateStatusBar();
  });

  updateStatusBar();
}

function deactivate() {
  activeApi = undefined;
}

// --------------------------------------------------------------- utilities

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => map[ch]);
}

function englishStem(title) {
  const match = /[（(]\s*([A-Za-z0-9_.+-]+)\s*[）)]/.exec(String(title || ''));
  if (!match) {
    return '';
  }
  return match[1].replace(/\.(c|cc|cpp|cxx|h|hpp|py|java)$/i, '');
}

function makeNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function safeFileName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|#%]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

function formatRange(begin, end) {
  const fmt = (value) => {
    if (!value) {
      return '?';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    const pad = (num) => String(num).padStart(2, '0');
    return (
      date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    );
  };
  return fmt(begin) + ' ~ ' + fmt(end);
}

module.exports = { activate, deactivate };
