// 北冥引擎 · 渲染脚本的命令行参数（video.mjs / still.mjs 共用）。
// 只做解析与校验，不碰文件系统和浏览器；出错抛 UsageError（exitCode 2），由脚本打印用法后退出。
//   takeOptions(args, names, { flags })
//                               从 args 里取走 `--名字 值` 形式的选项，返回 { '--名字': 值 }；flags 里的是不带值的开关，取走后记为 true。
//                               不认识的 -- 选项、缺值直接报错；同一选项写两次以后一次为准（npm run x -- --out y）。
//                               --size 由 page.mjs 的 takeSize 先取走，报错信息里一并列出
//   positiveInt(text, name)     正整数（--workers）
//   positiveNumber(text, name)  有限正数（--fps）
//   parseTime(text)             一个时刻（秒）：有限的非负数；拼错的选项、文字不会被当成时刻
//   rangeTimes('a:b:step')      [{ t, label }]：a、a+step、…（≤ b），按整数下标 a + i·step 生成，不累加浮点误差
//   timeLabel(t)                文件名用的时刻：能用两位小数精确表示就写两位（0.50），否则写到能精确表示的位数（0.0416667）

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

export function takeOptions(args, names, { also = ['--size'], flags = [] } = {}) {
  const out = {};
  for (let i = 0; i < args.length;) {
    const a = args[i];
    if (!a.startsWith('--')) { i++; continue; }
    if (flags.includes(a)) { out[a] = true; args.splice(i, 1); continue; }
    if (!names.includes(a)) throw new UsageError(`不认识的选项 ${a}（可用：${[...also, ...names, ...flags].join(' ')}）`);
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`选项 ${a} 缺少取值`);
    out[a] = v;
    args.splice(i, 2);
  }
  return out;
}

export function positiveInt(text, name) {
  const s = String(text).trim();
  if (!/^\d+$/.test(s) || Number(s) < 1 || !Number.isSafeInteger(Number(s))) throw new UsageError(`${name} 必须是正整数（收到 ${text}）`);
  return Number(s);
}

export function positiveNumber(text, name) {
  const s = String(text).trim();
  const v = s === '' ? NaN : Number(s);
  if (!Number.isFinite(v) || v <= 0) throw new UsageError(`${name} 必须是正数（收到 ${text}）`);
  return v;
}

const DECIMAL = /^\+?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function parseTime(text) {
  const s = String(text).trim();
  const v = DECIMAL.test(s) ? Number(s) : NaN;
  if (!Number.isFinite(v)) throw new UsageError(`时刻必须是非负的秒数（收到 ${text}）`);
  return v;
}

export function timeLabel(t) {
  for (let d = 2; d <= 9; d++) {
    const s = t.toFixed(d);
    if (Math.abs(Number(s) - t) <= 1e-9 * Math.max(1, Math.abs(t))) return d === 2 ? s : s.replace(/0+$/, '');
  }
  return t.toFixed(9).replace(/0+$/, '');
}

export function rangeTimes(spec, { max = 100000 } = {}) {
  const parts = String(spec).split(':');
  const bad = why => new UsageError(`--range 要写成 起:止:步长（秒），例如 0:9.5:0.5；${why}（收到 ${spec}）`);
  if (parts.length !== 3 || parts.some(p => !DECIMAL.test(p.trim()))) {
    // 负数、空步长、漏写步长（0:9.5）都落在这里：步长为 0 或负数会死循环，漏写会静默只出一张
    throw bad(parts.length !== 3 ? '必须正好三段' : '三段都要是非负数');
  }
  const [a, b, step] = parts.map(p => Number(p.trim()));
  if (!(step > 0)) throw bad('步长必须大于 0');
  if (b < a) throw bad('止不能小于起');
  const n = Math.floor((b - a) / step + 1e-9) + 1;
  if (n > max) throw bad(`会生成 ${n} 张，超过上限 ${max}`);
  const out = [];
  for (let i = 0; i < n; i++) {
    const raw = a + i * step;
    const label = timeLabel(raw);
    // 标签能精确表示时按标签取值，消掉 0.30000000000000004 这类浮点尾巴；否则按原值渲
    const t = Math.abs(Number(label) - raw) <= 1e-9 * Math.max(1, raw) ? Number(label) : raw;
    out.push({ t, label });
  }
  return out;
}
