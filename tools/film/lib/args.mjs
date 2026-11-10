// 北冥仓库 · 出片编排 · 严格参数解析：只认声明过的选项，未知选项、缺值、类型不对一律退出码 2，并说清合法取值。
//   parseArgs(argv, spec) → { opts, positionals }
//   spec = {
//     positionals: [{ name: '作品目录', required: true }],     多出来的位置参数也是用法错误
//     options: {
//       '--profile': { type: 'string', arg: '<档位>', help: '...' },
//       '--json':    { type: 'bool', help: '...' },
//       '--workers': { type: 'int', min: 1, max: 64 },
//       '--waive':   { type: 'list' },                           逗号分隔，可重复，合并去重
//       '--gpu':     { type: 'enum', values: ['required', 'any', 'software-ok'] },
//     },
//   }
// 写法：--k v 与 --k=v 都认；bool 选项不带值；"--" 之后全部当位置参数。opts 的键去掉前导 "--" 并转成驼峰（--no-cache → noCache）。
import { usage } from './exit.mjs';

export const camel = k => k.replace(/^--/, '').replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv, spec) {
  const options = spec.options || {};
  const opts = {};
  const positionals = [];
  const names = Object.keys(options);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(0, eq) : a;
      const def = options[key];
      if (!def) {
        const near = names.filter(n => n.includes(key.slice(2, 5))).slice(0, 3);
        throw usage(`不认识的选项 ${key}`, `可用选项：${names.join(' ')}${near.length ? `（是不是 ${near.join(' / ')}？）` : ''}`);
      }
      let val;
      if (def.type === 'bool') {
        if (eq > 0) throw usage(`${key} 是开关，不带值`);
        val = true;
      } else {
        if (eq > 0) val = a.slice(eq + 1);
        else {
          val = argv[i + 1];
          if (val === undefined || (val.startsWith('--') && val.length > 2)) throw usage(`${key} 后面要跟 ${def.arg || '一个值'}`);
          i++;
        }
        val = coerce(key, def, val);
      }
      const k = camel(key);
      if (def.type === 'list') opts[k] = [...new Set([...(opts[k] || []), ...val])];
      else opts[k] = val;
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      if (a === '-h') { opts.help = true; continue; }
      throw usage(`不认识的选项 ${a}`, '只认双横线的长选项，例如 --help');
    }
    positionals.push(a);
  }
  const want = spec.positionals || [];
  const missing = want.filter((p, i) => p.required && positionals[i] === undefined);
  if (missing.length && !opts.help) throw usage(`缺少参数：${missing.map(p => p.name).join('、')}`);
  if (positionals.length > want.length && !spec.variadic) {
    throw usage(`多余的参数：${positionals.slice(want.length).join(' ')}`, `这个命令只接受 ${want.map(p => `<${p.name}>`).join(' ') || '选项'}`);
  }
  return { opts, positionals };
}

function coerce(key, def, raw) {
  switch (def.type) {
    case 'string':
      if (!String(raw).trim()) throw usage(`${key} 的值不能为空`);
      return raw;
    case 'int': {
      if (!/^-?\d+$/.test(raw)) throw usage(`${key} 要一个整数，收到「${raw}」`);
      const n = Number(raw);
      if (def.min !== undefined && n < def.min) throw usage(`${key} 不能小于 ${def.min}，收到 ${n}`);
      if (def.max !== undefined && n > def.max) throw usage(`${key} 不能大于 ${def.max}，收到 ${n}`);
      return n;
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw usage(`${key} 要一个数，收到「${raw}」`);
      if (def.min !== undefined && n < def.min) throw usage(`${key} 不能小于 ${def.min}，收到 ${n}`);
      return n;
    }
    case 'enum':
      if (!def.values.includes(raw)) throw usage(`${key} 只能是 ${def.values.join(' / ')}，收到「${raw}」`);
      return raw;
    case 'list': {
      const items = String(raw).split(',').map(s => s.trim()).filter(Boolean);
      if (!items.length) throw usage(`${key} 的值不能为空`);
      if (def.values) for (const it of items) if (!def.values.includes(it)) throw usage(`${key} 只能取 ${def.values.join(' / ')}，收到「${it}」`);
      return items;
    }
    default:
      throw new Error(`参数表写错了：${key} 的 type=${def.type}`);
  }
}

// --size WxH：偶数、≥16（H.264 yuv420p 的要求）
export function parseSize(raw, key = '--size') {
  const m = /^(\d+)x(\d+)$/.exec(raw || '');
  const w = m && +m[1], h = m && +m[2];
  if (!m || w % 2 || h % 2 || w < 16 || h < 16 || w > 16384 || h > 16384) throw usage(`${key} 要写成 宽x高，都是 16–16384 的偶数，例如 1920x1080；收到「${raw}」`);
  return [w, h];
}

// --frames 规格：单帧 48、半开区间 72:120（含 72 不含 120，与镜头表同口径）、带步长 0:240:12、逗号组合 0:24,48,96
export function parseFrames(raw, frameCount, key = '--frames') {
  const out = new Set();
  for (const part of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?::(\d+)(?::(\d+))?)?$/.exec(part);
    if (!m) throw usage(`${key} 的写法不对：「${part}」`, '例：48、72:120（半开区间）、0:240:12、0:24,48');
    const a = +m[1];
    if (m[2] === undefined) { out.add(a); continue; }
    const b = +m[2], step = m[3] === undefined ? 1 : +m[3];
    if (step <= 0) throw usage(`${key} 的步长必须是正整数：「${part}」`);
    if (b <= a) throw usage(`${key} 的区间要写成 起:止 且 起 < 止（半开区间）：「${part}」`);
    for (let f = a; f < b; f += step) out.add(f);
  }
  const frames = [...out].sort((x, y) => x - y);
  if (!frames.length) throw usage(`${key} 没有给出任何帧`);
  const bad = frames.filter(f => f >= frameCount);
  if (bad.length) throw usage(`${key} 超出片长：本片 ${frameCount} 帧（0–${frameCount - 1}），收到 ${bad.slice(0, 5).join('、')}${bad.length > 5 ? ' …' : ''}`);
  if (frames.length > 20000) throw usage(`${key} 一次最多 20000 帧，收到 ${frames.length} 帧`);
  return frames;
}

// 时刻列表（秒）→ 帧号（四舍五入到整帧，与 engine/core/clock.js 的 frameOf 同口径）
export function parseTimes(raw, fps, frameCount, key = '--times') {
  const frames = new Set();
  for (const part of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
    const t = Number(part);
    if (!Number.isFinite(t) || t < 0) throw usage(`${key} 要逗号分隔的秒数，收到「${part}」`);
    frames.add(Math.min(frameCount - 1, Math.round(t * fps)));
  }
  if (!frames.size) throw usage(`${key} 没有给出任何时刻`);
  return [...frames].sort((a, b) => a - b);
}
