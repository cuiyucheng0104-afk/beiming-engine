// 晨渡 · 离屏出片入口（Node + Dawn，three r187 + TSL）：同一个 story.js 建出同一部片——同一份世界、镜头、后期预设、片名与 TEXTS，
// 只是运行时换成离屏那一份（TSL 卡通材质、TSL 底板工具、几何桥、PNG 解码）。作品模块契约见 docs/offscreen/README.md 2.1。
//   npm run offscreen -- render films/chendu/offscreen.mjs --out <文件.mp4> --frames 0:192 --size 1920x1080 --fps 24
// 查询串（宿主的 query，参数名与页面 main.js 相同）：msaa=0（默认 4）、animatic=1、notext=1、lookdev=<JSON>（合并到每镜预设之上）
// 片名题字等显示层代码用 document.createElement('canvas')：这里垫一个只会建画布的 document（Skia 画布），别的 DOM 一律报错。
import { readFileSync } from 'node:fs';
import { URL, URLSearchParams, fileURLToPath } from 'node:url';
import { makeStory } from './story.js';
import { createFilm } from '../../engine/offscreen/film.mjs';
import { createLook } from '../../engine/offscreen/tsl/look.js';
import { toonKind, makeToonShared, setToonShared, useR170Shadow } from '../../engine/offscreen/tsl/toon.js';
import { patchLayer } from '../../engine/offscreen/tsl/surface.js';
import { createPlates } from '../../engine/offscreen/tsl/plates.js';
import { geometry } from '../../engine/offscreen/bridge.mjs';
import { loadPaper } from '../../engine/offscreen/paper.mjs';
import { loadCanvas, loadFilmFonts } from '../../engine/offscreen/canvas.mjs';
import { decodePng } from '../../tools/plates/png.mjs';
import { loadStyleSync, mergeParams } from '../../engine/style/index.js';
import { frameOf } from '../../engine/core/clock.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export async function build({ THREE, TSL, renderer, pipeline, width: W, height: H, fps, query: q = new URLSearchParams() }) {
  const FILM = JSON.parse(readFileSync(new URL('./film.json', import.meta.url), 'utf8'));
  if (fps !== FILM.output.fps) throw new Error(`[chendu] 离屏帧率 ${fps} 和 film.json 的 ${FILM.output.fps} 不一致：一拍二会错拍，出片时带 --fps ${FILM.output.fps}`);
  if (Math.abs(W / H - FILM.output.width / FILM.output.height) > 0.01) throw new Error(`[chendu] 画幅 ${W}×${H} 和 film.json 的画幅比不同：本片按 16:9 构图`);
  const msaa = q.has('msaa') ? +q.get('msaa') : 4, animatic = q.has('animatic'), notext = q.has('notext'), lookdev = q.has('lookdev') ? JSON.parse(q.get('lookdev')) : null;
  const { createCanvas } = await loadCanvas();
  globalThis.document ??= { createElement(tag) { if (tag !== 'canvas') throw new Error(`离屏没有 DOM：只能建画布，收到 <${tag}>`); return createCanvas(1, 1); } };

  const style = loadStyleSync(FILM.style);
  const film = await createFilm({ THREE, TSL, renderer, pipeline, width: W, height: H, designHeight: FILM.output.height });
  const rt = {
    THREE, TSL, setToonShared, patchLayer,
    toonKind: spec => toonKind({ THREE, TSL }, spec),
    makeToonShared: init => makeToonShared({ THREE, TSL }, init),
    P: await createPlates({ THREE, TSL }),
    geo: g => geometry(THREE, g),
    readJson: async url => JSON.parse(readFileSync(fileURLToPath(url), 'utf8')),
    loadTexture: async url => {   // 同 TextureLoader 读图的朝向；作品随后照样设 sRGB、三线性与各向异性
      const png = decodePng(readFileSync(fileURLToPath(url)));
      const t = new THREE.DataTexture(png.data, png.width, png.height, THREE.RGBAFormat);
      t.flipY = true; t.generateMipmaps = true; t.needsUpdate = true;
      return t;
    },
    prepLight: L => useR170Shadow(TSL, L),
  };
  const look = createLook({ THREE, TSL, renderer }, {
    width: W, height: H, ss: animatic ? 1 : 2, msaa, refHeight: style.lookDefaults.refHeight, fps,
    defaults: style.lookDefaults.params, paper: loadPaper(THREE, `${ROOT}${style.lookDefaults.paper.asset}`),
  });
  const story = await makeStory({
    FILM, fonts: await loadFilmFonts(fileURLToPath(new URL('./fonts/', import.meta.url))), style, rt, K: film.K, DW: film.DW, DH: film.DH, animatic, notext,
    loadShot: s => import(new URL(s.module, import.meta.url).href),
    tune: look => (lookdev ? mergeParams(look, lookdev) : look),
  });
  return film.work({
    dur: FILM.output.frameCount / fps, fps, look,
    shots: story.shots.map(({ at, shot }) => ({ at, shot })),
    draw: (ctx, t) => story.drawText(ctx, frameOf(t, fps)),
    texts: story.texts,
  });
}
