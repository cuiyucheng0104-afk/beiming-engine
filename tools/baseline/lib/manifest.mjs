// 北冥仓库 · 金标准清单与审批记录（PNG 不进 git，仓库只存清单）。
//
//   清单   tests/golden/manifests/<平台键>/<集合>.json   schema beiming-golden-manifest/v1
//          每帧：id、页面、时刻、尺寸、像素哈希 pixelSha256（规范值）、PNG 字节哈希（只作缓存校验）；
//          另有平台键、设备、渲染器串、浏览器与工具版本、源提交、framesDigest（全部帧的摘要）、approval
//   审批   tests/golden/approvals.jsonl：一行一条，只追加。每次 update 写一条：谁、为什么、对应提交、前后摘要、改了哪些帧
//
//   manifestPath(root, platformKey, set)
//   framesDigest(frames)       → sha256（按 id 排序后的「id \t 宽x高 \t 像素哈希」逐行）
//   toBaseline(capture, approval) → 清单对象（去掉本机路径）
//   validateManifest(m)        → 错误列表（repo-check 规则也用）
//   diffFrames(before, after)  → { added, removed, changed }
//   appendApproval(root, rec) / readApprovals(root)
//   referencePath(root, id, platformKey) / listReferences(root)   认可参照（docs/style-baselines/<名@v版本>/<平台键>.json），冻结后不改
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MANIFEST_DIR = 'tests/golden/manifests';
export const REFERENCE_DIR = 'docs/style-baselines';
export const APPROVALS = 'tests/golden/approvals.jsonl';
export const manifestPath = (root, pk, set) => path.join(root, MANIFEST_DIR, pk, `${set}.json`);
// 认可参照：docs/style-baselines/<名@v版本>/<平台键>.json（同一个 schema，多 kind: 'style-reference' 与 referenceId）
export const referencePath = (root, id, pk) => path.join(root, REFERENCE_DIR, id, `${pk}.json`);

export function framesDigest(frames) {
  const lines = frames.map(f => `${f.id}\t${f.width}x${f.height}\t${f.pixelSha256}\n`).sort();
  return crypto.createHash('sha256').update(lines.join('')).digest('hex');
}

const FRAME_KEYS = ['id', 'page', 't', 'f', 'w', 'h', 'query', 'clip', 'width', 'height', 'pixelSha256', 'pngSha256', 'bytes'];
export function toBaseline(cap, approval) {
  const frames = cap.frames.map(f => Object.fromEntries(FRAME_KEYS.filter(k => f[k] !== undefined).map(k => [k, f[k]])));
  return {
    schema: 'beiming-golden-manifest/v1',
    set: cap.set, setHash: cap.setHash,
    platformKey: cap.platformKey, device: cap.device, renderer: cap.renderer, browser: cap.browser,
    env: cap.env,
    source: { commit: cap.source.commit, dirty: !!cap.source.dirty, ...(cap.source.renderedAt ? { renderedAt: cap.source.renderedAt } : {}) },
    capturedAt: cap.capturedAt,
    framesDigest: framesDigest(frames),
    frameCount: frames.length,
    approval,
    frames,
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
export function validateManifest(m) {
  const e = [];
  if (!m || m.schema !== 'beiming-golden-manifest/v1') e.push('schema 应为 beiming-golden-manifest/v1');
  for (const k of ['set', 'platformKey', 'device', 'renderer', 'browser', 'setHash', 'framesDigest']) if (!m?.[k]) e.push(`缺 ${k}`);
  if (m?.platformKey && !/^(darwin|win|linux)-[a-z0-9]+$/.test(m.platformKey)) e.push(`platformKey 写法不对：${m.platformKey}`);
  if (!m?.source?.commit || !/^[0-9a-f]{40}$/.test(m.source.commit)) e.push('source.commit 要是 40 位提交号');
  if (m?.source?.dirty) e.push('基线必须来自已提交的代码（source.dirty 为 true）');
  const a = m?.approval;
  if (!a || !a.by || !a.reason || !a.commit || !a.at) e.push('approval 要有 by、reason、commit、at');
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
export function listManifests(root) {
  const dir = path.join(root, MANIFEST_DIR), out = [];
  if (!fs.existsSync(dir)) return out;
  for (const pk of fs.readdirSync(dir)) {
    const d = path.join(dir, pk);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) out.push({ platformKey: pk, set: f.slice(0, -5), file: path.join(d, f) });
  }
  return out;
}
export function listReferences(root) {
  const dir = path.join(root, REFERENCE_DIR), out = [];
  if (!fs.existsSync(dir)) return out;
  for (const id of fs.readdirSync(dir)) {
    const d = path.join(dir, id);
    if (!/@v\d+$/.test(id) || !fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) if (/^(darwin|win|linux)-[a-z0-9]+\.json$/.test(f)) out.push({ id, platformKey: f.slice(0, -5), file: path.join(d, f) });
  }
  return out;
}
