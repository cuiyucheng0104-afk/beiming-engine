// 空显示层回归夹具：只有第 1 帧画 1 个白像素，其余帧不调用任何绘制方法。
import { createFilm } from '../../../engine/offscreen/film.mjs';
import { createLook } from '../../../engine/offscreen/tsl/look.js';

export async function build({ THREE, TSL, renderer, pipeline, width: W, height: H }) {
  const stats = globalThis.__OVERLAY_STATS = { reads: 0, clears: 0, pipelines: 0 };
  const countedPipeline = node => { stats.pipelines++; return pipeline(node); };
  const film = await createFilm({ THREE, TSL, renderer, pipeline: countedPipeline, width: W, height: H, designHeight: H });
  for (const [name, key] of [['getImageData', 'reads'], ['clearRect', 'clears']]) {
    const orig = film.ctx[name].bind(film.ctx);
    film.ctx[name] = (...args) => { stats[key]++; return orig(...args); };
  }
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xff0000);
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 10);
  const OFF = { outline: false, kuwahara: false, bloom: false, paper: false, vignette: 0, grain: 0, grade: { exposure: 1, warmth: 0, lift: 0, gamma: 1, gain: 1, saturation: 1, shoulder: 1 } };
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0, fps: 24, defaults: OFF });
  return film.work({
    dur: 4 / 24, fps: 24, look,
    shots: [{ id: 'S1', in: 0, out: 4, shot: { scene, camera, update() {}, look: () => ({}) } }],
    draw(ctx, _t, _shot, sctx) {
      if (sctx.localFrame === 1) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1, 1); }
    },
  });
}
