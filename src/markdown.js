'use strict';

function decodeBase64(value) {
  if (!value) {
    return '';
  }
  try {
    return Buffer.from(String(value), 'base64').toString('utf8');
  } catch (error) {
    return '';
  }
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function fixLinks(text, baseUrl) {
  if (!text) {
    return '';
  }
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return String(text)
    .replace(/\]\((?!https?:\/\/)(\/[^)]*)\)/g, (match, target) => '](' + base + target + ')')
    .replace(/src="(?!https?:\/\/)(\/[^"]*)"/g, (match, target) => 'src="' + base + target + '"')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function fence(text) {
  const body = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  let ticks = '```';
  while (body.indexOf(ticks) !== -1) {
    ticks += '`';
  }
  return ticks + 'text\n' + body + '\n' + ticks;
}

function problemToMarkdown(problem, options = {}) {
  const baseUrl = options.baseUrl || '';
  const contestTitle = options.contestTitle;
  const link = baseUrl + '/contest/' + problem.contestId + '/problem/' + problem.id;
  const lines = [];

  lines.push('# ' + problem.title, '');
  if (contestTitle) {
    lines.push('- **竞赛**：' + contestTitle);
  }
  lines.push('- **题目 ID**：' + problem.id);
  lines.push('- **时间限制**：' + problem.timeLimit + ' ms ｜ **内存限制**：' + problem.memoryLimit + ' KiB');
  if (problem.hasSpecialJudge || problem.isInteractive) {
    const tags = [];
    if (problem.hasSpecialJudge) {
      tags.push('特殊评测');
    }
    if (problem.isInteractive) {
      tags.push('交互题');
    }
    lines.push('- **类型**：' + tags.join('、'));
  }
  lines.push('- **原题链接**：[' + link + '](' + link + ')', '');

  lines.push('## 题目描述', '', fixLinks(problem.description, baseUrl).trim(), '');
  lines.push('## 输入格式', '', fixLinks(problem.inputFormat, baseUrl).trim(), '');
  lines.push('## 输出格式', '', fixLinks(problem.outputFormat, baseUrl).trim(), '');

  const cases = problem.sampleCases || [];
  if (cases.length > 0) {
    lines.push('## 样例', '');
    cases.forEach((item, index) => {
      if (cases.length > 1) {
        lines.push('### 样例 ' + (index + 1), '');
      }
      lines.push('**输入**', '', fence(decodeBase64(item.input)), '');
      lines.push('**输出**', '', fence(decodeBase64(item.output)), '');
    });
  }

  const footnote = fixLinks(problem.footNote, baseUrl).trim();
  if (footnote) {
    lines.push('## 提示', '', footnote, '');
  }

  return lines.join('\n');
}

module.exports = { problemToMarkdown, decodeBase64, stripAnsi, fixLinks, fence };
