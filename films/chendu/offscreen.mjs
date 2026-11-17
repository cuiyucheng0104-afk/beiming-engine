// 晨渡 · 同源离屏与 WebGPU 预览入口（three r187 + TSL）：同一个 story.js 建出同一部片——同一份世界、镜头、后期预设、片名与 TEXTS，
// 顶层不导入任何 node:* 模块，既可在 Chrome 的 WebGPU 预览页（?work=/films/chendu/offscreen.mjs）实时播控，也可在 Node + Dawn 里高速出片。
//   npm run offscreen -- render films/chendu/offscreen.mjs --out <文件.mp4> --frames 0:192 --size 1920x1080 --fps 24
// 查询串（宿主的 query，参数名与页面 main.js 相同）：msaa=0（默认 4）、animatic=1、notext=1、lookdev=<JSON>（合并到每镜预设之上）
import { makeStory } from './story.js';
import { createFilm } from '../../engine/offscreen/film.mjs';
import { createLook } from '../../engine/offscreen/tsl/look.js';
import { toonKind, makeToonShared, setToonShared, useR170Shadow } from '../../engine/offscreen/tsl/toon.js';
import { patchLayer } from '../../engine/offscreen/tsl/surface.js';
import { createPlates } from '../../engine/offscreen/tsl/plates.js';
import { geometry } from '../../engine/offscreen/bridge.mjs';
import { loadPaperAsync } from '../../engine/offscreen/paper.mjs';
import { readJson, loadFilmFontsIso } from '../../engine/offscreen/io.mjs';
import { loadStyle, mergeParams } from '../../engine/style/index.js';
import { frameOf } from '../../engine/core/clock.js';

export async function build({ THREE, TSL, renderer, pipeline, width: W, height: H, fps, query: q = new globalThis.URLSearchParams() }) {
  const FILM = await readJson(new globalThis.URL('./film.json', import.meta.url));
  if (fps !== FILM.output.fps) throw new Error(`[chendu] 离屏帧率 ${fps} 和 film.json 的 ${FILM.output.fps} 不一致：一拍二会错拍，出片时带 --fps ${FILM.output.fps}`);
  if (Math.abs(W / H - FILM.output.width / FILM.output.height) > 0.01) throw new Error(`[chendu] 画幅 ${W}×${H} 和 film.json 的画幅比不同：本片按 16:9 构图`);
  const msaa = q.has('msaa') ? +q.get('msaa') : 4, animatic = q.has('animatic'), notext = q.has('notext'), lookdev = q.has('lookdev') ? JSON.parse(q.get('lookdev')) : null;

  const style = await loadStyle(FILM.style);
  const film = await createFilm({ THREE, TSL, renderer, pipeline, width: W, height: H, designHeight: FILM.output.height });
  const P = await createPlates({ THREE, TSL });
  const rt = {
    THREE, TSL, setToonShared, patchLayer,
    toonKind: spec => toonKind({ THREE, TSL }, spec),
    makeToonShared: init => makeToonShared({ THREE, TSL }, init),
    P,
    geo: g => geometry(THREE, g),
    readJson: url => readJson(url),
    loadTexture: url => P.loadTextureAsync(url),
    prepLight: L => useR170Shadow(TSL, L),
  };
  const look = createLook({ THREE, TSL, renderer }, {
    width: W, height: H, ss: animatic ? 1 : 2, msaa, refHeight: style.lookDefaults.refHeight, fps,
    defaults: style.lookDefaults.params, paper: await loadPaperAsync(THREE, style.lookDefaults.paper.asset),
  });
  const story = await makeStory({
    FILM, fonts: await loadFilmFontsIso(new globalThis.URL('./fonts/', import.meta.url)), style, rt, K: film.K, DW: film.DW, DH: film.DH, animatic, notext,
    loadShot: s => import(new globalThis.URL(s.module, import.meta.url).href),
    tune: lk => (lookdev ? mergeParams(lk, lookdev) : lk),
  });
  return film.work({
    dur: FILM.output.frameCount / fps, fps, look,
    shots: story.shots.map(({ at, shot }) => ({ at, shot })),
    draw: (ctx, t) => story.drawText(ctx, frameOf(t, fps)),
    texts: story.texts,
  });
}
