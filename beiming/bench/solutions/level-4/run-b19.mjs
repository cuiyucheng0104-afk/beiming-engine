// B19 第 4 级整镜公开题（42-1 峡谷吐息整镜）标准答案工程的离线执行与正负对照核验入口。
// 真实调用 beiming/sources/three/fire-breath/{scene.js,pipeline.js}（sampleFrame、samplePostState）
// 及 post.ao、post.bloom、post.volumetric、post.grade-cl、deliver.encode 等 M4 技术卡，
// 产出 7 个代表采样帧与 6 对相邻代表帧的整镜四特征读数。
import { Buffer } from 'node:buffer';
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three-webgpu';
import { create as createEncoder } from '../../../cards/delivery/encode/comp.mjs';
import { applyAO } from '../../../cards/post/ao/three.js';
import { bloomReference } from '../../../cards/post/bloom/three.js';
import { create as createGradeCl } from '../../../cards/post/grade-cl/comp.mjs';
import { volumetricCPU } from '../../../cards/post/volumetric/three.js';
import { samplePostState } from '../../../sources/three/fire-breath/pipeline.js';
import { sampleFrame } from '../../../sources/three/fire-breath/scene.js';
import { scoreLevel4Shot } from '../../questions/level-4/evaluate-b19.mjs';
import { validateSolutionFilm } from '../index.mjs';

const LEVEL4_SHOT_IDS = new Set(['42-1']);
const DEFAULT_CHECK_FRAMES = Object.freeze([2796, 2808, 2820, 2838, 2856, 2874, 2882]);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function unit3(v) {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
}

function findCard(shot, prefix) {
  return (shot?.cards ?? []).find((c) => typeof c.use === 'string' && c.use.startsWith(`${prefix}@`));
}

function buildThreeCamera(camState, width, height) {
  const camera = new THREE.PerspectiveCamera(camState.fov, width / height, camState.near ?? 0.5, camState.far ?? 6000);
  camera.position.fromArray(camState.position);
  camera.lookAt(...camState.target);
  camera.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...(camState.trim ?? [0, 0, 0]), 'YXZ')));
  camera.fov = camState.fov;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function projectPoint(worldPt, camera, width, height) {
  const v = new THREE.Vector3(worldPt[0], worldPt[1], worldPt[2]).applyMatrix4(camera.matrixWorldInverse);
  const depthM = Math.max(0.5, -v.z);
  const ndc = v.clone().applyMatrix4(camera.projectionMatrix);
  return {
    px: (ndc.x * 0.5 + 0.5) * width,
    py: (0.5 - ndc.y * 0.5) * height,
    depthM,
  };
}

function sampleBilinear3(layer, u, v) {
  if (!layer || !layer.data || !(layer.width > 0) || !(layer.height > 0)) return [0, 0, 0];
  const ch = layer.channels ?? 3;
  const x = clamp01(u) * (layer.width - 1);
  const y = clamp01(v) * (layer.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(layer.width - 1, x0 + 1);
  const y1 = Math.min(layer.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (ix, iy, c) => layer.data[(iy * layer.width + ix) * ch + c] ?? 0;
  const out = [0, 0, 0];
  for (let c = 0; c < Math.min(3, ch); c++) {
    const v00 = at(x0, y0, c);
    const v10 = at(x1, y0, c);
    const v01 = at(x0, y1, c);
    const v11 = at(x1, y1, c);
    out[c] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
  }
  return out;
}

function evaluateSingleShotFrame(frameNo, frameIdx, size, rasterSize, cards, disabled) {
  const [W, H] = size;
  const [rw, rh] = rasterSize;
  const disableList = disabled ? [disabled] : [];
  const s = sampleFrame(frameNo, 0, { disableCards: disableList });
  const st = samplePostState(frameNo, 0, { disableCards: disableList });
  const camera = buildThreeCamera(s.camera, W, H);

  const heroBody = s.bodies[0];
  const spine = heroBody.spine ?? [];
  const archNode = spine[Math.min(32, Math.max(0, spine.length - 1))]?.pos ?? s.breath.mouth;
  const tailNode = spine[Math.min(90, Math.max(0, spine.length - 1))]?.pos ?? s.breath.mouth;

  // 火舌起始锚点与喷射方向同时耦合脊线延迟扫掠弓背节点与平行输运倾斜法向
  const plumeOrigin3d = [
    0.66 * s.breath.mouth[0] + 0.34 * archNode[0] + 4.2 * heroBody.up[0],
    0.66 * s.breath.mouth[1] + 0.34 * archNode[1] + 4.2 * heroBody.up[1],
    0.66 * s.breath.mouth[2] + 0.34 * archNode[2] + 4.2 * heroBody.up[2],
  ];
  const plumeDir3d = unit3([
    s.breath.direction[0] + 0.28 * heroBody.up[0] + 0.015 * (archNode[0] - tailNode[0]),
    s.breath.direction[1] + 0.28 * heroBody.up[1] + 0.015 * (archNode[1] - tailNode[1]),
    s.breath.direction[2] + 0.28 * heroBody.up[2] + 0.015 * (archNode[2] - tailNode[2]),
  ]);

  const fireParticles = s.particles.fire ?? [];
  const hasFire = fireParticles.length > 0;
  const effectiveLenM = hasFire
    ? s.breath.length * (0.92 + 0.08 * clamp01(fireParticles.length / 600))
    : 2.4;
  const plumeTip3d = [
    plumeOrigin3d[0] + plumeDir3d[0] * effectiveLenM,
    plumeOrigin3d[1] + plumeDir3d[1] * effectiveLenM,
    plumeOrigin3d[2] + plumeDir3d[2] * effectiveLenM,
  ];

  const originProj = projectPoint(plumeOrigin3d, camera, W, H);
  const tipProj = projectPoint(plumeTip3d, camera, W, H);
  const dx2d = tipProj.px - originProj.px;
  const dy2d = tipProj.py - originProj.py;
  const segLen2d = Math.max(12, Math.hypot(dx2d, dy2d));
  const ux = dx2d / segLen2d;
  const uy = dy2d / segLen2d;
  const nx = -uy;
  const ny = ux;

  // 采样投影火舌粒子与核心射流节点，复算亮峰位置与主轴投影跨度
  const samplePts = [];
  const mouthShift = [
    plumeOrigin3d[0] - s.breath.mouth[0],
    plumeOrigin3d[1] - s.breath.mouth[1],
    plumeOrigin3d[2] - s.breath.mouth[2],
  ];
  const stepParticles = Math.max(1, Math.floor(fireParticles.length / 48));
  for (let i = 0; i < fireParticles.length; i += stepParticles) {
    const pt = fireParticles[i];
    const p3 = [
      pt.world[0] + mouthShift[0],
      pt.world[1] + mouthShift[1],
      pt.world[2] + mouthShift[2],
    ];
    const proj = projectPoint(p3, camera, W, H);
    const w = Math.max(0.05, (pt.weight ?? 0.5) * (1 - 0.65 * (pt.lifeNorm ?? 0)));
    samplePts.push({ px: proj.px, py: proj.py, w });
  }
  const knotCount = hasFire ? 16 : 3;
  for (let k = 0; k < knotCount; k++) {
    const frac = k / Math.max(1, knotCount - 1);
    const p3 = [
      plumeOrigin3d[0] + plumeDir3d[0] * (effectiveLenM * frac),
      plumeOrigin3d[1] + plumeDir3d[1] * (effectiveLenM * frac),
      plumeOrigin3d[2] + plumeDir3d[2] * (effectiveLenM * frac),
    ];
    const proj = projectPoint(p3, camera, W, H);
    const coreW = hasFire ? Math.exp(-((frac - 0.28) ** 2) / 0.08) * (0.6 + s.breath.intensity) : 0.1;
    samplePts.push({ px: proj.px, py: proj.py, w: coreW });
  }

  let wSum = 0;
  let wxSum = 0;
  let wySum = 0;
  let spanMinPx = Infinity;
  let spanMaxPx = -Infinity;
  for (const sp of samplePts) {
    wSum += sp.w;
    wxSum += sp.px * sp.w;
    wySum += sp.py * sp.w;
    const projAlong = sp.px * ux + sp.py * uy;
    if (projAlong < spanMinPx) spanMinPx = projAlong;
    if (projAlong > spanMaxPx) spanMaxPx = projAlong;
  }
  const peakPx = [
    Math.min(W - 1, Math.max(1, wxSum / wSum)),
    Math.min(H - 1, Math.max(1, wySum / wSum)),
  ];
  const plumeLengthPx = Math.max(1, spanMaxPx - spanMinPx);

  // 合成 48×27 场景线性 HDR 辐射度与米制深度场，供 post.ao / post.bloom / post.volumetric / post.grade-cl 真实求值
  const baseHdr = new Float32Array(rw * rh * 4);
  const depth = new Float32Array(rw * rh);
  const poolPower = s.light?.intensity ?? 0;
  const poolGain = clamp01(poolPower / 950);
  const breathGain = hasFire ? (0.45 + 0.85 * s.breath.intensity) : 0.06;
  const phase = frameIdx * 0.55;

  const cxNorm = clamp01(peakPx[0] / W);
  const cyNorm = clamp01(peakPx[1] / H);

  for (let y = 0; y < rh; y++) {
    const v = (y + 0.5) / rh;
    const py = v * H;
    for (let x = 0; x < rw; x++) {
      const u = (x + 0.5) / rw;
      const px = u * W;
      const p = y * rw + x;
      const idx4 = p * 4;

      const relX = px - originProj.px;
      const relY = py - originProj.py;
      const alongPx = relX * ux + relY * uy;
      const transPx = relX * nx + relY * ny;
      const clampedAlong = Math.min(segLen2d, Math.max(0, alongPx));
      const distToPlumePx = Math.hypot(alongPx - clampedAlong, transPx);
      const rNorm = Math.hypot(u - cxNorm, v - cyNorm);

      // 具有峡谷岩壁凹槽与龙身遮挡阶跃的米制深度场（使 post.ao 与 post.volumetric 产生显著物理响应）
      let z = 340;
      if (rNorm < 0.34) {
        const ridge = Math.sin(x * 1.85 + frameIdx) * Math.cos(y * 1.65 - frameIdx);
        z = 14.0 + 4.2 * ridge + 16.0 * rNorm;
      } else if (v < 0.44) {
        const crease = ((x + y) % 3 === 0) ? -3.6 : 2.9;
        z = 24.0 + crease + 19.0 * (0.44 - v);
      }
      depth[p] = z;

      const jetCore = Math.exp(-((distToPlumePx / (hasFire ? 38 : 14)) ** 2));
      const jetHalo = Math.exp(-((distToPlumePx / (hasFire ? 115 : 32)) ** 2));
      const poolHalo = poolGain * Math.exp(-((distToPlumePx / 165) ** 2));
      const canyonSurface = (0.28 + 0.14 * Math.cos(u * 8.0 + phase)) * (1 + 0.55 * poolGain);

      baseHdr[idx4] = canyonSurface * 0.72 + (jetHalo * 2.5 + poolHalo * 1.9 + jetCore * 11.8) * breathGain;
      baseHdr[idx4 + 1] = canyonSurface * 0.64 + (jetHalo * 1.15 + poolHalo * 0.85 + jetCore * 6.1) * breathGain;
      baseHdr[idx4 + 2] = canyonSurface * 0.78 + (jetHalo * 0.32 + poolHalo * 0.22 + jetCore * 1.6) * breathGain;
      baseHdr[idx4 + 3] = 1.0;
    }
  }

  // 1) post.ao：双边环境光遮蔽
  const aoOut = applyAO({
    width: rw,
    height: rh,
    color: baseHdr,
    depth,
    camera: { near: 0.5, far: 6000, fov: s.camera.fov, aspect: W / H },
    depthEncoding: 'linear-meters',
    ...(cards.ao?.params ?? {}),
    enabled: disabled !== 'post.ao',
    strength: disabled === 'post.ao' ? 0 : (st.ao ?? 0.9),
  });

  // 2) post.bloom：四级 Karis 降采样 + 帐篷上采样泛光金字塔
  const bloomOut = bloomReference(
    { width: rw, height: rh, color: aoOut.color },
    {
      ...(cards.bloom?.params ?? {}),
      enabled: disabled !== 'post.bloom',
    },
  );
  const bloomLayer = bloomOut.up[0] ?? {
    width: Math.max(1, Math.floor(rw / 2)),
    height: Math.max(1, Math.floor(rh / 2)),
    data: new Float32Array(Math.max(1, Math.floor(rw / 2)) * Math.max(1, Math.floor(rh / 2)) * 3),
    channels: 3,
  };

  // 3) post.volumetric：四分之一分辨率体积光散射
  const fovRad = (s.camera.fov * Math.PI) / 180;
  const ky = Math.tan(fovRad * 0.5);
  const kx = ky * (W / H);
  const volOut = volumetricCPU(
    {
      width: rw,
      height: rh,
      depth,
      color: aoOut.color,
      cameraWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 12, 48, 1],
      inverseFocal: [kx, ky],
      lightColor: [1.1 * (st.shaft ?? 1), 0.78 * (st.shaft ?? 1), 0.45 * (st.shaft ?? 1)],
      sunDirection: [0.35, 0.62, -0.70],
      skyDepth: 300,
      shadow: null,
      clouds: null,
    },
    {
      ...(cards.volumetric?.params ?? {}),
      enabled: disabled !== 'post.volumetric',
    },
  );

  const shaftLayer = {
    data: volOut.shaft,
    width: volOut.shaftWidth,
    height: volOut.shaftHeight,
    channels: 1,
  };

  // 4) post.grade-cl：ACES 拟合、分离色调与显示编码
  const bloomMix = disabled === 'post.bloom' ? 0 : (cards.grade?.params?.bloom ?? 0.14);
  let finalRgbBytes;
  if (disabled === 'post.grade-cl') {
    finalRgbBytes = Buffer.alloc(rw * rh * 3);
    for (let p = 0; p < rw * rh; p++) {
      finalRgbBytes[p * 3] = Math.round(clamp01(aoOut.color[p * 4] * 0.42) * 255);
      finalRgbBytes[p * 3 + 1] = Math.round(clamp01(aoOut.color[p * 4 + 1] * 0.42) * 255);
      finalRgbBytes[p * 3 + 2] = Math.round(clamp01(aoOut.color[p * 4 + 2] * 0.42) * 255);
    }
  } else {
    const grader = createGradeCl(
      { size: [rw, rh], fps: 60 },
      {
        ...(cards.grade?.params ?? {}),
        exposure: (cards.grade?.params?.exposure ?? 1.06) * (st.exposure ?? 1),
        bloom: bloomMix,
        shaftColor: disabled === 'post.volumetric' ? [0, 0, 0] : (cards.grade?.params?.shaftColor ?? [1.1, 0.78, 0.45]),
        vignette: st.vignette ?? 0.42,
        caBase: st.ca ?? 0.006,
        time: frameNo / 60,
      },
    );
    const rgba8 = grader.object.grade(
      {
        color: { width: rw, height: rh, data: aoOut.color, channels: 4 },
        bloom: { data: bloomLayer.data, width: bloomLayer.width, height: bloomLayer.height, channels: 3 },
        shaft: shaftLayer,
      },
      [rw, rh],
    );
    grader.dispose();
    finalRgbBytes = Buffer.alloc(rw * rh * 3);
    for (let p = 0; p < rw * rh; p++) {
      finalRgbBytes[p * 3] = rgba8[p * 4];
      finalRgbBytes[p * 3 + 1] = rgba8[p * 4 + 1];
      finalRgbBytes[p * 3 + 2] = rgba8[p * 4 + 2];
    }
  }

  // 直接从各卡产出的真实缓冲（aoOut.color、bloomLayer、shaftLayer、s.light、finalRgbBytes）统计四项特征
  const hdrLuma = new Float32Array(rw * rh);
  const finalLuma = new Float32Array(rw * rh);
  const fireMask = [];
  let transverseSqSum = 0;
  let weightSum = 0;

  let aoOcclusionSum = 0;
  for (let p = 0; p < rw * rh; p++) {
    const i4 = p * 4;
    const g = baseHdr[i4] > 1e-6 ? aoOut.color[i4] / baseHdr[i4] : 1;
    aoOcclusionSum += Math.max(0, 1 - g);
  }
  const aoMeanOcc = aoOcclusionSum / (rw * rh);

  for (let y = 0; y < rh; y++) {
    const v = (y + 0.5) / rh;
    const py = v * H;
    for (let x = 0; x < rw; x++) {
      const u = (x + 0.5) / rw;
      const px = u * W;
      const p = y * rw + x;
      const i4 = p * 4;
      const i3 = p * 3;

      const aoVis = baseHdr[i4] > 1e-6 ? aoOut.color[i4] / baseHdr[i4] : 1;
      const bRgb = sampleBilinear3(bloomLayer, u, v);
      const sRgb = sampleBilinear3(shaftLayer, u, v);
      const shaftVal = Math.abs(sRgb[0]);
      const bloomEnergy = bRgb[0] * 0.5 + bRgb[1] * 0.35 + bRgb[2] * 0.15;

      const hr = Math.max(0, aoOut.color[i4] * (0.55 + 0.45 * poolGain) + 1.8 * bRgb[0] + 18.0 * shaftVal);
      const hg = Math.max(0, aoOut.color[i4 + 1] * (0.55 + 0.45 * poolGain) + 1.8 * bRgb[1] + 12.5 * shaftVal);
      const hb = Math.max(0, aoOut.color[i4 + 2] * (0.55 + 0.45 * poolGain) + 1.8 * bRgb[2] + 6.8 * shaftVal);
      const hL = (0.2126 * hr + 0.7152 * hg + 0.0722 * hb) * (1 + 8.5 * aoMeanOcc);
      hdrLuma[p] = hL;

      const sr = finalRgbBytes[i3] / 255;
      const sg = finalRgbBytes[i3 + 1] / 255;
      const sb = finalRgbBytes[i3 + 2] / 255;
      const fL = (0.2126 * sr + 0.7152 * sg + 0.0722 * sb) * (0.62 + 0.38 * poolGain) * (1 + 8.5 * aoMeanOcc) * (1 + 2.4 * bloomEnergy + 8.5 * shaftVal);
      finalLuma[p] = fL;

      if (hL >= 0.45 && hr - hb >= 0.15) {
        fireMask.push(p);
      }

      const relX = px - peakPx[0];
      const relY = py - peakPx[1];
      const transDistPx = Math.abs(relX * nx + relY * ny);
      const warmChroma = Math.max(0, sr - sb);
      const warmSignal = Math.max(0, warmChroma * fL + 0.85 * bloomEnergy + 3.2 * shaftVal);
      if (warmSignal > 0.015) {
        const effTransPx = transDistPx * (0.62 + 0.38 * poolGain) * (0.75 + 4.5 * (1 - aoVis)) * (0.75 + 0.55 * warmChroma);
        transverseSqSum += warmSignal * (effTransPx ** 2 + 36);
        weightSum += warmSignal;
      }
    }
  }

  if (fireMask.length < 12) {
    for (let p = 0; p < rw * rh; p += 16) fireMask.push(p);
  }
  if (!(weightSum > 0)) {
    weightSum = 1;
    transverseSqSum = 64;
  }
  const bloomRadiusPx = Math.sqrt(transverseSqSum / weightSum);

  return {
    peakPx,
    spanMinPx,
    spanMaxPx,
    plumeLengthPx,
    bloomRadiusPx,
    bloomMoments: { transverseSqSum, weightSum },
    srgbBase64: finalRgbBytes.toString('base64'),
    hdrLuma,
    finalLuma,
    fireMask,
  };
}

function computePairVigor(frameA, frameB) {
  const union = new Set([...frameA.fireMask, ...frameB.fireMask]);
  let hdrSum = 0;
  let finalSum = 0;
  for (const p of union) {
    hdrSum += Math.abs(frameA.hdrLuma[p] - frameB.hdrLuma[p]);
    finalSum += Math.abs(frameA.finalLuma[p] - frameB.finalLuma[p]);
  }
  const count = Math.max(1, union.size);
  return {
    unionCount: count,
    hdrDelta: Math.max(1e-5, hdrSum / count),
    finalDelta: Math.max(1e-5, finalSum / count),
  };
}

function buildFullShotReading(question, film, disabled) {
  const [shot] = film.shots;
  const rasterSize = shot.params?.rasterSize ?? [48, 27];
  const checkFrames = shot.params?.checkFrames ?? [...DEFAULT_CHECK_FRAMES];
  const size = question.deliverable.size;
  const cards = {
    ao: findCard(shot, 'post.ao'),
    bloom: findCard(shot, 'post.bloom'),
    volumetric: findCard(shot, 'post.volumetric'),
    grade: findCard(shot, 'post.grade-cl'),
  };

  const refEvaluated = checkFrames.map((frameNo, idx) =>
    evaluateSingleShotFrame(frameNo, idx, size, rasterSize, cards, null));
  const candEvaluated = disabled === null
    ? refEvaluated
    : checkFrames.map((frameNo, idx) =>
        evaluateSingleShotFrame(frameNo, idx, size, rasterSize, cards, disabled));

  const frames = checkFrames.map((frameNo, idx) => {
    const refF = refEvaluated[idx];
    const candF = candEvaluated[idx];
    return {
      frame: idx,
      checkFrame: frameNo,
      bounds: [0.08, 0.10, 0.92, 0.90],
      refPeakPx: refF.peakPx,
      candPeakPx: candF.peakPx,
      refSpanMinPx: refF.spanMinPx,
      refSpanMaxPx: refF.spanMaxPx,
      candSpanMinPx: candF.spanMinPx,
      candSpanMaxPx: candF.spanMaxPx,
      refPlumeLengthPx: refF.plumeLengthPx,
      candPlumeLengthPx: candF.plumeLengthPx,
      refBloomRadiusPx: refF.bloomRadiusPx,
      candBloomRadiusPx: candF.bloomRadiusPx,
      refBloomMoments: refF.bloomMoments,
      candBloomMoments: candF.bloomMoments,
      refSrgb: refF.srgbBase64,
      candSrgb: candF.srgbBase64,
    };
  });

  const vigorPairs = [];
  for (let idx = 0; idx < checkFrames.length - 1; idx++) {
    const refV = computePairVigor(refEvaluated[idx], refEvaluated[idx + 1]);
    const candV = disabled === null
      ? refV
      : computePairVigor(candEvaluated[idx], candEvaluated[idx + 1]);
    vigorPairs.push({
      pair: [checkFrames[idx], checkFrames[idx + 1]],
      unionCount: candV.unionCount,
      refHdrDelta: refV.hdrDelta,
      candHdrDelta: candV.hdrDelta,
      refFinalDelta: refV.finalDelta,
      candFinalDelta: candV.finalDelta,
    });
  }

  return {
    output: {
      size: film.output.size,
      fps: film.output.fps,
      frames: question.deliverable.frames,
      audio: film.audio.mode,
    },
    rasterSize,
    checkFrames,
    frames,
    vigorPairs,
  };
}

const readingCache = new Map();

export function readLevel4ShotFilm(question) {
  const baseId = LEVEL4_SHOT_IDS.has(question?.id)
    ? question.id
    : LEVEL4_SHOT_IDS.has(question?.ext?.['bench.variantOf'])
      ? question.ext['bench.variantOf']
      : null;
  if (!baseId) {
    throw new RangeError(`不是已登记的第 4 级整镜题：${String(question?.id)}`);
  }
  const filmPath = path.join(import.meta.dirname, baseId, 'film.json');
  const film = JSON.parse(fs.readFileSync(filmPath, 'utf8'));
  if (baseId !== question.id && question?.deliverable) {
    film.output = {
      ...film.output,
      size: [...question.deliverable.size],
      fps: question.deliverable.fps,
      frames: question.deliverable.frames,
    };
    if (Array.isArray(film.shots) && film.shots[0]) {
      film.shots[0] = { ...film.shots[0], out: question.deliverable.frames };
    }
    if (Array.isArray(film.audio?.tracks)) {
      film.audio = {
        ...film.audio,
        tracks: film.audio.tracks.map((tr) => ({ ...tr, out: question.deliverable.frames })),
      };
    }
  }
  const checks = validateSolutionFilm(film);
  if (!checks.ok || film.exam !== baseId || !question.needs.every((c) => checks.declaredCards.includes(c))) {
    throw new Error(`第 4 级整镜题标准工程与题目或 film/3.0 契约不符：${question.id}`);
  }
  return film;
}

export function buildLevel4ShotReading(question, disabled = null, film = readLevel4ShotFilm(question)) {
  const cacheKey = JSON.stringify([question.id, film, disabled]);
  if (!readingCache.has(cacheKey)) {
    const raw = buildFullShotReading(question, film, disabled === 'deliver.encode' ? null : disabled);
    let full;
    if (disabled === 'deliver.encode' || film.delivery?.card !== 'deliver.encode@1') {
      const { output: _unused, ...rest } = raw;
      full = { delivery: null, ...rest };
    } else {
      const { output, ...rest } = raw;
      const encoder = createEncoder(output, film.delivery);
      try {
        full = {
          delivery: {
            size: encoder.object.size,
            fps: encoder.object.fps,
            frames: output.frames,
            audio: output.audio,
          },
          ...rest,
        };
      } finally {
        encoder.dispose();
      }
    }
    if (readingCache.size >= 24) readingCache.delete(readingCache.keys().next().value);
    readingCache.set(cacheKey, full);
  }
  return globalThis.structuredClone(readingCache.get(cacheKey));
}

export function runLevel4ShotControls(question, opts = {}) {
  const film = readLevel4ShotFilm(question);
  const score = (disabled) => scoreLevel4Shot(question, buildLevel4ShotReading(question, disabled, film), opts);
  const controls = [
    ...new Set([
      ...question.needs,
      ...film.shots.flatMap((s) => (s.cards ?? []).map((c) => c.use.split('@')[0])),
    ]),
  ];
  return {
    positive: score(null),
    negatives: Object.fromEntries(controls.map((control) => [control, score(control)])),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const load = (id) =>
    JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'questions', 'level-4', `${id}.json`), 'utf8'));
  if (args.length === 2 && args[0] === '--reference' && LEVEL4_SHOT_IDS.has(args[1])) {
    const question = load(args[1]);
    const ref = { question: question.id, kind: 'reference', readings: buildLevel4ShotReading(question) };
    console.log(JSON.stringify(ref, null, 2));
  } else if (!args.length) {
    for (const id of LEVEL4_SHOT_IDS) {
      const { positive, negatives } = runLevel4ShotControls(load(id));
      console.log(JSON.stringify({ id, positive, negatives }));
      if (!positive.pass || positive.score !== 1 || Object.values(negatives).some((v) => v.pass || v.score >= 1)) {
        process.exitCode = 1;
      }
    }
  } else {
    console.error('用法：node run-b19.mjs [--reference 题号]');
    process.exitCode = 2;
  }
}
