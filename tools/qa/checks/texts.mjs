// 北冥 QA · texts：画面文字。打开作品页面，逐帧 render(t) 后读 window.TEXTS(t)（附录 C5：[{ text, box:[x,y,w,h], alpha, font }]；
// 也接受现有的 { id, text, x0, y0, x1, y1 }），并用探针记下同一帧里每次画字的字体与实际不透明度：
//   inframe    方框完整在画内
//   safe-area  方框在图文安全区内（档位 safeArea.title，16:9 为 EBU R95 每边 5%）
//   duration   不透明度 ≥ opaqueAlpha 的连续停留 ≥ max(minHoldSec, 字数×perUnitSec)（硬门）；导演规范的 字数÷4.5＋1.5 秒为软项
//   contrast   选每条文字最不透明的一帧，开、关文字各截一张无损图：差别大的像素是字，其余是背景；相对亮度对比 < 3:1 硬失败，< 4.5:1 软项
//   glyphs     每个字按 CSS 字体匹配规则逐家族查 cmap：落到系统字体（含 sans-serif 等通用族）即失败；字体没加载完也算失败
//   cjk-break  每条文字（\n 分出的每一行）行首不是收尾标点、行尾不是开头标点（规则表来自 engine/overlay/cjk.js；软项）
// 页面没有 TEXTS 时，用探针记下的画字调用与 DOM 文字代替（「推导模式」，停留时长只给软项）。
//
//   runTexts({ pageDir, profile, film, step, readyTimeoutMs, contrast, timeoutMs, root }) → { checks, warnings, summary }
import fs from 'node:fs';
import path from 'node:path';
import { makeCheck, finding, settle, notRun } from '../lib/checks.mjs';
import { usageError } from '../lib/cli-kit.mjs';
import { readPageRecord, checkPageRecordSpec, openPage, sampleFrames, fontInventory, screenshotSet } from '../lib/page.mjs';
import { openOffscreen, sampleFramesOffscreen, fontInventoryOffscreen, screenshotSetOffscreen } from '../lib/offscreen.mjs';
import { parseFont, parseUnicodeRange, inRanges } from '../lib/font.mjs';
import { decodePng } from '../lib/png.mjs';
import { fpsOf, REPO_ROOT } from '../lib/profiles.mjs';
import { normalizeItem, loadFaceBytes, measureContrast, sampleTextItems } from '../../../engine/render/lib/text-samples.mjs';
export { loadFaceBytes, measureContrast, sampleTextItems };
import { lintLine } from '../../../engine/overlay/cjk.js';

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

// 一条文字里违反行首行尾禁则的行：[{ line, kind, ch }]（\n 是硬换行，每行单独查）
export function cjkBreaks(text) {
  return String(text).split('\n').flatMap(line => lintLine(line).map(v => ({ line, kind: v.kind, ch: v.ch })));
}

export async function runTexts({ pageDir, profile, film = null, step = 1, readyTimeoutMs = 120000, contrast = true, timeoutMs = 600000, root = REPO_ROOT, size = null, offscreen = false, recorded = null }) {
  const T = profile.texts;
  const fps = recorded?.fps ?? (film?.fps || fpsOf(profile)).value;
  const [W, H] = size || [film?.width || profile.width, film?.height || profile.height];
  const warnings = [];
  const ids = ['texts.contract', 'texts.inframe', 'texts.safe-area', 'texts.duration', 'texts.contrast', 'texts.glyphs', 'texts.cjk-break'];
  const C = Object.fromEntries(ids.map(id => [id, makeCheck(id)]));
  const h = recorded || (offscreen
    ? await openOffscreen({ root, pageDir, width: W, height: H, fps, film })
    : await openPage({ root, pageDir, width: W, height: H, fps, profileId: profile.id, readyTimeoutMs }));
  try {
    const frameCount = recorded?.frameCount ?? film?.frameCount ?? Math.round(h.info.dur * fps);
    const contract = C['texts.contract'];
    contract.value = `${h.info.hasTexts ? '有' : '没有'} ${offscreen ? 'work.texts' : 'window.TEXTS'}；DUR ${h.info.dur} 秒；GPU ${h.info.gpu || '未知'}`;
    contract.evidence = { dur: h.info.dur, frames: frameCount, viewport: h.info.viewport, gpu: h.info.gpu, step };
    if (Math.round(h.info.dur * fps) !== frameCount) finding(contract, { key: 'dur', message: `round(DUR×fps) = ${Math.round(h.info.dur * fps)}，与作品描述的 frameCount ${frameCount} 不一致（附录 C5）` });
    if (!h.info.hasTexts) finding(contract, { key: 'no-texts', message: '页面没有 window.TEXTS(t)：改用画字探针与 DOM 文字推导（停留时长只作软项）', hint: '按附录 C5 实现 TEXTS(t)，返回 [{ text, box:[x,y,w,h], alpha, font }]' });
    if (/swiftshader|llvmpipe|software/i.test(h.info.gpu || '')) warnings.push(`页面用的是软件渲染（${h.info.gpu}），文字检查结果不受影响，只是慢`);

    const frames = [];
    for (let f = 0; f < frameCount; f += step) frames.push(f);
    if (frames[frames.length - 1] !== frameCount - 1) frames.push(frameCount - 1);
    const samples = recorded ? frames.map(f => recorded.frames[f]) : offscreen ? await sampleFramesOffscreen(h, frames, { fps }) : await sampleFrames(h, frames, { fps, dom: true, timeoutMs });
    if (h.externalRequests.length) finding(contract, { key: 'external', message: `页面请求了外网资源（已拦截）：${[...new Set(h.externalRequests)].slice(0, 3).join('、')}`, hint: '素材、字体、库全部放进仓库或作品目录（附录 C5 禁止访问外网）' });
    const badItems = new Set(), textsErrors = new Set();

    // ── 逐帧整理文字条目 ──
    const derived = !h.info.hasTexts;
    const tracks = new Map();   // id → { id, text, frames: Map<f, { box, alpha, font }>, fonts:Set }
    const runFonts = [];        // 所有画字调用（含离屏画布），缺字检查用
    const sampledFrames = new Set(frames), contrastPeaks = new Map();
    for (const s of recorded?.frames || samples) {
      // --step 只抽查布局和停留；已记录的对比度只能且必须按全片真实峰值核对。
      const sampled = sampledFrames.has(s.f);
      if (sampled && s.textsError) textsErrors.add(s.textsError);
      if (sampled) for (const r of [...s.runs, ...s.dom]) if (r.text && r.font) runFonts.push({ text: r.text, font: r.font, loaded: r.loaded, f: s.f });
      const items = new Map();
      for (const it of sampleTextItems(s, derived, W, H)) {
        if (it.bad) { if (sampled) badItems.add(it.text || '(空)'); continue; }
        items.set(JSON.stringify([it.id, it.text]), it);
      }
      for (const [key, it] of items) {
        const { font, alpha } = it;
        if ((alpha ?? 1) > (contrastPeaks.get(key)?.alphaValue ?? 0.02)) contrastPeaks.set(key, { ...it, key, f: s.f, alphaValue: alpha ?? 1 });
        if (!sampled) continue;
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

    // ── 行首行尾禁则（软项）──
    const cb = C['texts.cjk-break'];
    cb.expected = '每行行首不是收尾标点（，。、；：？！）》」』】〕”’…—），行尾不是开头标点（（《「『【〔“‘）';
    for (const tr of tracks.values()) {
      for (const v of cjkBreaks(tr.text)) {
        finding(cb, { key: `cjk@${tr.id}@${v.kind}`, target: tr.id, message: `「${v.line}」${v.kind === 'line-start' ? '行首是' : '行尾是'}「${v.ch}」`, hint: '用 engine/overlay/cjk.js 的 layoutText 排版（会推出、挤压），或改文案断句' });
      }
    }
    cb.value = `${tracks.size} 条文字，${cb.findings.length} 处违规`;
    settle(cb);

    // ── 缺字（cmap）──
    const gl = C['texts.glyphs'];
    gl.expected = '每个字都落在声明的网页字体里，没有回退到系统字体';
    const inv = recorded ? recorded.fonts : offscreen ? await fontInventoryOffscreen(h) : await fontInventory(h);
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
      return lacking ? `${pre()}回退到系统默认字体` : '声明的字体都没有这个字，回退到系统默认字体';
    };
    const unionHas = cp => faces.some(f => f.cps && f.status === 'loaded' && inRanges(cp, f.ranges) && f.cps.has(cp));
    let checked = 0;
    const seenRun = new Set();
    for (const r of runFonts) {
      const k = JSON.stringify([r.text, r.font, r.loaded === false]);
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
    else if (!tracks.size && !contrastPeaks.size) ct.value = '没有文字';
    else {
      // 无渲染记录的旧片沿用原规则：透明度并列（含原来的浮点容差）时检查中间帧。
      if (!recorded) for (const peak of contrastPeaks.values()) {
        const tied = [...tracks.get(peak.key).frames].filter(([, d]) => (d.alpha ?? 1) > 0.02 && (d.alpha ?? 1) >= peak.alphaValue - 1e-6);
        const [f, d] = tied[Math.floor(tied.length / 2)];
        Object.assign(peak, d, { f });
      }
      const byFrame = Map.groupBy([...contrastPeaks.values()], p => p.f);
      const rows = [];
      for (const [f, list] of [...byFrame.entries()].sort((a, b) => a[0] - b[0])) {
        const shots = recorded ? null : offscreen ? await screenshotSetOffscreen(h, f, fps) : await screenshotSet(h, f, fps);
        const A = shots && decodePng(shots.on), Bt = shots && decodePng(shots.text);
        let Bl = null;
        for (const d of list) {
          const tr = tracks.get(d.key) || d;
          // 先只关文字（字后面的底板、图标留着当背景）；画成路径的字关不掉，再改用整层藏掉的那张
          const saved = recorded?.frames[f].contrast.find(x => x.id === d.id && x.text === d.text && x.box?.length === 4 && x.box.every((n, k) => n === d.box[k]));
          if (recorded && !saved) {
            rows.push({ id: tr.id, text: tr.text, frame: f, alpha: d.alpha, separable: false });
            finding(ct, { key: 'missing@' + tr.id, target: tr.id, frames: [f, f + 1], message: '渲染记录缺这条文字峰值帧的可验证对比证据' });
            continue;
          }
          let m = recorded ? saved : measureContrast(A, Bt, d.box), via = saved?.via || 'text';
          if (!recorded && (!m || !m.separable)) { Bl = Bl || decodePng(shots.layer); m = measureContrast(A, Bl, d.box); via = 'layer'; }
          rows.push({ ...(m || { separable: false }), id: tr.id, text: tr.text, frame: f, alpha: d.alpha, via });
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
    if (!recorded) await h.close();
  }
}

/**
 * page-render 表复用页面探针的逐帧采样。D 路线的场景表来自 scene.textsAt(frame)，
 * 只含三维文字，对比度读取 work/contrast/{on,off}_NNNNNN.png。
 */
export async function runTextsFromJson({ textsFile, doc = readPageRecord(textsFile), contrastDir = null, profile, film = null, step = 1, contrast = true, size = null, root = REPO_ROOT, verifyVideo = null }) {
  const T = profile.texts;
  if (doc?.source != null || doc?.videoStreamSha256 != null || ['a', 'c'].includes(film?.route) ||
      (verifyVideo && film?.route !== 'd')) {
    checkPageRecordSpec(doc, { film, size, fps: (film?.fps || fpsOf(profile)).value });
    const box = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite);
    const draws = (list, dom) => Array.isArray(list) && list.every(r => typeof r?.text === 'string' && typeof r.font === 'string' &&
      (box(r.box) || (!dom && typeof r.error === 'string')));
    const faces = list => Array.isArray(list) && list.every(f => typeof f?.family === 'string' &&
      [f.src, f.bin, f.base].every(v => v == null || typeof v === 'string'));
    if (!Array.isArray(doc.frames) || doc.frames.length !== doc.frameCount || doc.frames.some((s, i) => s?.f !== i ||
        !draws(s.runs, false) || !draws(s.dom, true) || !(s.texts === null || Array.isArray(s.texts)) ||
        !Array.isArray(s.contrast) || s.contrast.some(x => !box(x?.box) || typeof x.separable !== 'boolean' ||
          (x.separable && (!Number.isFinite(x.ratio) || x.ratio < 1 || x.ratio > 21)))) ||
        !faces(doc.fonts?.faces) || !faces(doc.fonts?.set) || !Array.isArray(doc.fonts?.errors) || typeof doc.info?.hasTexts !== 'boolean' ||
        !Array.isArray(doc.externalRequests)) throw usageError('texts.json 的逐帧文字、字体或对比采样不完整');
    await verifyVideo?.(doc, textsFile);
    return runTexts({ profile, film, step, contrast, root, size: size || [doc.width, doc.height], recorded: { ...doc, origin: 'http://page.invalid' } });
  }
  if (doc?.schemaVersion !== 1 || !Array.isArray(doc.frames)) throw usageError('texts.json 缺少文字采样表');
  const fps = (film?.fps || fpsOf(profile)).value;
  const [W, H] = size || [doc.width || film?.width || profile.width, doc.height || film?.height || profile.height];
  // D 路线的旧表可以省略没有文字的帧，frameCount 仍是整片长度。
  const frameCount = doc.frameCount ?? film?.frameCount ?? doc.frames.length;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || (film?.frameCount != null && film.frameCount !== frameCount)) {
    throw usageError('texts.json 的总帧数无效或与作品要求不符');
  }
  const warnings = [];
  const ids = ['texts.contract', 'texts.inframe', 'texts.safe-area', 'texts.duration', 'texts.contrast', 'texts.glyphs', 'texts.cjk-break'];
  const C = Object.fromEntries(ids.map(id => [id, makeCheck(id)]));

  const contract = C['texts.contract'];
  contract.value = `离线文字采样表（${Array.isArray(doc.frames) ? doc.frames.length : 0} 帧记录；总帧数 ${frameCount}）`;
  contract.evidence = { source: 'texts.json', frames: frameCount, viewport: [W, H], step };

  const badItems = new Set();
  const tracks = new Map();
  const rawFrames = doc.frames;
  const seenFrames = new Set();
  for (const fr of rawFrames) {
    const f = fr?.frame ?? fr?.f;
    if (!Number.isSafeInteger(f) || f < 0 || f >= frameCount || seenFrames.has(f)) throw usageError('texts.json 的采样帧号无效、越界或重复');
    seenFrames.add(f);
    const rawItems = fr.items ?? fr.texts;
    if (!Array.isArray(rawItems)) throw usageError('texts.json 采样帧缺少文字条目数组');
    if (f % step !== 0) continue;
    for (const rawIt of rawItems) {
      const it = normalizeItem(rawIt, W, H);
      if (!it) continue;
      if (it.bad) { badItems.add(it.text || '(空)'); continue; }
      const alpha = it.alpha ?? 1;
      const key = `${it.id}\u0000${it.text}`;
      let tr = tracks.get(key);
      if (!tr) {
        const sameId = [...tracks.values()].some(x => x.id === it.id);
        tr = { key, id: sameId ? `${it.id}:${it.text}` : it.id, text: it.text, frames: new Map(), fonts: new Set(), alphaKnown: true, peak: 0 };
        tracks.set(key, tr);
      }
      tr.frames.set(f, { box: it.box, alpha, font: it.font });
      if (it.font) tr.fonts.add(it.font);
      tr.peak = Math.max(tr.peak, alpha);
    }
  }
  if (badItems.size) finding(contract, { key: 'bad-items', message: `texts.json 有 ${badItems.size} 种条目缺方框或方框不是数字：${[...badItems].slice(0, 3).join('、')}` });
  settle(contract);

  const sa = profile.safeArea.title;
  const safe = [sa.left * W, sa.top * H, W - sa.right * W, H - sa.bottom * H];
  const inf = C['texts.inframe'], saf = C['texts.safe-area'];
  inf.expected = `方框在 0–${W} × 0–${H} 内`;
  saf.expected = `图文安全区 x ${safe[0].toFixed(0)}–${safe[2].toFixed(0)}、y ${safe[1].toFixed(0)}–${safe[3].toFixed(0)}（每边 上${sa.top * 100}% 右${sa.right * 100}% 下${sa.bottom * 100}% 左${sa.left * 100}%）`;
  for (const tr of tracks.values()) {
    const outF = [], unsafeF = [];
    let worstOut = 0, worstUnsafe = 0;
    for (const [f, d] of tr.frames) {
      if ((d.alpha ?? 1) <= 0.02) continue;
      const b = d.box;
      const o = Math.max(0 - b[0], 0 - b[1], b[2] - W, b[3] - H);
      if (o > 0.5) { outF.push(f); worstOut = Math.max(worstOut, o); }
      const u = Math.max(safe[0] - b[0], safe[1] - b[1], b[2] - safe[2], b[3] - safe[3]);
      if (u > 0.5) { unsafeF.push(f); worstUnsafe = Math.max(worstUnsafe, u); }
    }
    const span = list => [Math.min(...list), Math.max(...list) + 1];
    if (outF.length) finding(inf, { key: `out@${tr.id}`, target: tr.id, frames: span(outF), message: `「${tr.text}」出画 ${worstOut.toFixed(0)} px（${outF.length} 帧，第 ${Math.min(...outF)}–${Math.max(...outF)} 帧）`, hint: '三维铭牌或 HUD 投射方框必须完整落在画内（用 placeInCameraFrustum / projectBoxToPixels 对齐）' });
    if (unsafeF.length) finding(saf, { key: `unsafe@${tr.id}`, target: tr.id, frames: span(unsafeF), message: `「${tr.text}」越出图文安全区 ${worstUnsafe.toFixed(0)} px（${unsafeF.length} 帧，第 ${Math.min(...unsafeF)}–${Math.max(...unsafeF)} 帧）`, hint: '往画面内收，或缩小三维文字尺寸' });
  }
  inf.value = `${tracks.size} 条文字，${inf.findings.length} 条出画`;
  saf.value = `${tracks.size} 条文字，${saf.findings.length} 条越出安全区`;
  settle(inf); settle(saf);

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
        const opaque = a === null ? true : a >= T.opaqueAlpha * (tr.peak || 1) - 1e-6;
        const contiguous = k > 0 && app[k] - app[k - 1] <= step;
        cur = opaque ? (contiguous && cur > 0 ? cur + 1 : 1) : 0;
        best = Math.max(best, cur);
      }
      const sec = (best * step) / fps;
      const range = [app[0], app[app.length - 1] + 1];
      const atEnd = range[1] >= frameCount - step + 1;
      durRows.push({ id: tr.id, text: tr.text, frames: range, opaqueSec: +sec.toFixed(3), needSec: +need.toFixed(3), targetSec: +target.toFixed(3), alphaKnown: true, peakAlpha: +tr.peak.toFixed(3) });
      if (sec + 1e-9 < need) {
        finding(du, { key: `short@${tr.id}@${range[0]}`, target: tr.id, frames: range,
          message: `「${tr.text}」完全显现只有 ${sec.toFixed(2)} 秒（${Math.round(sec * fps)} 帧），下限 ${need.toFixed(2)} 秒${atEnd ? '；它停在片尾，实际停留还取决于播放器是否停在最后一帧' : ''}`,
          hint: '拉长停留或减字；刻意的快闪要由用户批准后写进豁免（docs/quality/QA-GATE.md「豁免」）' });
      } else if (sec + 1e-9 < target) {
        finding(du, { key: `brief@${tr.id}@${range[0]}`, target: tr.id, frames: range, status: 'warn', message: `「${tr.text}」停留 ${sec.toFixed(2)} 秒，低于导演规范建议的 ${target.toFixed(2)} 秒（字数÷4.5＋1.5）` });
      }
    }
  }
  du.value = durRows.length ? durRows.map(r => `${r.text.slice(0, 12)} ${r.opaqueSec}s`).join('；') : '没有文字';
  du.evidence = { rows: durRows };
  settle(du);

  const cb = C['texts.cjk-break'];
  cb.expected = '每行行首不是收尾标点（，。、；：？！）》」』】〕”’…—），行尾不是开头标点（（《「『【〔“‘）';
  for (const tr of tracks.values()) {
    for (const v of cjkBreaks(tr.text)) {
      finding(cb, { key: `cjk@${tr.id}@${v.kind}`, target: tr.id, message: `「${v.line}」${v.kind === 'line-start' ? '行首是' : '行尾是'}「${v.ch}」`, hint: '改文案断句或离线重排贴图' });
    }
  }
  cb.value = `${tracks.size} 条文字，${cb.findings.length} 处违规`;
  settle(cb);

  const gl = C['texts.glyphs'];
  gl.expected = '每个字都由确定性几何体或预烘焙贴图提供，不依赖运行机器系统字体';
  gl.value = tracks.size ? `三维场景文字 ${tracks.size} 条（几何体或预烘焙贴图，不经过浏览器 CSS 字体回退）` : '没有文字';
  gl.evidence = { mode: 'texts-json', tracks: tracks.size };
  settle(gl);

  const ct = C['texts.contrast'];
  ct.expected = `≥ ${T.minContrast}:1（建议 ≥ ${T.goodContrast}:1）`;
  if (!contrast) notRun(ct, '用了 --no-contrast');
  else if (!tracks.size) { ct.value = '没有文字'; settle(ct); }
  else {
    const pad6 = n => String(n).padStart(6, '0');
    const pickFrame = tr => {
      const list = [...tr.frames.entries()].filter(([, d]) => (d.alpha ?? 1) > 0.02);
      if (!list.length) return null;
      const top = Math.max(...list.map(([, d]) => d.alpha ?? 1));
      const best = list.filter(([, d]) => (d.alpha ?? 1) >= top - 1e-6).map(([f]) => f).sort((a, b) => a - b);
      return best[Math.floor(best.length / 2)];
    };
    const rows = [];
    for (const tr of tracks.values()) {
      const f = pickFrame(tr);
      if (f === null) continue;
      const d = tr.frames.get(f);
      const onFile = contrastDir ? path.join(contrastDir, `on_${pad6(f)}.png`) : null;
      const offFile = contrastDir ? path.join(contrastDir, `off_${pad6(f)}.png`) : null;
      let m = null;
      if (onFile && offFile && fs.existsSync(onFile) && fs.existsSync(offFile)) {
        const A = decodePng(fs.readFileSync(onFile));
        const B = decodePng(fs.readFileSync(offFile));
        m = measureContrast(A, B, d.box);
      }
      rows.push({ id: tr.id, text: tr.text, frame: f, alpha: d.alpha, via: 'pathtrace-hideTexts', ...(m || { separable: false }) });
      if (!m || !m.separable) {
        finding(ct, { key: `unmeasured@${tr.id}`, target: tr.id, frames: [f, f + 1], status: 'warn', message: `「${tr.text}」第 ${f} 帧未能分离三维文字与背景，对比度需人工看关键帧核对`, hint: '在 scene.ts 中按 state.hideTexts 隐藏文字网格即可自动实测 WCAG 对比度' });
        continue;
      }
      if (m.ratio < T.minContrast) finding(ct, { key: `low@${tr.id}`, target: tr.id, frames: [f, f + 1], message: `「${tr.text}」第 ${f} 帧对比度 ${m.ratio}:1，低于 ${T.minContrast}:1`, hint: '提高发光字自发光强度或加深晶圆底板对比度' });
      else if (m.ratio < T.goodContrast) finding(ct, { key: `fair@${tr.id}`, target: tr.id, frames: [f, f + 1], status: 'warn', message: `「${tr.text}」第 ${f} 帧对比度 ${m.ratio}:1，低于建议的 ${T.goodContrast}:1` });
    }
    ct.value = rows.filter(r => r.separable).map(r => `${r.text.slice(0, 10)} ${r.ratio}:1`).join('；') || '没测到';
    ct.evidence = { rows, method: '同帧正常渲染与 state.hideTexts 关文字各渲一张无损 PNG，按 WCAG 相对亮度算比值' };
    settle(ct);
  }
  return {
    checks: ids.map(id => (C[id].status === 'pass' && !C[id].findings.length ? settle(C[id]) : C[id])),
    warnings,
    summary: { frames: frameCount, sampled: rawFrames.length, step, derived: false, mode: 'texts-json', texts: [...tracks.values()].map(t => ({ id: t.id, text: t.text, frames: t.frames.size })) },
  };
}
