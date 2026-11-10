// {{TITLE}} · 镜头 S2「近」：切近孤峰（竖直视场 28°），峰仍在右三分线（切点前后视觉落点只挪约 40 px，VISUAL-DESIGN §4.4），
// 太阳在峰右侧的远山后升起——film.json 的日出事件那一帧，日轮刚好露出一线并亮一下（拍点帧就是结果帧），
// 声音在同一帧响（sound.py 读同一个事件）。之后按画风登记的光的剧本从 hero 过渡到 hero-sunrise：假暖退场、真暖登场。
// 左上方是天空留白：片名在那里显影（main.js 画），离主体一个三分格以上。
import * as THREE from 'three';
import { aimCamera, placeOnScreen, screenToPlane, project, dirOf } from '../../../engine/stage/camera.js';
import { plate, glowSprite, tileRepeat } from '../../../engine/stage/plates.js';
import { hold, frameOf } from '../../../engine/core/clock.js';
import { DEG, eo, ss, seg, lerp } from '../../../engine/core/math.js';
import { PAL, SUN, setToon, sunrise, sunDisc, buildIslet, buildBoat, buildWake, boatPose, keyLight, buildWater, waterFrame, ridgeTexture, mistTexture, loadPlate, ISLET } from '../world.js';
import { billboard } from './s1.js';

export async function build({ shot, fps, DW, DH, preset, mixLook, sun, eventFrame }) {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(28, DW / DH, 1, 60000);
  const C0 = new THREE.Vector3(-40, 16, 560), C1 = new THREE.Vector3(-40.7, 17.5, 550);   // 推 10 m、升 1.5 m
  const YAW = 4.04 * DEG, PITCH = 6.58 * DEG;      // 峰落在右三分线、峰尖在上三分线附近、地平线压低到 y≈790 给天空留白
  aimCamera(cam, C0, YAW, PITCH);
  const cam0 = cam.clone();
  const fSun = eventFrame('sun-break');

  // ── 天空、日晕、日轮 ──
  const sky = plate(await loadPlate('sky_dawn', { flipX: true }), 0);
  const glowU = 1 - sky.material.map.userData.meta['关键位置']['地平线辉光中心_x'];
  const sunX = sun.screenX(cam0, DW, DH), skyW = DW * 1.35;
  const skyRect = [sunX - (glowU - 0.5) * skyW - skyW / 2, 820 - skyW / 2, skyW, skyW / 2];   // [左, 上, 宽, 高]：底边（画好的地平线）压在真地平线下
  placeOnScreen(sky, cam0, DW, DH, skyRect[0] + skyW / 2, skyRect[1] + skyW / 4, skyW, 20000, skyW / 2);
  const halo = glowSprite(PAL.sun, { order: 0.5, amt: 0.4, core: 0.25, squash: 2.4 });
  placeOnScreen(halo, cam0, DW, DH, sunX, 770, 1150, 15000, 1150);
  const disc = sunDisc({ order: 0.6 });

  // ── 远山：山脊在太阳正下方那一点的高度，按「事件帧日轮刚露出一半」反算摆位（构图服从事件，不手调） ──
  const W2 = DW * 1.5, H2 = 720, left = DW / 2 - W2 / 2;
  const crestY = project(cam0, DW, DH, cam0.position.clone().addScaledVector(dirOf(-SUN.az, sun.elev(fSun) + 0.45 * SUN.coreDeg), 1e4)).y;
  const uSun = (sunX - left) / W2;
  const far = ridgeTexture({ seed: 59, color: PAL.ridgeFar, light: PAL.ridgeLight, base: 0.58, amp: 0.24, sunU: uSun });
  const ridgeFar = plate(far.tex, 1); placeOnScreen(ridgeFar, cam0, DW, DH, DW / 2, crestY - far.topAt(uSun) * H2 + H2 / 2, W2, 4200, H2);
  const mid = ridgeTexture({ seed: 83, color: PAL.ridgeMid, light: PAL.ridgeLight, base: 0.62, amp: 0.2, sunU: uSun });
  const ridgeMid = plate(mid.tex, 2); placeOnScreen(ridgeMid, cam0, DW, DH, DW / 2, crestY + 22 - mid.topAt(uSun) * H2 + H2 / 2, W2, 2600, H2);   // 近山在太阳下方更低：挡住日轮的是远山
  scene.add(sky, halo, disc, ridgeFar, ridgeMid);
  const mists = [[792, 200, 1800, 3, 0.85, 5], [848, 110, 480, 5, 0.66, 13], [1050, 230, 150, 7, 0.3, 17]].map(([y, h, D, order, op, seed]) => {
    const m = mistTexture({ seed }); m.repeat.x = tileRepeat(m, DW * 1.6, h);
    const p = plate(m, order, { opacity: op }); placeOnScreen(p, cam0, DW, DH, DW / 2, y, DW * 1.6, D, h); scene.add(p); return m;
  });
  const veil = glowSprite(PAL.sun, { order: 3.5, amt: 0, core: 0.2, squash: 3.2 });   // 光从雾后透出来：加色辉光叠在远雾之上（craft/two-five-d.md §4.1）
  placeOnScreen(veil, cam0, DW, DH, sunX, 792, 1000, 1700, 1000); scene.add(veil);

  // ── 三维：同一组峰与礁（世界位置不变），渡船换到左下中景继续向右（屏幕方向与 S1 一致） ──
  scene.add(buildIslet());
  const water = buildWater({ sky: sky.material.map, skyRect, DW, DH }); scene.add(water);   // 水面倒映的就是这张天空
  const boat = buildBoat(), wake = buildWake(), boatBase = screenToPlane(cam0, DW, DH, 600, 962).clone(); scene.add(boat, wake);
  const lamp = glowSprite(PAL.lamp, { order: 5.5, amt: 1.3, core: 1.8 }); scene.add(lamp);
  const key = keyLight(sun.keyDir(), ISLET.clone().add(new THREE.Vector3(0, 50, 0))); scene.add(key, key.target);

  const lampAt = new THREE.Vector3();
  const kAt = f => ss(seg(f, fSun - 6, fSun + 30));   // 日出过渡进度：事件前 6 帧起、后 30 帧到位
  function update(t, f) {
    const lf = f - shot.in, n = shot.out - shot.in, u = Math.min(1, lf / n);
    aimCamera(cam, new THREE.Vector3().lerpVectors(C0, C1, eo(u) * 0.85 + u * 0.15), YAW, PITCH);   // 接着上一镜的推：起步有速度，结尾落定
    mists.forEach((m, i) => { m.offset.x = (0.003 + 0.002 * i) * t; });
    const sp = sun.place(disc, cam0, DW, DH, f, { size: 300, D: 15000 });
    const k = kAt(f), glint = disc.material.uniforms.glint.value;
    disc.material.uniforms.amt.value = lerp(0.85, 1.2, k);
    placeOnScreen(halo, cam0, DW, DH, sp.x, Math.max(sp.y, 700) + 30, lerp(1150, 1500, k), 15000, lerp(1150, 1500, k));   // 日晕跟着日轮走，升起后变大
    halo.material.uniforms.amt.value = lerp(0.4, 1.25, k) + 0.3 * glint;
    veil.material.uniforms.amt.value = 0.42 * k + 0.25 * glint;
    sunrise(k);
    boatPose(boat, boatBase, 2.2, lf / fps, hold(f, 2), 2);
    wake.position.set(boat.position.x, 0, boat.position.z);
    boat.updateMatrixWorld(); lampAt.set(5.2, 2.3, 0).applyMatrix4(boat.matrixWorld);
    billboard(lamp, cam, lampAt, 16, DH);
    waterFrame(water, cam, DW, DH, { t, held: hold(f, 2), sunAz: sun.az, sunUp: k });
    setToon({ inkTime: hold(f, 2), keyDir: sun.keyDir().toArray(), fillDir: [0, -1, 0], fillGain: lerp(0.8, 0.62, k), skyGain: 1, exposure: lerp(1, 1.12, k) });
  }
  // 光的剧本：画风登记的 hero → hero-sunrise 两态之间按事件进度插值（allowedOverrides「日出过渡」）
  const A = preset('hero'), B = preset('hero-sunrise');
  return { scene, camera: cam, update, look: t => ({ t, ...mixLook(A, B, kAt(frameOf(t, fps))) }) };
}
