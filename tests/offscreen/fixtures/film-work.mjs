// 影片外壳（engine/offscreen/film.mjs）的作品夹具：两个镜头（纯色背景，S1 红、S2 蓝，切点第 6 帧）+ 显示层在左上角画一块半透明的白。
// 后期全关；检查切镜、局部帧号与显示层合成。
import { createFilm } from '../../../engine/offscreen/film.mjs';
import { createLook } from '../../../engine/offscreen/tsl/look.js';

export async function build({ THREE, TSL, renderer, pipeline, width: W, height: H }) {
  const film = await createFilm({ THREE, TSL, renderer, pipeline, width: W, height: H, designHeight: H });
  const seen = globalThis.__FILM_SEEN = [];
  const shot = (hex, id) => {
    const scene = new THREE.Scene(); scene.background = new THREE.Color(hex);
    return { scene, camera: new THREE.PerspectiveCamera(30, W / H, 0.1, 10), update: (t, f, c) => seen.push([id, f, c.localFrame]), look: () => ({}) };
  };
  const OFF = { outline: false, kuwahara: false, bloom: false, paper: false, vignette: 0, grain: 0, grade: { exposure: 1, warmth: 0, lift: 0, gamma: 1, gain: 1, saturation: 1, shoulder: 1 } };
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0, fps: 24, defaults: OFF });
  return film.work({
    dur: 12 / 24, fps: 24, look,
    shots: [{ id: 'S1', in: 0, out: 6, shot: shot(0xff0000, 'S1') }, { id: 'S2', in: 6, out: 12, shot: shot(0x0000ff, 'S2') }],
    draw: ctx => { ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(0, 0, W / 2, H / 2); },
    texts: () => [{ id: 'x', text: '渡', box: [0, 0, 10, 10] }],
  });
}
