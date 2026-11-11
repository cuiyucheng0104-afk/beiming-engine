// 北冥仓库 · 帧比对：先比像素哈希；不同的帧再解 PNG 算逐像素差、PSNR、SSIM，按容差判定，出差异热图与接触印。
//
//   compareFrames({ ref, cur, tolerance, strict, outDir, log })
//     ref / cur = { frames: [{ id, width, height, pixelSha256, file? }], dir? }   file 相对 dir；参照没有 PNG 时只能比哈希
//     tolerance  集合的 samePlatform 或 crossPlatform 容差（见 metrics.judge）
//     strict     true：任何不是逐像素一致的帧都算失败（像素保护、宣称「逐像素一致」时用）
//   → { ok, summary: { total, identical, within, differs, unverified, missing, extra }, frames: [...], contact }
//   帧状态：identical 逐像素一致 | within 有差异但在容差内 | differs 超出容差 | unverified 哈希不同但拿不到参照像素
//           | missing 参照有、这次没截到 | extra 这次有、参照没有（集合定义变了）
import fs from 'node:fs';
import path from 'node:path';
import { decodePNG, encodePNG } from './png.mjs';
import { compareImages, judge, diffHeatmap, contactSheet } from './metrics.mjs';

export function compareFrames({ ref, cur, tolerance = {}, strict = false, outDir, log = () => {}, maxSheet = 12 }) {
  const R = new Map(ref.frames.map(f => [f.id, f])), C = new Map(cur.frames.map(f => [f.id, f]));
  const ids = [...new Set([...R.keys(), ...C.keys()])].sort();
  const frames = [], sheetRows = [];
  const summary = { total: ids.length, identical: 0, within: 0, differs: 0, unverified: 0, missing: 0, extra: 0 };
  if (outDir) fs.mkdirSync(path.join(outDir, 'diff'), { recursive: true });
  for (const id of ids) {
    const r = R.get(id), c = C.get(id);
    const row = { id, status: null };
    if (!c) { row.status = 'missing'; summary.missing++; frames.push(row); continue; }
    if (!r) { row.status = 'extra'; summary.extra++; frames.push(row); continue; }
    row.pixelSha256 = { ref: r.pixelSha256, cur: c.pixelSha256 };
    if (r.pixelSha256 === c.pixelSha256) { row.status = 'identical'; summary.identical++; frames.push(row); continue; }
    const rp = r.file && ref.dir ? path.join(ref.dir, r.file) : null;
    if (!rp || !fs.existsSync(rp)) { row.status = 'unverified'; summary.unverified++; frames.push(row); continue; }
    const A = decodePNG(fs.readFileSync(rp)), B = decodePNG(fs.readFileSync(path.join(cur.dir, c.file)));
    const stats = compareImages(A, B);
    const v = judge(stats, tolerance);
    row.stats = stats;
    if (stats.identical) { row.status = 'identical'; summary.identical++; frames.push(row); continue; }   // 哈希算法不同但像素相同（不应发生）
    row.status = v.ok && !strict ? 'within' : 'differs';
    if (!v.ok) row.reasons = v.reasons;
    else if (strict) row.reasons = ['--strict：要求逐像素一致'];
    summary[row.status]++;
    if (outDir && !stats.sizeMismatch) {
      const heat = diffHeatmap(A, B);
      const f = path.join('diff', path.basename(c.file));
      fs.writeFileSync(path.join(outDir, f), encodePNG(heat));
      row.diff = f;
      if (row.status === 'differs' && sheetRows.length < maxSheet) sheetRows.push([A, B, heat]);
    }
    frames.push(row);
  }
  let contact = null;
  if (outDir && sheetRows.length) {
    contact = 'contact.png';
    fs.writeFileSync(path.join(outDir, contact), encodePNG(contactSheet(sheetRows, { tileW: 480 })));
    log(`接触印（每行：参照 | 当前 | 差异热图）：${path.join(outDir, contact)}`);
  }
  const ok = summary.differs === 0 && summary.unverified === 0 && summary.missing === 0 && summary.extra === 0;
  return { ok, summary, frames, contact };
}

export function summaryLine(s) {
  const parts = [`${s.identical}/${s.total} 逐像素一致`];
  if (s.within) parts.push(`${s.within} 帧在容差内`);
  if (s.differs) parts.push(`${s.differs} 帧超出容差`);
  if (s.unverified) parts.push(`${s.unverified} 帧哈希不同但没有参照像素`);
  if (s.missing) parts.push(`${s.missing} 帧没截到`);
  if (s.extra) parts.push(`${s.extra} 帧参照里没有`);
  return parts.join('，');
}

export function worstStats(frames) {
  const st = frames.map(f => f.stats).filter(s => s && !s.identical && !s.sizeMismatch);
  if (!st.length) return null;
  return {
    maxDiff: Math.max(...st.map(s => s.maxDiff)),
    maxFracAbove1: Math.max(...st.map(s => s.fracAbove1)),
    maxFracAbove2: Math.max(...st.map(s => s.fracAbove2)),
    minPsnr: Math.min(...st.map(s => s.psnr ?? Infinity)),
    minSsim: Math.min(...st.map(s => s.ssim)),
  };
}
