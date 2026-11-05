'use strict';

// dotOJ verdict codes (from the web client's verdict table).
const VERDICTS = {
  0: { key: 'Pending', label: '等待评测', short: 'PD', accepted: false, pending: true },
  1: { key: 'Compiling', label: '编译中', short: 'CP', accepted: false, pending: true },
  2: { key: 'Running', label: '正在运行', short: 'RN', accepted: false, pending: true },
  3: { key: 'Accepted', label: '答案正确', short: 'AC', accepted: true, pending: false },
  4: { key: 'WrongAnswer', label: '答案错误', short: 'WA', accepted: false, pending: false },
  5: { key: 'TimeLimitExceeded', label: '时间超限', short: 'TLE', accepted: false, pending: false },
  6: { key: 'MemoryLimitExceeded', label: '内存超限', short: 'MLE', accepted: false, pending: false },
  7: { key: 'CompilationError', label: '编译错误', short: 'CE', accepted: false, pending: false },
  8: { key: 'RuntimeError', label: '运行错误', short: 'RE', accepted: false, pending: false },
  9: { key: 'Finished', label: '测试完成', short: 'AC', accepted: true, pending: false },
  10: { key: 'PartialAccepted', label: '部分正确', short: 'PC', accepted: false, pending: false },
  21: { key: 'Rejected', label: '未通过', short: 'RJ', accepted: false, pending: false },
};

function verdictInfo(code) {
  return VERDICTS[code] || { key: 'Unknown', label: '未知结果 (' + code + ')', short: '??', accepted: false, pending: false };
}

function verdictLabel(code) {
  const info = verdictInfo(code);
  return info.short + ' · ' + info.label;
}

function isPending(code) {
  return verdictInfo(code).pending;
}

function isAccepted(code) {
  return verdictInfo(code).accepted;
}

module.exports = { VERDICTS, verdictInfo, verdictLabel, isPending, isAccepted };
