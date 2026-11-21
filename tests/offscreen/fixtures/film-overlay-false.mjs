// 「画了又返回 false」回归夹具：第 1 帧在 (0,0) 画白点并返回 false（本帧不叠图），第 2 帧在 (5,0) 画绿点。
import { createFilm } from '../../../engine/offscreen/film.mjs';
import { createLook } from '../../../engine/offscreen/tsl/look.js';

export async function build({ THREE, TSL, renderer, pipeline, width: W, height: H }) {
  const film = await createFilm({ THREE, TSL, renderer, pipeline, width: W, height: H, designHeight: H });
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xff0000);
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 10);
  const OFF = { outline: false, kuwahara: false, bloom: false, paper: false, vignette: 0, grain: 0, grade: { exposure: 1, warmth: 0, lift: 0, gamma: 1, gain: 1, saturation: 1, shoulder: 1 } };
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0, fps: 24, defaults: OFF });
  return film.work({
    dur: 3 / 24, fps: 24, look,
    shots: [{ id: 'S1', in: 0, out: 3, shot: { scene, camera, update() {}, look: () => ({}) } }],
    draw(ctx, _t, _shot, sctx) {
      if (sctx.localFrame === 1) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1, 1); return false; }
      if (sctx.localFrame === 2) { ctx.fillStyle = '#00ff00'; ctx.fillRect(5, 0, 1, 1); }
    },
  });
}
