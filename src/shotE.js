// src/shotE.js — 镜头 E「关灯 · 静默」15.00–19.00：全船关灯只留航行灯，与鲲在暗夜海面静默同行
// 单场景双拍切换：
//   Beat E1（15.00–16.60）：近景侧脸（shotB 同构双层画布），15.25s 关灯瞬间天空沉入深靛夜 #0B1026，轮廓光晕降至 0.04，仅留青色 AR 镜片微光；
//   Beat E2（16.60–19.00）：暗夜开阔海口远景（无城市天际线），渡船熄灭舱灯与桅顶白灯，红绿航行灯及加宽水面拉影（3.2×24）在暗处鲜明发光，
//                           鲲以低 LOD 静默滑过海面，18.3–19.0s 地平线微露破晓前的第一丝暖光。
import * as THREE from 'three';
import { drawGirl, drawGirlMotes, girlCamera, girlAnchors } from './girl.js';
import { createKun } from './kun.js';
import { setToonGlobals } from './toon.js';
import { createFerry, createWake, lightStreak } from './ferry.js';
import { clamp, lerp, seg, ss, ss5, DEG } from '../engine/core/math.js';
import { hold, heldTime } from '../engine/core/clock.js';
import { plate, plateCopy, tileRepeat, canvasLayer, cutoutPlane, glowSprite } from '../engine/stage/plates.js';
import { aimCamera, fillScreen, placeOnScreen, placeStrip, screenToPlane, project } from '../engine/stage/camera.js';
import { headingQuat, integratePath } from '../engine/stage/motion.js';
import { wireOutlines } from '../engine/stage/outline.js';

export const E_START = 15.0;
export const E_SPLIT = 16.6;
export const E_END = 19.0;

export function buildShotE({ W, H, K = 1, tex, img, q }) {
  const P = (k, d) => (q && q.has(k) ? parseFloat(q.get(k)) : d);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(30, W / H, 1, 1000);

  // ── Beat E1（15.00–16.60）：暗夜侧脸 + 青色 AR 镜片光 ──
  const gE1 = new THREE.Group();
  scene.add(gE1);
  aimCamera(cam, new THREE.Vector3(0, 0, 0), 0, 0);

  const { ctx: bctx, tex: bgTex } = canvasLayer(Math.round(W * K), Math.round(H * K));
  const { ctx: fctx, tex: figTex } = canvasLayer(Math.round(W * K), Math.round(H * K));
  const bgPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: bgTex, toneMapped: false, fog: false, depthWrite: false })
  );
  bgPlane.renderOrder = 0; bgPlane.userData.outline = false;
  gE1.add(bgPlane); fillScreen(bgPlane, cam, W, H, 100);

  const figPlane = cutoutPlane(figTex, { order: 10, cut: 0.5 });
  gE1.add(figPlane); fillScreen(figPlane, cam, W, H, 10);

  const skyImg = img || tex?.shotB_sky?.image;
  const IW = skyImg.width, IH = skyImg.height;
  const PW = 2350, PH = PW * IH / IW;
  const left0 = 1840 - 0.932 * PW, top0 = 905 - 0.882 * PH;

  // ── Beat E2（16.60–19.00）：暗夜外海远景（无城市天际线） ──
  const gE2 = new THREE.Group();
  gE2.visible = false;
  scene.add(gE2);

  const fogE2 = new THREE.FogExp2('#0B1026', P('efog', 0.00032));
  const camE2 = new THREE.PerspectiveCamera(22, W / H, 5, 40000);
  const CAM2_0 = new THREE.Vector3(0, 26, 0);
  const PITCH2 = P('epitch', -0.5) * DEG;
  const Y2_0 = P('ey0', 4) * DEG, Y2_1 = P('ey1', 7.5) * DEG;
  const PUSH2 = 22;

  const camE2_0 = camE2.clone(); aimCamera(camE2_0, CAM2_0, Y2_0, PITCH2);
  const camE2_mid = camE2.clone(); aimCamera(camE2_mid, CAM2_0, (Y2_0 + Y2_1) * 0.5, PITCH2);

  const putE2 = (mesh, cx, cy, wpx, D, hpx) => {
    gE2.add(mesh);
    placeOnScreen(mesh, camE2_mid, W, H, cx, cy, wpx, D, hpx);
    return mesh;
  };
  const skyE2 = putE2(plate(tex.sky_tall, 0, { color: '#141b42' }), W * 0.5, -180, 3600, 20000);
  const cloudsE2 = putE2(plate(tex.clouds_back, 1, { color: '#1a224d', opacity: 0.85 }), W * 0.5, 210, 3400, 6000);
  const riverE2 = putE2(plate(tex.river, 4, { color: '#172148' }), W * 0.5, 484 + 750, 3600, 1450, 1500);

  const mistTex = plateCopy(tex.mist_low, { wrap: true });
  const mistE2 = putE2(plate(mistTex, 5, { color: '#24305e', opacity: 0.45 }), W * 0.5, 494, 3600, 1300, 280);
  mistTex.repeat.set(tileRepeat(tex.mist_low, 3600, 280), 1);

  // 18.3–19.0s 地平线微弱破晓暖光
  const dawn = glowSprite('#FFB26B', { order: 0.5, amt: 0.02, core: 0.4, squash: 2.5 });
  putE2(dawn, W * 0.28, 488, 1800, 15000, 520);

  const key = new THREE.DirectionalLight('#9aaee6', 1);
  const KEY_DIR = new THREE.Vector3(-0.72, 0.14, -0.68).normalize();
  gE2.add(key, key.target);

  // 鲲：暗夜滑行（LOD 0.55，淡墨线）
  const kun = createKun({ lod: 0.55, wisps: false, blinkPeriod: 5, blinkOffset: 0.8 });
  wireOutlines(kun.group, { alpha: 0.65 });
  kun.group.rotation.order = 'YXZ';
  gE2.add(kun.group);

  const kunP0 = new THREE.Vector3(110, 54, -730);
  const kunDir = () => new THREE.Vector3(-0.78, 0.02, -0.62).normalize();
  const kunPosAt = integratePath(kunP0, kunDir, () => 26, { t0: E_SPLIT, steps: 72, fps: 24 });

  // 渡船：熄灭舱灯、船尾灯与桅顶白灯，只保留红/绿航行灯与其加宽水面倒影
  const ferry = createFerry();
  ferry.group.rotation.order = 'YXZ';
  ferry.group.traverse(o => {
    if (!o.isMesh || !o.material?.isMeshBasicMaterial) return;
    if (o === ferry.lights.white || o === ferry.lights.sternLamp) {
      o.visible = false;
    } else if (o !== ferry.lights.red && o !== ferry.lights.green) {
      o.material = o.material.clone();
      o.material.color.set('#141936');
    }
  });
  ferry.lights.red.material.color.set('#FF3B3B').multiplyScalar(3.6);
  ferry.lights.green.material.color.set('#3BFF8A').multiplyScalar(3.4);
  gE2.add(ferry.group);

  const wake = createWake();
  wake.renderOrder = 5.2;
  wake.material.uniforms.uOpacity.value = 0.32;
  wake.material.uniforms.uCol.value.set('#44588c');
  gE2.add(wake);

  const streaks = [
    { m: lightStreak('#FF4A4A', 1.8), lamp: ferry.lights.red, w: 3.2, h: 24 },
    { m: lightStreak('#4AFF95', 1.7), lamp: ferry.lights.green, w: 3.2, h: 24 },
    { m: lightStreak('#FFC46B', 0.9), lamp: ferry.lights.white, w: 3.2, h: 24, hide: true },
  ];
  for (const s of streaks) {
    s.m.renderOrder = 5.3;
    if (s.hide) s.m.visible = false;
    gE2.add(s.m);
  }

  const FERRY2_0 = screenToPlane(camE2_0, W, H, 760, 650);
  const FERRY2_YAW = 2.12;
  const FERRY2_V = 4.2;
  const FERRY2_DIR = new THREE.Vector3(Math.cos(FERRY2_YAW), 0, -Math.sin(FERRY2_YAW));

  const hudState = { eye: null, nav: [], head: { yaw: 0, pitch: 0 } };
  const _v = new THREE.Vector3(), _bow = new THREE.Vector3(), _tail = new THREE.Vector3();
  const _kq = new THREE.Quaternion(), _yAxis = new THREE.Vector3(0, 1, 0);
  const _cSky0 = new THREE.Color('#141b42'), _cSky1 = new THREE.Color('#424d86');
  const _cCld0 = new THREE.Color('#1a224d'), _cCld1 = new THREE.Color('#4d5792');
  const _cRiv0 = new THREE.Color('#172148'), _cRiv1 = new THREE.Color('#3d4a7c');
  const _cMst0 = new THREE.Color('#24305e'), _cMst1 = new THREE.Color('#5a679a');

  function update(t, f) {
    if (t < E_SPLIT) {
      gE1.visible = true; gE2.visible = false;
      scene.fog = null;
      if (cam.fov !== 30 || cam.far !== 1000) {
        cam.fov = 30; cam.near = 1; cam.far = 1000;
        cam.updateProjectionMatrix();
      }
      aimCamera(cam, _v.set(0, 0, 0), 0, 0);

      const tl = clamp((t - E_START) * 1.1, 0, 1.95);
      const camG = girlCamera(tl);
      const z = 1 + (camG.zoom - 1) * 0.3, fx = camG.fx * W, fy = camG.fy * H;
      const lightsOff = ss(seg(t, 15.22, 15.55));

      bctx.setTransform(K, 0, 0, K, 0, 0); bctx.globalAlpha = 1; bctx.filter = 'none';
      bctx.fillStyle = '#0B1026'; bctx.fillRect(0, 0, W, H);
      bctx.save();
      bctx.translate(fx, fy); bctx.scale(z, z); bctx.translate(-fx, -fy);
      bctx.filter = `blur(${2.4 * K}px)`;
      bctx.globalAlpha = lerp(0.55, 0.14, lightsOff);
      bctx.drawImage(skyImg, left0 - 14 * tl, top0, PW, PH);
      bctx.filter = 'none';
      bctx.restore();
      bctx.fillStyle = '#0B1026';
      bctx.globalAlpha = lerp(0.32, 0.78, lightsOff);
      bctx.fillRect(0, 0, W, H);
      bctx.globalAlpha = lerp(0.45, 0.18, lightsOff);
      drawGirlMotes(bctx, tl, W, H, { cam: camG });
      bctx.globalAlpha = 1;
      bgTex.needsUpdate = true;

      fctx.setTransform(K, 0, 0, K, 0, 0); fctx.clearRect(0, 0, W, H);
      drawGirl(fctx, tl, W, H, {
        cam: camG,
        halo: lerp(0.32, 0.04, lightsOff),
        reflect: false,
        wrap: lerp(0.3, 0.1, lightsOff),
        wrapStops: [[0, '#1B224D'], [0.6, '#394682'], [1, '#6C7DC2']],
      });
      // 在暗夜曝光下保持镜片青色 AR 内缘微光清晰可读
      {
        const a = girlAnchors(tl, W, H, { cam: camG });
        const glowGain = tl < 0.5
          ? 0.52
          : lerp(0.52, 1.0, ss(seg(tl, 0.5, 0.58))) * lerp(1.0, 0.78, ss(seg(tl, 0.65, 1.15)));
        fctx.save();
        fctx.globalCompositeOperation = 'lighter';
        for (const [pt, rx, ry, gain] of [[a.nearLens, 30 * a.px, 66 * a.px, 1.0], [a.farLens, 11 * a.px, 54 * a.px, 0.55]]) {
          fctx.save();
          fctx.translate(pt[0], pt[1]);
          fctx.rotate(-0.24);
          fctx.scale(1, ry / rx);
          const rg = fctx.createRadialGradient(0, 0, rx * 0.15, 0, 0, rx);
          rg.addColorStop(0, `rgba(159,232,255,${(0.36 * glowGain * gain).toFixed(3)})`);
          rg.addColorStop(0.65, `rgba(159,232,255,${(0.56 * glowGain * gain).toFixed(3)})`);
          rg.addColorStop(1, 'rgba(159,232,255,0)');
          fctx.fillStyle = rg;
          fctx.beginPath(); fctx.arc(0, 0, rx, 0, Math.PI * 2); fctx.fill();
          fctx.restore();
        }
        fctx.restore();
      }
      figTex.needsUpdate = true;
      return;
    }

    // ── Beat E2：暗夜外海远景 ──
    gE1.visible = false; gE2.visible = true;
    scene.fog = fogE2;
    if (cam.fov !== 22 || cam.far !== 40000) {
      cam.fov = 22; cam.near = 5; cam.far = 40000;
      cam.updateProjectionMatrix();
    }

    const u2 = clamp((t - E_SPLIT) / (E_END - E_SPLIT));
    const push = PUSH2 * ss5(u2);
    const yaw = lerp(Y2_0, Y2_1, ss5(u2));
    aimCamera(cam, _v.set(CAM2_0.x, CAM2_0.y, CAM2_0.z - push), yaw, PITCH2);

    const predawn = ss(seg(t, 18.15, E_END));
    skyE2.material.color.copy(_cSky0).lerp(_cSky1, predawn);
    cloudsE2.material.color.copy(_cCld0).lerp(_cCld1, predawn);
    riverE2.material.color.copy(_cRiv0).lerp(_cRiv1, predawn);
    mistE2.material.color.copy(_cMst0).lerp(_cMst1, predawn);
    mistTex.offset.x = (t * 0.008) % 1;
    dawn.material.uniforms.amt.value = 0.02 + 1.15 * predawn;
    fogE2.color.set('#0B1026').lerp(_cSky1, predawn * 0.45);

    const ts = heldTime(f, 2);
    headingQuat(kunDir(), 0.04 * Math.sin((ts - E_SPLIT) * 0.5), _kq);
    kun.group.quaternion.copy(_kq);
    kunPosAt(ts, kun.group.position);
    kun.group.updateMatrixWorld(true);
    kun.setPose(ts);
    key.position.copy(KEY_DIR); key.target.position.set(0, 0, 0);
    kun.fitShadow(key, { size: 2048 });

    const fq = heldTime(f, 2);
    ferry.group.position.copy(FERRY2_0).addScaledVector(FERRY2_DIR, FERRY2_V * (t - E_SPLIT));
    ferry.group.position.y = 0.2 * Math.sin(fq * 2.3);
    ferry.group.rotation.set(0.01 * Math.sin(fq * 1.9 + 1), FERRY2_YAW, 0.008 * Math.sin(fq * 1.5));
    ferry.group.updateMatrixWorld(true);

    _bow.set(ferry.length * 0.5, 0, 0).applyAxisAngle(_yAxis, FERRY2_YAW).add(ferry.group.position);
    _tail.set(-ferry.length * 4.0, 0, 0).applyAxisAngle(_yAxis, FERRY2_YAW).add(ferry.group.position);
    const pa = project(cam, W, H, _bow), pb = project(cam, W, H, _tail);
    const d0 = (pa.z + pb.z) / 2, d1 = Math.max(pa.z, pb.z) + 2;
    placeStrip(wake, cam, W, H, _bow, _tail, 24, 1.5);
    if (d0 > 1 && d1 > d0) {
      const s = d1 / d0;
      wake.position.sub(cam.position).multiplyScalar(s).add(cam.position);
      wake.scale.multiplyScalar(s);
    }
    wake.material.uniforms.uT.value = t;

    for (const s of streaks) {
      if (s.hide) { s.m.visible = false; continue; }
      s.lamp.getWorldPosition(_v);
      s.m.position.set(_v.x, -s.h * 0.45, _v.z);
      s.m.quaternion.copy(cam.quaternion);
      s.m.scale.set(s.w, s.h, 1);
      s.m.material.uniforms.uSeed.value = hold(f, 2) % 97;
    }

    setToonGlobals({
      inkTime: hold(f, 2),
      fillGain: 0.08,
      exposure: lerp(0.55, 0.92, predawn),
      fillDir: [0.08, -1, 0.1],
      keyDir: KEY_DIR.toArray(),
      skyGain: lerp(0.6, 1.0, predawn),
    });
  }

  const look = t => {
    const exposure = t < 15.55
      ? lerp(0.82, 0.42, ss(seg(t, 15.0, 15.5)))
      : t < 18.0
        ? 0.42
        : lerp(0.42, 0.72, ss(seg(t, 18.0, 18.45)));
    const predawn = ss(seg(t, 18.1, E_END));
    const isE2 = t >= E_SPLIT;
    return {
      t,
      outline: isE2 ? { width: 2.2, near: 200, far: 2000, farScale: 0.55, wobble: 1.0, tint: 0.2, opacity: 0.75 } : false,
      kuwahara: isE2
        ? { radius: 3, farRadius: 6.5, farStart: 500, farEnd: 1600, strength: 1, protect: [0.65, 1.2] }
        : { radius: 1.6, farRadius: 6, farStart: 30, farEnd: 60, strength: 1, protect: [0.65, 1.2] },
      bloom: { strength: 1.1, threshold: 0.48, radius: 0.8, knee: 0.25 },
      grade: {
        exposure,
        warmth: lerp(0.0, 0.08, predawn),
        lift: [0.006, 0.012, 0.032],
        gamma: 0.96,
        gain: 1.0,
        saturation: 1.05,
        shoulder: 0.9,
      },
      paper: { strength: 0.11 },
      vignette: lerp(0.32, 0.24, predawn),
      grain: 0.65,
      fog: null,
    };
  };

  return { scene, camera: cam, update, look, hudState };
}
