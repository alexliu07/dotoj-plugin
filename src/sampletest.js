'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { TextDecoder } = require('util');

const MAX_OUTPUT = 1024 * 1024; // 1 MB per stream
const COMPILE_TIMEOUT = 30000;

function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function tokensOf(text) {
  const trimmed = normalizeText(text).trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

// Mode A: whitespace is irrelevant. A difference that only touches the head or
// tail of the output is reported as a warning instead of a failure.
function compareOutput(actual, expected) {
  const a = normalizeText(actual);
  const e = normalizeText(expected);
  if (a === e) {
    return { status: 'pass', note: '' };
  }

  const at = tokensOf(a);
  const et = tokensOf(e);
  const sameTokens = at.length === et.length && at.every((token, index) => token === et[index]);
  if (sameTokens) {
    // Tokens match, so any raw difference is whitespace. When the trimmed
    // texts are identical the difference is only at the head/tail.
    const edgeOnly = a.trim() === e.trim();
    return {
      status: edgeOnly ? 'warn' : 'pass',
      note: edgeOnly ? '首尾空行/空格不同（不影响通过）' : '仅行内空白不同（不影响通过）',
    };
  }

  let index = 0;
  while (index < at.length && index < et.length && at[index] === et[index]) {
    index += 1;
  }
  const expectedToken = index < et.length ? et[index] : '(输出结束)';
  const actualToken = index < at.length ? at[index] : '(输出结束)';
  return {
    status: 'fail',
    note: '第 ' + (index + 1) + ' 个内容不一致：期望 ' + JSON.stringify(expectedToken) + '，实际 ' + JSON.stringify(actualToken),
    detail: {
      index,
      expectedToken,
      actualToken,
      expectedCount: et.length,
      actualCount: at.length,
    },
  };
}

function decodeBuffer(buffer) {
  if (!buffer || buffer.length === 0) {
    return '';
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch (gbkError) {
      return buffer.toString('latin1');
    }
  }
}

function killTree(child) {
  if (!child || child.killed) {
    return;
  }
  try {
    child.kill();
  } catch (error) {
    // ignore
  }
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    } catch (error) {
      // ignore
    }
  }
}

function compilerFor(filePath, configured, args) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const custom = String(configured || '').trim();
  const commonArgs = Array.isArray(args) && args.length > 0 ? args : ['-O2', '-Wall'];
  if (ext === '.c') {
    return { language: 'C', command: custom || 'gcc', args: commonArgs.slice() };
  }
  if (ext === '.cpp' || ext === '.cc' || ext === '.cxx') {
    return { language: 'C++', command: custom || 'g++', args: commonArgs.slice() };
  }
  return undefined;
}

function compile(options) {
  const { command, args, sourceFile, outputFile, cwd } = options;
  return new Promise((resolve) => {
    let finished = false;
    let stderr = '';
    let stdout = '';
    let child;

    const done = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn(command, args.concat(['-o', outputFile, sourceFile]), {
        cwd,
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }

    const timer = setTimeout(() => {
      killTree(child);
      done({ ok: false, error: '编译超时（' + Math.round(COMPILE_TIMEOUT / 1000) + ' 秒）', output: stderr || stdout });
    }, COMPILE_TIMEOUT);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += chunk.toString('utf8');
      }
    });
    child.on('error', (error) => {
      if (error && error.code === 'ENOENT') {
        done({ ok: false, error: '找不到编译器 “' + command + '”。请安装 gcc/g++，或设置 dotoj.compilerPath。' });
      } else {
        done({ ok: false, error: error.message });
      }
    });
    child.on('close', (code) => {
      const output = (stderr || stdout || '').trim();
      done(code === 0 ? { ok: true, output } : { ok: false, error: '编译失败（退出码 ' + code + '）', output });
    });
  });
}

function runOnce(options) {
  const { exe, input, timeoutMs, cwd, env, onSpawn } = options;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdoutBuffer = Buffer.alloc(0);
    let stderrBuffer = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let finished = false;
    let child;

    const finish = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn(exe, [], { cwd, env, windowsHide: true });
      if (typeof onSpawn === 'function') {
        onSpawn(child);
      }
    } catch (error) {
      resolve({ error: error.message, timedOut: false, code: -1, stdout: '', stderr: '', timeMs: 0 });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(50, timeoutMs));

    child.stdout.on('data', (chunk) => {
      if (stdoutBuffer.length >= MAX_OUTPUT) {
        truncated = true;
        return;
      }
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBuffer.length >= MAX_OUTPUT) {
        truncated = true;
        return;
      }
      stderrBuffer = Buffer.concat([stderrBuffer, chunk]);
    });
    child.on('error', (error) => {
      finish({ error: error.message, timedOut, code: -1, stdout: '', stderr: '', timeMs: Date.now() - startedAt });
    });
    child.on('close', (code) => {
      const stdout = decodeBuffer(stdoutBuffer);
      const stderr = decodeBuffer(stderrBuffer);
      finish({
        code,
        timedOut,
        truncated,
        stdout: stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) : stdout,
        stderr,
        timeMs: Date.now() - startedAt,
      });
    });

    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(String(input == null ? '' : input), 'utf8');
    }
  });
}

async function runSampleTests(options) {
  const {
    sourceFile,
    samples,
    timeLimitMs,
    compilerPath,
    compilerArgs,
    token,
    onProgress,
  } = options;

  const compiler = compilerFor(sourceFile, compilerPath, compilerArgs);
  if (!compiler) {
    return { ok: false, error: '只支持 .c / .cpp / .cc / .cxx 文件。' };
  }

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dotoj-sample-'));
  const exe = path.join(workDir, process.platform === 'win32' ? 'prog.exe' : 'prog');
  let currentChild;

  const onCancel = () => {
    if (currentChild) {
      killTree(currentChild);
    }
  };
  if (token && typeof token.onCancellationRequested === 'function') {
    token.onCancellationRequested(onCancel);
  }

  try {
    if (onProgress) {
      onProgress('正在编译（' + compiler.language + '）…');
    }
    const compiled = await compile({
      command: compiler.command,
      args: compiler.args,
      sourceFile,
      outputFile: exe,
      cwd: workDir,
    });
    if (!compiled.ok) {
      return {
        ok: false,
        language: compiler.language,
        compiler: compiler.command,
        error: compiled.error,
        output: compiled.output || '',
      };
    }
    if (token && token.isCancellationRequested) {
      return { ok: false, cancelled: true };
    }

    const env = Object.assign({}, process.env);
    const compilerDir = path.dirname(compiler.command);
    if (compilerDir && compilerDir !== '.') {
      env.PATH = compilerDir + path.delimiter + (env.PATH || '');
    }

    const limit = Math.max(10, Number(timeLimitMs) || 1000);
    const timeoutMs = limit + 300; // 进程启动开销的宽限
    const items = [];

    for (let index = 0; index < samples.length; index += 1) {
      if (token && token.isCancellationRequested) {
        return { ok: false, cancelled: true };
      }
      if (onProgress) {
        onProgress('运行样例 ' + (index + 1) + '/' + samples.length + '…');
      }

      const result = await runOnce({
        exe,
        input: samples[index].input,
        timeoutMs,
        cwd: workDir,
        env,
        onSpawn: (child) => {
          currentChild = child;
        },
      });
      currentChild = undefined;

      if (result.error) {
        items.push({
          index: index + 1,
          status: 'error',
          note: '无法运行程序：' + result.error,
          timeMs: result.timeMs || 0,
          expected: samples[index].output,
          actual: '',
        });
        continue;
      }

      if (result.timedOut) {
        items.push({
          index: index + 1,
          status: 'tle',
          note: '超过时间限制（' + limit + ' ms）',
          timeMs: result.timeMs,
          expected: samples[index].output,
          actual: result.stdout,
        });
        continue;
      }

      const compared = compareOutput(result.stdout, samples[index].output);
      items.push({
        index: index + 1,
        status: compared.status,
        note: compared.note,
        detail: compared.detail,
        timeMs: result.timeMs,
        truncated: !!result.truncated,
        expected: samples[index].output,
        actual: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
      });
    }

    return {
      ok: true,
      language: compiler.language,
      compiler: compiler.command,
      timeLimit: limit,
      items,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    killTree(currentChild);
    fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  compareOutput,
  normalizeText,
  tokensOf,
  decodeBuffer,
  compilerFor,
  runSampleTests,
};
