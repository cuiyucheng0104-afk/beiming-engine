// src/shotB.js — 镜头 B「她」3.00–5.00：林潮逆光侧脸剪影近景
// 两层面片：远处是 shotB_sky（明亮的破晓天空，轻微虚焦当景深；跟人物同一个推镜焦点，只推 30% 做视差）+ 逆光光尘；
// 近处是 girl.js 画的人物层（CanvasTexture，抠像面片：彩色层 + 深度遮罩，让后期给人物小笔触、天空大笔触）。
// 人物一拍二（girl.js 内部量化）；推镜、天光、光尘 24 fps 平滑。
import * as THREE from 'three';
import { drawGirl, drawGirlMotes, girlCamera, GIRL_SHOT } from './girl.js';
import { cutoutPlane, placeOnScreen, aimCamera, clamp, ss, seg } from './scene.js';

export function buildShotB({ W, H, img, K = 1 }) {   // W×H：1040 高的设计尺寸；K：实际像素 / 设计像素（原生 4K 时 2）
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(30, W / H, 1, 1000);
  aimCamera(cam, new THREE.Vector3(0, 0, 0), 0, 0);

  const mk = () => { const c = document.createElement('canvas'); c.width = Math.round(W * K); c.height = Math.round(H * K); return c; };
  const bg = mk(), bctx = bg.getContext('2d');
  const fig = mk(), fctx = fig.getContext('2d');
  const bgTex = new THREE.CanvasTexture(bg); bgTex.colorSpace = THREE.SRGBColorSpace;
  const figTex = new THREE.CanvasTexture(fig); figTex.colorSpace = THREE.SRGBColorSpace;

  const bgPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: bgTex, toneMapped: false, fog: false, depthWrite: false }));
  bgPlane.renderOrder = 0; bgPlane.userData.outline = false;
  scene.add(bgPlane); placeOnScreen(bgPlane, cam, W, H, W / 2, H / 2, W, 100, H);
  const figPlane = cutoutPlane(figTex, { order: 10, cut: 0.5 });
  scene.add(figPlane); placeOnScreen(figPlane, cam, W, H, W / 2, H / 2, W, 10, H);

  // 天空：光晕（底板 0.932, 0.882）放在画面右下，脸的前方正对光晕 = 逆光
  const IW = img.width, IH = img.height;
  const PW = 2350, PH = PW * IH / IW;
  const GX = 1840, GY = 905;                              // 光晕在画面上的位置（推镜前）
  const left0 = GX - 0.932 * PW, top0 = GY - 0.882 * PH;

  function update(t) {
    const tl = clamp(t - GIRL_SHOT.start, 0, GIRL_SHOT.dur - 1e-6);
    const camG = girlCamera(tl);
    const z = 1 + (camG.zoom - 1) * 0.3, fx = camG.fx * W, fy = camG.fy * H;
    // 背景：推 30%，轻微向左漂（人物背后的天空在动，24 fps 平滑），虚焦 2.4 px
    bctx.setTransform(K, 0, 0, K, 0, 0); bctx.globalAlpha = 1; bctx.filter = 'none';
    bctx.fillStyle = '#B9A6DE'; bctx.fillRect(0, 0, W, H);
    bctx.save();
    bctx.translate(fx, fy); bctx.scale(z, z); bctx.translate(-fx, -fy);
    bctx.filter = `blur(${2.4 * K}px)`;   // 画布滤镜的长度不随变换缩放
    bctx.drawImage(img, left0 - 14 * tl, top0, PW, PH);
    bctx.filter = 'none';
    bctx.restore();
    // 0.8 秒后：暗影掠过时，天光微微变粉（和镜片里的粉色天光同步）
    const pinkA = 0.10 * ss(seg(tl, 0.8, 1.15));
    if (pinkA > 0) { bctx.save(); bctx.globalCompositeOperation = 'soft-light'; bctx.globalAlpha = pinkA; bctx.fillStyle = '#F2A0A6'; bctx.fillRect(0, 0, W, H); bctx.restore(); }
    drawGirlMotes(bctx, tl, W, H, { cam: camG });
    bgTex.needsUpdate = true;
    // 人物层
    fctx.setTransform(K, 0, 0, K, 0, 0); fctx.clearRect(0, 0, W, H);
    drawGirl(fctx, tl, W, H, { cam: camG, halo: 0.38 });
    figTex.needsUpdate = true;
  }

  const look = t => {
    const tl = t - GIRL_SHOT.start;
    return {
      t,
      outline: false,
      kuwahara: { radius: 1.6, farRadius: 6, farStart: 30, farEnd: 60, strength: 1, protect: [1.05, 1.6] },
      bloom: { strength: 0.85, threshold: 0.7, radius: 0.75, knee: 0.3 },
      grade: { exposure: 1.0, warmth: 0.13, lift: [0.02, 0.012, 0.045], gamma: 0.97, gain: 1.01, saturation: 1.08, shoulder: 0.9 },
      paper: { strength: 0.12 }, vignette: 0.26, grain: 0.65, fog: null,
    };
  };

  return { scene, camera: cam, update, look };
}
