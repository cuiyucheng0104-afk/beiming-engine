// baseline.references：认可参照 docs/style-baselines/<名>@v<版本>/ 冻结且成套（CRAFT-10、D05「认可参照单独存放」）：
//   目录名合规；有 README.md；至少一份平台清单 <平台键>.json，且都是这份参照的清单、摘要对得上；
//   同一参照的各平台清单登记同一提交、同一集合定义；
//   有 keyframes.json 时，关键帧图都在、字节哈希与登记一致、解码后的像素与认可参照清单里那一帧逐位相同、单个不超过 5 MiB。
import fs from 'node:fs';
import { decodePNG, pixelSha256 } from '../../../baseline/lib/png.mjs';
import { REFERENCE_DIR, listReferences, validateManifest } from '../../../baseline/lib/manifest.mjs';
import { KEYFRAME_MAX_BYTES, readJsonAbs, sha256 } from './_shared.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]*@v[1-9][0-9]*$/;
const NOT_REFERENCE = new Set(['records']);   // 这些子目录不是认可参照

function checkKeyframes(ctx, id, manifests, out) {
  const relFile = `${REFERENCE_DIR}/${id}/keyframes.json`;
  if (!ctx.exists(relFile)) return;
  let kf;
  try { kf = JSON.parse(ctx.read(relFile)); } catch (e) { out.push({ level: 'error', file: relFile, message: `读不出来（${e.message}）` }); return; }
  if (kf.schema !== 'beiming-style-keyframes/v1' || kf.reference !== id) { out.push({ level: 'error', file: relFile, message: `schema 应为 beiming-style-keyframes/v1、reference 应为 ${id}` }); return; }
  const m = manifests.get(kf.platformKey);
  if (!m) { out.push({ level: 'error', file: relFile, message: `关键帧登记的平台 ${kf.platformKey} 没有认可参照清单 ${id}/${kf.platformKey}.json`, hint: '关键帧只能由 golden keyframes 在已登记的平台上导出' }); return; }
  if (kf.commit !== m.source?.commit) out.push({ level: 'error', file: relFile, message: `关键帧登记的提交 ${String(kf.commit).slice(0, 12)} 不是认可参照的登记提交 ${String(m.source?.commit).slice(0, 12)}` });
  const byId = new Map(m.frames.map(f => [f.id, f]));
  const names = new Set();
  for (const k of Array.isArray(kf.keyframes) ? kf.keyframes : []) {
    const where = `关键帧 ${k?.name}`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(k?.name || '') || names.has(k.name)) { out.push({ level: 'error', file: relFile, message: `${where}：名字要是小写字母、数字、-，且不重复` }); continue; }
    names.add(k.name);
    if (k.file !== `keyframes/${k.name}.png`) { out.push({ level: 'error', file: relFile, message: `${where}：file 应为 keyframes/${k.name}.png` }); continue; }
    const ref = byId.get(k.frame);
    if (!ref) { out.push({ level: 'error', file: relFile, message: `${where}：帧 ${k.frame} 不在认可参照 ${id}（${kf.platformKey}）里` }); continue; }
    if (k.pixelSha256 !== ref.pixelSha256) out.push({ level: 'error', file: relFile, message: `${where}：登记的像素哈希与认可参照清单里 ${k.frame} 的不同` });
    const imgRel = `${REFERENCE_DIR}/${id}/${k.file}`;
    if (!ctx.exists(imgRel)) { out.push({ level: 'error', file: imgRel, message: `${where} 的图不在`, hint: `node tools/baseline/golden.mjs keyframes --reference ${id}` }); continue; }
    const buf = fs.readFileSync(ctx.abs(imgRel));
    if (buf.length > KEYFRAME_MAX_BYTES) out.push({ level: 'error', file: imgRel, message: `${(buf.length / 1048576).toFixed(1)} MiB，超过 5 MiB（D10）` });
    if (sha256(buf) !== k.sha256) out.push({ level: 'error', file: imgRel, message: `文件换了：字节哈希与 keyframes.json 登记的不同`, hint: '认可参照的关键帧冻结不改；误改就 git checkout 还原' });
    let px = null;
    try { px = pixelSha256(decodePNG(buf)); } catch (e) { out.push({ level: 'error', file: imgRel, message: `不是能解码的 PNG（${e.message}）` }); continue; }
    if (px !== ref.pixelSha256) out.push({ level: 'error', file: imgRel, message: `像素与认可参照清单里 ${k.frame} 不一致`, hint: '关键帧必须是登记提交渲出的原样像素；用 golden keyframes 导出' });
  }
}

export default {
  id: 'baseline.references',
  title: '认可参照冻结、成套，关键帧与参照逐像素一致',
  run(ctx) {
    const out = [];
    if (!ctx.isDir(REFERENCE_DIR)) return out;
    const byId = new Map();
    for (const r of listReferences(ctx.root)) { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r); }
    for (const name of fs.readdirSync(ctx.abs(REFERENCE_DIR)).sort()) {
      const relDir = `${REFERENCE_DIR}/${name}`;
      if (!ctx.isDir(relDir) || NOT_REFERENCE.has(name)) continue;
      if (!ID_RE.test(name)) { out.push({ level: 'error', file: relDir, message: `认可参照目录要叫 <名>@v<版本>（现在是 ${name}）`, hint: '规则见 docs/style-baselines/POLICY.md 第 7 节' }); continue; }
      if (!ctx.exists(`${relDir}/README.md`)) out.push({ level: 'error', file: relDir, message: '认可参照缺 README.md（是什么、认可依据与状态、怎么用）' });
      const files = byId.get(name) || [];
      if (!files.length) out.push({ level: 'error', file: relDir, message: '认可参照目录里没有任何平台清单（<平台键>.json）', hint: 'node tools/baseline/golden.mjs reference --set <集合> --id <名>@v<版本> …' });
      const seen = [], manifests = new Map();
      for (const { platformKey, file } of files) {
        const f = ctx.rel(file);
        let m;
        try { m = readJsonAbs(file); } catch (e) { out.push({ level: 'error', file: f, message: `读不出来（${e.message}）` }); continue; }
        for (const e of validateManifest(m)) out.push({ level: 'error', file: f, message: e, hint: '认可参照只能由 golden reference 生成，冻结后不改' });
        if (m.kind !== 'style-reference' || m.referenceId !== name) out.push({ level: 'error', file: f, message: `不是 ${name} 的认可参照清单（kind=${m.kind}，referenceId=${m.referenceId}）` });
        if (m.platformKey !== platformKey) out.push({ level: 'error', file: f, message: `文件名是 ${platformKey}，清单里却是 ${m.platformKey}` });
        seen.push({ platformKey, commit: m.source?.commit, setHash: m.setHash });
        manifests.set(platformKey, m);
      }
      const commits = new Set(seen.map(s => s.commit)), hashes = new Set(seen.map(s => s.setHash));
      if (commits.size > 1 || hashes.size > 1) out.push({ level: 'error', file: relDir, message: `同一个认可参照的各平台清单登记了不同的提交或集合定义：${seen.map(s => `${s.platformKey}@${String(s.commit).slice(0, 12)}`).join('、')}`, hint: '补登记新平台时用同一个提交与同一份集合定义' });
      checkKeyframes(ctx, name, manifests, out);
    }
    return out;
  },
};
