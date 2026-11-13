'use strict';

const http = require('http');
const https = require('https');

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  get isUnauthorized() {
    return this.status === 401;
  }
}

function joinUrl(baseUrl, pathname) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return base + pathname;
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name && String(headers[key]).toLowerCase() === 'true');
}

class DotOjClient {
  constructor(options = {}) {
    this.getBaseUrl = options.getBaseUrl || (() => options.baseUrl || '');
    this.getToken = options.getToken || (() => undefined);
    this.getTimeout = options.getTimeout || (() => options.timeout || 20000);
    this.onUnauthorized = options.onUnauthorized;
  }

  baseUrl() {
    return String(this.getBaseUrl() || '').replace(/\/+$/, '');
  }

  async request(method, pathname, options = {}) {
    try {
      return await this.send(method, pathname, options);
    } catch (error) {
      const unauthorized = error instanceof ApiError && error.isUnauthorized;
      if (!unauthorized || options.skipAuthRetry || typeof this.onUnauthorized !== 'function') {
        throw error;
      }
      const recovered = await this.onUnauthorized(error);
      if (!recovered) {
        throw error;
      }
      return this.send(method, pathname, Object.assign({}, options, { skipAuthRetry: true }));
    }
  }

  send(method, pathname, options = {}) {
    const query = options.query;
    const body = options.body;
    const extraHeaders = options.headers || {};
    const timeout = options.timeout || this.getTimeout();

    let url;
    try {
      url = new URL(joinUrl(this.baseUrl(), pathname));
    } catch (error) {
      return Promise.reject(new Error('OJ 地址无效：' + this.baseUrl()));
    }

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = Object.assign({ Accept: 'application/json' }, extraHeaders);
    const token = this.getToken();
    if (token && !hasHeader(headers, 'x-skip-inject-token')) {
      headers.Authorization = 'Bearer ' + token;
    }
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }

    const lib = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed;
            if (text) {
              try {
                parsed = JSON.parse(text);
              } catch (error) {
                parsed = text;
              }
            }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
              return;
            }
            let message = '';
            if (parsed && typeof parsed === 'object') {
              message = parsed.message || parsed.title || parsed.error || '';
            } else if (typeof parsed === 'string') {
              message = parsed.replace(/^"|"$/g, '');
            }
            if (!message) {
              message = res.statusCode === 401 ? '未登录或登录已过期' : 'HTTP ' + res.statusCode;
            }
            reject(new ApiError(message, res.statusCode, parsed));
          });
        }
      );

      req.setTimeout(timeout, () => {
        req.destroy(new Error('请求超时（' + timeout + ' ms）'));
      });
      req.on('error', (error) => reject(error));
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  login(username, password) {
    return this.request('POST', '/api/v2/auth/login', {
      body: { username, password },
      headers: { 'X-Skip-Inject-Token': 'true' },
      skipAuthRetry: true,
    });
  }

  getContests() {
    return this.request('GET', '/api/v2/contest', { query: { pageIndex: 1, pageSize: 100 } }).then(
      (data) => (data && data.items) || []
    );
  }

  getContest(contestId) {
    return this.request('GET', '/api/v2/contest/' + contestId);
  }

  getProblem(problemId) {
    return this.request('GET', '/api/v2/problem/' + problemId);
  }

  getLanguages() {
    return this.request('GET', '/api/v2/application/languages');
  }

  // dotOJ >= 2.7 exposes samples as public test cases instead of embedding
  // them in the problem payload.
  getPublicCase(problemId, caseNumber, revision) {
    return this.request('GET', '/api/v2/problem/' + problemId + '/public-cases/' + caseNumber, {
      query: { revision },
    });
  }

  submit(problemId, languageId, code) {
    return this.request('POST', '/api/v2/submission', {
      body: {
        problemId,
        program: {
          language: languageId,
          code: Buffer.from(code, 'utf8').toString('base64'),
        },
      },
    });
  }

  getSubmission(submissionId) {
    return this.request('GET', '/api/v2/submission/' + submissionId);
  }

  getSubmissionDetail(submissionId) {
    return this.request('GET', '/api/v2/submission/' + submissionId + '/detail', {
      headers: { 'X-Skip-Error-Redirect': 'true' },
    });
  }
}

module.exports = { DotOjClient, ApiError };
