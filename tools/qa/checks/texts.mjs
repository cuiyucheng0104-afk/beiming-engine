// 北冥 QA · texts：画面文字。打开作品页面，逐帧 render(t) 后读 window.TEXTS(t)（附录 C5：[{ text, box:[x,y,w,h], alpha, font }]；
// 也接受现有的 { id, text, x0, y0, x1, y1 }），并用探针记下同一帧里每次画字的字体与实际不透明度：
//   inframe    方框完整在画内
//   safe-area  方框在图文安全区内（档位 safeArea.title，16:9 为 EBU R95 每边 5%）
//   duration   不透明度 ≥ opaqueAlpha 的连续停留 ≥ max(minHoldSec, 字数×perUnitSec)（硬门）；导演规范的 字数÷4.5＋1.5 秒为软项
//   contrast   选每条文字最不透明的一帧，开、关文字各截一张无损图：差别大的像素是字，其余是背景；相对亮度对比 < 3:1 硬失败，< 4.5:1 软项
//   glyphs     每个字按 CSS 字体匹配规则逐家族查 cmap：落到系统字体（含 sans-serif 等通用族）即失败；字体没加载完也算失败
// 页面没有 TEXTS 时，用探针记下的画字调用与 DOM 文字代替（「推导模式」，停留时长只给软项）。
//
//   runTexts({ pageDir, profile, film, step, readyTimeoutMs, contrast, timeoutMs, root }) → { checks, warnings, summary }
import fs from 'node:fs';
import path from 'node:path';
import { makeCheck, finding, settle, notRun } from '../lib/checks.mjs';
import { openPage, sampleFrames, fontInventory, screenshotSet } from '../lib/page.mjs';
import { parseFont, parseUnicodeRange, inRanges } from '../lib/font.mjs';
import { decodePng } from '../lib/png.mjs';
import { fpsOf, REPO_ROOT } from '../lib/profiles.mjs';

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);
const CJK = /[⺀-⿟぀-ヿ㄀-ㄯ㆐-ㇿ㐀-䶿一-鿿가-힯豈-﫿\u{20000}-\u{3134F}]/u;
const SKIP_CP = cp => cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff;

// 读字单位：一个汉字（及假名、谚文）算 1，一串连续的拉丁字母或数字算 1，标点不算
export function readingUnits(text) {
  let n = 0;
  for (const ch of String(text)) if (CJK.test(ch)) n++;
  n += (String(text).match(/[A-Za-z0-9À-ɏ]+/g) || []).length;
  return Math.max(1, n);
}

// CSS font 简写 → { style, weight, families }
export function parseFontSpec(spec) {
  const s = String(spec || '').trim();
  const m = /^(.*?)(\d*\.?\d+)(px|pt|em|rem|%|vh|vw)(?:\s*\/\s*\S+)?\s+(.+)$/.exec(s);
  if (!m) return { style: 'normal', weight: 400, families: s ? s.split(',').map(f => f.trim().replace(/^["']|["']$/g, '')) : [] };
  const pre = m[1].trim().split(/\s+/).filter(Boolean);
  let style = 'normal', weight = 400;
  for (const t of pre) {
    if (/^(italic|oblique)$/i.test(t)) style = 'italic';
    else if (/^bold$/i.test(t)) weight = 700;
    else if (/^bolder$/i.test(t)) weight = 700;
    else if (/^lighter$/i.test(t)) weight = 300;
    else if (/^\d{3}$/.test(t)) weight = +t;
  }
  const families = [];
  let cur = '', q = null;
  for (const ch of m[4]) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ',') { families.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) families.push(cur.trim());
  return { style, weight, families };
}
const famKey = f => String(f || '').trim().replace(/^["']|["']$/g, '').toLowerCase();

function weightRange(w) {
  const parts = String(w ?? '400').trim().split(/\s+/).map(x => (x === 'normal' ? 400 : x === 'bold' ? 700 : +x)).filter(Number.isFinite);
  return parts.length ? [Math.min(...parts), Math.max(...parts)] : [400, 400];
}
// CSS Fonts 4 §5.2 的字重匹配：先找含目标字重的；否则按规定的方向找最近的
function pickFaces(faces, weight, style) {
  const st = faces.filter(f => (f.style === 'normal') === (style === 'normal'));
  const pool = st.length ? st : faces;
  const near = f => Math.min(Math.max(weight, f.range[0]), f.range[1]);
  const rank = p => {
    if (p === weight) return 0;
    if (weight >= 400 && weight <= 500) return p > weight && p <= 500 ? 1000 + p : p < weight ? 3000 - p : 5000 + p;
    if (weight < 400) return p < weight ? 1000 - p : 3000 + p;
    return p > weight ? 1000 + p : 3000 - p;
  };
  let best = Infinity;
  for (const f of pool) best = Math.min(best, rank(near(f)));
  return pool.filter(f => rank(near(f)) === best);
}

function normalizeItem(t, W, H) {
  if (!t || typeof t !== 'object') return null;
  const text = t.text == null ? '' : String(t.text);
  let box = null;
  if (Array.isArray(t.box) && t.box.length === 4 && t.box.every(Number.isFinite)) box = [t.box[0], t.box[1], t.box[0] + t.box[2], t.box[1] + t.box[3]];
  else if ([t.x0, t.y0, t.x1, t.y1].every(Number.isFinite)) box = [t.x0, t.y0, t.x1, t.y1];
  if (!box) return { bad: true, text };
  return { id: t.id != null ? String(t.id) : text, text, box, alpha: Number.isFinite(t.alpha) ? t.alpha : null, font: typeof t.font === 'string' ? t.font : null, W, H };
}
const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const area = b => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

function loadFaceBytes(face, origin, root) {
  if (face.bin) return Buffer.from(face.bin, 'base64');
  const src = face.src || '';
  if (/^\s*local\(/i.test(src) && !/url\(/i.test(src)) return { local: true };
  const m = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(src);
  if (!m) return null;
  let u;
  try { u = new URL(m[2], face.base || origin + '/'); } catch { return null; }
  if (u.protocol === 'data:') {
    const i = u.href.indexOf(',');
    return /;base64/i.test(u.href.slice(0, i)) ? Buffer.from(decodeURIComponent(u.href.slice(i + 1)), 'base64') : Buffer.from(decodeURIComponent(u.href.slice(i + 1)), 'latin1');
  }
  if (u.origin !== origin) return { external: u.href };
  const file = path.join(root, decodeURIComponent(u.pathname));
  if (!file.startsWith(path.resolve(root)) || !fs.existsSync(file)) return { missing: u.pathname };
  return fs.readFileSync(file);
}

const lin = v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (d, i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const pctl = (arr, p) => { if (!arr.length) return 0; const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };

// 同一帧「照常」与「关掉文字」两张图里，按方框算文字对比度（两张图都按 sRGB 解码成 WCAG 相对亮度）：
//   方框内差值 ≥ 0.5×P99 的像素是字的笔画核心；方框向外扩 max(4 px, 0.3×字高) 的范围里、差值 < max(6, 0.1×P99) 的像素是字周围
//   没被改动的背景；两者之间（抗锯齿边、辉光）两边都不算。字取笔画核心亮度的 P75（亮字）/ P25（暗字），
//   背景取对字不利的一侧四分位（亮字取背景 P75、暗字取 P25），按 WCAG 公式求比值。
//   背景按「照常」那张图取：字后面的半透明底板、描边、暗晕都算进背景（它们本来就是为可读性画的）。
export function measureContrast(on, off, box) {
  const W = on.width, H = on.height;
  const x0 = Math.max(0, Math.floor(box[0])), y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(W, Math.ceil(box[2])), y1 = Math.min(H, Math.ceil(box[3]));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const pad = Math.max(4, Math.round(0.3 * (y1 - y0)));
  const X0 = Math.max(0, x0 - pad), Y0 = Math.max(0, y0 - pad), X1 = Math.min(W, x1 + pad), Y1 = Math.min(H, y1 + pad);
  const diffAt = i => Math.max(Math.abs(on.data[i] - off.data[i]), Math.abs(on.data[i + 1] - off.data[i + 1]), Math.abs(on.data[i + 2] - off.data[i + 2]));
  const inner = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) inner.push(diffAt((y * W + x) * 4));
  const top = pctl(inner, 0.99);
  const hi = Math.max(24, 0.5 * top), lo = Math.max(6, 0.1 * top);
  const fg = [], bg = [];
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const i = (y * W + x) * 4, d = diffAt(i);
    const inBox = x >= x0 && x < x1 && y >= y0 && y < y1;
    if (inBox && d >= hi) fg.push(lum(on.data, i));
    else if (d < lo) bg.push(lum(on.data, i));
  }
  if (fg.length < Math.max(12, 0.004 * inner.length) || bg.length < 12) return { separable: false, fgPixels: fg.length, bgPixels: bg.length };
  const bright = pctl(fg, 0.5) >= pctl(bg, 0.5);
  const Lf = bright ? pctl(fg, 0.75) : pctl(fg, 0.25);
  const Lb = bright ? pctl(bg, 0.75) : pctl(bg, 0.25);
  return { separable: true, ratio: +ratio(Lf, Lb).toFixed(2), fg: +Lf.toFixed(4), bg: +Lb.toFixed(4), fgPixels: fg.length, bgPixels: bg.length, textIs: bright ? 'lighter' : 'darker' };
}

export async function runTexts({ pageDir, profile, film = null, step = 1, readyTimeoutMs = 120000, contrast = true, timeoutMs = 600000, root = REPO_ROOT }) {
  const T = profile.texts;
  const fps = (film?.fps || fpsOf(profile)).value;
  const W = film?.width || profile.width, H = film?.height || profile.height;
  const warnings = [];
  const ids = ['texts.contract', 'texts.inframe', 'texts.safe-area', 'texts.duration', 'texts.contrast', 'texts.glyphs'];
  const C = Object.fromEntries(ids.map(id => [id, makeCheck(id)]));
  const h = await openPage({ root, pageDir, width: W, height: H, fps, profileId: profile.id, readyTimeoutMs });
  try {
    const frameCount = film?.frameCount ?? Math.round(h.info.dur * fps);
    const contract = C['texts.contract'];
    contract.value = `${h.info.hasTexts ? '有' : '没有'} window.TEXTS；DUR ${h.info.dur} 秒；GPU ${h.info.gpu || '未知'}`;
    contract.evidence = { dur: h.info.dur, frames: frameCount, viewport: h.info.viewport, gpu: h.info.gpu, step };
    if (Math.round(h.info.dur * fps) !== frameCount) finding(contract, { key: 'dur', message: `round(DUR×fps) = ${Math.round(h.info.dur * fps)}，与作品描述的 frameCount ${frameCount} 不一致（附录 C5）` });
    if (!h.info.hasTexts) finding(contract, { key: 'no-texts', message: '页面没有 window.TEXTS(t)：改用画字探针与 DOM 文字推导（停留时长只作软项）', hint: '按附录 C5 实现 TEXTS(t)，返回 [{ text, box:[x,y,w,h], alpha, font }]' });
    if (/swiftshader|llvmpipe|software/i.test(h.info.gpu || '')) warnings.push(`页面用的是软件渲染（${h.info.gpu}），文字检查结果不受影响，只是慢`);

    const frames = [];
    for (let f = 0; f < frameCount; f += step) frames.push(f);
    if (frames[frames.length - 1] !== frameCount - 1) frames.push(frameCount - 1);
    const samples = await sampleFrames(h, frames, { fps, dom: true, timeoutMs });
    if (h.externalRequests.length) finding(contract, { key: 'external', message: `页面请求了外网资源（已拦截）：${[...new Set(h.externalRequests)].slice(0, 3).join('、')}`, hint: '素材、字体、库全部放进仓库或作品目录（附录 C5 禁止访问外网）' });
    const badItems = new Set(), textsErrors = new Set();

    // ── 逐帧整理文字条目 ──
    const derived = !h.info.hasTexts;
    const tracks = new Map();   // id → { id, text, frames: Map<f, { box, alpha, font }>, fonts:Set }
    const runFonts = [];        // 所有画字调用（含离屏画布），缺字检查用
    for (const s of samples) {
      if (s.textsError) textsErrors.add(s.textsError);
      for (const r of [...s.runs, ...s.dom]) if (r.text && r.font) runFonts.push({ text: r.text, font: r.font, loaded: r.loaded, f: s.f });
      let items;
      if (!derived) items = (s.texts || []).map(t => normalizeItem(t, W, H)).filter(Boolean);
      else {
        const merged = new Map();
        for (const r of [...s.runs.filter(x => x.attached && x.box), ...s.dom]) {
          if (!r.text.trim()) continue;
          const k = r.text.trim();
          const m = merged.get(k);
          if (m) { m.box = [Math.min(m.box[0], r.box[0]), Math.min(m.box[1], r.box[1]), Math.max(m.box[2], r.box[2]), Math.max(m.box[3], r.box[3])]; m.alpha = Math.max(m.alpha, r.alpha ?? 1); }
          else merged.set(k, { id: k, text: k, box: [...r.box], alpha: r.alpha ?? 1, font: r.font });
        }
        items = [...merged.values()];
      }
      for (const it of items) {
        if (it.bad) { badItems.add(it.text || '(空)'); continue; }
        // 探针给出同一帧里落在方框内、文字相同的画字调用：取它们的最大不透明度与字体
        const runs = s.runs.filter(r => r.box && (r.text === it.text || (it.text.includes(r.text) && r.text.trim().length > 0)) && (!r.attached || overlap(r.box, it.box) > 0.3 * Math.min(area(r.box), area(it.box) || 1)));
        const alpha = it.alpha ?? (runs.length ? Math.max(...runs.map(r => r.alpha ?? 1)) : null);
        const font = it.font || runs.find(r => !r.filter)?.font || runs[0]?.font || null;
        // 按「id + 文字」分轨：同一个 id 换了内容（如 识别中… → 未能识别）是两条要分别读完的字
        const key = `${it.id}\u0000${it.text}`;
        let tr = tracks.get(key);
        if (!tr) {
          const sameId = [...tracks.values()].some(x => x.id === it.id);
          tr = { key, id: sameId ? `${it.id}:${it.text}` : it.id, text: it.text, frames: new Map(), fonts: new Set(), alphaKnown: false, peak: 0 };
          tracks.set(key, tr);
        }
        tr.frames.set(s.f, { box: it.box, alpha, font });
        if (font) tr.fonts.add(font);
        if (alpha !== null) { tr.alphaKnown = true; tr.peak = Math.max(tr.peak, alpha); }
      }
    }
    if (badItems.size) finding(contract, { key: 'bad-items', message: `TEXTS 有 ${badItems.size} 种条目缺方框或方框不是数字：${[...badItems].slice(0, 3).join('、')}` });
    if (textsErrors.size) finding(contract, { key: 'texts-error', message: `TEXTS(t) 抛错：${[...textsErrors][0]}` });
    const noAlpha = [...tracks.values()].filter(t => !t.alphaKnown).map(t => t.id);
    if (noAlpha.length && !derived) finding(contract, { key: 'no-alpha', message: `这些文字的 TEXTS 条目没有 alpha、探针也没量到不透明度，停留时长按「出现」计：${noAlpha.slice(0, 5).join('、')}`, hint: 'TEXTS 条目加 alpha 字段（附录 C5），停留时长才能按「完全显现」计' });
    settle(contract);

    // ── 画内与安全区 ──
    const sa = profile.safeArea.title;
    const safe = [sa.left * W, sa.top * H, W - sa.right * W, H - sa.bottom * H];
    const inf = C['texts.inframe'], saf = C['texts.safe-area'];
    inf.expected = `方框在 0–${W} × 0–${H} 内`;
    saf.expected = `图文安全区 x ${safe[0].toFixed(0)}–${safe[2].toFixed(0)}、y ${safe[1].toFixed(0)}–${safe[3].toFixed(0)}（每边 上${sa.top * 100}% 右${sa.right * 100}% 下${sa.bottom * 100}% 左${sa.left * 100}%）`;
    for (const tr of tracks.values()) {
      let outF = [], unsafeF = [], worstOut = 0, worstUnsafe = 0;
      for (const [f, d] of tr.frames) {
        if ((d.alpha ?? 1) <= 0.02) continue;
        const b = d.box;
        const o = Math.max(0 - b[0], 0 - b[1], b[2] - W, b[3] - H);
        if (o > 0.5) { outF.push(f); worstOut = Math.max(worstOut, o); }
        const u = Math.max(safe[0] - b[0], safe[1] - b[1], b[2] - safe[2], b[3] - safe[3]);
        if (u > 0.5) { unsafeF.push(f); worstUnsafe = Math.max(worstUnsafe, u); }
      }
      const span = list => [Math.min(...list), Math.max(...list) + 1];
      if (outF.length) finding(inf, { key: `out@${tr.id}`, target: tr.id, frames: span(outF), message: `「${tr.text}」出画 ${worstOut.toFixed(0)} px（${outF.length} 帧，第 ${Math.min(...outF)}–${Math.max(...outF)} 帧）`, hint: '文字要么完整在画内、要么完全在画外（VISUAL-DESIGN §6.3）' });
      if (unsafeF.length) finding(saf, { key: `unsafe@${tr.id}`, target: tr.id, frames: span(unsafeF), message: `「${tr.text}」越出图文安全区 ${worstUnsafe.toFixed(0)} px（${unsafeF.length} 帧，第 ${Math.min(...unsafeF)}–${Math.max(...unsafeF)} 帧）`, hint: '往画面内收，或缩字号；竖屏注意平台界面会压住上下与右侧' });
    }
    inf.value = `${tracks.size} 条文字，${inf.findings.length} 条出画`;
    saf.value = `${tracks.size} 条文字，${saf.findings.length} 条越出安全区`;
    settle(inf); settle(saf);

    // ── 停留时长 ──
    const du = C['texts.duration'];
    du.expected = `完全显现（不透明度 ≥ 该条峰值的 ${Math.round(T.opaqueAlpha * 100)}%）连续 ≥ max(${T.minHoldSec} 秒, 字数×${T.perUnitSec} 秒)；建议 ≥ 字数÷${T.targetUnitsPerSec}＋${T.targetBaseSec} 秒`;
    const durRows = [];
    for (const tr of tracks.values()) {
      const fs2 = [...tr.frames.keys()].sort((a, b) => a - b);
      const apps = [];
      for (const f of fs2) { const last = apps[apps.length - 1]; if (last && f - last[last.length - 1] <= step) last.push(f); else apps.push([f]); }
      const units = readingUnits(tr.text);
      const need = Math.max(T.minHoldSec, units * T.perUnitSec), target = units / T.targetUnitsPerSec + T.targetBaseSec;
      for (const app of apps) {
        let best = 0, cur = 0;
        for (let k = 0; k < app.length; k++) {
          const a = tr.frames.get(app[k]).alpha;
          // 「完全显现」按这条字自己的峰值不透明度算：显示层的字本来就是半透明的（如 0.85），不能按绝对 0.9 判它永远没显现
          const opaque = a === null ? true : a >= T.opaqueAlpha * (tr.peak || 1) - 1e-6;
          const contiguous = k > 0 && app[k] - app[k - 1] <= step;
          cur = opaque ? (contiguous && cur > 0 ? cur + 1 : 1) : 0;
          best = Math.max(best, cur);
        }
        const sec = (best * step) / fps;
        const range = [app[0], app[app.length - 1] + 1];
        const atEnd = range[1] >= frameCount - step + 1;
        durRows.push({ id: tr.id, text: tr.text, frames: range, opaqueSec: +sec.toFixed(3), needSec: +need.toFixed(3), targetSec: +target.toFixed(3), alphaKnown: tr.alphaKnown, peakAlpha: tr.alphaKnown ? +tr.peak.toFixed(3) : null });
        if (sec + 1e-9 < need) {
          finding(du, { key: `short@${tr.id}@${range[0]}`, target: tr.id, frames: range, status: derived ? 'warn' : undefined,
            message: `「${tr.text}」${tr.alphaKnown ? '完全显现' : '出现'}只有 ${sec.toFixed(2)} 秒（${Math.round(sec * fps)} 帧），下限 ${need.toFixed(2)} 秒${atEnd ? '；它停在片尾，实际停留还取决于播放器是否停在最后一帧' : ''}`,
            hint: '拉长停留或减字；刻意的快闪（例如半拍闪卡）要由用户批准后写进豁免（docs/quality/QA-GATE.md「豁免」）' });
        } else if (sec + 1e-9 < target) {
          finding(du, { key: `brief@${tr.id}@${range[0]}`, target: tr.id, frames: range, status: 'warn', message: `「${tr.text}」停留 ${sec.toFixed(2)} 秒，低于导演规范建议的 ${target.toFixed(2)} 秒（字数÷4.5＋1.5，DIRECTING 步骤 9）` });
        }
      }
    }
    du.value = durRows.length ? durRows.map(r => `${r.text.slice(0, 12)} ${r.opaqueSec}s`).join('；') : '没有文字';
    du.evidence = { rows: durRows };
    settle(du);

    // ── 缺字（cmap）──
    const gl = C['texts.glyphs'];
    gl.expected = '每个字都落在声明的网页字体里，没有回退到系统字体';
    const inv = await fontInventory(h);
    for (const e of inv.errors) warnings.push(e);
    const faces = [];
    const seenFace = new Set();
    for (const f of inv.faces) {
      const k = [famKey(f.family), f.weight, f.style, f.unicodeRange, f.src, f.bin ? f.bin.length : 0].join('|');
      if (seenFace.has(k)) continue;
      seenFace.add(k);
      const st = f.status || inv.set.find(x => famKey(x.family) === famKey(f.family) && String(x.weight) === String(f.weight) && x.style === f.style)?.status || 'unloaded';
      const bytes = loadFaceBytes(f, h.origin, root);
      const face = { family: famKey(f.family), label: f.family, range: weightRange(f.weight), style: /italic|oblique/i.test(f.style) ? 'italic' : 'normal', ranges: parseUnicodeRange(f.unicodeRange), status: st, cps: null, problem: null, src: f.src ? f.src.slice(0, 120) : '(二进制)' };
      if (Buffer.isBuffer(bytes)) { try { face.cps = parseFont(bytes).cps; } catch (e) { face.problem = `字体文件解析失败：${e.message}`; } }
      else if (bytes?.local) face.problem = '用 local() 引用系统字体：换机器字形就变';
      else if (bytes?.external) face.problem = `字体来自外网 ${bytes.external}（已拦截）`;
      else if (bytes?.missing) face.problem = `字体文件不存在：${bytes.missing}`;
      else face.problem = '读不到字体来源';
      faces.push(face);
    }
    const byFam = new Map();
    for (const f of faces) { if (!byFam.has(f.family)) byFam.set(f.family, []); byFam.get(f.family).push(f); }
    const misses = new Map();   // 字 → { cp, texts:Set, fonts:Set, why:Set }
    const miss = (ch, text, font, why) => {
      let m = misses.get(ch);
      if (!m) { m = { ch, cp: ch.codePointAt(0), texts: new Set(), fonts: new Set(), why: new Set() }; misses.set(ch, m); }
      m.texts.add(text.slice(0, 40)); m.fonts.add(font); m.why.add(why);
    };
    // 按 CSS 字体回退顺序逐家族找；lacking = 前面已加载、但子集里没有这个字的网页字体（报给人看：缺的是谁的字）
    const resolveChar = (cp, spec) => {
      let lacking = null;
      const pre = () => (lacking ? `「${lacking}」的子集里没有这个字，` : '');
      for (const fam of spec.families) {
        const k = famKey(fam);
        if (GENERIC.has(k)) return `${pre()}落到通用字体族 ${fam}（系统字体）`;
        const list = byFam.get(k);
        if (!list) return `${pre()}字体族「${fam}」不是页面加载的网页字体（会用系统里的同名字体或回退）`;
        for (const f of pickFaces(list, spec.weight, spec.style)) {
          if (!inRanges(cp, f.ranges)) continue;
          if (f.problem) return `${pre()}「${f.label}」${f.problem}`;
          if (f.status !== 'loaded') return `${pre()}「${f.label}」画字时没加载完（状态 ${f.status}）`;
          if (f.cps.has(cp)) return null;
        }
        lacking = lacking || list[0].label;
      }
      return `${pre()}声明的字体都没有这个字，回退到系统默认字体`;
    };
    const unionHas = cp => faces.some(f => f.cps && f.status === 'loaded' && inRanges(cp, f.ranges) && f.cps.has(cp));
    let checked = 0;
    const seenRun = new Set();
    for (const r of runFonts) {
      const k = r.text + '\u0000' + r.font;
      if (seenRun.has(k)) continue;
      seenRun.add(k);
      const spec = parseFontSpec(r.font);
      for (const ch of r.text) {
        const cp = ch.codePointAt(0);
        if (SKIP_CP(cp)) continue;
        checked++;
        const why = resolveChar(cp, spec);
        if (why) miss(ch, r.text, r.font, why);
      }
      if (r.loaded === false) for (const ch of r.text) if (!SKIP_CP(ch.codePointAt(0))) miss(ch, r.text, r.font, 'document.fonts.check 为 false：画字时字体还没加载');
    }
    // TEXTS 里有、但探针没记到画字调用的文字（例如画成路径的书法片名）：至少要被某个已加载的网页字体覆盖
    for (const tr of tracks.values()) {
      if (tr.fonts.size) {
        for (const font of tr.fonts) {
          const spec = parseFontSpec(font);
          for (const ch of tr.text) { const cp = ch.codePointAt(0); if (SKIP_CP(cp)) continue; checked++; const why = resolveChar(cp, spec); if (why) miss(ch, tr.text, font, why); }
        }
      } else {
        for (const ch of tr.text) { const cp = ch.codePointAt(0); if (SKIP_CP(cp)) continue; checked++; if (!unionHas(cp)) miss(ch, tr.text, '(TEXTS 没写 font)', '没有任何已加载的网页字体含这个字'); }
      }
    }
    gl.value = misses.size ? `${misses.size} 个字缺字形：${[...misses.keys()].slice(0, 20).join('')}` : `查了 ${checked} 个字形，都在网页字体里`;
    gl.evidence = { faces: faces.map(f => ({ family: f.label, weight: f.range.join('–'), style: f.style, status: f.status, glyphs: f.cps ? f.cps.size : null, problem: f.problem, src: f.src })), checkedChars: checked };
    for (const m of misses.values()) {
      finding(gl, { key: `glyph@${m.ch}`, target: m.ch, message: `「${m.ch}」（U+${m.cp.toString(16).toUpperCase().padStart(4, '0')}）${[...m.why][0]}；出现在「${[...m.texts][0]}」，字体 ${[...m.fonts][0]}`,
        hint: '把这些字加进作品自己的字体子集（作品目录下的 fonts/，从带许可的原始字体离线子集化）；不要改共享的 fonts/ 子集，也不要依赖系统字体' });
    }
    settle(gl);

    // ── 对比度 ──
    const ct = C['texts.contrast'];
    ct.expected = `≥ ${T.minContrast}:1（建议 ≥ ${T.goodContrast}:1）`;
    if (!contrast) notRun(ct, '用了 --no-contrast');
    else if (!tracks.size) ct.value = '没有文字';
    else {
      // 每条文字取不透明度最高的一帧（并列取其中间），同帧的合并成一次截图
      const pickFrame = tr => {
        const list = [...tr.frames.entries()].filter(([, d]) => (d.alpha ?? 1) > 0.02);
        if (!list.length) return null;
        const top = Math.max(...list.map(([, d]) => d.alpha ?? 1));
        const best = list.filter(([, d]) => (d.alpha ?? 1) >= top - 1e-6).map(([f]) => f).sort((a, b) => a - b);
        return best[Math.floor(best.length / 2)];
      };
      const byFrame = new Map();
      for (const tr of tracks.values()) { const f = pickFrame(tr); if (f === null) continue; if (!byFrame.has(f)) byFrame.set(f, []); byFrame.get(f).push(tr); }
      const rows = [];
      for (const [f, list] of [...byFrame.entries()].sort((a, b) => a[0] - b[0])) {
        const shots = await screenshotSet(h, f, fps);
        const A = decodePng(shots.on), Bt = decodePng(shots.text);
        let Bl = null;
        for (const tr of list) {
          const d = tr.frames.get(f);
          // 先只关文字（字后面的底板、图标留着当背景）；画成路径的字关不掉，再改用整层藏掉的那张
          let m = measureContrast(A, Bt, d.box), via = 'text';
          if (!m || !m.separable) { Bl = Bl || decodePng(shots.layer); m = measureContrast(A, Bl, d.box); via = 'layer'; }
          rows.push({ id: tr.id, text: tr.text, frame: f, alpha: d.alpha, via, ...(m || { separable: false }) });
          if (!m || !m.separable) { finding(ct, { key: `unmeasured@${tr.id}`, target: tr.id, frames: [f, f + 1], status: 'warn', message: `「${tr.text}」第 ${f} 帧分不出字和背景（关掉文字后画面没变），对比度没测到`, hint: '文字若画在 WebGL 场景里（世界内文字），要人工看 4K 与 1080 对照帧' }); continue; }
          if (m.ratio < T.minContrast) finding(ct, { key: `low@${tr.id}`, target: tr.id, frames: [f, f + 1], message: `「${tr.text}」第 ${f} 帧对比度 ${m.ratio}:1，低于 ${T.minContrast}:1`, hint: '加暗晕、描边或半透明底板，或换落点（文字不压亮背景）；VISUAL-DESIGN §6.3' });
          else if (m.ratio < T.goodContrast) finding(ct, { key: `fair@${tr.id}`, target: tr.id, frames: [f, f + 1], status: 'warn', message: `「${tr.text}」第 ${f} 帧对比度 ${m.ratio}:1，低于建议的 ${T.goodContrast}:1` });
        }
      }
      ct.value = rows.filter(r => r.separable).map(r => `${r.text.slice(0, 10)} ${r.ratio}:1`).join('；') || '没测到';
      ct.evidence = { rows, method: '同帧照常 / 只关文字（画成路径的字改为藏掉显示层）各截一张无损 PNG；差值 ≥ max(24, 0.5×P99) 的像素是笔画核心，差值 < max(6, 0.1×P99) 的是背景，中间的抗锯齿边与辉光不计；字取笔画核心的 P75（亮字）/ P25（暗字），背景取对字不利一侧的四分位（亮字 P75、暗字 P25），按 WCAG 相对亮度算比值' };
      settle(ct);
    }
    return {
      checks: ids.map(id => (C[id].status === 'pass' && !C[id].findings.length ? settle(C[id]) : C[id])),
      warnings,
      summary: { frames: frameCount, sampled: samples.length, step, derived, texts: [...tracks.values()].map(t => ({ id: t.id, text: t.text, frames: t.frames.size })) },
    };
  } finally {
    await h.close();
  }
}
