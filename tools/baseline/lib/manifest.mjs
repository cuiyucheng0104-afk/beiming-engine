// 北冥仓库 · 金标准清单与审批记录（PNG 不进 git，仓库只存清单）。
//
//   平台清单  tests/golden/<平台键>/manifest.json            schema beiming-golden-platform/v1
//             { schema, platformKey, sets: { <集合>: <集合基线> } }：一个平台一份，含这个平台登记过的全部集合
//   集合基线  schema beiming-golden-manifest/v1（平台清单里的每一项；认可参照的 <平台键>.json 也是这个格式）
//             每帧：id、页面、时刻、尺寸、像素哈希 pixelSha256（规范值）、PNG 字节哈希（只作缓存校验）；
//             另有平台键、设备、渲染器串、浏览器与工具版本、源提交、framesDigest（全部帧的摘要）、approval。
//             status: 'candidate' 的是「待审批候选」（capture --platform 写入，approval 为 null），golden approve 转正前
//             不参与比对，规范检查也不放行
//   审批      tests/golden/approvals.jsonl：一行一条，只追加。每次 update / approve / reference 写一条：
//             谁、为什么、对应提交、前后摘要、改了哪些帧
//   认可参照  docs/style-baselines/<名@v版本>/<平台键>.json（集合基线格式，另有 kind: 'style-reference'、referenceId），冻结后不改
//
//   platformFile(root, pk) / readPlatform(root, pk) / writePlatform(root, pk, doc) / listPlatforms(root)
//   listManifests(root)        → [{ platformKey, set, file, m }]：全部平台清单里的全部集合（含候选）
//   framesDigest(frames)       → sha256（按 id 排序后的「id \t 宽x高 \t 像素哈希」逐行）
//   toBaseline(capture, approval) → 集合基线对象（去掉本机路径）；approval 为 null 时是候选
//   validateManifest(m, { allowCandidate }) / validatePlatform(doc, pk)   → 错误列表（repo-check 规则也用）
//   diffFrames(before, after)  → { added, removed, changed }
//   appendApproval(root, rec) / readApprovals(root)
//   referencePath(root, id, pk) / listReferences(root)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GOLDEN_DIR = 'tests/golden';
export const REFERENCE_DIR = 'docs/style-baselines';
export const APPROVALS = 'tests/golden/approvals.jsonl';
export const PLATFORM_SCHEMA = 'beiming-golden-platform/v1';
export const SET_SCHEMA = 'beiming-golden-manifest/v1';
export const PK_RE = /^(darwin|win|linux)-[a-z0-9]+$/;
export const platformFile = (root, pk) => path.join(root, GOLDEN_DIR, pk, 'manifest.json');
export const platformRel = pk => `${GOLDEN_DIR}/${pk}/manifest.json`;
// 认可参照：docs/style-baselines/<名@v版本>/<平台键>.json（集合基线格式，多 kind: 'style-reference' 与 referenceId）
export const referencePath = (root, id, pk) => path.join(root, REFERENCE_DIR, id, `${pk}.json`);

export function framesDigest(frames) {
  const lines = frames.map(f => `${f.id}\t${f.width}x${f.height}\t${f.pixelSha256}\n`).sort();
  return crypto.createHash('sha256').update(lines.join('')).digest('hex');
}

const FRAME_KEYS = ['id', 'page', 't', 'f', 'w', 'h', 'query', 'clip', 'width', 'height', 'pixelSha256', 'pngSha256', 'bytes'];
const SOURCE_KEYS = ['commit', 'dirty', 'renderedAt', 'capturedAt', 'pixelTree', 'pixelPaths'];
export function toBaseline(cap, approval) {
  const frames = cap.frames.map(f => Object.fromEntries(FRAME_KEYS.filter(k => f[k] !== undefined).map(k => [k, f[k]])));
  const source = Object.fromEntries(SOURCE_KEYS.filter(k => cap.source?.[k] !== undefined).map(k => [k, cap.source[k]]));
  source.dirty = !!source.dirty;
  return {
    schema: SET_SCHEMA,
    set: cap.set, setHash: cap.setHash,
    platformKey: cap.platformKey, device: cap.device, renderer: cap.renderer, browser: cap.browser,
    env: cap.env,
    source,
    capturedAt: cap.capturedAt,
    framesDigest: framesDigest(frames),
    frameCount: frames.length,
    ...(approval ? {} : { status: 'candidate' }),
    approval: approval || null,
    frames,
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
export function validateManifest(m, { allowCandidate = false } = {}) {
  const e = [];
  if (!m || m.schema !== SET_SCHEMA) e.push(`schema 应为 ${SET_SCHEMA}`);
  for (const k of ['set', 'platformKey', 'device', 'renderer', 'browser', 'setHash', 'framesDigest']) if (!m?.[k]) e.push(`缺 ${k}`);
  if (m?.platformKey && !PK_RE.test(m.platformKey)) e.push(`platformKey 写法不对：${m.platformKey}`);
  if (!m?.source?.commit || !/^[0-9a-f]{40}$/.test(m.source.commit)) e.push('source.commit 要是 40 位提交号');
  if (m?.source?.dirty) e.push('基线必须来自已提交的代码（source.dirty 为 true）');
  if (m?.status === 'candidate') {
    if (!allowCandidate) e.push('这是待审批的候选（status=candidate），还没有人审批：审批人看过画面后用 golden approve 转正，或删掉这一项');
    if (m.approval) e.push('候选不能带 approval（转正用 golden approve）');
    if (!HEX64.test(m.source?.pixelTree || '') || !Array.isArray(m.source?.pixelPaths)) e.push('候选要记 source.pixelTree 与 source.pixelPaths（审批时据此核对登记提交的像素路径）');
  } else if (m?.status !== undefined) e.push(`status 只能是 candidate 或不写（现在是 ${JSON.stringify(m.status)}）`);
  else {
    const a = m?.approval;
    if (!a || !a.by || !a.reason || !a.commit || !a.at) e.push('approval 要有 by、reason、commit、at');
  }
  if (!Array.isArray(m?.frames) || !m.frames.length) { e.push('frames 为空'); return e; }
  const ids = new Set();
  for (const f of m.frames) {
    if (!f.id || ids.has(f.id)) e.push(`帧编号重复或为空：${f.id}`);
    ids.add(f.id);
    if (!HEX64.test(f.pixelSha256 || '')) e.push(`${f.id}：pixelSha256 不是 64 位十六进制`);
    if (!(Number.isInteger(f.width) && Number.isInteger(f.height) && f.width > 0 && f.height > 0)) e.push(`${f.id}：缺宽高`);
    if (typeof f.t !== 'number') e.push(`${f.id}：缺时刻 t`);
  }
  if (m.frameCount !== m.frames.length) e.push(`frameCount ${m.frameCount} 与帧数 ${m.frames.length} 不符`);
  if (framesDigest(m.frames) !== m.framesDigest) e.push('framesDigest 与帧列表对不上（清单被手改过？要改基线请走 golden update）');
  return e;
}

export function validatePlatform(doc, pk, { allowCandidate = false } = {}) {
  const e = [];
  if (!doc || doc.schema !== PLATFORM_SCHEMA) e.push(`schema 应为 ${PLATFORM_SCHEMA}`);
  if (doc?.platformKey !== pk) e.push(`放在 ${pk}/ 下，清单里却是 ${doc?.platformKey}`);
  if (!doc?.sets || typeof doc.sets !== 'object' || Array.isArray(doc.sets)) { e.push('sets 要是对象 { <集合>: <集合基线> }'); return e; }
  for (const [s, m] of Object.entries(doc.sets)) {
    for (const x of validateManifest(m, { allowCandidate })) e.push(`${s}：${x}`);
    if (m?.set && m.set !== s) e.push(`${s}：键是 ${s}，内容却是集合 ${m.set}`);
    if (m?.platformKey && m.platformKey !== pk) e.push(`${s}：平台键是 ${m.platformKey}，不属于 ${pk}`);
  }
  return e;
}

export function diffFrames(before, after) {
  const b = new Map((before || []).map(f => [f.id, f])), a = new Map(after.map(f => [f.id, f]));
  return {
    added: [...a.keys()].filter(k => !b.has(k)),
    removed: [...b.keys()].filter(k => !a.has(k)),
    changed: [...a.keys()].filter(k => b.has(k) && b.get(k).pixelSha256 !== a.get(k).pixelSha256),
  };
}

export function readApprovals(root) {
  const f = path.join(root, APPROVALS);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { return { invalid: true, line: i + 1 }; }
  });
}
export function appendApproval(root, rec) {
  const f = path.join(root, APPROVALS);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(rec) + '\n');
}
export function readManifest(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ── 平台清单 ──
export const emptyPlatform = pk => ({ schema: PLATFORM_SCHEMA, platformKey: pk, sets: {} });
/** → 平台清单对象；文件不存在为 null；读不出来抛 Error（由调用方转成 contract 错误）。 */
export function readPlatform(root, pk) {
  const f = platformFile(root, pk);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
export function writePlatform(root, pk, doc) {
  const f = platformFile(root, pk);
  const sets = Object.fromEntries(Object.keys(doc.sets).sort().map(k => [k, doc.sets[k]]));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: PLATFORM_SCHEMA, platformKey: pk, sets }, null, 1) + '\n');
  fs.renameSync(tmp, f);
  return f;
}
export function listPlatforms(root) {
  const dir = path.join(root, GOLDEN_DIR), out = [];
  if (!fs.existsSync(dir)) return out;
  for (const pk of fs.readdirSync(dir).sort()) {
    const f = platformFile(root, pk);
    if (PK_RE.test(pk) && fs.existsSync(f)) out.push({ platformKey: pk, file: f });
  }
  return out;
}
/** 全部平台清单里的全部集合：[{ platformKey, set, file, m }]；读不出来的平台清单给一项 { platformKey, file, error }。 */
export function listManifests(root) {
  const out = [];
  for (const { platformKey, file } of listPlatforms(root)) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { out.push({ platformKey, file, set: null, m: null, error: e.message }); continue; }
    for (const [set, m] of Object.entries(doc?.sets || {})) out.push({ platformKey, set, file, m });
  }
  return out;
}
export function listReferences(root) {
  const dir = path.join(root, REFERENCE_DIR), out = [];
  if (!fs.existsSync(dir)) return out;
  for (const id of fs.readdirSync(dir).sort()) {
    const d = path.join(dir, id);
    if (!/@v\d+$/.test(id) || !fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d).sort()) if (/^(darwin|win|linux)-[a-z0-9]+\.json$/.test(f)) out.push({ id, platformKey: f.slice(0, -5), file: path.join(d, f) });
  }
  return out;
}
