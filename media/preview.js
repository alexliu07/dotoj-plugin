(function () {
  const vscode = acquireVsCodeApi();

  function bind(id, type) {
    const element = document.getElementById(id);
    if (element) {
      element.addEventListener('click', () => vscode.postMessage({ type }));
    }
  }

  bind('submit', 'submit');
  bind('newfile', 'newfile');
  bind('sampletest', 'sampletest');
  bind('download', 'download');

  const STATES = {
    pass: { icon: '✅', text: '通过', cls: 'ok' },
    warn: { icon: '⚠️', text: '通过（有警告）', cls: 'warn' },
    fail: { icon: '❌', text: '输出不一致', cls: 'bad' },
    tle: { icon: '⏱️', text: '超时', cls: 'bad' },
    error: { icon: '💥', text: '运行错误', cls: 'bad' },
  };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pre(text) {
    return '<pre>' + esc(text || '') + '</pre>';
  }

  function render(payload) {
    const box = document.getElementById('results');
    if (!box) {
      return;
    }
    if (!payload) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;

    if (payload.state === 'running') {
      const done = payload.progress ? ' <span class="muted">' + esc(payload.progress) + '</span>' : '';
      box.innerHTML = '<div class="results-head">样例测试 · 运行中…' + done + '</div>';
      return;
    }

    if (payload.compileError) {
      box.innerHTML =
        '<div class="results-head bad">❌ 编译失败' +
        '<span class="muted">' + esc(payload.language || '') + ' · ' + esc(payload.compiler || '') + '</span></div>' +
        '<div class="note">' + esc(payload.compileError) + '</div>' +
        (payload.output ? '<details open><summary>编译器输出</summary>' + pre(payload.output) + '</details>' : '');
      return;
    }

    const summary = payload.summary || { passed: 0, total: 0 };
    const allPassed = summary.total > 0 && summary.passed === summary.total;
    let html =
      '<div class="results-head ' + (allPassed ? 'ok' : 'bad') + '">' +
      '样例测试 · ' + summary.passed + '/' + summary.total + ' 通过' +
      (payload.timeLimit ? '<span class="muted">时间限制 ' + payload.timeLimit + ' ms</span>' : '') +
      '</div>';

    (payload.items || []).forEach((item) => {
      const meta = STATES[item.status] || { icon: '•', text: item.status, cls: '' };
      html +=
        '<div class="sample ' + meta.cls + '">' +
        '<span class="sample-icon">' + meta.icon + '</span>' +
        '<span class="sample-label">样例 ' + item.index + '</span>' +
        '<span class="sample-state">' + esc(meta.text) + '</span>' +
        '<span class="sample-time">' + (item.timeMs || 0) + ' ms</span>' +
        (item.note ? '<div class="note">' + esc(item.note) + '</div>' : '');
      if (item.status !== 'pass') {
        html +=
          '<details><summary>查看输入输出</summary>' +
          '<div class="kv"><span>期望输出</span>' + pre(item.expected) + '</div>' +
          '<div class="kv"><span>实际输出</span>' + pre(item.actual) + '</div>' +
          (item.stderr ? '<div class="kv"><span>stderr</span>' + pre(item.stderr) + '</div>' : '') +
          '</details>';
      }
      html += '</div>';
    });

    box.innerHTML = html;
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.type === 'sampleResults') {
      render(data.payload);
    }
  });

  render(window.__dotojResults || null);
})();