// 片子描述的脚手架、模板与考题的展开，以及写入前的两件小事：
//   candidate：把补丁按路径松散地作用一遍得到「候选片子」，只用来给 L1 出诊断和机器修法（真正的写入一律走 kernel 的 applyFilmWrite）；
//   wholeFilmPatch：整份 film/3.0 换成顶层逐键 set / remove 的补丁，交给 applyFilmWrite（它只收补丁），id、exam、predicates.base 照旧受只读规则管。
import { isDeepStrictEqual as same } from 'node:util';
import { ASSETS, getAsset } from './assets.mjs';

export const TEMPLATES = Object.freeze({
  title: '一个 three 片名镜头（cards-data，overlay.title@1）',
  turntable: 's01 blender 资产转台（cards-data）+ s02 three 片名镜头（cards-data）',
});
export const DEFAULT_OUTPUT = Object.freeze({ size: [1280, 720], fps: '30/1', frames: 60 });
const TITLE_RE = /^[A-Z0-9 .:-]{1,24}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 片名镜头：默认启用入场缓出与微漂移动效（settle-drift），不预置整镜冻结豁免 */
export function titleShot(id, from, to, text, seed, { ink } = {}) {
  return {
    id, in: from, out: to, source: 'three', host: 'page', mode: 'cards-data', colorRef: 'display', seed,
    cards: [{ as: 'title', use: 'overlay.title@1', params: { text, enter: from - 1, settleFrames: Math.min(12, Math.max(2, to - from)), motion: 'settle-drift', heightFrac: Math.min(0.5, 1.78 / text.length), ...(ink ? { ink } : {}) } }],
    roles: { hero: 'title' },
  };
}

/** 两个相机关键帧带着相机绕主体转过一段弧，look 始终绑定同一装配体。 */
export function turntableShot(id, from, to, seed, assets = { kit: 'asset:rtx-card@1' }) {
  const hero = Object.keys(assets)[0];
  const pos = assets[hero] === 'asset:mech-head-proxy@1' ? [0.15, 0.05, 0.58] : [0.09, 0.07, 0.33];
  const keys = [{ f: 0, pos: [-pos[0], pos[1], pos[2]], look: hero },
    { f: to - from - 1, pos, look: hero }];
  return {
    id, in: from, out: to, source: 'blender', host: 'cycles', mode: 'cards-data', colorRef: 'scene', seed, assets,
    cards: [{ as: 'cam', use: 'camera.spline@1', params: { keys } },
      { as: 'cycles', use: 'blender.cycles@1', params: {} }, { as: 'keys', use: 'blender.state-keys@1', params: {} }],
    roles: { hero }, shutter: { angleDeg: 180, samples: 1 }, tiers: { draft: { samples: 16 }, final: { samples: 64 } },
  };
}

/**
 * 建脚手架。opts：id、template（title | turntable）、output、title、text（片名，大写 ASCII）、asset、question（考题，question/0.1）。
 * 交回 { film, files: { 相对路径: 文本 }, assetRef }。predicates.base 由服务器写 floor@1。
 */
export function scaffold({ id, template, output, title, text = template === 'turntable' ? 'RTX' : 'RTX 5090', asset = 'asset:rtx-card@1', question } = {}) {
  if (!TITLE_RE.test(text)) throw Object.assign(new Error('片名只收大写拉丁字母、数字、空格和 - . :，最多 24 个字'), { code: 'contract.bad-value' });
  const kind = template ?? 'title';
  if (!Object.hasOwn(TEMPLATES, kind)) throw Object.assign(new Error(`模板 ${kind} 不认识：只有 ${Object.keys(TEMPLATES).join('、')}`), { code: 'contract.bad-value' });
  if (kind === 'turntable' && !getAsset(asset)) throw Object.assign(new Error(`资产 ${asset} 不在内置资产表里`), { code: 'contract.bad-value' });
  const examAssets = Object.fromEntries(Object.entries(question?.assets ?? {}).map(([alias, source]) => {
    const ref = source === 'calib/mech-head-proxy@1' ? 'asset:mech-head-proxy@1' : source;
    if (!getAsset(ref)) throw Object.assign(new Error(`考题资产 ${alias} 缺少材料，请登记 ${source} 的资产文件`), { code: 'contract.bad-value' });
    return [alias, ref];
  }));
  const hasExamAssets = Object.keys(examAssets).length > 0;
  const deliverable = question?.deliverable;
  const out = {
    size: [...(deliverable?.size ?? output?.size ?? DEFAULT_OUTPUT.size)],
    fps: deliverable?.fps ?? output?.fps ?? DEFAULT_OUTPUT.fps,
    frames: deliverable?.frames ?? output?.frames ?? DEFAULT_OUTPUT.frames,
  };
  if (!out.size.every((v) => Number.isInteger(v) && v > 0 && v % 2 === 0)) throw Object.assign(new Error('output.size 要两个正偶数（像素）'), { code: 'contract.bad-value' });
  if (!Number.isInteger(out.frames) || out.frames < (kind === 'turntable' ? 4 : 2)) throw Object.assign(new Error('output.frames 太少'), { code: 'contract.bad-value' });
  const withAudio = deliverable?.audio !== 'none';
  const files = {};
  let shots, transitions, events;
  if (kind === 'turntable') {
    const cut = Math.floor(out.frames / 2);
    shots = [turntableShot('s01', 0, cut, 1001, hasExamAssets ? examAssets : { kit: asset }), titleShot('s02', cut, out.frames, text, 1002, { ink: '#111318' })];
    transitions = [{ id: 'cut-a', at: cut, type: 'cut' }];
    events = [{ id: 'title', frame: `cut(${cut})`, shot: 's02', ...(withAudio ? { audio: 'hit.low', sync: 'onset' } : {}) }];
  } else if (hasExamAssets) {
    shots = [turntableShot('s01', 0, out.frames, 1001, examAssets)];
    transitions = [];
    events = [];
  } else {
    shots = [titleShot('s01', 0, out.frames, text, 1001)];
    transitions = [];
    events = [{ id: 'title', frame: 0, shot: 's01', ...(withAudio ? { audio: 'hit.low', sync: 'onset' } : {}) }];
  }
  const style = kind === 'turntable'
    ? { view: { scene: 'agx-mhc', display: 'srgb' }, tokens: { ink: '#111318', paper: '#EAE6DF' } }
    : { view: { scene: 'agx-mhc', display: 'srgb' } };
  const film = {
    format: 'film/3.0', id, ...(title ? { title } : {}), ...(question ? { exam: question.id } : {}),
    output: out, ...(hasExamAssets && shots.length === 1 ? { assets: examAssets } : {}), shots, ...(transitions.length ? { transitions } : {}), events,
    style,
    ...(withAudio ? { audio: { mode: 'script', loudness: -14, truePeak: -1 } } : {}),
    predicates: { base: ['floor@1'], extra: [...(question?.basePredicates ?? [])] },
    delivery: { master: 'h264-crf14-bt709', web: true, contact: true },
  };
  if (question) files['exam.json'] = `${JSON.stringify(question, null, 2)}\n`;
  return { film, files, assetRef: kind === 'turntable' ? asset : null };
}

const ADDRESSED = { shots: 'id', transitions: 'id', events: 'id', overlays: 'id', narration: 'id', cards: 'as' };

/** 照路径写法找上一层：{ parent, key }；找不到是 null（只用于候选片子） */
function locate(root, path, create) {
  const segs = path.split('/');
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (!isObj(cur)) return null;
    if (!Object.hasOwn(cur, s)) {
      if (!create) return null;
      cur[s] = {};
    }
    cur = cur[s];
    if (Array.isArray(cur)) {
      if (!Object.hasOwn(ADDRESSED, s) || i + 1 >= segs.length - 1) return { parent: cur, key: segs[i + 1], array: s };
      const want = segs[++i];
      cur = cur.find((x) => isObj(x) && x[ADDRESSED[s]] === want);
    }
  }
  return isObj(cur) || Array.isArray(cur) ? { parent: cur, key: segs[segs.length - 1] } : null;
}

/** 补丁松散地作用到片子的副本上：作用不了的操作跳过。只给 L1 出诊断用，不是写入 */
export function candidate(film, ops) {
  const out = structuredClone(film);
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!isObj(op) || typeof op.path !== 'string') continue;
    const loc = locate(out, op.path, op.op === 'set');
    if (!loc) continue;
    const { parent, key } = loc;
    if (Array.isArray(parent)) {
      if (op.op === 'add' && isObj(op.value)) parent.push(structuredClone(op.value));
      continue;
    }
    if (op.op === 'set') parent[key] = structuredClone(op.value);
    else if (op.op === 'remove') delete parent[key];
    else if (op.op === 'rename' && typeof op.to === 'string' && Object.hasOwn(parent, key)) {
      const entries = Object.entries(parent);
      for (const k of Object.keys(parent)) delete parent[k];
      for (const [k, v] of entries) parent[k === key ? op.to : k] = v;
    } else if (op.op === 'add' && Array.isArray(parent[key]) && isObj(op.value)) parent[key].push(structuredClone(op.value));
  }
  return out;
}

export function hasStoredPath(film, path) {
  const location = locate(film, path, false);
  return location != null && Object.hasOwn(location.parent, location.key);
}


/**
 * 整份片子 → 顶层逐键的补丁（相同的键不写；rev 不是片子的键）。
 * predicates 往下拆一层：只改了 extra 的整份提交不该碰到只读的 predicates/base。
 */
export function wholeFilmPatch(stored, next, rev) {
  const ops = [];
  const body = { ...next };
  delete body.rev;
  const diff = (from, to, prefix) => {
    for (const [k, v] of Object.entries(to)) {
      if (same(from[k], v)) continue;
      if (!prefix && k === 'predicates' && isObj(from[k]) && isObj(v)) diff(from[k], v, 'predicates/');
      else ops.push({ op: 'set', path: `${prefix}${k}`, value: v });
    }
    for (const k of Object.keys(from)) if (!Object.hasOwn(to, k)) ops.push({ op: 'remove', path: `${prefix}${k}` });
  };
  diff(stored, body, '');
  return { format: 'patch/0.1', rev, ops };
}

/**
 * 把机器修法落到补丁的操作上：rename 改写命中的操作的路径（没有操作直接写那个键时，补一条 rename 操作）；
 * set / add / remove 接在后面。交回新的操作数组，不动原来的。
 */
export function fixesIntoOps(ops, fixes) {
  let out = (Array.isArray(ops) ? ops : []).filter((o) => isObj(o) && typeof o.path === 'string').map((o) => ({ ...o }));
  for (const f of fixes) {
    if (f.op !== 'rename') { out.push(fixToOp(f)); continue; }
    const to = [...f.path.split('/').slice(0, -1), f.to].join('/');
    const hit = out.some((o) => o.path === f.path || o.path.startsWith(`${f.path}/`));
    out = out.map((o) => (o.path === f.path || o.path.startsWith(`${f.path}/`) ? { ...o, path: `${to}${o.path.slice(f.path.length)}` } : o));
    if (!hit) out.push(fixToOp(f));
  }
  return out;
}

/** 从内核 applyFilmWrite 的未知键诊断提取可落到本次提交操作上的 rename 修法（正确键已存在时 L1 不会发 rename，这里补上） */
export function unknownKeyFixes(ops, diagnostics) {
  if (!Array.isArray(ops) || !Array.isArray(diagnostics)) return [];
  const fixes = [];
  const seen = new Set();
  for (const d of diagnostics) {
    if (d?.code !== 'contract.unknown-key' || typeof d.at !== 'string' || typeof d.hint !== 'string') continue;
    const m = /是否指\s+([^/#\s]+)$/.exec(d.hint);
    if (!m) continue;
    const to = m[1];
    const target = [...d.at.split('/').slice(0, -1), to].join('/');
    const matched = ops.filter((o) => typeof o?.path === 'string' && (o.path === d.at || o.path.startsWith(`${d.at}/`)));
    if (!matched.length || matched.some((o) => ['id', 'exam', 'predicates', 'predicates/base'].includes(`${target}${o.path.slice(d.at.length)}`))) continue;
    if (seen.has(d.at)) continue;
    seen.add(d.at);
    fixes.push({ op: 'rename', path: d.at, to, applicability: 'machine' });
  }
  return fixes;
}

/** 去掉修法的 applicability，换成补丁操作 */
export const fixToOp = ({ op, path, value, to }) => ({ op, path, ...(op === 'set' || op === 'add' ? { value } : {}), ...(op === 'rename' ? { to } : {}) });

export { ASSETS };
