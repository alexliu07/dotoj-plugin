'use strict';

const path = require('path');
const vscode = require('vscode');
const { DotOjClient, ApiError } = require('./api');
const { verdictInfo, verdictLabel, isPending, isAccepted } = require('./verdicts');
const { problemToMarkdown, decodeBase64, stripAnsi } = require('./markdown');
const { runSampleTests } = require('./sampletest');
const { loadSamples, clearSampleCache } = require('./samples');

const TOKEN_KEY = 'dotoj.token';
const CREDENTIALS_KEY = 'dotoj.credentials';
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
  const baseUrl = () => String(config().get('baseUrl', '') || '').trim().replace(/\/+$/, '');
  const tokenKeyFor = (url) => TOKEN_KEY + ':' + String(url || '').replace(/\/+$/, '').toLowerCase();
  const credentialsKey = () => CREDENTIALS_KEY + ':' + String(baseUrl() || '').replace(/\/+$/, '').toLowerCase();
  const pollInterval = () => Math.max(200, Number(config().get('pollIntervalMs', 800)) || 800);

  const client = new DotOjClient({
    getBaseUrl: baseUrl,
    getToken: () => state.token,
    getTimeout: () => Number(config().get('requestTimeoutMs', 20000)) || 20000,
    onUnauthorized: () => onUnauthorized(),
  });

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  const treeEmitter = new vscode.EventEmitter();

  // Remember where the user's code lives: the webview panel steals focus and
  // leaves `activeTextEditor` undefined, but downloads should still land next
  // to the file that was being edited.
  let lastFileDirectory = '';
  let lastFileUri;
  const rememberActiveEditor = (editor) => {
    if (editor && editor.document && !editor.document.isUntitled && editor.document.uri.scheme === 'file') {
      lastFileDirectory = path.dirname(editor.document.uri.fsPath);
      lastFileUri = editor.document.uri;
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
    constructor(problem, sections) {
      super(problem.title, vscode.TreeItemCollapsibleState.None);
      this.problem = problem;
      this.id = 'problem:' + problem.id;
      this.contextValue = 'dotoj.problem';
      this.iconPath = problem.solved
        ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
        : new vscode.ThemeIcon('symbol-method');
      const sectionName =
        problem.section || (problem.sectionId && sections ? sections.get(problem.sectionId) : '') || '';
      this.description = sectionName;
      this.tooltip = new vscode.MarkdownString(
        '**' + problem.title + '**\n\n#' + problem.id + (problem.section ? ' · ' + problem.section : '')
      );
      this.command = { command: 'dotoj.openProblem', title: '打开题目', arguments: [problem.id] };
    }
  }

  function sectionNames(detail) {
    const map = new Map();
    for (const section of (detail && detail.sections) || []) {
      if (section && section.id) {
        map.set(section.id, section.name || '');
      }
    }
    return map;
  }

  // ---------------------------------------------------------------- tree

  const tree = {
    onDidChangeTreeData: treeEmitter.event,
    getTreeItem: (item) => item,
    getChildren: async (element) => {
      if (!baseUrl()) {
        return [new ActionItem('设置服务器地址…', 'dotoj.switchServer', 'server-environment')];
      }
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
          return problems.map((problem) => new ProblemItem(problem, sectionNames(detail)));
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
  updateTreeDescription();

  // ------------------------------------------------------------- helpers

  function refresh() {
    state.contests = null;
    state.contestDetails.clear();
    state.problems.clear();
    clearSampleCache();
    treeEmitter.fire();
  }

  function setSignedIn(value) {
    vscode.commands.executeCommand('setContext', SIGNED_IN_CONTEXT, !!value);
  }

  function currentProblem() {
    const stored = context.workspaceState.get(STATE_CURRENT);
    if (!stored) {
      return undefined;
    }
    if (stored.server && stored.server !== baseUrl()) {
      return undefined;
    }
    return stored;
  }

  function setCurrentProblem(problem) {
    const value = problem ? Object.assign({}, problem, { server: baseUrl() }) : undefined;
    return context.workspaceState.update(STATE_CURRENT, value).then(updateStatusBar);
  }

  function fileBindings() {
    return context.workspaceState.get(STATE_FILE_MAP, {});
  }

  function bindFile(uri, problem) {
    const map = Object.assign({}, fileBindings());
    if (problem) {
      map[uri.toString()] = Object.assign({}, problem, { server: baseUrl() });
    } else {
      delete map[uri.toString()];
    }
    return context.workspaceState.update(STATE_FILE_MAP, map);
  }

  function updateStatusBar() {
    const problem = currentProblem();
    if (!baseUrl()) {
      statusBar.text = '$(server-environment) dotOJ 设置服务器';
      statusBar.command = 'dotoj.switchServer';
      statusBar.tooltip = '还没有配置 dotOJ 服务器，点击设置';
    } else if (!state.token) {
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

  async function getSavedCredentials() {
    try {
      const raw = await context.secrets.get(credentialsKey());
      if (!raw) {
        return undefined;
      }
      const parsed = JSON.parse(raw);
      if (parsed && parsed.username && parsed.password) {
        return parsed;
      }
    } catch (error) {
      output.appendLine('读取保存的账号失败：' + describeError(error));
    }
    return undefined;
  }

  async function saveCredentials(username, password) {
    if (!config().get('rememberPassword', true)) {
      return;
    }
    try {
      await context.secrets.store(credentialsKey(), JSON.stringify({ username, password }));
    } catch (error) {
      output.appendLine('保存账号失败：' + describeError(error));
    }
  }

  async function clearCredentials() {
    try {
      await context.secrets.delete(credentialsKey());
    } catch (error) {
      // ignore
    }
  }

  let autoLoginPromise = null;

  async function tryAutoLogin() {
    if (!baseUrl()) {
      return 'missing';
    }
    if (autoLoginPromise) {
      return autoLoginPromise;
    }
    autoLoginPromise = (async () => {
      const saved = await getSavedCredentials();
      if (!saved) {
        output.appendLine('[' + new Date().toLocaleString() + '] 没有保存该服务器的账号密码，跳过自动登录。');
        return 'missing';
      }
      output.appendLine(
        '[' + new Date().toLocaleString() + '] 登录已过期，尝试用保存的账号自动登录（' + saved.username + '）…'
      );
      try {
        const result = await client.login(saved.username, saved.password);
        if (!result || !result.token) {
          return 'failed';
        }
        state.token = result.token;
        await context.secrets.store(tokenKeyFor(baseUrl()), result.token);
        setSignedIn(true);
        updateStatusBar();
        treeEmitter.fire();
        output.appendLine('自动登录成功。');
        return 'ok';
      } catch (error) {
        output.appendLine('自动登录失败：' + describeError(error));
        return 'failed';
      }
    })().finally(() => {
      autoLoginPromise = null;
    });
    return autoLoginPromise;
  }

  async function promptRelogin(reason) {
    state.token = undefined;
    await context.secrets.delete(tokenKeyFor(baseUrl()));
    setSignedIn(false);
    updateStatusBar();
    refresh();
    const message =
      reason === 'missing'
        ? 'dotOJ 登录已过期，且没有保存这个服务器的账号密码，请重新登录。'
        : 'dotOJ 登录已过期，自动登录失败了，请重新登录。';
    const choice = await vscode.window.showWarningMessage(message, '登录');
    if (choice === '登录') {
      await login();
      return !!state.token;
    }
    return false;
  }

  async function onUnauthorized() {
    const outcome = await tryAutoLogin();
    if (outcome === 'ok') {
      return true;
    }
    return promptRelogin(outcome);
  }

  function reportError(error, prefix) {
    const text = (prefix ? prefix + '：' : '') + describeError(error);
    output.appendLine('[' + new Date().toLocaleString() + '] ' + text);
    if (error instanceof ApiError && error.isUnauthorized) {
      // The client already tried to recover (saved credentials / manual login).
      return;
    }
    vscode.window.showErrorMessage('dotOJ ' + text);
  }

  // --------------------------------------------------------------- login

  async function login() {
    if (!(await ensureServer())) {
      return;
    }
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
      await context.secrets.store(tokenKeyFor(baseUrl()), result.token);
      await context.globalState.update(STATE_USER, state.username);
      await saveCredentials(username.trim(), password);
      setSignedIn(true);
      updateStatusBar();
      refresh();
      vscode.window.showInformationMessage('已登录 dotOJ：' + (result.fullName || state.username));
    } catch (error) {
      reportError(error, '登录失败');
    }
  }

  async function loginWithToken() {
    if (!(await ensureServer())) {
      return;
    }
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
      await context.secrets.store(tokenKeyFor(baseUrl()), state.token);
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
    await context.secrets.delete(tokenKeyFor(baseUrl()));
    await clearCredentials();
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
      const sections = sectionNames(detail);
      for (const problem of detail.problems || []) {
        const sectionName =
          problem.section || (problem.sectionId && sections.get(problem.sectionId)) || '';
        picks.push({
          label: problem.title,
          description: '#' + problem.id + (sectionName ? ' · ' + sectionName : ''),
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

  async function buildProblemHtml(webview, problem, markdown, initialResults) {
    const body = await renderMarkdownHtml(markdown);
    const nonce = makeNonce();
    const katexCss = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'media', 'katex', 'katex.min.css')
    );
    const previewCss = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'media', 'preview.css')
    );
    const previewJs = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'media', 'preview.js')
    );
    const csp = [
      "default-src 'none'",
      'img-src ' + webview.cspSource + ' https: http: data:',
      'style-src ' + webview.cspSource + " 'unsafe-inline'",
      'font-src ' + webview.cspSource,
      'script-src ' + webview.cspSource + " 'nonce-" + nonce + "'",
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
      '<button id="newfile" class="secondary">新建文件</button>',
      '<button id="sampletest" class="secondary">样例测试</button>',
      '<button id="download" class="secondary">下载题面</button>',
      '<span class="meta">#' + problem.id + ' · ' + escapeHtml(problem.title) + '</span>',
      '</div>',
      '<section id="results" class="results" hidden></section>',
      '<main class="markdown-body">',
      body,
      '</main>',
      '<script nonce="' + nonce + '">',
      'window.__dotojResults = ' +
        (initialResults ? JSON.stringify(initialResults).replace(/</g, '\\u003c') : 'null') +
        ';',
      '</script>',
      '<script nonce="' + nonce + '" src="' + previewJs + '"></script>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  // ------------------------------------------------------ problem view

  let problemView;
  let shownProblem;
  let lastProblemHtml = '';
  const sampleCache = new Map();

  async function handleProblemMessage(message, target) {
    if (!message || typeof message !== 'object' || !target) {
      return;
    }
    if (message.type === 'submit') {
      await submit(target);
    } else if (message.type === 'sampletest') {
      await runSamplesFor(target);
    } else if (message.type === 'download') {
      await downloadProblem(target);
    } else if (message.type === 'newfile') {
      await createProblemFile(target);
    }
  }

  async function revealSampleResults(problemId) {
    const id = problemId || (currentProblem() && currentProblem().id);
    if (!id) {
      return;
    }
    try {
      await vscode.commands.executeCommand('dotoj.problemView.focus');
    } catch (error) {
      // the view container may be hidden entirely
    }
    if (!problemView) {
      // The panel was closed: rebuild it, cached results are injected again.
      await openProblem(id);
      return;
    }
    try {
      problemView.show(true);
    } catch (error) {
      // ignore
    }
    problemView.webview.postMessage({ type: 'revealResults' });
  }

  function publishSampleState(problemId, payload) {
    sampleCache.set(problemId, payload);
    if (problemView) {
      problemView.webview.postMessage({ type: 'sampleResults', payload });
    }
  }

  async function runSamplesFor(problem) {
    try {
      if (!problem || !problem.id) {
        return;
      }
      if (!(await ensureServer())) {
        return;
      }
      let data = state.problems.get(problem.id);
      if (!data) {
        data = await client.getProblem(problem.id);
        state.problems.set(problem.id, data);
      }
      let samples = [];
      try {
        samples = await loadSamples(client, data);
      } catch (error) {
        reportError(error, '获取样例');
        return;
      }
      if (samples.length === 0) {
        vscode.window.showWarningMessage('dotOJ：这道题没有样例。');
        return;
      }

      const editor = vscode.window.activeTextEditor;
      const uri = editor && editor.document ? editor.document.uri : lastFileUri;
      if (!uri || uri.scheme !== 'file') {
        vscode.window.showWarningMessage('dotOJ：请先打开要测试的 .c / .cpp 文件。');
        return;
      }
      const ext = path.extname(uri.fsPath).toLowerCase();
      if (!['.c', '.cpp', '.cc', '.cxx'].includes(ext)) {
        vscode.window.showWarningMessage('dotOJ：样例测试只支持 C / C++ 源文件。');
        return;
      }

      const document = await vscode.workspace.openTextDocument(uri);
      if (document.isDirty) {
        await document.save();
      }

      publishSampleState(problem.id, { state: 'running', total: samples.length });

      const outcome = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '样例测试：' + problem.title,
          cancellable: true,
        },
        (progress, token) =>
          runSampleTests({
            sourceFile: uri.fsPath,
            samples,
            timeLimitMs: data.timeLimit,
            compilerPath: config().get('compilerPath', ''),
            compilerArgs: config().get('compilerArgs', ['-O2', '-Wall']),
            token,
            onProgress: (message) => {
              progress.report({ message });
              publishSampleState(problem.id, { state: 'running', total: samples.length, progress: message });
            },
          })
      );

      if (outcome.cancelled) {
        publishSampleState(problem.id, {
          state: 'done',
          language: outcome.language,
          cancelled: true,
          items: [],
          summary: { passed: 0, total: samples.length },
        });
        vscode.window.showInformationMessage('dotOJ：已取消样例测试。');
        return;
      }

      if (!outcome.ok) {
        publishSampleState(problem.id, {
          state: 'done',
          language: outcome.language,
          compiler: outcome.compiler,
          compileError: outcome.error,
          output: outcome.output || '',
          items: [],
          summary: { passed: 0, total: samples.length },
        });
        output.appendLine('[' + new Date().toLocaleString() + '] 样例测试失败：' + outcome.error);
        if (outcome.output) {
          output.appendLine(outcome.output);
        }
        vscode.window
          .showErrorMessage('dotOJ 样例测试：' + outcome.error, '查看详情')
          .then((choice) => {
            if (choice === '查看详情') {
              revealSampleResults(problem.id);
            }
          });
        return;
      }

      const passed = outcome.items.filter((item) => item.status === 'pass' || item.status === 'warn').length;
      publishSampleState(problem.id, {
        state: 'done',
        language: outcome.language,
        compiler: outcome.compiler,
        timeLimit: outcome.timeLimit,
        items: outcome.items,
        summary: { passed, total: outcome.items.length },
      });

      outcome.items.forEach((item) => {
        output.appendLine(
          '[' + new Date().toLocaleString() + '] 样例 ' + item.index + '：' + item.status +
            '（' + item.timeMs + ' ms）' + (item.note ? ' - ' + item.note : '')
        );
      });

      const summaryText = passed + '/' + outcome.items.length + ' 样例通过';
      if (passed === outcome.items.length) {
        vscode.window.showInformationMessage('dotOJ 样例测试：' + summaryText);
      } else {
        vscode.window.showWarningMessage('dotOJ 样例测试：' + summaryText, '查看详情').then((choice) => {
          if (choice === '查看详情') {
            revealSampleResults(problem.id);
          }
        });
      }
    } catch (error) {
      reportError(error, '样例测试');
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
      if (!(await ensureServer())) {
        return;
      }
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
      let samples = [];
      try {
        samples = await loadSamples(client, problem);
      } catch (error) {
        output.appendLine('读取样例失败：' + describeError(error));
      }
      const markdown = problemToMarkdown(problem, {
        baseUrl: baseUrl(),
        contestTitle: contest && contest.title,
        samples,
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
        const html = await buildProblemHtml(view.webview, problem, markdown, sampleCache.get(problem.id));
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
        panel.webview.html = await buildProblemHtml(panel.webview, problem, markdown, sampleCache.get(problem.id));
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
    if (!(await ensureServer())) {
      return;
    }
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
      const bound = fileBindings()[document.uri.toString()];
      problem =
        (bound && (!bound.server || bound.server === baseUrl()) ? bound : undefined) ||
        currentProblem() ||
        undefined;
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

  async function createProblemFile(problem) {
    const directory = resolveDownloadDirectory();
    if (!directory) {
      vscode.window.showWarningMessage('dotOJ：找不到目录，请先打开一个文件或工作区。');
      return;
    }
    const base = englishStem(problem.title) || safeFileName(problem.title) || 'problem-' + problem.id;
    const fileName = base + '.c';
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
      if (!exists) {
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from('', 'utf8'));
        output.appendLine('[' + new Date().toLocaleString() + '] 新建文件：' + fileUri.fsPath);
      } else {
        output.appendLine('[' + new Date().toLocaleString() + '] 文件已存在，直接打开：' + fileUri.fsPath);
      }
      const document = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(document, { preview: false });
      await bindFile(document.uri, { id: problem.id, title: problem.title, contestId: problem.contestId });
      await setCurrentProblem({ id: problem.id, title: problem.title, contestId: problem.contestId });
      if (exists) {
        vscode.window.showInformationMessage('文件已存在，已打开：' + fileName);
      }
    } catch (error) {
      reportError(error, '新建文件');
    }
  }

  async function downloadProblem(argument) {
    if (!(await ensureServer())) {
      return;
    }
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
  // ------------------------------------------------------- servers

  function updateTreeDescription() {
    try {
      const url = baseUrl();
      treeView.description = url ? url.replace(/^https?:\/\//, '') : '未设置服务器';
      treeView.tooltip = url ? '当前服务器：' + url : '点击设置 dotOJ 服务器';
    } catch (error) {
      // purely cosmetic
    }
  }

  function validateServerUrl(value) {
    try {
      const parsed = new URL(String(value || '').trim());
      return /^https?:$/.test(parsed.protocol) ? '' : '地址必须以 http:// 或 https:// 开头';
    } catch (error) {
      return '地址格式不正确';
    }
  }

  async function promptServerUrl() {
    const value = await vscode.window.showInputBox({
      title: '设置 dotOJ 服务器',
      prompt: '输入 dotOJ 服务器地址，例如 https://public.oj.cpl.icu',
      value: 'https://public.oj.cpl.icu',
      ignoreFocusOut: true,
      validateInput: validateServerUrl,
    });
    if (!value) {
      return undefined;
    }
    return String(value).trim().replace(/\/+$/, '');
  }

  async function rememberServer(url, name) {
    const list = (config().get('servers', []) || []).slice();
    const exists = list.some(
      (item) => item && String(item.url || '').replace(/\/+$/, '').toLowerCase() === url.toLowerCase()
    );
    if (exists) {
      return;
    }
    list.push({ name: name || url.replace(/^https?:\/\//, ''), url });
    await persistSetting('servers', list);
  }

  async function ensureServer() {
    if (baseUrl()) {
      return true;
    }
    const url = await promptServerUrl();
    if (!url) {
      return false;
    }
    await persistSetting('baseUrl', url);
    await rememberServer(url);
    return true;
  }

  function configuredServers() {
    const list = config().get('servers', []) || [];
    const result = [];
    const seen = new Set();
    for (const item of list) {
      if (!item || !item.url) {
        continue;
      }
      const url = String(item.url).trim().replace(/\/+$/, '');
      const key = url.toLowerCase();
      if (!url || seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ name: String(item.name || url), url });
    }
    const current = baseUrl();
    if (current && !seen.has(current.toLowerCase())) {
      result.unshift({ name: current.replace(/^https?:\/\//, ''), url: current });
    }
    return result;
  }

  async function persistSetting(key, value) {
    const info = config().inspect(key);
    const jobs = [config().update(key, value, vscode.ConfigurationTarget.Global)];
    if (info && info.workspaceValue !== undefined) {
      jobs.push(config().update(key, value, vscode.ConfigurationTarget.Workspace));
    }
    await Promise.all(jobs);
  }

  async function addServer() {
    const name = await vscode.window.showInputBox({
      title: '添加 dotOJ 服务器',
      prompt: '给这个服务器起个名字，例如：NJU 2026 C 语言作业',
      ignoreFocusOut: true,
      validateInput: (value) => (String(value || '').trim() ? '' : '名字不能为空'),
    });
    if (!name) {
      return undefined;
    }
    const url = await promptServerUrl();
    if (!url) {
      return undefined;
    }
    const normalized = url;
    const list = (config().get('servers', []) || []).slice();
    list.push({ name: String(name).trim(), url: normalized });
    await persistSetting('servers', list);
    return { name: String(name).trim(), url: normalized };
  }

  async function switchServer() {
    if (!baseUrl() && configuredServers().length === 0) {
      const url = await promptServerUrl();
      if (!url) {
        return;
      }
      await persistSetting('baseUrl', url);
      await rememberServer(url);
      vscode.window.showInformationMessage('已设置服务器：' + url);
      return;
    }
    const items = configuredServers().map((server) => ({
      label: server.name,
      description: server.url,
      server,
    }));
    items.push({ label: '$(add) 添加服务器…', description: '输入一个新的 dotOJ 地址', server: undefined, add: true });
    const picked = await vscode.window.showQuickPick(items, {
      title: '切换 dotOJ 服务器',
      placeHolder: '当前：' + baseUrl(),
      matchOnDescription: true,
    });
    if (!picked) {
      return;
    }
    let target = picked.server;
    if (picked.add) {
      target = await addServer();
      if (!target) {
        return;
      }
    }
    if (target.url === baseUrl()) {
      vscode.window.showInformationMessage('已经在使用 ' + target.url);
      return;
    }
    await persistSetting('baseUrl', target.url);
    vscode.window.showInformationMessage('已切换到 ' + (target.name || target.url));
  }

  async function reloadToken() {
    const token = await context.secrets.get(tokenKeyFor(baseUrl()));
    state.token = token || undefined;
    setSignedIn(!!state.token);
    updateStatusBar();
  }

  // ------------------------------------------------------------- commands

  context.subscriptions.push(
    vscode.commands.registerCommand('dotoj.login', login),
    vscode.commands.registerCommand('dotoj.loginWithToken', loginWithToken),
    vscode.commands.registerCommand('dotoj.logout', logout),
    vscode.commands.registerCommand('dotoj.forgetPassword', async () => {
      if (!baseUrl()) {
        vscode.window.showWarningMessage('dotOJ：还没有设置服务器。');
        return;
      }
      const answer = await vscode.window.showWarningMessage('清除 ' + baseUrl() + ' 保存的账号密码？', { modal: true }, '清除');
      if (answer !== '清除') {
        return;
      }
      await clearCredentials();
      vscode.window.showInformationMessage('已清除保存的账号密码。');
    }),
    vscode.commands.registerCommand('dotoj.refresh', () => {
      refresh();
    }),
    vscode.commands.registerCommand('dotoj.showSampleResults', (problemId) => revealSampleResults(problemId)),
    vscode.commands.registerCommand('dotoj.sampleTest', async (argument) => {
      let problem = problemFromArg(argument) || currentProblem();
      if (!problem) {
        problem = await pickProblem();
        if (problem) {
          problem = { id: problem.id, title: problem.title, contestId: problem.contestId };
        }
      }
      if (!problem) {
        return;
      }
      await runSamplesFor(problem);
    }),
    vscode.commands.registerCommand('dotoj.switchServer', switchServer),
    vscode.commands.registerCommand('dotoj.addServer', () => addServer()),
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
      if (!baseUrl()) {
        vscode.window.showWarningMessage('dotOJ：请先设置服务器地址。');
        return;
      }
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
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('dotoj.baseUrl')) {
        state.languages = null;
        state.contests = null;
        state.contestDetails.clear();
        state.problems.clear();
        await reloadToken();
        updateTreeDescription();
        refresh();
      } else if (event.affectsConfiguration('dotoj.servers')) {
        updateTreeDescription();
      }
    })
  );

  // ------------------------------------------------------------- start up

  activeApi = { client, state, refresh, updateStatusBar };

  if (baseUrl()) {
    context.secrets.get(tokenKeyFor(baseUrl())).then((token) => {
      state.token = token || undefined;
      setSignedIn(!!state.token);
      if (state.token) {
        treeEmitter.fire();
      }
      updateStatusBar();
    });
  } else {
    updateStatusBar();
  }

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
