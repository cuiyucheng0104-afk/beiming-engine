// 北冥仓库 · requirements.lock 的读取与 PEP 508 环境标记求值（不依赖 Python 的 packaging 库）。
//
// 接口：
//   parseLock(text)              → {header: {input, inputSha256, excludeNewer, uv, python}, pins: [{name, version, marker, hashes:[...]}]}
//   normalizeName(name)          PEP 503 规范名（小写，-_. 统一成 -）
//   evalMarker(marker, envInfo)  标记是否对该解释器成立；envInfo 来自 probePython（platform、machine、system、osName、fullVersion、implementation）
//   markerEnv(probe)             把 probePython 的结果转成标记变量表
//   pinsFor(lock, probe)         该解释器应当安装的包 → [{name, version}]
import { createHash } from 'node:crypto';

export const normalizeName = n => n.toLowerCase().replace(/[-_.]+/g, '-');
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function parseLock(text) {
  const header = {};
  const pins = [];
  const logical = [];
  let buf = '';
  for (const raw of text.split(/\r?\n/)) {
    const m = /^#\s*(input|exclude-newer|uv|python|targets):\s*(.+)$/.exec(raw.trim());
    if (m) {
      if (m[1] === 'input') {
        const mm = /^(\S+)\s+sha256=([0-9a-f]{64})/.exec(m[2]);
        if (mm) { header.input = mm[1]; header.inputSha256 = mm[2]; }
      } else header[m[1] === 'exclude-newer' ? 'excludeNewer' : m[1]] = m[2].trim();
      continue;
    }
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (!line.trim()) { if (buf) { logical.push(buf); buf = ''; } continue; }
    if (line.trimEnd().endsWith('\\')) { buf += line.trimEnd().slice(0, -1) + ' '; continue; }
    buf += line;
    logical.push(buf);
    buf = '';
  }
  if (buf) logical.push(buf);
  for (const l of logical) {
    const s = l.trim();
    if (!s || s.startsWith('-')) continue;
    const hashes = [...s.matchAll(/--hash=sha256:([0-9a-f]{64})/g)].map(x => x[1]);
    const spec = s.replace(/--hash=sha256:[0-9a-f]{64}/g, '').trim();
    const [req, marker] = spec.split(/\s*;\s*/, 2);
    const mm = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([^\s;]+)$/.exec(req.trim());
    if (!mm) { pins.push({ name: req.trim(), version: null, marker: marker || null, hashes, invalid: true }); continue; }
    pins.push({ name: normalizeName(mm[1]), version: mm[2], marker: marker ? marker.trim() : null, hashes });
  }
  return { header, pins };
}

// ── PEP 508 标记：词法 + 递归下降；版本类变量按版本比较，其余按字符串 ──
const VERSION_VARS = new Set(['python_version', 'python_full_version', 'implementation_version', 'platform_release']);
function tokenize(s) {
  const out = [];
  const re = /\s*(?:(\()|(\))|(===|==|!=|<=|>=|~=|<|>)|(not\s+in\b)|(in\b)|(and\b)|(or\b)|(not\b)|'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_.]*))/y;
  let m;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    m = re.exec(s);
    if (!m) { if (/^\s*$/.test(s.slice(i))) break; throw new Error(`无法解析环境标记：${s}`); }
    i = re.lastIndex;
    if (m[1]) out.push({ t: '(' }); else if (m[2]) out.push({ t: ')' });
    else if (m[3]) out.push({ t: 'op', v: m[3] });
    else if (m[4]) out.push({ t: 'op', v: 'not in' }); else if (m[5]) out.push({ t: 'op', v: 'in' });
    else if (m[6]) out.push({ t: 'and' }); else if (m[7]) out.push({ t: 'or' }); else if (m[8]) out.push({ t: 'not' });
    else if (m[9] !== undefined) out.push({ t: 'str', v: m[9] }); else if (m[10] !== undefined) out.push({ t: 'str', v: m[10] });
    else if (m[11]) out.push({ t: 'var', v: m[11] });
  }
  return out;
}
function cmpVersion(a, b) {
  const pa = String(a).split(/[.+-]/).map(x => (/^\d+$/.test(x) ? +x : x));
  const pb = String(b).split(/[.+-]/).map(x => (/^\d+$/.test(x) ? +x : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
function compare(op, l, r, versionish) {
  if (op === 'in') return String(r).includes(String(l));
  if (op === 'not in') return !String(r).includes(String(l));
  if (versionish && /^[\d.]+/.test(String(l)) && /^[\d.]+/.test(String(r))) {
    const c = cmpVersion(l, r);
    if (op === '~=') {          // 兼容发布：~=3.12 即 >=3.12 且 ==3.*
      const prefix = String(r).split('.').slice(0, -1), lp = String(l).split('.');
      return c >= 0 && prefix.every((x, k) => lp[k] === x);
    }
    return { '==': c === 0, '===': String(l) === String(r), '!=': c !== 0, '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 }[op];
  }
  return { '==': l === r, '===': l === r, '!=': l !== r, '<': l < r, '<=': l <= r, '>': l > r, '>=': l >= r, '~=': l === r }[op];
}
export function evalMarker(marker, env) {
  if (!marker) return true;
  const toks = tokenize(marker);
  let i = 0;
  const peek = () => toks[i];
  const value = () => {
    const t = toks[i++];
    if (!t) throw new Error(`环境标记不完整：${marker}`);
    if (t.t === 'str') return { v: t.v, ver: false };
    if (t.t === 'var') { if (t.v === 'extra') return { v: '', ver: false }; if (!(t.v in env)) throw new Error(`未知的标记变量 ${t.v}`); return { v: env[t.v], ver: VERSION_VARS.has(t.v) }; }
    throw new Error(`环境标记语法错误：${marker}`);
  };
  const atom = () => {
    if (peek()?.t === '(') { i++; const v = orExpr(); if (toks[i++]?.t !== ')') throw new Error(`括号不配对：${marker}`); return v; }
    if (peek()?.t === 'not') { i++; return !atom(); }
    const l = value();
    const op = toks[i++];
    if (op?.t !== 'op') throw new Error(`缺少比较符：${marker}`);
    const r = value();
    return compare(op.v, l.v, r.v, l.ver || r.ver);
  };
  const andExpr = () => { let v = atom(); while (peek()?.t === 'and') { i++; const r = atom(); v = v && r; } return v; };
  const orExpr = () => { let v = andExpr(); while (peek()?.t === 'or') { i++; const r = andExpr(); v = v || r; } return v; };
  const res = orExpr();
  if (i !== toks.length) throw new Error(`环境标记有多余内容：${marker}`);
  return res;
}

export function markerEnv(p) {
  const [maj, min] = p.version;
  return {
    os_name: p.osName, sys_platform: p.platform, platform_machine: p.machine, platform_system: p.system,
    platform_python_implementation: p.implementation === 'cpython' ? 'CPython' : p.implementation === 'pypy' ? 'PyPy' : p.implementation,
    implementation_name: p.implementation, python_version: `${maj}.${min}`, python_full_version: p.fullVersion || p.version.join('.'),
    implementation_version: p.fullVersion || p.version.join('.'), platform_release: '', platform_version: '',
  };
}

export function pinsFor(lock, probe) {
  const env = markerEnv(probe);
  return lock.pins.filter(p => p.version && evalMarker(p.marker, env)).map(p => ({ name: p.name, version: p.version }));
}
