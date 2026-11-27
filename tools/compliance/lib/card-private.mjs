// 暂存区检查独立运行；公开卡状态的报告摘要是唯一允许的 64 位摘要。
const patterns = [
  ['lab-url', /lab:\/\//i],
  ['private-source-path', /原包源码|cards-overlay|exams-hidden|(?:复刻|调研资料|北冥引擎规划|实验室)[\\/]/i],
  ['local-path', /\/(?:Users|home)\/|\b[a-z]:[\\/]/i],
  ['bare-sha256', /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i],
];
const privateField = /^\/(?:provenance\/(?:studied|lab)|verify\/parity\/truth|ablation(?:\/\d+)?\/lab|priors\/\d+\/source)$/;

export function publicCardLeakCodes(text) {
  const codes = new Set();
  function inspect(value, isReport = false) {
    for (const [code, pattern] of patterns) {
      if (isReport && code === 'bare-sha256' && /^sha256:[0-9a-f]{64}$/.test(value)) continue;
      if (pattern.test(value)) codes.add(code);
    }
  }

  // JSON.parse 校验语法；逐个读取词元保留重复键、原始数字及字符串转义。
  try { JSON.parse(text); } catch { return ['invalid-json']; }
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:"]+/gu);
  let cursor = 0;
  function visit(path, statusArrayItem = false, isReport = false) {
    const token = tokens[cursor++];
    if (token === '{') {
      while (tokens[cursor] !== '}') {
        const key = JSON.parse(tokens[cursor++]);
        inspect(key);
        const next = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        if (privateField.test(next)) codes.add('private-overlay-field');
        cursor++; // 冒号
        visit(next, false, statusArrayItem && key === 'parityReport');
        if (tokens[cursor] === ',') cursor++;
      }
      cursor++;
    } else if (token === '[') {
      let index = 0;
      while (tokens[cursor] !== ']') {
        visit(`${path}/${index++}`, path === '/status');
        if (tokens[cursor] === ',') cursor++;
      }
      cursor++;
    } else {
      inspect(token.startsWith('"') ? JSON.parse(token) : token, isReport);
    }
  }
  visit('');
  return [...codes];
}
