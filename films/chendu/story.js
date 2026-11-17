// 晨渡 · 两边共用的「片子本身」：事件表、字体核对、世界与太阳、按镜头表建镜头（含预演版）、片名与副标题的显示层、TEXTS。
// A 路线页面（main.js）与离屏出片（offscreen.mjs）都调 makeStory；页面独有的东西（查询参数、剪影检查、构图参考线、预演时间条）留在 main.js。
// 内容从模版的 main.js 原样搬来，时间与版式的数字一个没改。
//   await makeStory({ FILM, fonts, style, rt, K, DW, DH, animatic, loadShot, tune }) → { EV, eventFrame, world, sun, shots, drawText(ctx, f), texts(t) }
//     fonts      loadFilmFonts 的结果（页面 engine/style/fonts.js，离屏 engine/offscreen/canvas.mjs，两边接口相同）
//     loadShot   s => 镜头模块（页面 import(URL)，离屏 import(文件)）；tune(look) 页面的 lookdev 扫参（离屏不给）；notext 不画字（?notext=1）
import { fontSpec } from '../../engine/overlay/text.js';
import { frameOf, hold } from '../../engine/core/clock.js';
import { ss, seg } from '../../engine/core/math.js';
import { parseLookPreset, styleKey, parseStyleRef, resolveLook, mixLook } from '../../engine/style/index.js';
import { makeWorld } from './world.js';
import { createTitle } from './title.js';

export async function makeStory({ FILM, fonts, style, rt, K, DW, DH, animatic = false, notext = false, loadShot, tune = f => f }) {
  const FPS = FILM.output.fps;
  const fail = m => { throw new Error(`[chendu] ${m}`); };
  // ── 事件：画面、声音、字幕读同一张表（film.json events，单位：帧） ──
  const EV = new Map((FILM.events || []).map(e => [e.id, e]));
  const eventFrame = id => { const e = EV.get(id); if (!e) fail(`film.json 的 events 里没有 ${id}`); return e.frame; };

  // ── 字体：只用本片子集（tools/fonts/subset.mjs 生成）；缺字直接报错，不静默回退系统字体 ──
  const TEXT = new Map((FILM.texts || []).map(t => [t.id, t]));
  for (const t of TEXT.values()) fonts.assert(t.font, t.text, `texts.${t.id}`);

  const world = makeWorld(rt);
  const sun = world.makeSun(eventFrame('sun-break'), FPS);

  const shots = [];
  for (const s of FILM.shots) {
    const p = parseLookPreset(s.lookPreset);
    if (styleKey(p) !== styleKey(parseStyleRef(FILM.style))) fail(`镜头 ${s.id} 的 lookPreset ${s.lookPreset} 不属于本片画风 ${styleKey(parseStyleRef(FILM.style))}`);
    const preset = (name = p.preset, overrides = s.lookOverrides || {}) => {
      const r = resolveLook(style, name, overrides, { strict: true });   // 越出 allowedOverrides 直接报错（改画风要升版本）
      return r.params;
    };
    const mod = await loadShot(s);
    const shot = await mod.build({ shot: s, fps: FPS, DW, DH, K, preset, mixLook, sun, eventFrame, world, rt });
    const tuned = { ...shot, look: t => tune(shot.look(t)) };
    shots.push({ at: s.in / FPS, spec: s, shot: animatic ? draft(tuned) : tuned });
  }
  // 动态预演：同一条时间轴、同样的镜头，关掉笔触、纸纹与颗粒（快、也不让人把预演当成终版画面）
  function draft(shot) { return { ...shot, look: t => ({ ...shot.look(t), kuwahara: false, paper: { strength: 0.04 }, grain: 0 }) }; }

  // ── 显示层：片名在 S2 左上的天空留白里题写（墨色，像山水画的题款）；副标题随后落款。位置按设计稿像素 × K ──
  // 字重从 film.json 的 fonts 读（子集就是按这个字重生成的），不在这里另写一份
  const INK = [42, 45, 82];   // 画风的墨（world.js 的 PAL.ink）：片名、副标题与山石的墨线同一种墨
  const weightOf = fam => (FILM.fonts || []).find(f => f.family === fam)?.weight ?? 400;
  const tTitle = TEXT.get('title'), tSub = TEXT.get('subtitle');
  const fIn = eventFrame('title-in');
  const T = createTitle({ text: tTitle.text, font: fontSpec(weightOf(tTitle.font), 158 * K, [tTitle.font]), size: 158 * K, x: 214 * K, y: 330 * K, ls: 0.06, color: INK });
  const nG = T.glyphs.length, stagger = nG > 1 ? Math.min(8, 12 / (nG - 1)) : 0, dev = 26;   // 字越多错开越小：每个字约 1.1 秒洇满，整行约 1.4 秒
  // 一拍二地洇开，先快后慢（墨落纸上洇得快、越往外越慢；二次缓出，留出看得见的洇开过程）。事件帧就是第一笔墨落纸的那一帧：画面在这一帧已经有墨，
  // 声音（sound.py 的落笔声）同帧起音——结果帧对拍，声音不抢在画面前面（craft/animation.md §5.4、§5.7）
  const titleP = f => { const h = hold(f - fIn, 2) * 2 + 2; return T.glyphs.map((_, i) => { const u = seg(h, i * stagger, i * stagger + dev); return 1 - (1 - u) * (1 - u); }); };
  const subStart = fIn + Math.round(stagger * (nG - 1)) + 8;   // 最后一个字洇开一阵之后再落款：先读片名，再读副标题
  const subF = fontSpec(weightOf(tSub.font), 32 * K, [tSub.font]), subX = 222 * K, subY = 330 * K + 158 * K * 0.55 + 62 * K, subLs = 0.18 * 32 * K;
  const subA = f => ss(seg(f, subStart, subStart + 10));   // 完整停留 ≥ 字数 ÷ 4.5 + 1.5 秒（DIRECTING 步骤 9 的读字时长）
  function drawText(ctx, f) {
    if (notext || f < fIn) return;
    T.draw(ctx, titleP(f));
    const a = subA(f);
    if (a > 0.003) {
      ctx.save(); ctx.font = subF; ctx.textBaseline = 'alphabetic'; ctx.letterSpacing = `${subLs.toFixed(2)}px`;
      ctx.shadowColor = `rgba(255,246,236,${(0.45 * a).toFixed(3)})`; ctx.shadowBlur = 10 * K;   // 一圈很淡的纸色：小字压在云纹上也清楚（不靠它过对比度）
      ctx.fillStyle = `rgba(${INK.join(',')},${(0.95 * a).toFixed(3)})`; ctx.fillText(tSub.text, subX, subY);
      ctx.restore();
    }
  }
  function texts(t) {
    const f = frameOf(t, FPS), out = [];
    if (notext || f < fIn) return out;
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
  return { EV, eventFrame, world, sun, shots, drawText, texts };
}
