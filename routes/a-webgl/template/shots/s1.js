// {{TITLE}} · 镜头 S1「远」：晨前的江面，孤峰在右三分线上，乌篷渡船在左三分线下方驶向它。长焦（竖直视场 16°）压缩远山，
// 缓推 + 微移：前景岸石、近雾、礁脚雾、峰、远山、天空按视深 D 拉开视差（D 越小动得越多；天空不动）。
// 构图（1920×1080 设计稿）：地平线在下三分线 y≈720，峰尖在上三分线附近，主体中心 x≈1290；左下前景压角、右侧留天空给太阳。
// 时间：镜头与雾、水每帧都动（一拍一）；渡船起伏一拍二；墨线与皴线一拍二沸腾。镜头时长读 film.json，改 in / out 运镜自动伸缩。
import * as THREE from 'three';
import { aimCamera, placeOnScreen, screenToPlane } from '../../../engine/stage/camera.js';
import { plate, cutoutPlane, glowSprite, tileRepeat } from '../../../engine/stage/plates.js';
import { hold } from '../../../engine/core/clock.js';
import { DEG } from '../../../engine/core/math.js';
import { PAL, setToon, frameCamera, peakPoint, buildIslet, buildBoat, buildWake, boatPose, keyLight, buildWater, waterFrame, ridgeTexture, mistTexture, foregroundTexture, loadPlate, ISLET } from '../world.js';

export async function build({ shot, fps, DW, DH, preset, sun }) {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(16, DW / DH, 1, 60000);
  const C0 = new THREE.Vector3(-120, 30, 1100), C1 = new THREE.Vector3(-117.5, 30.5, 1086);   // 推 14 m、右移 2.5 m
  // 构图：地平线落在下三分线、主峰（轴线半高处）落在右三分线——先定屏幕位置，偏航与俯仰反算出来（world.js 的 frameCamera）
  const { yaw: YAW, pitch: PITCH } = frameCamera(cam, C0, { horizonY: DH * 2 / 3, subject: peakPoint('main'), subjectX: DW * 2 / 3 }, DW, DH);
  const cam0 = cam.clone();                      // 底板一律按起始机位摆，之后的视差交给真实透视

  // ── 底板与手绘层（D = 视深；renderOrder 与 D 同序：越远越小） ──
  const sky = plate(await loadPlate('sky_dawn', { flipX: true }), 0);
  const glowU = 1 - sky.material.map.userData.meta['关键位置']['地平线辉光中心_x'];   // 翻转后辉光在右；从登记表读，不手抄
  const sunX = sun.screenX(cam0, DW, DH), skyW = DW * 1.4;
  const skyRect = [sunX - (glowU - 0.5) * skyW - skyW / 2, 750 - skyW / 2, skyW, skyW / 2];   // [左, 上, 宽, 高]：底边（画好的地平线）压在真地平线下
  placeOnScreen(sky, cam0, DW, DH, skyRect[0] + skyW / 2, skyRect[1] + skyW / 4, skyW, 20000, skyW / 2);
  const halo = glowSprite(PAL.sun, { order: 0.5, amt: 0.4, core: 0.25, squash: 2.6 });   // 晨前：太阳还在山后，只在它要升起的方位留一团暖晕（预告）
  placeOnScreen(halo, cam0, DW, DH, sunX, 700, 980, 15000, 980);
  const ridgeU = (sunX + DW * 0.25) / (DW * 1.5);
  const far = ridgeTexture({ seed: 31, color: PAL.ridgeFar, light: PAL.ridgeLight, base: 0.6, amp: 0.22, sunU: ridgeU });
  const ridgeFar = plate(far.tex, 1); placeOnScreen(ridgeFar, cam0, DW, DH, DW / 2, 600, DW * 1.5, 4200, 720);
  const mid = ridgeTexture({ seed: 47, color: PAL.ridgeMid, light: PAL.ridgeLight, base: 0.66, amp: 0.18, sunU: ridgeU });
  const ridgeMid = plate(mid.tex, 2); placeOnScreen(ridgeMid, cam0, DW, DH, DW / 2, 628, DW * 1.5, 2600, 720);
  scene.add(sky, halo, ridgeFar, ridgeMid);
  const mists = [[731, 210, 1800, 3, 0.85, 3], [818, 120, 1000, 5, 0.7, 7], [962, 240, 420, 6, 0.36, 11]].map(([y, h, D, order, op, seed]) => {
    const m = mistTexture({ seed }); m.repeat.x = tileRepeat(m, DW * 1.6, h);   // 两端在画外：雾带比画面宽 60%
    const p = plate(m, order, { opacity: op }); placeOnScreen(p, cam0, DW, DH, DW / 2, y, DW * 1.6, D, h); scene.add(p); return m;
  });
  const fore = cutoutPlane(foregroundTexture(), { order: 8 });   // 抠像面片：写深度，Kuwahara 给它近处的小笔触
  placeOnScreen(fore, cam0, DW, DH, 290, 941, 820, 150, 358); scene.add(fore);

  // ── 三维：峰与礁、乌篷渡船与尾迹、真水面 ──
  scene.add(buildIslet());
  const water = buildWater({ sky: sky.material.map, skyRect, DW, DH }); scene.add(water);   // 水面倒映的就是这张天空
  const boat = buildBoat(), wake = buildWake(), boatBase = screenToPlane(cam0, DW, DH, 690, 862).clone(); scene.add(boat, wake);
  const lamp = glowSprite(PAL.lamp, { order: 5.5, amt: 1.3, core: 1.8 }); scene.add(lamp);
  const key = keyLight(sun.keyDir(), ISLET.clone().add(new THREE.Vector3(0, 50, 0))); scene.add(key, key.target);

  const lampAt = new THREE.Vector3();
  function update(t, f) {
    const lf = f - shot.in, n = shot.out - shot.in, u = Math.min(1, lf / n);
    const e = u * (1.18 - 0.18 * u);   // 近线性：开场就在走、切出时仍在动（运动中切），尾部略收
    aimCamera(cam, new THREE.Vector3().lerpVectors(C0, C1, e), YAW, PITCH);
    mists.forEach((m, i) => { m.offset.x = (0.003 + 0.002 * i) * t; });   // 雾带一拍一缓慢平移
    boatPose(boat, boatBase, 2.2, lf / fps, hold(f, 2), 1);
    wake.position.set(boat.position.x, 0, boat.position.z);
    boat.updateMatrixWorld(); lampAt.set(5.2, 2.3, 0).applyMatrix4(boat.matrixWorld);
    billboard(lamp, cam, lampAt, 18, DH);
    waterFrame(water, cam, DW, DH, { t, held: hold(f, 2), sunAz: sun.az, sunUp: 0 });
    setToon({ inkTime: hold(f, 2), keyDir: sun.keyDir().toArray(), fillDir: [0, -1, 0], fillGain: 0.8, skyGain: 1, exposure: 1 });
  }
  const P = preset();   // film.json 里本镜头的 lookPreset（beiming-original@v1/wide），不另写一份后期数值
  return { scene, camera: cam, update, look: t => ({ t, ...P }) };
}

// 加色辉光点挂在三维位置上：每帧朝向相机，尺寸按设计稿像素给（远近都一样亮的灯点）
const _v = new THREE.Vector3();
export function billboard(sprite, cam, at, px, DH) {
  const d = _v.copy(at).sub(cam.position).length(), s = px * 2 * d * Math.tan(cam.fov * DEG / 2) / DH;
  sprite.position.copy(at); sprite.quaternion.copy(cam.quaternion); sprite.scale.set(s, s, 1);
}
