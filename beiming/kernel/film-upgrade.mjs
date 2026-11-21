// 片子描述升级器：把旧的作品描述（film.json，schemaVersion 2）换成 film/3.0 的片子描述。纯函数，不读文件、不读时钟、不改入参。
//
//   upgradeFilmV2ToV3(v2Film, options) → film/3.0 对象
//   reportFilmUpgrade(v2Film, options) → { film, renamed: { shots, events, cues }, left, notes }
//       renamed 是旧标识到新标识的对照（只列变了的；cues 是打点的名字到它换成的事件 id）；left 是 film/3.0 里没有位置、没带过来的旧字段路径；notes 是换算时取了近似或补了默认值的地方。
//
// 带过来的：片子 id、片名、画幅、帧率、总帧数、镜头区间 [in, out)、切点（每个切点写一条硬切）、事件（帧号、所属镜头、声音名）、
// 节拍表（tempo 或 timeline.sections 的 bpm 和一拍几帧）、按节拍地址写的打点（cues，换成事件）、刻意的静止和黑场（qa.intentional）、
// 声音的模式和响度、路径追踪的种子和采样数、画风令牌、最低谓词 floor@1。
// 镜头条目里 film/3.0 没有对应键的旧字段（module、evaluation、lookPreset、note……）原样放进这个镜头的 params，交给入口文件。
//
// options（都可以不给）：
//   id、title          覆盖片子的 id、片名
//   vars               { 名字: 值 }，替换模版里的 {{名字}} 占位
//   source、host、mode、entry、colorRef   镜头的渲染分派；默认 legacy-page、page、native-code、旧描述的入口文件、display
//   tokens             { 名字: "#RRGGBB" }，画风令牌；不给时取旧描述 style.tokens，再没有就取 styleLock 的色板
//   styleLock          旧描述 style.lock 指的那份画风锁（已经读成对象），取它 palette.colors 的 id 和 hex
//   sceneView          场景参考镜头用的查找表名，默认 agx-mhc
//   master             母版的编码预设，默认 h264-crf14-bt709
//   predicatesBase     predicates.base，默认 ["floor@1"]
// 升级不了的输入（不是 schemaVersion 2、镜头区间不衔接、事件落在片子或镜头之外、标识换不成合法写法）抛 FilmUpgradeError，不交半截结果。

const FILM_ID = /^[a-z][a-z0-9_-]*$/;
const FREE_KEY = /^[^/#\s]+$/;
const ENTRY = /^(?!\/)(?![\s\S]*(^|\/)\.\.(\/|$))[^\\:]+$/;
const AUDIO_NAME = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
const LUT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const BASE_REF = /^(floor|template:[a-z][a-z0-9-]*)@[1-9][0-9]*$/;
const SOURCE = /^(blender|three|core|legacy-page)$/;
const AUDIO_MODES = { script: 'script', wav: 'track', native: 'track', none: 'none' };
const SYNCS = ['onset', 'pcenter'];
const DELIBERATE = { intentional: null, holds: 'freeze', blackouts: 'black' };
const MAX_SEED = 4294967295;
// 帧号取整的容差，单位帧：FRAME_EPS 只吸收 秒 × 帧率 的浮点误差；CUE_FRAME_TOL 是旧校验器判「打点落在整帧上」用的
const FRAME_EPS = 1e-6;
const CUE_FRAME_TOL = 1e-4;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const nonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isSeed = (v) => nonNegInt(v) && v <= MAX_SEED;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

export class FilmUpgradeError extends Error {
  /** code 是 film-upgrade.<原因>；at 是旧描述里出问题的字段路径 */
  constructor(code, at, message) {
    super(`${at}：${message}`);
    this.name = 'FilmUpgradeError';
    this.code = `film-upgrade.${code}`;
    this.at = at;
  }
}
const fail = (code, at, message) => { throw new FilmUpgradeError(code, at, message); };

/** 把 {{名字}} 换成 vars 里的值；vars 里没有的占位原样留着 */
function fill(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{\s*([^{}\s]*)\s*\}\}/g, (all, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : all));
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

/** 旧标识换成 film/3.0 的写法：小写，不合法的字符换成连字符，不以字母开头就补前缀。换不出来返回 null */
function toId(raw, { prefix, underscore = false }) {
  if (typeof raw !== 'string') return null;
  const bad = underscore ? /[^a-z0-9_-]+/g : /[^a-z0-9-]+/g;
  const core = raw.toLowerCase().replace(bad, '-').replace(/^-+|-+$/g, '');
  if (!core) return null;
  return /^[a-z]/.test(core) ? core : `${prefix}-${core}`;
}

/** 一组旧标识逐个换写法；换完撞名的往后加 -2、-3。返回新标识的数组，renamed（Map）里记下变了的 */
function mapIds(raws, { prefix, at, taken = new Set(), reserved = [], renamed }) {
  return raws.map((raw, i) => {
    const base = toId(raw, { prefix });
    if (base === null) fail('bad-id', `${at}[${i}]`, `标识 ${JSON.stringify(raw)} 换不成 film/3.0 的写法（小写字母、数字、连字符，以小写字母开头）`);
    if (raws.indexOf(raw) !== i) fail('bad-id', `${at}[${i}]`, `标识 ${JSON.stringify(raw)} 在旧描述里重复`);
    const stem = reserved.includes(base) ? `${prefix}-${base}` : base;
    let id = stem;
    for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
    taken.add(id);
    if (id !== raw) renamed.set(raw, id);
    return id;
  });
}

/** 帧率换成 "<分子>/<分母>"，约到最简。收正整数、正的小数（23.976 这类按 x000/1001 认）和 "a/b" 字符串 */
function toFps(v, at) {
  let num, den;
  const frac = typeof v === 'string' ? /^([1-9]\d*)\/([1-9]\d*)$/.exec(v.trim()) : null;
  if (frac) [num, den] = [Number(frac[1]), Number(frac[2])];
  else {
    const x = typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
    if (!(typeof x === 'number' && Number.isFinite(x) && x > 0)) fail('bad-fps', at, `帧率 ${JSON.stringify(v)} 不是正数`);
    const ntsc = Math.round(x * 1.001);
    if (Number.isInteger(x)) [num, den] = [x, 1];
    else if (ntsc >= 1 && Math.abs(x - ntsc * 1000 / 1001) < 5e-3) [num, den] = [ntsc * 1000, 1001];
    else [num, den] = [Math.round(x * 1e6), 1e6];
    if (num < 1) fail('bad-fps', at, `帧率 ${JSON.stringify(v)} 太小，换不成正整数比`);
  }
  const g = gcd(num, den);
  return { text: `${num / g}/${den / g}`, value: num / den };
}

/** 色值换成 #RRGGBB 大写；不是六位或三位十六进制就返回 null */
function toColor(v) {
  const m = typeof v === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim()) : null;
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${hex.toUpperCase()}`;
}

/** obj 里不在 carried 里的键，写成路径 */
const leftover = (obj, carried, prefix) => (isObj(obj) ? Object.keys(obj).filter((k) => !carried.includes(k)).map((k) => (prefix ? `${prefix}/${k}` : k)) : []);

function outputOf(v2, notes) {
  const o = isObj(v2.output) ? v2.output : {};
  const width = o.width ?? v2.size?.[0];
  const height = o.height ?? v2.size?.[1];
  if (!posInt(width) || !posInt(height)) fail('bad-size', 'output', `画幅 ${JSON.stringify([width, height])} 不是两个正整数`);
  const fps = toFps(o.fps ?? v2.fps, 'output.fps');
  let frames = o.frameCount;
  if (frames === undefined && typeof v2.dur === 'number') {
    frames = Math.round(v2.dur * fps.value);
    if (Math.abs(frames - v2.dur * fps.value) > FRAME_EPS) fail('bad-frames', 'dur', `时长 ${v2.dur} 秒在 ${fps.text} 帧每秒下不是整数帧`);
    notes.push(`output.frames 取自旧描述的 dur × fps = ${frames}`);
  }
  if (!posInt(frames)) fail('bad-frames', 'output.frameCount', `总帧数 ${JSON.stringify(frames)} 不是正整数`);
  return { output: { size: [width, height], fps: fps.text, frames }, fpsValue: fps.value };
}

/** 镜头区间必须从 0 起、首尾相接、到总帧数为止（D1）；旧描述没有镜头表时整片算一个镜头 */
function shotSpans(v2, frames, renamed, notes) {
  if (v2.shots !== undefined && !Array.isArray(v2.shots)) fail('bad-timeline', 'shots', 'shots 不是数组');
  if (!v2.shots?.length) {
    notes.push(`旧描述没有镜头表，整片写成一个镜头 s01 [0, ${frames})`);
    return [{ id: 's01', in: 0, out: frames, old: {} }];
  }
  v2.shots.forEach((s, i) => { if (!isObj(s)) fail('bad-timeline', `shots[${i}]`, '镜头条目不是对象'); });
  const ids = mapIds(v2.shots.map((s) => s.id), { prefix: 's', at: 'shots', reserved: ['film'], renamed });
  let expect = 0;
  v2.shots.forEach((s, i) => {
    if (!nonNegInt(s.in) || !posInt(s.out) || s.out <= s.in) fail('bad-timeline', `shots[${i}]`, `镜头 ${s.id} 的区间 [${s.in}, ${s.out}) 不是 in < out 的整数帧`);
    if (s.in !== expect) fail('bad-timeline', `shots[${i}].in`, `镜头 ${s.id} 的 in 是 ${s.in}，应该接着前面的 ${expect}`);
    expect = s.out;
  });
  if (expect !== frames) fail('bad-timeline', 'shots', `最后一个镜头的 out 是 ${expect}，总帧数是 ${frames}`);
  return v2.shots.map((s, i) => ({ id: ids[i], in: s.in, out: s.out, old: s }));
}

/** 节拍表：tempo（段落起点写秒）和 timeline.sections（段落起点写帧）是同一份表的两种写法，统一成 [{ id, t0 秒, bpm, meter }] */
function tempoSections(v2, fpsValue) {
  const raw = Array.isArray(v2.tempo) ? v2.tempo
    : Array.isArray(v2.timeline?.sections) ? v2.timeline.sections.filter(isObj).map((s) => ({ ...s, t0: nonNegInt(s.start) ? s.start / fpsValue : undefined }))
      : [];
  return raw.filter((s) => isObj(s) && typeof s.t0 === 'number' && Number.isFinite(s.t0) && typeof s.bpm === 'number' && s.bpm > 0);
}

function timelineOf(sections, fpsValue, notes) {
  if (!sections.length) return null;
  const bpms = [...new Set(sections.map((s) => s.bpm))];
  if (bpms.length > 1) {
    notes.push(`旧节拍表有 ${bpms.length} 种速度（${bpms.join('、')}），film/3.0 的 timeline 只能写一个，没有写；打点的帧号已经照各段速度算进事件`);
    return null;
  }
  const beatFrames = fpsValue * 60 / bpms[0];
  const whole = Math.abs(beatFrames - Math.round(beatFrames)) < FRAME_EPS;
  if (!whole) notes.push(`一拍是 ${beatFrames} 帧，不是整数，timeline.beatFrames 没有写`);
  return { bpm: bpms[0], ...(whole ? { beatFrames: Math.round(beatFrames) } : {}) };
}

/** cues 的一项 [段落, 小节, 拍, 拍内分数] 换成帧号，照旧校验器的算法：秒数按六位小数取整，乘帧率，离整帧不超过 CUE_FRAME_TOL 就取那个整帧 */
function cueFrame(sections, name, addr, fpsValue, notes) {
  const at = `cues.${name}`;
  if (!Array.isArray(addr) || addr.length < 2) fail('bad-cue', at, '打点地址不是 [段落, 小节, 拍, 拍内分数]');
  const [sec, bar, beat = 1, frac = 0] = addr;
  const s = sections.find((x) => x.id === sec);
  if (!s) fail('bad-cue', at, `节拍表里没有段落 ${JSON.stringify(sec)}`);
  const meter = s.meter ?? 4;
  if (![bar, beat, frac, meter].every((n) => typeof n === 'number' && Number.isFinite(n))) fail('bad-cue', at, '小节、拍、拍内分数必须是数');
  const x = Number((s.t0 + ((bar - 1) * meter + (beat - 1) + frac) * 60 / s.bpm).toFixed(6)) * fpsValue;
  if (Math.abs(x - Math.round(x)) <= CUE_FRAME_TOL) return Math.round(x);
  notes.push(`打点 ${name} 落在第 ${Number(x.toFixed(3))} 帧，不是整帧，取了它所在的第 ${Math.floor(x)} 帧`);
  return Math.floor(x);
}

function eventsOf(v2, shots, shotRenamed, frames, sections, fpsValue, renamed, cueRenamed, left, notes) {
  if (v2.events !== undefined && !Array.isArray(v2.events)) fail('bad-event', 'events', 'events 不是数组');
  const olds = v2.events ?? [];
  olds.forEach((e, i) => { if (!isObj(e)) fail('bad-event', `events[${i}]`, '事件条目不是对象'); });
  const taken = new Set();
  const ids = mapIds(olds.map((e) => e.id), { prefix: 'e', at: 'events', taken, renamed });
  const out = olds.map((e, i) => {
    const at = `events[${i}]`;
    if (!nonNegInt(e.frame) || e.frame >= frames) fail('bad-event', `${at}.frame`, `事件 ${e.id} 的帧号 ${JSON.stringify(e.frame)} 不在 [0, ${frames}) 内`);
    const ev = { id: ids[i], frame: e.frame };
    if (e.shot !== undefined) {
      const shot = shots.find((s) => s.id === (shotRenamed.get(e.shot) ?? e.shot));
      if (!shot) fail('bad-event', `${at}.shot`, `事件 ${e.id} 的镜头 ${JSON.stringify(e.shot)} 不在镜头表里`);
      if (e.frame < shot.in || e.frame >= shot.out) fail('bad-event', `${at}.frame`, `事件 ${e.id} 在第 ${e.frame} 帧，不在镜头 ${e.shot} 的 [${shot.in}, ${shot.out}) 内`);
      ev.shot = shot.id;
    }
    const carried = ['id', 'frame', 'shot'];
    if (typeof e.audio === 'string') {
      const name = AUDIO_NAME.test(e.audio) ? e.audio : e.audio.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
      if (AUDIO_NAME.test(name)) {
        ev.audio = name;
        carried.push('audio');
        if (name !== e.audio) notes.push(`事件 ${e.id} 的声音名 ${JSON.stringify(e.audio)} 改写成 ${name}`);
      }
    }
    if (SYNCS.includes(e.sync)) { ev.sync = e.sync; carried.push('sync'); }
    left.push(...leftover(e, carried, `events/${e.id}`));
    return ev;
  });
  // 按节拍地址写的打点没有声音名和所属镜头，只带名字和帧号
  const cues = isObj(v2.cues) ? Object.entries(v2.cues) : [];
  if (cues.length && !sections.length) fail('bad-cue', 'cues', '有打点却没有能用的节拍表（tempo 或 timeline.sections）');
  const cueIds = mapIds(cues.map(([name]) => name), { prefix: 'e', at: 'cues', taken, renamed: cueRenamed });
  cues.forEach(([name, addr], i) => {
    const frame = cueFrame(sections, name, addr, fpsValue, notes);
    if (!(frame >= 0 && frame < frames)) fail('bad-cue', `cues.${name}`, `打点落在第 ${frame} 帧，不在 [0, ${frames}) 内`);
    out.push({ id: cueIds[i], frame });
  });
  return out;
}

/** 刻意的静止和黑场：一段跨了几个镜头就按镜头切开，每个镜头各记自己那一截（D19） */
function deliberateOf(v2, shots, left) {
  const qa = isObj(v2.qa) ? v2.qa : {};
  const byShot = new Map(shots.map((s) => [s.id, []]));
  for (const [list, alias] of Object.entries(DELIBERATE)) {
    (Array.isArray(qa[list]) ? qa[list] : []).forEach((it, i) => {
      const kind = it?.kind ?? alias;
      const from = it?.from ?? it?.in;
      const to = it?.to ?? it?.out;
      if (!['freeze', 'black'].includes(kind) || !nonNegInt(from) || !posInt(to) || from >= to || to > shots.at(-1).out) { left.push(`qa/${list}/${i}`); return; }
      const why = isStr(it.reason) ? it.reason : `旧描述 qa.${list} 第 ${i} 项声明的${kind === 'freeze' ? '静止' : '黑场'}`;
      for (const s of shots) {
        const [a, b] = [Math.max(from, s.in), Math.min(to, s.out)];
        if (a < b) byShot.get(s.id).push({ kind, in: a, out: b, why });
      }
    });
  }
  left.push(...leftover(qa, Object.keys(DELIBERATE), 'qa'));
  return byShot;
}

function dispatchOf(v2, options) {
  const source = options.source ?? 'legacy-page';
  if (!SOURCE.test(source)) fail('bad-option', 'options.source', `帧源 ${JSON.stringify(source)} 不是 blender、three、core、legacy-page 之一`);
  const host = options.host ?? 'page';
  const mode = options.mode ?? 'native-code';
  if (!isStr(host)) fail('bad-option', 'options.host', '宿主必须是不空的字符串');
  if (!['cards-data', 'build-script', 'native-code'].includes(mode)) fail('bad-option', 'options.mode', `作者模式 ${JSON.stringify(mode)} 不认识`);
  const colorRef = options.colorRef ?? 'display';
  if (!['scene', 'display'].includes(colorRef)) fail('bad-option', 'options.colorRef', 'colorRef 只能是 scene 或 display');
  if (mode === 'cards-data') return { source, host, mode, colorRef };
  // 旧描述不写入口文件时的默认值，照旧校验器的规则
  const byRoute = v2.route === 'b' ? (v2.native?.entry ?? 'film.tsx') : v2.route === 'd' ? 'scene.ts' : v2.backend === 'webgpu' ? 'offscreen.mjs' : 'index.html';
  const entry = options.entry ?? v2.entry ?? byRoute;
  if (typeof entry !== 'string' || !ENTRY.test(entry)) fail('bad-entry', options.entry === undefined ? 'entry' : 'options.entry', `入口文件 ${JSON.stringify(entry)} 不是片子目录里的相对路径`);
  return { source, host, mode, entry, colorRef };
}

function tokensOf(v2, options, notes) {
  const given = options.tokens ?? (isObj(v2.style?.tokens) ? v2.style.tokens : null);
  const fromLock = Array.isArray(options.styleLock?.palette?.colors) ? Object.fromEntries(options.styleLock.palette.colors.filter(isObj).map((c) => [c.id, c.hex])) : null;
  const raw = given ?? fromLock;
  if (!isObj(raw)) return null;
  const where = options.tokens ? 'options.tokens' : given ? 'style.tokens' : 'options.styleLock.palette.colors';
  const out = [];
  for (const [name, value] of Object.entries(raw)) {
    const color = toColor(value);
    if (!FREE_KEY.test(name) || color === null) {
      if (options.tokens) fail('bad-option', `options.tokens.${name}`, `令牌 ${JSON.stringify(name)}: ${JSON.stringify(value)} 不是自由键加 #RRGGBB 色值`);
      notes.push(`${where} 的 ${JSON.stringify(name)}: ${JSON.stringify(value)} 不是颜色令牌，没有带过来`);
    } else out.push([name, color]);
  }
  return out.length ? Object.fromEntries(out) : null;
}

function audioOf(v2, left, notes) {
  if (!isObj(v2.audio)) return null;
  const a = v2.audio;
  const out = {};
  const carried = [];
  if (Object.hasOwn(AUDIO_MODES, a.mode)) {
    out.mode = AUDIO_MODES[a.mode];
    carried.push('mode');
    if (out.mode !== a.mode) notes.push(`audio.mode 的 ${a.mode} 写成 ${out.mode}（给一条现成音轨去对位）`);
  }
  if (typeof a.targetLUFS === 'number' && Number.isFinite(a.targetLUFS)) { out.loudness = a.targetLUFS; carried.push('targetLUFS'); }
  if (typeof a.truePeakDbTP === 'number' && Number.isFinite(a.truePeakDbTP)) { out.truePeak = a.truePeakDbTP; carried.push('truePeakDbTP'); }
  left.push(...leftover(a, carried, 'audio'));
  return out;
}

/** 路径追踪的每像素采样数写进档位：正片的进 final，动态预演的进 draft；某个镜头单独写了的用它自己的 */
function tiersOf(v2, oldShotId) {
  const p = isObj(v2.pathtrace) ? v2.pathtrace : {};
  const final = isObj(p.shotSpp) && posInt(p.shotSpp[oldShotId]) ? p.shotSpp[oldShotId] : p.spp;
  const tiers = { ...(posInt(p.animaticSpp) ? { draft: { samples: p.animaticSpp } } : {}), ...(posInt(final) ? { final: { samples: final } } : {}) };
  return Object.keys(tiers).length ? tiers : null;
}

/** 镜头的 params：旧镜头条目里 film/3.0 没有对应键的字段原样带着，再加全片的路线、后端和路径追踪剩下的设置，给入口文件读 */
function shotParams(v2, old, left) {
  const params = new Map();
  for (const key of ['route', 'backend']) if (v2[key] !== undefined) params.set(key, v2[key]);
  if (isObj(v2.pathtrace)) {
    const rest = Object.entries(v2.pathtrace).filter(([k, v]) => !(['spp', 'animaticSpp', 'shotSpp'].includes(k) || (k === 'seed' && isSeed(v))));
    if (rest.length) params.set('pathtrace', Object.fromEntries(rest));
  }
  for (const [key, value] of Object.entries(old)) {
    if (['id', 'in', 'out'].includes(key)) continue;
    if (FREE_KEY.test(key)) params.set(key, value);
    else left.push(`shots/${old.id}/${key}`);
  }
  return params.size ? structuredClone(Object.fromEntries(params)) : null;
}

export function reportFilmUpgrade(v2Film, options = {}) {
  if (!isObj(v2Film)) fail('not-v2', '根', '旧描述不是对象');
  if (v2Film.schemaVersion !== 2) fail('not-v2', 'schemaVersion', `只收 schemaVersion 是 2 的作品描述，收到 ${JSON.stringify(v2Film.schemaVersion)}`);
  if (!isObj(options)) fail('bad-option', 'options', 'options 不是对象');
  const v2 = isObj(options.vars) ? fill(v2Film, options.vars) : v2Film;
  const notes = [];
  const left = [];
  const renamed = { shots: new Map(), events: new Map(), cues: new Map() };

  const rawId = options.id ?? v2.id;
  const id = typeof rawId === 'string' && FILM_ID.test(rawId) ? rawId : toId(rawId, { prefix: 'f', underscore: true });
  if (id === null) fail('bad-id', 'id', `片子的 id ${JSON.stringify(rawId)} 换不成 film/3.0 的写法；用 options.id 给一个`);
  if (id !== rawId) notes.push(`片子的 id ${JSON.stringify(rawId)} 不合 film/3.0 的写法，改写成 ${id}；要别的值用 options.id 或 options.vars 给`);
  const title = options.title ?? v2.title;

  const { output, fpsValue } = outputOf(v2, notes);
  const spans = shotSpans(v2, output.frames, renamed.shots, notes);
  const sections = tempoSections(v2, fpsValue);
  const timeline = timelineOf(sections, fpsValue, notes);
  const events = eventsOf(v2, spans, renamed.shots, output.frames, sections, fpsValue, renamed.events, renamed.cues, left, notes);
  const deliberate = deliberateOf(v2, spans, left);
  const dispatch = dispatchOf(v2, options);
  const { colorRef, ...render } = dispatch;

  const shots = spans.map((s) => {
    const params = shotParams(v2, s.old, left);
    const tiers = tiersOf(v2, s.old.id);
    const kept = deliberate.get(s.id);
    return { id: s.id, in: s.in, out: s.out, ...render, colorRef, ...(params ? { params } : {}), ...(tiers ? { tiers } : {}), ...(kept.length ? { deliberate: kept } : {}) };
  });
  for (const s of spans.slice(1)) {
    if (s.old.transition !== undefined && s.old.transition !== 'cut') notes.push(`镜头 ${s.old.id} 的转场 ${JSON.stringify(s.old.transition)} 在 film/3.0 里只能写成硬切；原值留在这个镜头的 params.transition`);
  }
  const transitions = spans.slice(1).map((s) => ({ id: `cut-${s.in}`, at: s.in, type: 'cut' }));

  const sceneView = options.sceneView ?? 'agx-mhc';
  if (typeof sceneView !== 'string' || !LUT_NAME.test(sceneView)) fail('bad-option', 'options.sceneView', `查找表名 ${JSON.stringify(sceneView)} 不合写法`);
  if (options.sceneView === undefined) notes.push('style.view.scene 旧描述里没有，补了默认的 agx-mhc');
  const tokens = tokensOf(v2, options, notes);
  const master = options.master ?? 'h264-crf14-bt709';
  if (typeof master !== 'string' || !LUT_NAME.test(master)) fail('bad-option', 'options.master', `编码预设 ${JSON.stringify(master)} 不合写法`);
  if (options.master === undefined) notes.push('delivery.master 旧描述里没有（旧描述写的是交付档位），补了默认的 h264-crf14-bt709');
  const base = options.predicatesBase ?? ['floor@1'];
  if (!Array.isArray(base) || new Set(base).size !== base.length || !base.every((b) => typeof b === 'string' && BASE_REF.test(b))) fail('bad-option', 'options.predicatesBase', 'predicates.base 的每一项是 floor@<主版本> 或 template:<模板名>@<主版本>，不重复');
  const web = Array.isArray(v2.deliveries) && v2.deliveries.some((d) => typeof d === 'string' && d.startsWith('web-'));
  const seed = v2.pathtrace?.seed;
  const audio = audioOf(v2, left, notes);

  left.push(...leftover(v2.output, ['width', 'height', 'fps', 'frameCount'], 'output'));
  left.push(...leftover(v2.style, isObj(v2.style?.tokens) && !options.tokens ? ['tokens'] : [], 'style'));
  left.push(...leftover(v2.timeline, ['sections'], 'timeline'));
  // 顶层：这些键要么整个带过来了，要么上面已经逐项记过剩下的
  left.push(...leftover(v2, ['schemaVersion', 'id', 'title', 'route', 'backend', 'entry', 'output', 'dur', 'fps', 'size', 'shots', 'events', 'tempo', 'cues', 'timeline', 'audio', 'style', 'pathtrace', 'qa'], ''));
  if (v2.shots?.length && v2.entry === undefined && dispatch.entry !== undefined && options.entry === undefined) notes.push(`旧描述没写入口文件，照旧规则取默认的 ${dispatch.entry}`);

  const film = {
    format: 'film/3.0',
    id,
    ...(isSeed(seed) ? { seed } : {}),
    ...(isStr(title) ? { title } : {}),
    output,
    ...(timeline ? { timeline } : {}),
    shots,
    ...(transitions.length ? { transitions } : {}),
    ...(events.length ? { events } : {}),
    style: { ...(tokens ? { tokens } : {}), view: { scene: sceneView, display: 'srgb' } },
    ...(audio ? { audio } : {}),
    predicates: { base: [...base] },
    delivery: { master, ...(web ? { web: true } : {}) },
  };
  return { film, renamed: Object.fromEntries(Object.entries(renamed).map(([k, m]) => [k, Object.fromEntries(m)])), left: [...new Set(left)].sort(), notes };
}

export function upgradeFilmV2ToV3(v2Film, options = {}) {
  return reportFilmUpgrade(v2Film, options).film;
}
