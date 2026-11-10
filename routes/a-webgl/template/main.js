// {{TITLE}} · 页面入口：读 film.json（唯一的时间与规格来源）→ 本片字体子集 → 画风注册表 → 按镜头表加载镜头模块 → 交给影片外壳。
// 这里不写任何镜头时间、帧率、画幅的数字：切点、事件、字幕都从 film.json 来，改 film.json 不用改代码（镜头运镜按自己的 in/out 伸缩）。
// 页面约定（附录 C5）：window.DUR = frameCount / fps；render(t) 确定；READY；TEXTS(t) → [{ id, text, box:[x,y,w,h], alpha, font }]；
// 另给 window.TIMELINE（镜头表与事件表，单位：帧）。查询参数（都只给自查用，成片不带）：
//   ?animatic=1  动态预演：关笔触与纸纹、底部画时间条（给 animatic 闸用，DIRECTING.md 步骤 7.5）
//   ?guides=1    构图参考线：三分线、图文安全区 90%、动作安全区 93%、本帧文字方框（VISUAL-DESIGN §4.1、§6.3）
//   ?sil=1       剪影检查：三维主体涂黑、底板与辉光全关、白底、不过后期（VISUAL-DESIGN §3「剪影」）
//   ?dbg=id|depth|edge|line|bloom|paper|kuwahara|scene 看后期中间缓冲；?notext=1 不画字（出风格帧做对照时用）
//   ?lookdev=<JSON>（或 window.__LOOKDEV）定调扫参：把这组后期参数合并到每镜预设之上，不受 allowedOverrides 限制——
//                只给 tools/lookdev/sweep.mjs 与 LOOKDEV.md 的扫参用；成片里出现它就说明画风还没定，要回去走定调
import * as THREE from 'three';
import { createFilm } from '../../engine/stage/film.js';
import { createLook } from '../../engine/look/index.js';
import { fontSpec } from '../../engine/overlay/text.js';
import { frameOf, hold } from '../../engine/core/clock.js';
import { ss, eo, seg, clamp } from '../../engine/core/math.js';
import { loadStyle, parseLookPreset, styleKey, parseStyleRef, resolveLook, mixLook, mergeParams } from '../../engine/style/index.js';
import { loadFilmFonts } from '../../engine/style/fonts.js';
import { makeSun } from './world.js';
import { createTitle } from './title.js';

const q = new URLSearchParams(location.search);
if (q.has('lookdev')) window.__LOOKDEV = JSON.parse(q.get('lookdev'));
const FILM = await (await fetch(new URL('./film.json', import.meta.url))).json();
const OUT = FILM.output, FPS = OUT.fps, N = OUT.frameCount;
const fail = m => { throw new Error(`[{{NAME}}] ${m}`); };
if (FILM.schemaVersion !== 2) fail('film.json 要是 schemaVersion 2（附录 C6）');
if (!(Number.isInteger(FPS) && FPS > 0 && Number.isInteger(N) && N > 0)) fail('film.json 的 output.fps 与 output.frameCount 要是正整数');
const R = window.__RENDER;   // 渲染器注入的实际规格：帧率必须等于 film.json，否则一拍二会变成 2、3 帧交替
if (R && R.fps && R.fps !== FPS) fail(`渲染器的帧率 ${R.fps} 和 film.json 的 ${FPS} 不一致：改 film.json 或换交付档位`);
if (Math.abs(innerWidth / innerHeight - OUT.width / OUT.height) > 0.01)
  fail(`画面 ${innerWidth}×${innerHeight} 和 film.json 的 ${OUT.width}×${OUT.height} 画幅比不同：本模版按 16:9 构图，直接调渲染器时带 --size ${OUT.width}x${OUT.height}（或它的整数倍）`);

// ── 事件：画面、声音、字幕读同一张表（film.json events，单位：帧） ──
const EV = new Map((FILM.events || []).map(e => [e.id, e]));
const eventFrame = id => { const e = EV.get(id); if (!e) fail(`film.json 的 events 里没有 ${id}`); return e.frame; };

// ── 字体：只用本片子集（tools/fonts/subset.mjs 生成）；缺字直接报错，不静默回退系统字体 ──
const fonts = await loadFilmFonts(new URL('./fonts/', import.meta.url));
const TEXT = new Map((FILM.texts || []).map(t => [t.id, t]));
for (const t of TEXT.values()) fonts.assert(t.font, t.text, `texts.${t.id}`);

// ── 画风：film.json 的 style 与每个镜头的 lookPreset 都必须在注册表里（engine/style/registry.json） ──
const style = await loadStyle(FILM.style);
const film = createFilm({ designHeight: OUT.height });     // 镜头在 1920×1080 设计稿上摆；4K 时 K = 2，构图不变
const { W, H, K, DW, DH } = film;
const animatic = q.has('animatic');
const look = createLook(film.renderer, W, H, {
  ss: animatic ? 1 : 2, msaa: 4, refHeight: style.lookDefaults.refHeight, fogColor: style.lookDefaults.fogColor,
  defaults: style.lookDefaults.params, paperUrl: new URL(`../../${style.lookDefaults.paper.asset}`, import.meta.url).href,
});
const sun = makeSun(eventFrame('sun-break'), FPS);

const shots = [];
for (const s of FILM.shots) {
  const p = parseLookPreset(s.lookPreset);
  if (styleKey(p) !== styleKey(parseStyleRef(FILM.style))) fail(`镜头 ${s.id} 的 lookPreset ${s.lookPreset} 不属于本片画风 ${styleKey(parseStyleRef(FILM.style))}`);
  const preset = (name = p.preset, overrides = s.lookOverrides || {}) => {
    const r = resolveLook(style, name, overrides, { strict: true });   // 越出 allowedOverrides 直接报错（改画风要升版本）
    return r.params;
  };
  const mod = await import(new URL(s.module, import.meta.url).href);
  const shot = await mod.build({ shot: s, fps: FPS, DW, DH, K, preset, mixLook, sun, eventFrame });
  const tuned = { ...shot, look: t => (window.__LOOKDEV ? mergeParams(shot.look(t), window.__LOOKDEV) : shot.look(t)) };
  shots.push({ at: s.in / FPS, spec: s, shot: animatic ? draft(tuned) : tuned });
}
// 动态预演：同一条时间轴、同样的镜头，关掉笔触、纸纹与颗粒（快、也不让人把预演当成终版画面）
function draft(shot) { return { ...shot, look: t => ({ ...shot.look(t), kuwahara: false, paper: { strength: 0.04 }, grain: 0 }) }; }
// 剪影检查：只留描边的三维物体（峰、礁、松、渡船），一律涂成纯黑不受光；底板、水、辉光、尾迹全部隐藏，白底直出不过后期。
// 缩到 160 px 宽仍认得出「峰群 + 一条船」，主体的形才算立住了（灰度缩略图看明度，这里只看形）。
const sil = q.has('sil');
if (sil) {
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  for (const { shot } of shots) {
    shot.scene.background = new THREE.Color(0xffffff);
    shot.scene.traverse(o => { if (o.isMesh || o.isSprite) { if (o.userData.outline === true) o.material = black; else o.visible = false; } });
  }
}
const silPost = { ready: Promise.resolve(), render(scene, camera) { film.renderer.setRenderTarget(null); film.renderer.render(scene, camera); } };

// ── 显示层：片名在 S2 左上的天空留白里显影；副标题随后淡入。位置按设计稿像素 × K ──
const tTitle = TEXT.get('title'), tSub = TEXT.get('subtitle');
const fIn = eventFrame('title-in');
const T = createTitle({ text: tTitle.text, font: fontSpec(400, 158 * K, [tTitle.font]), size: 158 * K, x: 214 * K, y: 330 * K, ls: 0.06 });
const nG = T.glyphs.length, stagger = nG > 1 ? Math.min(8, 12 / (nG - 1)) : 0, dev = 22;   // 字越多错开越小：整行约 1.3 秒显完
const fFull = fIn + Math.round(stagger * (nG - 1)) + dev;
const titleP = f => { const h = fIn + hold(f - fIn, 2) * 2; return T.glyphs.map((_, i) => eo(seg(h, fIn + i * stagger, fIn + i * stagger + dev))); };   // 一拍二地洇开；先快后慢（墨落纸上洇得快、越往外越慢）
const subF = fontSpec(400, 30 * K, [tSub.font]), subX = 222 * K, subY = 330 * K + 158 * K * 0.55 + 62 * K, subLs = 0.2 * 30 * K;
const subA = f => ss(seg(f, fFull - 10, fFull + 6));   // 副标题在片名收尾时淡入：完整停留 ≥ 字数 × 0.12 秒（QA 的读字时长门）
function drawText(ctx, f) {
  if (q.has('notext') || f < fIn) return;
  T.draw(ctx, titleP(f));
  const a = subA(f);
  if (a > 0.003) {
    ctx.save(); ctx.font = subF; ctx.textBaseline = 'alphabetic'; ctx.letterSpacing = `${subLs.toFixed(2)}px`;
    ctx.shadowColor = `rgba(36,30,86,${(0.7 * a).toFixed(3)})`; ctx.shadowBlur = 14 * K;      // 暗晕托底：浅色字压在亮天上也够对比度
    ctx.fillStyle = `rgba(255,248,240,${(0.94 * a).toFixed(3)})`; ctx.fillText(tSub.text, subX, subY);
    ctx.restore();
  }
}
function texts(t) {
  const f = frameOf(t, FPS), out = [];
  if (q.has('notext') || f < fIn) return out;
  const p = Math.min(...titleP(f));
  if (p > 0) out.push({ id: 'title', text: tTitle.text, box: T.box().map(v => Math.round(v)), alpha: +p.toFixed(3), font: tTitle.font });
  const a = subA(f);
  if (a > 0) {
    const c = document.createElement('canvas').getContext('2d'); c.font = subF; c.letterSpacing = `${subLs}px`;
    const m = c.measureText(tSub.text);
    out.push({ id: 'subtitle', text: tSub.text, box: [Math.round(subX), Math.round(subY - m.actualBoundingBoxAscent), Math.round(m.width), Math.round(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent)], alpha: +a.toFixed(3), font: tSub.font });
  }
  return out;
}
// 构图参考线（?guides=1）：三分线（细）、图文安全区 90%（实线）、动作安全区 93%（虚线）、本帧文字的方框（暖色）
function drawGuides(ctx, t) {
  ctx.save(); ctx.lineWidth = Math.max(1, K);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  for (const k of [1, 2]) { ctx.beginPath(); ctx.moveTo(W * k / 3, 0); ctx.lineTo(W * k / 3, H); ctx.moveTo(0, H * k / 3); ctx.lineTo(W, H * k / 3); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(120,255,200,0.8)'; ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9);
  ctx.setLineDash([8 * K, 6 * K]); ctx.strokeRect(W * 0.035, H * 0.035, W * 0.93, H * 0.93); ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,190,90,0.95)'; for (const x of texts(t)) ctx.strokeRect(...x.box);
  ctx.restore();
}
// 动态预演的时间条：镜头分段、事件刻度、播放头（不用字，免得引入子集外的字形）
function drawTimebar(ctx, f) {
  const x0 = 96 * K, x1 = W - 96 * K, y = H - 34 * K, X = fr => x0 + (x1 - x0) * fr / N;
  ctx.save(); ctx.fillStyle = 'rgba(10,10,30,0.55)'; ctx.fillRect(x0, y - 6 * K, x1 - x0, 12 * K);
  FILM.shots.forEach((s, i) => { ctx.fillStyle = i % 2 ? 'rgba(160,170,230,0.8)' : 'rgba(230,200,170,0.8)'; ctx.fillRect(X(s.in) + K, y - 4 * K, X(s.out) - X(s.in) - 2 * K, 8 * K); });
  ctx.fillStyle = '#FFC46B'; for (const e of EV.values()) ctx.fillRect(X(e.frame) - K, y - 14 * K, 2 * K, 28 * K);
  ctx.fillStyle = '#fff'; ctx.fillRect(X(f) - 1.5 * K, y - 18 * K, 3 * K, 36 * K);
  ctx.restore();
}

window.TIMELINE = { fps: FPS, frameCount: N, shots: FILM.shots.map(({ id, in: a, out: b }) => ({ id, in: a, out: b })), events: [...EV.values()] };
await film.run({
  dur: N / FPS, fps: FPS, post: sil ? silPost : look, debug: q.get('dbg'),
  shots: shots.map(({ at, shot }) => ({ at, shot })),
  draw: (ctx, t) => { const f = frameOf(t, FPS); if (!sil) drawText(ctx, f); if (animatic) drawTimebar(ctx, f); if (q.has('guides')) drawGuides(ctx, t); },
  texts,
  warm: [0, ...FILM.shots.map(s => (s.in + s.out) / 2 / FPS), eventFrame('sun-break') / FPS, (N - 1) / FPS],
});
