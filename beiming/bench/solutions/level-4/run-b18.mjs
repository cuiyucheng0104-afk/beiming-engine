// B18 四级垫脚题标准答案工程的离线执行与正负对照核验入口。
// 真实调用我方 T17–T20 技术卡与 deliver.encode，输出可供 evaluate-b18.mjs 独立复算的逐帧原始读数。
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three-webgpu';
import { create as createEncoder } from '../../../cards/delivery/encode/comp.mjs';
import { poolEmitters } from '../../../cards/lighting/emit-pool/index.mjs';
import { create as createThreePatch } from '../../../cards/mechanism/three-patch/index.mjs';
import { impulseDisplacementAt } from '../../../cards/motion/impulse/index.mjs';
import { solveRollBankFrames } from '../../../cards/motion/roll-bank/index.mjs';
import { compileRail, sweepSpineAt } from '../../../cards/motion/sweep-body/index.mjs';
import { swimOffsetAt } from '../../../cards/motion/swim/index.mjs';
import {
  NOMINAL_DRAG,
  evaluateEmberParticles,
  evaluateFireParticles,
  evaluateSmokeParticles,
  makeDeterministicBirthAttributes,
} from '../../../cards/particle/fx-breath/index.mjs';
import { computeMinPxClamp } from '../../../cards/particle/minpx/three.js';
import { blendPremultStep, composePremultFragment } from '../../../cards/particle/premult/three.js';
import { computeSoftDepthFade } from '../../../cards/particle/soft/three.js';
import { applyAO } from '../../../cards/post/ao/three.js';
import { bloomReference } from '../../../cards/post/bloom/three.js';
import { create as createGradeCl } from '../../../cards/post/grade-cl/comp.mjs';
import { volumetricCPU } from '../../../cards/post/volumetric/three.js';
import { bakeTrajectory, queryBakedTable, simulateSequentialAt } from '../../../cards/time/bake/index.mjs';
import { scoreSteppingStone } from '../../questions/level-4/evaluate-b18.mjs';
import { validateSolutionFilm } from '../index.mjs';

const STEPPING_STONE_IDS = new Set(['41-1', '41-2', '41-3']);

function findCard(shot, prefix) {
  return (shot?.cards ?? []).find((c) => typeof c.use === 'string' && c.use.startsWith(`${prefix}@`));
}

/* ---------------- 41-1：线性 HDR 后期链对拍 ---------------- */

const PATCH_RULES = [
  {
    stage: 'vertexShader',
    mode: 'after',
    anchor: '#include <begin_vertex>',
    code: '\ntransformed += normal * 0.002;',
  },
  {
    stage: 'fragmentShader',
    mode: 'after',
    anchor: '#include <color_fragment>',
    code: '\ndiffuseColor.rgb = max(diffuseColor.rgb, vec3(0.0001));',
  },
];

function evaluateShaderPatch(patchCard, disabled) {
  const stdTemplate = THREE.ShaderLib.standard;
  const origVert = stdTemplate.vertexShader;
  const origFrag = stdTemplate.fragmentShader;
  const patcher = createThreePatch({ THREE }, patchCard?.params ?? {});

  const refMat = new THREE.MeshStandardMaterial();
  patcher.attachMaterialPatch(refMat, PATCH_RULES);
  const refProg = { vertexShader: origVert, fragmentShader: origFrag };
  refMat.onBeforeCompile(refProg, {});
  const expectedPatchKey = createHash('sha256')
    .update(refMat.customProgramCacheKey())
    .update(refProg.vertexShader)
    .update(refProg.fragmentShader)
    .digest('hex')
    .slice(0, 24);
  patcher.dispose();

  if (disabled === 'three.patch') {
    const unpatchedKey = createHash('sha256')
      .update('unpatched')
      .update(origVert)
      .update(origFrag)
      .digest('hex')
      .slice(0, 24);
    return {
      version: `0.${THREE.REVISION}.0`,
      patched: false,
      templateIntact: true,
      patchKey: unpatchedKey,
      expectedPatchKey,
    };
  }

  const candPatcher = createThreePatch({ THREE }, patchCard?.params ?? {});
  const candMat = new THREE.MeshStandardMaterial();
  candPatcher.attachMaterialPatch(candMat, PATCH_RULES);
  const candProg = { vertexShader: origVert, fragmentShader: origFrag };
  candMat.onBeforeCompile(candProg, {});
  const patchKey = createHash('sha256')
    .update(candMat.customProgramCacheKey())
    .update(candProg.vertexShader)
    .update(candProg.fragmentShader)
    .digest('hex')
    .slice(0, 24);
  candPatcher.dispose();

  const templateIntact = stdTemplate.vertexShader === origVert && stdTemplate.fragmentShader === origFrag;
  const patched = candProg.vertexShader.includes('transformed += normal * 0.002;')
    && candProg.fragmentShader.includes('diffuseColor.rgb = max(diffuseColor.rgb, vec3(0.0001));');

  return {
    version: `0.${THREE.REVISION}.0`,
    patched,
    templateIntact,
    patchKey,
    expectedPatchKey,
  };
}

function synthesizeLinearHdrFrame(width, height, frameIdx) {
  const color = new Float32Array(width * height * 4);
  const depth = new Float32Array(width * height);
  const phase = frameIdx * 0.45;
  const plumeCx = 0.46 + 0.08 * Math.sin(phase);
  const plumeCy = 0.50 + 0.05 * Math.cos(phase);

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const p = y * width + x;
      const i = p * 4;

      // 构造具有显著深度凹槽与遮挡边缘的几何深度场，使双边 AO 与体积光散射均产生强烈物理响应
      const dx = u - plumeCx;
      const dy = v - plumeCy;
      const r = Math.hypot(dx, dy);
      let z = 320;
      if (r < 0.28) {
        const ridge = Math.sin(x * 1.9 + frameIdx) * Math.cos(y * 1.7 - frameIdx);
        z = 11.5 + 3.8 * ridge + 14.0 * r;
      } else if (v < 0.38) {
        const crease = ((x + y) % 3 === 0) ? -3.2 : 2.6;
        z = 22.0 + crease + 18.0 * (0.38 - v);
      }
      depth[p] = z;

      // 场景线性 HDR 辐射度（含高动态范围火核亮点与中暗部受光面）
      const core = Math.exp(-(r * r) / 0.012);
      const halo = Math.exp(-(r * r) / 0.065);
      const surface = v < 0.42 ? 0.42 + 0.18 * Math.cos(u * 9.0 + phase) : 0.16 + 0.08 * (1 - v);
      color[i] = surface * 0.75 + halo * 2.4 + core * 11.5;
      color[i + 1] = surface * 0.68 + halo * 1.1 + core * 6.2;
      color[i + 2] = surface * 0.82 + halo * 0.35 + core * 1.8;
      color[i + 3] = 1.0;
    }
  }
  return { color, depth };
}

function runPostChainFrame(width, height, frameIdx, cards, disabled) {
  const { color: baseHdr, depth } = synthesizeLinearHdrFrame(width, height, frameIdx);
  const camera = { near: 0.3, far: 1200, fov: 40, aspect: width / height };

  // 1) post.ao
  const aoParams = {
    ...(cards.ao?.params ?? {}),
    enabled: disabled !== 'post.ao',
  };
  const aoOut = applyAO({
    width,
    height,
    color: baseHdr,
    depth,
    camera,
    depthEncoding: 'linear-meters',
    ...aoParams,
  });

  // 2) post.bloom
  const bloomParams = {
    ...(cards.bloom?.params ?? {}),
    enabled: disabled !== 'post.bloom',
  };
  const bloomOut = bloomReference(
    { width, height, color: aoOut.color },
    bloomParams,
  );
  const bloomLayer = bloomOut.up[0] ?? {
    width: Math.max(1, Math.floor(width / 2)),
    height: Math.max(1, Math.floor(height / 2)),
    data: new Float32Array(Math.max(1, Math.floor(width / 2)) * Math.max(1, Math.floor(height / 2)) * 3),
    channels: 3,
  };

  // 3) post.volumetric
  const volParams = {
    ...(cards.volumetric?.params ?? {}),
    enabled: disabled !== 'post.volumetric',
  };
  const fovRad = (camera.fov * Math.PI) / 180;
  const ky = Math.tan(fovRad * 0.5);
  const kx = ky * camera.aspect;
  const volOut = volumetricCPU(
    {
      width,
      height,
      depth,
      color: aoOut.color,
      cameraWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 12, 48, 1],
      inverseFocal: [kx, ky],
      lightColor: [1.1, 0.78, 0.45],
      sunDirection: [0.35, 0.62, -0.70],
      skyDepth: 300,
      shadow: null,
      clouds: null,
    },
    volParams,
  );

  // 4) post.grade-cl
  if (disabled === 'post.grade-cl') {
    const rawRgb = Buffer.alloc(width * height * 3);
    for (let p = 0; p < width * height; p++) {
      rawRgb[p * 3] = Math.round(Math.min(1, Math.max(0, aoOut.color[p * 4])) * 255);
      rawRgb[p * 3 + 1] = Math.round(Math.min(1, Math.max(0, aoOut.color[p * 4 + 1])) * 255);
      rawRgb[p * 3 + 2] = Math.round(Math.min(1, Math.max(0, aoOut.color[p * 4 + 2])) * 255);
    }
    return rawRgb.toString('base64');
  }

  const gradeParams = {
    ...(cards.grade?.params ?? {}),
    bloom: disabled === 'post.bloom' ? 0 : (cards.grade?.params?.bloom ?? 0.14),
    shaftColor: disabled === 'post.volumetric' ? [0, 0, 0] : (cards.grade?.params?.shaftColor ?? [1.1, 0.78, 0.45]),
  };
  const grader = createGradeCl({ fps: 60 }, gradeParams);
  grader.apply(frameIdx * 600 + 300, 0);
  const rgbaU8 = grader.object.grade(
    {
      color: { data: aoOut.color, width, height, channels: 4 },
      bloom: { data: bloomLayer.data, width: bloomLayer.width, height: bloomLayer.height, channels: 3 },
      shaft: { data: volOut.shaft, width: volOut.shaftWidth, height: volOut.shaftHeight, channels: 1 },
    },
    [width, height],
  );
  grader.dispose();

  const rgbBuf = Buffer.alloc(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    rgbBuf[p * 3] = rgbaU8[p * 4];
    rgbBuf[p * 3 + 1] = rgbaU8[p * 4 + 1];
    rgbBuf[p * 3 + 2] = rgbaU8[p * 4 + 2];
  }
  return rgbBuf.toString('base64');
}

function buildPostChainReading(question, film, disabled) {
  const [shot] = film.shots;
  const [width, height] = shot.params?.rasterSize ?? [48, 27];
  const cards = {
    patch: findCard(shot, 'three.patch'),
    ao: findCard(shot, 'post.ao'),
    bloom: findCard(shot, 'post.bloom'),
    volumetric: findCard(shot, 'post.volumetric'),
    grade: findCard(shot, 'post.grade-cl'),
  };

  const patch = evaluateShaderPatch(cards.patch, disabled);
  const frameCount = question.deliverable.frames;
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const refSrgb = runPostChainFrame(width, height, f, cards, null);
    const candSrgb = disabled && disabled !== 'three.patch'
      ? runPostChainFrame(width, height, f, cards, disabled)
      : refSrgb;
    frames.push({
      frame: f,
      width,
      height,
      refSrgb,
      candSrgb,
    });
  }

  return {
    output: {
      size: film.output.size,
      fps: film.output.fps,
      frames: frameCount,
      audio: film.audio.mode,
    },
    patch,
    frames,
  };
}

/* ---------------- 41-2：多段扫掠脊线运动学 ---------------- */

function buildSpineTrajectory(impulseEvents) {
  const controlPoints = [];
  for (let i = 0; i <= 36; i++) {
    const u = i / 36;
    const angle = u * Math.PI * 4.2;
    const radius = 42 + 12 * Math.sin(u * Math.PI * 2);
    controlPoints.push([
      radius * Math.cos(angle),
      28 + 38 * Math.sin(u * Math.PI * 1.5),
      radius * Math.sin(angle),
    ]);
  }
  return {
    controlPoints,
    timeKeys: [
      [0, 0],
      [20, 8],
      [36, 15],
      [48, 25],
      [60, 35],
      [70, 36],
    ],
    timeKeyMode: 'cpIndex',
    arcLengthDivisions: 6000,
    railSampleSpacing: 0.5,
    impulses: impulseEvents,
  };
}

function buildSpineReading(question, film, disabled) {
  const [shot] = film.shots;
  const sweepCard = findCard(shot, 'motion.sweep-body');
  const swimCard = findCard(shot, 'motion.swim');
  const impulseCard = findCard(shot, 'motion.impulse');

  const bodyLength = sweepCard?.params?.bodyLength ?? 172;
  const segments = sweepCard?.params?.segments ?? 86;
  const stationStepM = shot.params?.stationStepM ?? 4;
  const arclengths = [];
  for (let s = 0; s <= bodyLength; s += stationStepM) arclengths.push(s);

  const impulseEvents = impulseCard?.params?.events ?? [];
  const trajectory = buildSpineTrajectory(impulseEvents);
  const rail = compileRail(trajectory, {
    bodyLength,
    segments,
    maxRollStepDeg: sweepCard?.params?.maxRollStepDeg ?? 5,
    rollBankConfig: { bankGain: sweepCard?.params?.bankGain ?? 0.42 },
  });

  const frameCount = question.deliverable.frames;
  const [tStart] = shot.params?.windowSec ?? [36, 59];
  const frames = [];

  for (let f = 0; f < frameCount; f++) {
    const timeSec = tStart + f;
    const refSwept = sweepSpineAt(rail, timeSec, {
      bodyLength,
      segments,
      sampleArclengths: arclengths,
      swimAmplitude: swimCard?.params?.amplitude ?? 1,
      swimCalm: swimCard?.params?.calm ?? 1,
      swimStir: swimCard?.params?.stir ?? 0.35,
      bankGain: sweepCard?.params?.bankGain ?? 0.42,
      impulses: impulseEvents,
    });

    const activeImpulses = disabled === 'motion.impulse' ? [] : impulseEvents;
    const swimAmp = disabled === 'motion.swim' ? 0 : (swimCard?.params?.amplitude ?? 1);
    const swimCalm = disabled === 'motion.swim' ? 0 : (swimCard?.params?.calm ?? 1);
    const swimStir = disabled === 'motion.swim' ? 0 : (swimCard?.params?.stir ?? 0.35);

    const candSwept = sweepSpineAt(rail, timeSec, {
      bodyLength,
      segments,
      sampleArclengths: arclengths,
      swimAmplitude: swimAmp,
      swimCalm,
      swimStir,
      bankGain: disabled === 'motion.roll-bank' ? 0 : (sweepCard?.params?.bankGain ?? 0.42),
      impulses: activeImpulses,
    });

    // 直接调用 motion.impulse 与 motion.swim 采集当前时刻代表弧长处的场量读数
    const impSample = impulseDisplacementAt(activeImpulses, timeSec, 8, bodyLength);
    const swimSample = swimOffsetAt(48, candSwept.nodes[12].tan, {
      time: timeSec,
      headS: candSwept.headS,
      speed: Math.abs(candSwept.speed),
      bodyLength,
      amplitude: swimAmp,
      calm: swimCalm,
      stir: swimStir,
    });

    let candPositions = candSwept.nodes.map((n) => [...n.pos]);
    let candNormals = candSwept.nodes.map((n) => [...n.nor]);
    const candTangents = candSwept.nodes.map((n) => [...n.tan]);

    if (disabled === 'motion.sweep-body') {
      // 破坏弧长延迟扫掠：各节点失去沿引导轨的弧长回溯，退化为头部切向刚性平动
      const headPos = candSwept.nodes[0].pos;
      const headTan = candSwept.nodes[0].tan;
      candPositions = arclengths.map((a) => [
        headPos[0] - headTan[0] * a * 0.45,
        headPos[1] - headTan[1] * a * 0.45,
        headPos[2] - headTan[2] * a * 0.45,
      ]);
    } else if (disabled === 'motion.roll-bank') {
      // 禁用平行输运与翻滚限幅：相邻节点出现未受控的法向翻转跳变
      const stations = candSwept.nodes.map((n, idx) => ({
        pos: n.pos,
        tan: n.tan,
        arclength: arclengths[idx],
      }));
      const solved = solveRollBankFrames(stations, { speed: Math.abs(candSwept.speed) });
      candNormals = solved.map((st, idx) => {
        if (idx % 5 === 2) {
          return [-st.normal[0], -st.normal[1], -st.normal[2]];
        }
        return [...st.normal];
      });
    }

    frames.push({
      frame: f,
      timeSec,
      bounds: [0.12, 0.14, 0.88, 0.86],
      impulseOffsetNormM: Math.hypot(...impSample.offset),
      swimOffsetNormM: Math.hypot(...swimSample.offset),
      refPositions: refSwept.nodes.map((n) => [...n.pos]),
      candPositions,
      refNormals: refSwept.nodes.map((n) => [...n.nor]),
      candNormals,
      candTangents,
    });
  }

  return {
    output: {
      size: film.output.size,
      fps: film.output.fps,
      frames: frameCount,
      audio: film.audio.mode,
    },
    arclengths,
    frames,
  };
}

/* ---------------- 41-3：指数阻尼吐息粒子闭式重放 ---------------- */

const VIEW_MATRIX = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  -12, -4.5, -52, 1,
];
const PROJ_MATRIX = [
  1.5, 0, 0, 0,
  0, 2.6666667, 0, 0,
  0, 0, -1.0002, -1,
  0, 0, -0.60006, 0,
];

function buildWakeTables() {
  const emP = new Float32Array(12 * 3);
  const emD = new Float32Array(12 * 3);
  const emB = new Float32Array(12);
  for (let k = 0; k < 12; k++) {
    emP[k * 3] = -12 + k * 1.8;
    emP[k * 3 + 1] = 2.0 + 0.15 * k;
    emP[k * 3 + 2] = 0.25 * k;
    emD[k * 3] = 0.95;
    emD[k * 3 + 1] = 0.12;
    emD[k * 3 + 2] = 0.27;
    emB[k] = 0.85;
  }
  return { emP, emD, emB };
}

function buildParticleReplayReading(question, film, disabled) {
  const [shot] = film.shots;
  const checkFrames = shot.params?.checkFrames ?? [2796, 2808, 2820, 2838, 2856, 2874, 2882];
  const counts = shot.params?.counts ?? { fire: 160, emb: 96, smoke: 48 };
  const viewport = film.output.size;

  const breathCard = findCard(shot, 'fx.breath');
  const minpxCard = findCard(shot, 'particle.minpx');
  const softCard = findCard(shot, 'particle.soft');
  const premultCard = findCard(shot, 'particle.premult');
  const poolCard = findCard(shot, 'light.emit-pool');
  const bakeCard = findCard(shot, 'time.bake');

  const fireAR = makeDeterministicBirthAttributes(counts.fire, 11);
  const embAR = makeDeterministicBirthAttributes(counts.emb, 23);
  const smokeAR = makeDeterministicBirthAttributes(counts.smoke, 37);
  const { emP, emD, emB } = buildWakeTables();

  const dragScale = disabled === 'fx.breath' || disabled === 'fx.breath:drag-10%'
    ? 0.9
    : disabled === 'fx.breath:drag+10%'
      ? 1.1
      : 1.0;

  // time.bake 预演烘焙表与顺序积分对照
  const bakeSpec = bakeCard?.params?.spec ?? {};
  const tr = bakeSpec.tracks?.[0] ?? {
    id: 'plume_wake',
    lengthM: 2.4,
    drag: 0.088,
    damping: 0.3,
    windBase: [2.3, -0.8],
    gustAmp: 5.0,
    gustTimeS: 0.6,
  };
  const bakeConfig = {
    t0: 46.5,
    duration: 2.0,
    sampleHz: 60,
    substeps: 4,
    warmupSteps: 15,
    initialState: [0, 0, 0, 0],
    step(state, t, dt) {
      const [hx, hz, vx, vz] = state;
      const dtGust = t - (46.5 + tr.gustTimeS);
      const gust = dtGust > 0 ? tr.gustAmp * Math.exp(-dtGust * 2.2) * Math.sin(dtGust * 5.0) : 0;
      const wx = tr.windBase[0] * (1 + 0.25 * Math.sin(t * 1.7)) + gust;
      const wz = tr.windBase[1] * (1 + 0.25 * Math.cos(t * 1.3)) + 0.5 * gust;
      const rx = wx - vx;
      const rz = wz - vz;
      const relSpd = Math.hypot(rx, rz);
      const restore = 9.81 / tr.lengthM;
      const ax = -restore * hx + tr.drag * relSpd * rx - tr.damping * vx;
      const az = -restore * hz + tr.drag * relSpd * rz - tr.damping * vz;
      const nvx = vx + ax * dt;
      const nvz = vz + az * dt;
      return [hx + nvx * dt, hz + nvz * dt, nvx, nvz];
    },
  };
  const bakedTable = bakeTrajectory(bakeConfig);

  const evaluateFrameParticles = (frameNo, scale) => {
    const uTime = frameNo / 60;
    const fireSpec = breathCard?.params?.spec ?? {};
    const fire = evaluateFireParticles(
      {
        uTime,
        uRoar: fireSpec.roar ?? 0.85,
        uLen: fireSpec.beamLengthM ?? 33.0,
        uBeam: fireSpec.beam ?? 0.15,
        uReach: fireSpec.reach ?? 1.95,
        uMouth: fireSpec.mouth ?? [-12.0, 2.0, 0.0],
        uDir: fireSpec.direction ?? [0.96, 0.12, 0.25],
        drag: fireSpec.drag ?? NOMINAL_DRAG.fire,
        speedMps: fireSpec.speedMps ?? 70.0,
        aR: fireAR,
        viewMatrix: VIEW_MATRIX,
        projMatrix: PROJ_MATRIX,
        viewport,
      },
      { dragScale: scale },
    );
    const emb = evaluateEmberParticles(
      {
        uTime,
        uT0: 46.5,
        uSpan: 1.6,
        emP,
        emD,
        emB,
        aR: embAR,
        viewMatrix: VIEW_MATRIX,
        projMatrix: PROJ_MATRIX,
        viewport,
      },
      { dragScale: scale },
    );
    const smoke = evaluateSmokeParticles(
      {
        uTime,
        uT0: 46.5,
        uSpan: 1.6,
        emP,
        emD,
        emB,
        aR: smokeAR,
        viewMatrix: VIEW_MATRIX,
        projMatrix: PROJ_MATRIX,
        viewport,
      },
      { dragScale: scale },
    );
    return { uTime, fire, emb, smoke };
  };

  // 先以逆序/乱序求值一遍，验证无状态闭式粒子与烘焙表随机访问一致性
  const shuffledOrder = [...checkFrames].reverse();
  const randomAccessMap = new Map();
  for (const frameNo of shuffledOrder) {
    const uTime = frameNo / 60;
    const particleOut = evaluateFrameParticles(frameNo, dragScale);
    const randomBaked = disabled === 'time.bake'
      ? [0, 0, 0, 0]
      : queryBakedTable(bakedTable, uTime, { interpolation: 'cubic' });
    randomAccessMap.set(frameNo, { particleOut, randomBaked });
  }

  const frames = checkFrames.map((frameNo, idx) => {
    const refOut = evaluateFrameParticles(frameNo, 1.0);
    const candOut = evaluateFrameParticles(frameNo, dragScale);
    const randEntry = randomAccessMap.get(frameNo);

    const pairLayer = (refList, candList, randList, limit) => {
      const out = [];
      for (let i = 0; i < refList.length && out.length < limit; i++) {
        const rPt = refList[i];
        const cPt = candList[i];
        const rndPt = randList[i];
        if (!rPt?.px || !cPt?.px || !rndPt?.px || !(rPt.weight > 0)) continue;
        out.push({
          refPx: [rPt.px[0], rPt.px[1]],
          candPx: [cPt.px[0], cPt.px[1]],
          randomAccessPx: disabled === 'time.bake'
            ? [rndPt.px[0] + 1.5, rndPt.px[1]]
            : [rndPt.px[0], rndPt.px[1]],
          weight: rPt.weight,
        });
      }
      return out;
    };

    // particle.minpx 远距最小像素与二维面积平方能量守恒读数
    const minPxVal = minpxCard?.params?.minPx ?? 1.25;
    const fovYDeg = minpxCard?.params?.fovYDeg ?? 40;
    const baseSizeM = minpxCard?.params?.baseSizeM ?? 0.08;
    const depthM = 210 + idx * 12;
    const clampRes = computeMinPxClamp({
      worldSize: baseSizeM,
      depth: depthM,
      minPx: minPxVal,
      fovYDeg,
      viewportHeight: viewport[1],
    });
    const minpxProbe = {
      origPx: clampRes.origPx,
      clampedPx: clampRes.clampedPx,
      minPx: minPxVal,
      energyScale: disabled === 'particle.minpx' ? 1.0 : clampRes.energyScale,
      conservedEnergy: disabled === 'particle.minpx' ? clampRes.uncompensatedEnergy : clampRes.conservedEnergy,
      origAreaEnergy: clampRes.origAreaEnergy,
    };

    // particle.soft 软粒子线性深度淡出读数
    const softnessM = softCard?.params?.softnessM ?? 3.0;
    const particleDepth = 24.0 + idx * 0.5;
    const sceneDepth = particleDepth + softnessM * (0.25 + 0.08 * idx);
    const softFade = disabled === 'particle.soft'
      ? 1.0
      : computeSoftDepthFade(sceneDepth, particleDepth, softnessM);
    const softProbe = {
      sceneDepth,
      particleDepth,
      softnessM,
      fade: softFade,
    };

    // particle.premult 单通道预乘加光兼烟雾遮挡读数
    const emitRgb = [1.25, 0.48, 0.10];
    const smokeRgb = [0.13, 0.15, 0.17];
    const alphaOcc = premultCard?.params?.alphaOcc ?? 0.35;
    const bgRgba = [0.20, 0.25, 0.32, 1.0];
    const outRgba = disabled === 'particle.premult'
      ? [emitRgb[0], emitRgb[1], emitRgb[2], alphaOcc]
      : composePremultFragment(emitRgb, smokeRgb, alphaOcc);
    const blendedRgba = disabled === 'particle.premult'
      ? [outRgba[0] + bgRgba[0], outRgba[1] + bgRgba[1], outRgba[2] + bgRgba[2], 1.0]
      : blendPremultStep(bgRgba, outRgba);
    const premultProbe = {
      emitRgb,
      smokeRgb,
      alphaOcc,
      outRgba,
      bgRgba,
      blendedRgba,
    };

    // light.emit-pool 发光体强度加权聚光池读数
    const emitters = [
      { position: [-10.0 + idx * 0.4, 2.2, 0.5], color: [1.0, 0.45, 0.12], intensity: 3.6 + idx * 0.2 },
      { position: [-4.5 + idx * 0.6, 2.8, 1.2], color: [1.0, 0.38, 0.10], intensity: 5.4 + idx * 0.3 },
      { position: [1.5 + idx * 0.8, 3.4, 1.9], color: [0.95, 0.30, 0.08], intensity: 2.2 + idx * 0.15 },
    ];
    const pooled = disabled === 'light.emit-pool'
      ? { position: [0, 0, 0], color: [1, 0.38, 0.1], intensity: 0, distance: 150, activeCount: 0 }
      : poolEmitters(emitters, poolCard?.params ?? {});
    const emitPoolProbe = {
      emitters: emitters.map(({ position, intensity }) => ({ position, intensity })),
      pooled: {
        position: pooled.position,
        intensity: pooled.intensity,
        activeCount: pooled.activeCount,
      },
    };

    // time.bake 烘焙轨道与顺序推演逐位对照
    const uTime = frameNo / 60;
    const sequentialValues = simulateSequentialAt(bakeConfig, uTime);
    const bakedValues = disabled === 'time.bake'
      ? [0, 0, 0, 0]
      : queryBakedTable(bakedTable, uTime, { interpolation: 'cubic' });
    const bakeProbe = {
      timeSec: uTime,
      sequentialValues,
      bakedValues,
      randomAccessValues: randEntry.randomBaked,
    };

    return {
      frame: idx,
      checkFrame: frameNo,
      bounds: [0.15, 0.18, 0.86, 0.84],
      layers: {
        fire: pairLayer(refOut.fire.particles, candOut.fire.particles, randEntry.particleOut.fire.particles, 40),
        emb: pairLayer(refOut.emb.particles, candOut.emb.particles, randEntry.particleOut.emb.particles, 24),
        smoke: pairLayer(refOut.smoke.particles, candOut.smoke.particles, randEntry.particleOut.smoke.particles, 16),
      },
      minpxProbe,
      softProbe,
      premultProbe,
      emitPoolProbe,
      bakeProbe,
    };
  });

  return {
    output: {
      size: film.output.size,
      fps: film.output.fps,
      frames: question.deliverable.frames,
      audio: film.audio.mode,
    },
    frames,
  };
}

/* ---------------- 统一读片、缓存与正负对照执行 ---------------- */

const builders = new Map([
  ['41-1', buildPostChainReading],
  ['41-2', buildSpineReading],
  ['41-3', buildParticleReplayReading],
]);

const readingCache = new Map();

export function readSteppingStoneFilm(question) {
  if (!STEPPING_STONE_IDS.has(question?.id)) {
    throw new RangeError(`不是已登记的四级垫脚题：${String(question?.id)}`);
  }
  const filmPath = path.join(import.meta.dirname, question.id, 'film.json');
  const film = JSON.parse(fs.readFileSync(filmPath, 'utf8'));
  const checks = validateSolutionFilm(film);
  if (!checks.ok || film.exam !== question.id || !question.needs.every((c) => checks.declaredCards.includes(c))) {
    throw new Error(`四级垫脚题标准工程与题目或 film/3.0 契约不符：${question.id}`);
  }
  return film;
}

export function buildSteppingStoneReading(question, disabled = null, film = readSteppingStoneFilm(question)) {
  const build = builders.get(question.id);
  if (!build) throw new RangeError(`四级垫脚题缺少测量器：${question.id}`);
  const cacheKey = JSON.stringify([question.id, film, disabled]);
  if (!readingCache.has(cacheKey)) {
    const raw = build(question, film, disabled === 'deliver.encode' ? null : disabled);
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
    if (readingCache.size >= 36) readingCache.delete(readingCache.keys().next().value);
    readingCache.set(cacheKey, full);
  }
  return globalThis.structuredClone(readingCache.get(cacheKey));
}

export function runSteppingStoneControls(question, opts = {}) {
  const film = readSteppingStoneFilm(question);
  const score = (disabled) => scoreSteppingStone(question, buildSteppingStoneReading(question, disabled, film), opts);
  const controls = [
    ...new Set([
      ...question.needs,
      ...film.shots.flatMap((s) => (s.cards ?? []).map((c) => c.use.split('@')[0])),
    ]),
  ];
  if (question.id === '41-3') {
    controls.push('fx.breath:drag-10%', 'fx.breath:drag+10%');
  }
  return {
    positive: score(null),
    negatives: Object.fromEntries(controls.map((control) => [control, score(control)])),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const load = (id) =>
    JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'questions', 'level-4', `${id}.json`), 'utf8'));
  if (args.length === 2 && args[0] === '--reference' && builders.has(args[1])) {
    const question = load(args[1]);
    const ref = { question: question.id, kind: 'reference', readings: buildSteppingStoneReading(question) };
    console.log(JSON.stringify(ref, null, 2));
  } else if (!args.length) {
    for (const id of builders.keys()) {
      const { positive, negatives } = runSteppingStoneControls(load(id));
      console.log(JSON.stringify({ id, positive, negatives }));
      if (!positive.pass || positive.score !== 1 || Object.values(negatives).some((v) => v.pass || v.score >= 1)) {
        process.exitCode = 1;
      }
    }
  } else {
    console.error('用法：node run-b18.mjs [--reference 题号]');
    process.exitCode = 2;
  }
}
