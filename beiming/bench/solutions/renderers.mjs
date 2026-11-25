// B20 12 份标准答案工程的真实技术卡驱动渲染器与真实读回量测器。
// 每道题真实调用对应 beiming/cards/* 模块、经 FFmpeg 编码生成标准 BT.709 deliverable.mp4，
// 再通过真实 ffprobe/ffmpeg 解码与 observe/metrics + 官方 evaluate-b2/b3/b4 + verify/predicates 读回判分。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { create as createAlign } from '../../cards/audio/align/comp.mjs';
import { create as createEventMix } from '../../cards/audio/event-mix/comp.mjs';
import { create as createMaster } from '../../cards/audio/master/comp.mjs';
import { evaluate as evalCueKf } from '../../cards/camera/cue-kf/evaluate.mjs';
import { evaluate as evalDrift } from '../../cards/camera/drift/evaluate.mjs';
import { evaluate as evalFit } from '../../cards/camera/fit/evaluate.mjs';
import { evaluate as evalOrbit } from '../../cards/camera/orbit/evaluate.mjs';
import { stagePlan } from '../../cards/mechanism/page-det2d/config.mjs';
import { evaluate as evalCutGrid } from '../../cards/time/cut-grid/evaluate.mjs';
import { evaluate as evalEnvelope } from '../../cards/time/envelope/evaluate.mjs';
import { evaluate as evalEvents } from '../../cards/time/events/evaluate.mjs';
import { evaluate as evalNarration } from '../../cards/time/narration/evaluate.mjs';
import { evaluate as evalTimeline } from '../../cards/time/timeline/evaluate.mjs';
import { create as createPanels } from '../../cards/two-d/layout-panels/comp.mjs';
import { create as createCursor } from '../../cards/two-d/overlay-cursor/comp.mjs';
import { create as createSubs } from '../../cards/two-d/overlay-subs/comp.mjs';
import { audioLoudness, blackFreezeDup, cutYdif, deliverSpec } from '../../observe/metrics/index.mjs';
import { checkAssertion, evaluateAssertion, parseFps, scopeRange } from '../../verify/predicates.mjs';
import {
  argsOf as argsOfL1,
  readClosure,
  readFraming,
  readLayout,
  readMaster,
  readNearest,
  readPixelBoxes,
  score as scoreL1,
} from '../questions/level-1/evaluate-b2.mjs';
import {
  evaluate as evaluateL2a,
  read23_2,
  read27_1,
  read29_2,
  read30_1,
  readFilm,
} from '../questions/level-2-a/evaluate-b3.mjs';
import {
  median,
  readBaseShare,
  readCameraStatic,
  readHits,
  readLock,
  readMoveStarts,
  readMusicAlign,
  readSubtitleLag,
  score as scoreL2b,
} from '../questions/level-2-b/evaluate-b4.mjs';
import {
  SAMPLE_RATE,
  bt709Args,
  decodeAllFramesGray,
  decodeAudioMono48k,
  decodeSelectedFramesGray,
  decodeSelectedFramesRgb,
  encodeRawFramesStream,
  encodeSpecFor,
  probeDeliverableSpecAsync,
  runFfmpegSync,
  writeFfmetadataChapters,
  writeWav48k,
} from './media.mjs';

const AUDIO_CHANNELS = { none: 0, mono: 1, stereo: 2, required: 2 };

const fpsFloat = (fpsStr) => {
  const parsed = parseFps(fpsStr);
  return Number(parsed.num) / Number(parsed.den);
};

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cmpHolds(value, cmp) {
  if (!cmp || !Number.isFinite(value)) return false;
  if (cmp.op === '>=') return value >= cmp.value;
  if (cmp.op === '<=') return value <= cmp.value;
  if (cmp.op === 'in') return value >= cmp.lo && value <= cmp.hi;
  return false;
}

const dropComparisonUnit = (text) => text.replace(/(\])\s*(?:deg|f|s|mm)\b/g, '$1');

/** 通用基础谓词求值：已上线谓词交 verify/predicates.mjs，planned 几何/环绕/起音谓词由真实量测逐项核对 */
export function evaluateBasePredicate(text, film, measured) {
  const stripped = dropComparisonUnit(text);
  const checked = checkAssertion(stripped);
  if (checked.ok) {
    const res = evaluateAssertion(stripped, film, measured);
    return { predicate: text, pass: res.status === 'pass', status: res.status, detail: res };
  }
  const onlyPlanned = Boolean(checked.assertion)
    && checked.errors.length > 0
    && checked.errors.every((e) => e.evidence === 'predicate.planned');
  if (!onlyPlanned) {
    return { predicate: text, pass: false, status: 'fail', detail: { errors: checked.errors } };
  }
  const a = checked.assertion;
  const bound = checked.bound;
  const range = scopeRange(a.scope, film);
  if (!range) return { predicate: text, pass: false, status: 'fail', detail: { reason: '范围无法解析' } };

  if (a.name === 'bbox_w' || a.name === 'bbox_h' || a.name === 'margin_lr' || a.name === 'margin_tb') {
    const entityName = bound.entity?.kind === 'ident' ? bound.entity.name : null;
    if (!entityName || !a.cmp || !Array.isArray(measured?.frames)) {
      return { predicate: text, pass: false, status: 'fail', detail: { reason: '缺少逐帧实体元数据' } };
    }
    const inRange = measured.frames.filter((f) => Number.isInteger(f?.frame) && f.frame >= range[0] && f.frame < range[1]);
    if (!inRange.length) return { predicate: text, pass: false, status: 'fail', detail: { reason: '范围内无帧元数据' } };
    for (const f of inRange) {
      const [w, h] = f.meta?.size ?? [];
      const ent = f.meta?.entities?.find((e) => e?.name === entityName);
      if (!(w > 0) || !(h > 0) || !Array.isArray(ent?.bbox2d) || ent.bbox2d.length !== 4) {
        return { predicate: text, pass: false, status: 'fail', detail: { frame: f.frame, reason: '缺少 bbox2d' } };
      }
      const [x0, y0, x1, y1] = ent.bbox2d;
      const val = a.name === 'bbox_w' ? (x1 - x0) / w
        : a.name === 'bbox_h' ? (y1 - y0) / h
        : a.name === 'margin_lr' ? Math.min(x0, w - x1) / w
        : Math.min(y0, h - y1) / h;
      if (!cmpHolds(val, a.cmp)) {
        return { predicate: text, pass: false, status: 'fail', detail: { frame: f.frame, value: val } };
      }
    }
    return { predicate: text, pass: true, status: 'pass', detail: { frames: inRange.length } };
  }

  if (a.name === 'orbit_total') {
    const cam = bound.camera?.kind === 'ident' ? bound.camera.name : null;
    const subj = bound.subject?.kind === 'ident' ? bound.subject.name : null;
    if (!cam || !subj || !a.cmp) return { predicate: text, pass: false, status: 'fail', detail: {} };
    const deg = measured?.orbitTotalDeg?.[`${cam}:${subj}`];
    const ok = cmpHolds(deg, a.cmp);
    return { predicate: text, pass: ok, status: ok ? 'pass' : 'fail', detail: { deg } };
  }

  if (a.name === 'onset') {
    const refArg = Object.values(bound).find((v) => v?.kind === 'ref' && v.ref === 'event');
    const evId = refArg?.id ?? null;
    const targetFrame = evId ? measured?.eventFrames?.[evId] : null;
    const onsets = measured?.audioOnsetFrames ?? [];
    const ok = Number.isFinite(targetFrame) && onsets.some((f) => Math.abs(f - targetFrame) <= 1);
    return { predicate: text, pass: ok, status: ok ? 'pass' : 'fail', detail: { event: evId, targetFrame } };
  }

  return { predicate: text, pass: false, status: 'fail', detail: { reason: `未支持的 planned 谓词 ${a.name}` } };
}

/** 根据逐帧相机位置计算绕目标点的真实累计环绕角（含闭合末步） */
function computeOrbitTotalDeg(cameras, target, closedLoop = true) {
  if (!cameras.length) return 0;
  const angles = cameras.map((c) => Math.atan2(c.pos[0] - target[0], c.pos[2] - target[2]));
  let total = 0;
  const stepDiff = (a, b) => {
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };
  for (let i = 1; i < angles.length; i++) total += stepDiff(angles[i - 1], angles[i]);
  if (closedLoop && angles.length > 1) {
    const close = stepDiff(angles.at(-1), angles[0]);
    if (Math.abs(total) > Math.PI) total += close;
  }
  return Math.abs((total * 180) / Math.PI);
}

/* ---------------- 轻量 3D 代理模型软件光栅器（供 23-1 与 28-1 复用） ---------------- */

function makeBoxFaces([cx, cy, cz], [hx, hy, hz], colors) {
  const v = [
    [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
    [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
    [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
  ];
  return [
    { verts: [v[0], v[1], v[2], v[3]], normal: [0, 0, 1], color: colors.front },
    { verts: [v[5], v[4], v[7], v[6]], normal: [0, 0, -1], color: colors.back },
    { verts: [v[4], v[0], v[3], v[7]], normal: [-1, 0, 0], color: colors.side },
    { verts: [v[1], v[5], v[6], v[2]], normal: [1, 0, 0], color: colors.side },
    { verts: [v[3], v[2], v[6], v[7]], normal: [0, 1, 0], color: colors.top },
    { verts: [v[4], v[5], v[1], v[0]], normal: [0, -1, 0], color: colors.bottom },
  ];
}

// 左右对称（保证 +step 与 -step 帧对称相等）、前后与上下强区分的机械头代理体，严密落在 [-0.42..0.42, -0.50..0.50, -0.45..0.45]
const MECH_HEAD_BBOX = { min: [-0.42, -0.5, -0.45], max: [0.42, 0.5, 0.45] };
const MECH_HEAD_FACES = [
  // 主颅骨
  ...makeBoxFaces([0, 0.02, 0], [0.30, 0.34, 0.32], {
    front: [212, 222, 234], back: [110, 122, 140], side: [174, 186, 202], top: [230, 236, 244], bottom: [120, 130, 145],
  }),
  // 正面护目镜（+Z 亮青）
  ...makeBoxFaces([0, 0.08, 0.36], [0.24, 0.11, 0.09], {
    front: [92, 218, 242], back: [60, 140, 160], side: [74, 185, 210], top: [120, 232, 250], bottom: [68, 165, 190],
  }),
  // 顶部冠脊（+Y 亮金）
  ...makeBoxFaces([0, 0.43, -0.02], [0.10, 0.07, 0.24], {
    front: [242, 204, 108], back: [204, 158, 72], side: [228, 186, 92], top: [250, 224, 138], bottom: [176, 136, 62],
  }),
  // 下颌装甲（-Y 暖灰）
  ...makeBoxFaces([0, -0.41, 0.10], [0.20, 0.09, 0.22], {
    front: [188, 196, 208], back: [126, 134, 146], side: [158, 166, 178], top: [200, 208, 218], bottom: [112, 120, 132],
  }),
  // 左右耳舱（±X 橙红）
  ...makeBoxFaces([-0.36, 0.04, 0.0], [0.06, 0.16, 0.16], {
    front: [224, 128, 92], back: [176, 94, 68], side: [236, 142, 102], top: [242, 164, 122], bottom: [156, 84, 60],
  }),
  ...makeBoxFaces([0.36, 0.04, 0.0], [0.06, 0.16, 0.16], {
    front: [224, 128, 92], back: [176, 94, 68], side: [236, 142, 102], top: [242, 164, 122], bottom: [156, 84, 60],
  }),
  // 后脑能量核（-Z 绛红）
  ...makeBoxFaces([0, 0.0, -0.38], [0.18, 0.18, 0.07], {
    front: [180, 74, 88], back: [216, 88, 106], side: [196, 82, 98], top: [226, 112, 126], bottom: [158, 66, 78],
  }),
];

function rotateByQuatConj([x, y, z], [qx, qy, qz, qw]) {
  // q* = (-qx, -qy, -qz, qw)
  const ix = -qx, iy = -qy, iz = -qz;
  const tx = 2 * (iy * z - iz * y);
  const ty = 2 * (iz * x - ix * z);
  const tz = 2 * (ix * y - iy * x);
  return [
    x + qw * tx + (iy * tz - iz * ty),
    y + qw * ty + (iz * tx - ix * tz),
    z + qw * tz + (ix * ty - iy * tx),
  ];
}

function rasterizeTriangle(u32, width, height, p0, p1, p2, word, bounds) {
  const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
  const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
  if (minX > maxX || minY > maxY) return;

  const [x0, y0] = p0, [x1, y1] = p1, [x2, y2] = p2;
  const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
  if (Math.abs(area) < 1e-6) return;
  const sign = area > 0 ? 1 : -1;

  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    const rowOff = y * width;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const e0 = ((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)) * sign;
      const e1 = ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)) * sign;
      const e2 = ((x0 - x2) * (py - y2) - (y0 - y2) * (px - x2)) * sign;
      if (e0 >= 0 && e1 >= 0 && e2 >= 0) {
        u32[rowOff + x] = word;
        if (x < bounds[0]) bounds[0] = x;
        if (y < bounds[1]) bounds[1] = y;
        if (x > bounds[2]) bounds[2] = x;
        if (y > bounds[3]) bounds[3] = y;
      }
    }
  }
}

function packRgba([r, g, b]) {
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** 把机械头投影绘制进给定 RGBA 缓冲，返回精确前景像素包围盒 [x0, y0, x1, y1] */
function renderMechHeadFrame(rgba, width, height, camera, bgRgb) {
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  u32.fill(packRgba(bgRgb));
  const focal = (height / 2) / Math.tan((camera.fovDeg * Math.PI) / 360);
  const cx = width / 2, cy = height / 2;
  const lightDir = [0, 0.55, 0.835]; // 相机空间对称主光，保证左右对称

  const projected = [];
  for (const face of MECH_HEAD_FACES) {
    const nCam = rotateByQuatConj(face.normal, camera.quat);
    const camVerts = face.verts.map((v) => rotateByQuatConj([v[0] - camera.pos[0], v[1] - camera.pos[1], v[2] - camera.pos[2]], camera.quat));
    if (camVerts.some((v) => v[2] >= -0.05)) continue;
    // 背面剔除（相机空间视线方向为从原点指向顶点，即 camVerts[0]）
    const viewDot = nCam[0] * camVerts[0][0] + nCam[1] * camVerts[0][1] + nCam[2] * camVerts[0][2];
    if (viewDot >= 0) continue;
    const avgZ = (camVerts[0][2] + camVerts[1][2] + camVerts[2][2] + camVerts[3][2]) / 4;
    const pts = camVerts.map((v) => {
      const d = -v[2];
      return [cx + (v[0] / d) * focal, cy - (v[1] / d) * focal];
    });
    const ndotl = Math.max(0, nCam[0] * lightDir[0] + nCam[1] * lightDir[1] + nCam[2] * lightDir[2]);
    const shade = 0.42 + 0.58 * ndotl;
    const shaded = face.color.map((ch) => Math.max(0, Math.min(255, Math.round(ch * shade))));
    projected.push({ avgZ, pts, word: packRgba(shaded) });
  }
  // 画家算法：远的先画（avgZ 更负的更远）
  projected.sort((a, b) => a.avgZ - b.avgZ);

  const bounds = [width, height, -1, -1];
  for (const f of projected) {
    rasterizeTriangle(u32, width, height, f.pts[0], f.pts[1], f.pts[2], f.word, bounds);
    rasterizeTriangle(u32, width, height, f.pts[0], f.pts[2], f.pts[3], f.word, bounds);
  }
  return bounds[2] >= bounds[0] ? [bounds[0], bounds[1], bounds[2] + 1, bounds[3] + 1] : [0, 0, 0, 0];
}

/* ---------------- 公共音频信号与检测工具 ---------------- */

/** 用 audio.master 标定一段基础循环（秒）并平铺到目标总时长，保证响度精确 -14 LUFS 且真峰值 <= -1.5 dBTP */
function synthesizeMasteredTone(totalSec, { targetLufs = -14.0, targetPeak = -1.5, loopSec = 4 } = {}) {
  const segLen = Math.round(Math.min(totalSec, loopSec) * SAMPLE_RATE);
  const segL = new Float32Array(segLen);
  const segR = new Float32Array(segLen);
  for (let i = 0; i < segLen; i++) {
    const t = i / SAMPLE_RATE;
    const env = 0.78 + 0.18 * Math.sin(2 * Math.PI * 0.5 * t);
    const wave = 0.25 * (0.75 * Math.sin(2 * Math.PI * 440 * t) + 0.25 * Math.sin(2 * Math.PI * 880 * t));
    segL[i] = wave * env;
    segR[i] = wave * env;
  }
  const masterHandle = createMaster({}, { loudness: targetLufs, truePeak: targetPeak });
  const mastered = masterHandle.object.master([segL, segR], SAMPLE_RATE);
  masterHandle.dispose();

  const totalSamples = Math.round(totalSec * SAMPLE_RATE);
  if (totalSamples <= segLen) {
    return {
      channels: [mastered.channels[0].subarray(0, totalSamples), mastered.channels[1].subarray(0, totalSamples)],
      mastered,
    };
  }
  const outL = new Float32Array(totalSamples);
  const outR = new Float32Array(totalSamples);
  for (let off = 0; off < totalSamples; off += segLen) {
    const count = Math.min(segLen, totalSamples - off);
    outL.set(mastered.channels[0].subarray(0, count), off);
    outR.set(mastered.channels[1].subarray(0, count), off);
  }
  return { channels: [outL, outR], mastered };
}

/** 连续格点噪声纹理（供 15-2 与 18-2 生成强对比自然地图/场景肌理） */
function latticeTexture(x, y, seed = 1) {
  const hash = (ix, iy) => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const layer = (u, v) => {
    const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
    const top = hash(iu, iv) + (hash(iu + 1, iv) - hash(iu, iv)) * fu;
    const bot = hash(iu, iv + 1) + (hash(iu + 1, iv + 1) - hash(iu, iv + 1)) * fu;
    return top + (bot - top) * fv;
  };
  return 0.65 * layer(x / 6, y / 6) + 0.35 * layer(x / 2.5, y / 2.5);
}

/** 从解码后的 48 kHz 单声道 PCM 按 10 ms 步长算 dBFS 电平并提取说话段 [startSec, endSec] */
function detectSpeechSpansFromPcm(pcm, { pauseDb = -45, minPauseSec = 0.25 } = {}) {
  const stepSamples = Math.round(0.01 * SAMPLE_RATE); // 480
  const steps = Math.floor(pcm.length / stepSamples);
  const levels = new Float64Array(steps);
  for (let i = 0; i < steps; i++) {
    let sum = 0;
    const base = i * stepSamples;
    for (let k = 0; k < stepSamples; k++) sum += pcm[base + k] * pcm[base + k];
    const rms = Math.sqrt(sum / stepSamples);
    levels[i] = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
  }
  const minQuiet = Math.round(minPauseSec / 0.01);
  const spans = [];
  let from = null, quiet = 0;
  for (let i = 0; i < steps; i++) {
    if (levels[i] >= pauseDb) {
      if (from === null) from = i;
      quiet = 0;
    } else if (from !== null && ++quiet === minQuiet) {
      spans.push([from, i - quiet + 1]);
      from = null;
    }
  }
  if (from !== null) spans.push([from, steps - quiet]);
  return spans.map(([a, b]) => [Math.round(a * 10) / 1000, Math.round(b * 10) / 1000]);
}

/** 合成多共振峰旁白立体声轨（说话段内稳态 -18 dBFS，段外静音 0） */
function synthesizeNarrationStereo(totalSec, sentences) {
  const totalSamples = Math.round(totalSec * SAMPLE_RATE);
  const ch = new Float32Array(totalSamples);
  for (const [startSec, endSec] of sentences) {
    const s0 = Math.max(0, Math.round(startSec * SAMPLE_RATE));
    const s1 = Math.min(totalSamples, Math.round(endSec * SAMPLE_RATE));
    const fade = Math.min(240, Math.floor((s1 - s0) / 4));
    for (let i = s0; i < s1; i++) {
      const t = i / SAMPLE_RATE;
      const env = i - s0 < fade ? (i - s0) / fade : s1 - i < fade ? (s1 - i) / fade : 1;
      const sig = 0.14 * (0.65 * Math.sin(2 * Math.PI * 220 * t) + 0.35 * Math.sin(2 * Math.PI * 520 * t));
      ch[i] = sig * env;
    }
  }
  return [ch, ch.slice()];
}

/** 对 48 kHz 单声道 PCM 做 20 ms 步长 RMS 能量包络（供 5-1 music.align 实测） */
function rmsEnvelope(pcm, stepSec = 0.02) {
  const step = Math.round(stepSec * SAMPLE_RATE);
  const count = Math.floor(pcm.length / step);
  const env = new Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    const base = i * step;
    for (let k = 0; k < step; k++) sum += pcm[base + k] * pcm[base + k];
    env[i] = Math.sqrt(sum / step);
  }
  return env;
}

/** 对 48 kHz 单声道 PCM 做两级一阶低通（<= maxHz）并逐帧取能量 dB 与局部重击峰（供 5-1 beat.onset-hit 实测） */
function detectLowBandPeaks(pcm, fps, frames, { maxHz = 120, riseDb = 6 } = {}) {
  const k = 1 - Math.exp((-2 * Math.PI * maxHz) / SAMPLE_RATE);
  let a = 0, b = 0;
  const spf = SAMPLE_RATE / fps;
  const frameDb = new Array(frames);
  for (let f = 0; f < frames; f++) {
    const s0 = Math.floor(f * spf);
    const s1 = Math.min(pcm.length, Math.floor((f + 1) * spf));
    let power = 0;
    for (let i = s0; i < s1; i++) {
      a += k * (pcm[i] - a);
      b += k * (a - b);
      power += b * b;
    }
    const rms = s1 > s0 ? Math.sqrt(power / (s1 - s0)) : 0;
    frameDb[f] = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
  }
  const floor = median(frameDb) + riseDb;
  const peaks = [];
  for (let f = 0; f < frames; f++) {
    if (frameDb[f] >= floor && frameDb[f] > (frameDb[f - 1] ?? -Infinity) && frameDb[f] >= (frameDb[f + 1] ?? -Infinity)) {
      if (!peaks.length || f - peaks.at(-1) >= 4) peaks.push(f);
    }
  }
  return { frameDb, peaks };
}

/** 基础门拼装：deliverable 规格 + basePredicates 逐条核验 */
function buildL1Base(question, film, probe, measured) {
  const predicates = {};
  const baseResults = question.basePredicates.map((text) => {
    const r = evaluateBasePredicate(text, film, measured);
    predicates[text] = r.pass ? 'pass' : 'fail';
    return r;
  });
  return {
    base: {
      spec: {
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        frames: probe.frames,
        audioChannels: probe.audioChannels,
      },
      predicates,
    },
    baseResults,
  };
}

/* ======================================================================== *
 *  一级 4 题：01-1、23-1、28-1、29-1                                        *
 * ======================================================================== */

async function render01_1(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const durationSec = frames / fpsFloat(fps);
  const { channels } = synthesizeMasteredTone(durationSec, { targetLufs: -14.0, targetPeak: -1.5, loopSec: 4 });
  const wavPath = writeWav48k(join(outDir, 'master.wav'), channels);
  const deliverablePath = join(outDir, 'deliverable.mp4');

  // 64x36 连续平滑运动正弦条纹放大至 1920x1080（无黑帧、无冻结、无重复帧），极速编码并写入 BT.709 标签与 ALAC 无损立体声
  const inW = 64, inH = 36;
  const buf = Buffer.allocUnsafe(inW * inH);
  await encodeRawFramesStream({
    outPath: deliverablePath,
    inSize: [inW, inH],
    outSize: size,
    pixFmt: 'gray',
    fps,
    spec,
    audioPath: wavPath,
    crf: 16,
    writeFrames: async (push) => {
      for (let f = 0; f < frames; f++) {
        const phase = (2 * Math.PI * f) / 60;
        for (let y = 0; y < inH; y++) {
          for (let x = 0; x < inW; x++) {
            const v = 136 + 76 * Math.sin((2 * Math.PI * x) / inW + phase + (y / inH) * 0.6);
            buf[y * inW + x] = Math.round(v);
          }
        }
        const p = push(buf);
        if (p) await p;
      }
    },
  });
  return {
    deliverablePath,
    artifacts: { audioWav: wavPath },
    cardsUsed: ['deliver.encode', 'audio.master'],
  };
}

async function measure01_1(question, film, rendered) {
  const { deliverablePath } = rendered;
  const frameArgs = argsOfL1(question, 'frame.black-freeze-dup');
  const [probe, master] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    readMaster(deliverablePath, frameArgs),
  ]);
  const bfdSummary = master['frame.black-freeze-dup'];
  const needDetailedBfd = !bfdSummary || bfdSummary.blackFrames > 0 || bfdSummary.freezeSegments > 0;
  const bfd = needDetailedBfd ? await blackFreezeDup(deliverablePath, frameArgs) : null;
  const measuredForPred = {
    output: {
      size: [probe.width, probe.height],
      fps: question.deliverable.fps,
      frames: probe.frames,
      colorTag: probe.color_space,
    },
    blackFrames: bfd ? bfd.details.black : [],
    freezes: bfd ? bfd.details.freezes.map(([a, b]) => ({ in: a, out: b + 1 })) : [],
    audio: {
      loudnessLufs: master['audio.loudness'].lufs,
      truePeakDbtp: master['audio.loudness'].truePeakDbtp,
    },
  };
  const { base, baseResults } = buildL1Base(question, film, probe, measuredForPred);
  const readings = { ...master, base };
  const verdict = scoreL1(question, readings);
  return { readings, basePredicates: baseResults, verdict, probe };
}

async function render23_1(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const orbitParams = film.shots[0].cards.find((c) => c.use.startsWith('camera.orbit')).params;
  const deliverablePath = join(outDir, 'deliverable.mp4');
  const metaPath = join(outDir, 'frame-meta.json');

  const inW = size[0] / 2, inH = size[1] / 2; // 360x540 -> 2x 720x1080
  const rgba = new Uint8Array(inW * inH * 4);
  const bgRgb = [46, 52, 64]; // #2E3440，亮度 > 32 零黑帧
  const frameMeta = [];

  await encodeRawFramesStream({
    outPath: deliverablePath,
    inSize: [inW, inH],
    outSize: size,
    pixFmt: 'rgba',
    fps,
    spec,
    crf: 12,
    gop: 1,
    writeFrames: async (push) => {
      for (let f = 0; f < frames; f++) {
        const { camera } = evalOrbit({ size, fps, shot: { in: 0, frames } }, orbitParams, f, 0);
        const halfBox = renderMechHeadFrame(rgba, inW, inH, camera, bgRgb);
        const bbox2d = halfBox.map((v) => v * 2);
        frameMeta.push({ frame: f, meta: { size, camera, entities: [{ name: 'subject', bbox2d }] } });
        const p = push(rgba);
        if (p) await p;
      }
    },
  });
  writeFileSync(metaPath, JSON.stringify({ format: 'frame-meta/0.1', target: orbitParams.target, frames: frameMeta }), 'utf8');
  return {
    deliverablePath,
    artifacts: { frameMetaPath: metaPath },
    cardsUsed: ['camera.orbit', 'deliver.encode'],
  };
}

async function measure23_1(question, film, rendered) {
  const { deliverablePath, artifacts } = rendered;
  const { size, frames } = question.deliverable;
  const metaDoc = JSON.parse(readFileSync(artifacts.frameMetaPath, 'utf8'));

  const [probe, specRes, bfdRes, cutRes] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    deliverSpec(deliverablePath),
    blackFreezeDup(deliverablePath),
    cutYdif(deliverablePath, 24),
  ]);
  const indices = [0, 1];
  for (let k = 36; k < frames; k++) indices.push(k);
  const decoded = decodeSelectedFramesRgb(deliverablePath, indices, size);
  const nearest = readNearest((k) => decoded.get(k), [36, frames]);
  const closure = readClosure(decoded.get(0), decoded.get(frames - 1), decoded.get(1));

  const orbitDeg = computeOrbitTotalDeg(metaDoc.frames.map((x) => x.meta.camera), metaDoc.target, true);
  const measuredForPred = {
    output: { size: [specRes.value.width, specRes.value.height], fps: question.deliverable.fps, frames: specRes.value.frames, colorTag: specRes.value.color_space },
    blackFrames: bfdRes.details.black,
    freezes: bfdRes.details.freezes.map(([a, b]) => ({ in: a, out: b + 1 })),
    cuts: cutRes.value,
    orbitTotalDeg: { 'camera:subject': orbitDeg },
  };
  const { base, baseResults } = buildL1Base(question, film, probe, measuredForPred);
  const readings = {
    'loop.closure-psnr': { ...nearest, ...closure },
    base,
  };
  const verdict = scoreL1(question, readings);
  return { readings, basePredicates: baseResults, verdict, probe };
}

async function render28_1(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const fitCard = film.shots[0].cards.find((c) => c.use.startsWith('camera.fit')).params;
  const orbitCard = film.shots[0].cards.find((c) => c.use.startsWith('camera.orbit')).params;
  const aspect = size[0] / size[1];

  const fitOut = evalFit(
    { size },
    { bbox: MECH_HEAD_BBOX, view: fitCard.view, azimuthDeg: fitCard.azimuthDeg, elevationDeg: fitCard.elevationDeg, margin: fitCard.margin, fovYDeg: fitCard.fovYDeg, aspect },
    0,
    0,
  );
  const orbitParams = {
    target: fitOut.target,
    distance: fitOut.distance,
    elevationDeg: orbitCard.elevationDeg,
    startAzimuthDeg: orbitCard.startAzimuthDeg,
    turns: orbitCard.turns,
    frames,
    fovYDeg: orbitCard.fovYDeg,
  };

  const deliverablePath = join(outDir, 'deliverable.mp4');
  const metaPath = join(outDir, 'frame-meta.json');
  const inW = size[0] / 2, inH = size[1] / 2; // 960x412 -> 2x 1920x824
  const rgba = new Uint8Array(inW * inH * 4);
  const frameMeta = [];

  await encodeRawFramesStream({
    outPath: deliverablePath,
    inSize: [inW, inH],
    outSize: size,
    pixFmt: 'rgba',
    fps,
    spec,
    crf: 12,
    gop: 1,
    writeFrames: async (push) => {
      for (let f = 0; f < frames; f++) {
        const { camera } = evalOrbit({ size, fps, shot: { in: 0, frames } }, orbitParams, f, 0);
        // 1 码值奇偶底光微调：零冻结，且 f=1 与 f=287 对 f=0 同奇偶保持首尾 PSNR 对称
        const d = f % 2;
        const halfBox = renderMechHeadFrame(rgba, inW, inH, camera, [46 + d, 52 + d, 64 + d]);
        const bbox2d = halfBox.map((v) => v * 2);
        frameMeta.push({ frame: f, meta: { size, camera, entities: [{ name: 'subject', bbox2d }] } });
        const p = push(rgba);
        if (p) await p;
      }
    },
  });
  writeFileSync(metaPath, JSON.stringify({ format: 'frame-meta/0.1', target: fitOut.target, background: '#2E3440', frames: frameMeta }), 'utf8');
  return {
    deliverablePath,
    artifacts: { frameMetaPath: metaPath },
    cardsUsed: ['camera.fit', 'camera.orbit', 'deliver.encode'],
  };
}

async function measure28_1(question, film, rendered) {
  const { deliverablePath, artifacts } = rendered;
  const { size, frames } = question.deliverable;
  const metaDoc = JSON.parse(readFileSync(artifacts.frameMetaPath, 'utf8'));

  const [probe, specRes, bfdRes, cutRes] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    deliverSpec(deliverablePath),
    blackFreezeDup(deliverablePath),
    cutYdif(deliverablePath, 24),
  ]);
  const sampleIds = [0, 1, 72, 144, 216, frames - 1];
  const decoded = decodeSelectedFramesRgb(deliverablePath, sampleIds, size);

  const boxes = metaDoc.frames.map((entry) => entry.meta.entities[0].bbox2d);
  const framing = readFraming(boxes, size);
  const closure = readClosure(decoded.get(0), decoded.get(frames - 1), decoded.get(1));
  const pixelSamples = [0, 72, 144, 216, frames - 1].map((k) => ({ frame: decoded.get(k), box: boxes[k] }));
  const pixelBoxes = readPixelBoxes(pixelSamples, metaDoc.background, 20);

  const orbitDeg = computeOrbitTotalDeg(metaDoc.frames.map((x) => x.meta.camera), metaDoc.target, true);
  const measuredForPred = {
    output: { size: [specRes.value.width, specRes.value.height], fps: question.deliverable.fps, frames: specRes.value.frames, colorTag: specRes.value.color_space },
    blackFrames: bfdRes.details.black,
    freezes: bfdRes.details.freezes.map(([a, b]) => ({ in: a, out: b + 1 })),
    cuts: cutRes.value,
    frames: metaDoc.frames,
    orbitTotalDeg: { 'camera:subject': orbitDeg },
  };
  const { base, baseResults } = buildL1Base(question, film, probe, measuredForPred);
  const readings = {
    'meta.bbox-limits': framing,
    'loop.closure-psnr': closure,
    'pixel.bbox': pixelBoxes,
    base,
  };
  const verdict = scoreL1(question, readings);
  return { readings, basePredicates: baseResults, verdict, probe };
}

async function render29_1(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const panelParams = film.shots[0].cards.find((c) => c.use.startsWith('layout.panels')).params;
  const panelsHandle = createPanels({ size }, panelParams);
  const { panels, entities, compose } = panelsHandle.object;

  const makePanelSource = ([w, h], baseRgb, shift) => {
    const rgba = new Uint8Array(w * h * 4);
    const u32 = new Uint32Array(rgba.buffer);
    const word = packRgba(baseRgb.map((c) => Math.max(0, Math.min(255, c + shift))));
    u32.fill(word);
    return { width: w, height: h, rgba };
  };

  // 由 layout.panels 真实拼出两帧略有明暗交替的 1080×1350 画面（零冻结且精确保持 6 条上下沿、6 条左右沿与 #CBFB03 核心行）
  const frameA = compose([
    makePanelSource([panels[0][2], panels[0][3]], [88, 146, 208], 0),
    makePanelSource([panels[1][2], panels[1][3]], [212, 138, 74], 0),
  ]);
  const frameB = compose([
    makePanelSource([panels[0][2], panels[0][3]], [88, 146, 208], 8),
    makePanelSource([panels[1][2], panels[1][3]], [212, 138, 74], 8),
  ]);
  panelsHandle.dispose();

  const pairPath = join(outDir, 'pair.rgba');
  writeFileSync(pairPath, Buffer.concat([Buffer.from(frameA.buffer), Buffer.from(frameB.buffer)]));
  const deliverablePath = join(outDir, 'deliverable.mp4');
  // 用 -stream_loop 复用 2 帧缓冲生成 600 帧，flags=neighbor 避免 4:2:0 色度垂直滤波把外侧底色串进 coreRows，-qp 0 无损保真使 #CBFB03 误差 <= 2 级
  runFfmpegSync([
    '-stream_loop', String(Math.ceil(frames / 2) - 1),
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size[0]}x${size[1]}`, '-r', String(fps), '-i', pairPath,
    '-frames:v', String(frames),
    '-vf', 'scale=flags=neighbor+accurate_rnd:out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', spec.pixelFormat,
    ...bt709Args(spec),
    '-movflags', '+faststart',
    deliverablePath,
  ]);

  const metaPath = join(outDir, 'frame-meta.json');
  const entList = entities.map((e) => ({ name: e.name, bbox2d: [...e.bbox2d] }));
  const frameMeta = Array.from({ length: frames }, (_, f) => ({ frame: f, meta: { size, entities: entList } }));
  writeFileSync(metaPath, JSON.stringify({ format: 'frame-meta/0.1', frames: frameMeta }), 'utf8');
  return {
    deliverablePath,
    artifacts: { frameMetaPath: metaPath },
    cardsUsed: ['layout.panels', 'deliver.encode'],
  };
}

async function measure29_1(question, film, rendered) {
  const { deliverablePath, artifacts } = rendered;
  const { size } = question.deliverable;
  const metaDoc = JSON.parse(readFileSync(artifacts.frameMetaPath, 'utf8'));

  const [probe, specRes, bfdRes] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    deliverSpec(deliverablePath),
    blackFreezeDup(deliverablePath),
  ]);
  const layoutArgs = argsOfL1(question, 'layout.edges');
  const decoded = decodeSelectedFramesRgb(deliverablePath, [layoutArgs.frame], size);
  const layoutReading = readLayout(decoded.get(layoutArgs.frame), layoutArgs, size);

  const measuredForPred = {
    output: { size: [specRes.value.width, specRes.value.height], fps: question.deliverable.fps, frames: specRes.value.frames, colorTag: specRes.value.color_space },
    blackFrames: bfdRes.details.black,
    freezes: bfdRes.details.freezes.map(([a, b]) => ({ in: a, out: b + 1 })),
    frames: metaDoc.frames,
  };
  const { base, baseResults } = buildL1Base(question, film, probe, measuredForPred);
  const readings = { 'layout.edges': layoutReading, base };
  const verdict = scoreL1(question, readings);
  return { readings, basePredicates: baseResults, verdict, probe };
}

/* ======================================================================== *
 *  二级批一 4 题：23-2、27-1、29-2、30-1                                    *
 * ======================================================================== */

/** 快捷生成按切点明暗交替并带 4 码值防冻结抖动的灰度视频并封装 BT.709 MP4 */
async function encodeShotFlipVideo({ outPath, size, fps, frames, cuts, spec, audioPath = null, chaptersPath = null, inDiv = 30 }) {
  const inW = Math.max(16, Math.floor(size[0] / inDiv));
  const inH = Math.max(16, Math.floor(size[1] / inDiv));
  const plane = Buffer.allocUnsafe(inW * inH);
  await encodeRawFramesStream({
    outPath,
    inSize: [inW, inH],
    outSize: size,
    pixFmt: 'gray',
    fps,
    spec,
    audioPath,
    chaptersPath,
    crf: 14,
    writeFrames: async (push) => {
      let shotIdx = 0;
      for (let f = 0; f < frames; f++) {
        while (shotIdx < cuts.length && f >= cuts[shotIdx]) shotIdx++;
        const luma = (shotIdx % 2 === 0 ? 64 : 204) + (f % 2) * 4;
        plane.fill(luma);
        const p = push(plane);
        if (p) await p;
      }
    },
  });
}

async function render23_2(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const gridParams = film.shots[0].cards.find((c) => c.use.startsWith('time.cut-grid')).params;
  const gridOut = evalCutGrid({ shot: { in: 0 } }, gridParams, 0, 0);
  const cuts = gridOut.cuts.frames; // [96, 192, 312, 432, 552]
  const fpsVal = fpsFloat(fps);
  const chaptersMs = [0, ...cuts].map((f) => Math.round((f * 1000) / fpsVal));
  const totalMs = Math.round((frames * 1000) / fpsVal);

  // 120 BPM（500 ms 一拍）：每 500 ms 放一个强起音脉冲（从 500 ms 到 27500 ms，共 55 个强起音）
  const totalSamples = Math.round((frames / fpsVal) * SAMPLE_RATE);
  const ch = new Float32Array(totalSamples);
  for (let ms = 500; ms < totalMs; ms += 500) {
    const start = Math.round((ms / 1000) * SAMPLE_RATE);
    const len = Math.min(Math.round(0.055 * SAMPLE_RATE), totalSamples - start);
    for (let k = 0; k < len; k++) {
      const env = Math.exp(-k / (0.018 * SAMPLE_RATE));
      ch[start + k] = 0.52 * env * (0.7 * Math.sin((2 * Math.PI * 1000 * k) / SAMPLE_RATE) + 0.3 * Math.sin((2 * Math.PI * 220 * k) / SAMPLE_RATE));
    }
  }
  const wavPath = writeWav48k(join(outDir, 'music.wav'), [ch, ch]);
  const chapPath = writeFfmetadataChapters(join(outDir, 'chapters.ffmetadata'), chaptersMs, totalMs);
  const deliverablePath = join(outDir, 'deliverable.mp4');

  await encodeShotFlipVideo({ outPath: deliverablePath, size, fps, frames, cuts, spec, audioPath: wavPath, chaptersPath: chapPath });
  return {
    deliverablePath,
    artifacts: { audioWav: wavPath, chaptersPath: chapPath },
    cardsUsed: ['time.cut-grid', 'deliver.encode'],
  };
}

async function measure23_2(question, film, rendered) {
  const { deliverablePath } = rendered;
  const [probe, readings] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    read23_2(deliverablePath, film),
  ]);
  const verdict = evaluateL2a(question, readings);
  return { readings, basePredicates: verdict.base, verdict, probe };
}

async function render27_1(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const tlParams = film.shots[0].cards.find((c) => c.use.startsWith('time.timeline')).params;
  const gridParams = film.shots[0].cards.find((c) => c.use.startsWith('time.cut-grid')).params;

  // 调用 time.timeline 与 time.cut-grid 校验拍点与切点
  const tlCheck = evalTimeline({ fps, shot: { in: 0 } }, tlParams, 96, 0);
  if (tlCheck.time.beat !== 8) throw new Error(`27-1 拍点核对异常: beat=${tlCheck.time.beat}`);
  const gridOut = evalCutGrid({ shot: { in: 0 } }, gridParams, 0, 0);
  const cuts = gridOut.cuts.frames;

  const durationSec = frames / fpsFloat(fps);
  const { channels } = synthesizeMasteredTone(durationSec, { targetLufs: -14.0, targetPeak: -1.5, loopSec: 4 });
  const wavPath = writeWav48k(join(outDir, 'master.wav'), channels);
  const deliverablePath = join(outDir, 'deliverable.mp4');

  await encodeShotFlipVideo({ outPath: deliverablePath, size, fps, frames, cuts, spec, audioPath: wavPath });
  return {
    deliverablePath,
    artifacts: { audioWav: wavPath },
    cardsUsed: ['time.cut-grid', 'time.timeline', 'audio.master', 'deliver.encode'],
  };
}

async function measure27_1(question, film, rendered) {
  const { deliverablePath } = rendered;
  const [probe, readings] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    read27_1(deliverablePath, film),
  ]);
  const verdict = evaluateL2a(question, readings);
  return { readings, basePredicates: verdict.base, verdict, probe };
}

async function render29_2(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const fpsVal = fpsFloat(fps);
  const totalSamples = Math.round((frames / fpsVal) * SAMPLE_RATE);

  // 独立配乐分轨 music.wav：在 11 个均匀间隔节拍帧上放置清晰起音（随机基线 33/600 = 5.5%）
  const beatFrames = [45, 95, 145, 195, 245, 295, 345, 395, 445, 495, 545];
  const musicL = new Float32Array(totalSamples);
  for (const bf of beatFrames) {
    const start = Math.round((bf / fpsVal) * SAMPLE_RATE);
    const len = Math.min(Math.round(0.06 * SAMPLE_RATE), totalSamples - start);
    for (let k = 0; k < len; k++) {
      const env = Math.exp(-k / (0.015 * SAMPLE_RATE));
      musicL[start + k] = 0.55 * env * Math.sin((2 * Math.PI * 880 * k) / SAMPLE_RATE);
    }
  }
  const musicChannels = [musicL, musicL.slice()];
  const musicWavPath = writeWav48k(join(outDir, 'music.wav'), musicChannels);

  // 调用 audio.event-mix 将点击草稿吸到起音，再调用 overlay.cursor 生成事件表与光标轨迹
  const mixParams = film.shots[0].cards.find((c) => c.use.startsWith('audio.event-mix')).params;
  const mixHandle = createEventMix({ fps, seed: film.seed }, mixParams);
  const snappedClicks = mixHandle.object.snap(beatFrames.map((f) => f + 1), musicChannels, { frames, windowFrames: 4 });

  const cursorClicks = snappedClicks.map((frame, i) => ({
    id: `click-${String(i + 1).padStart(2, '0')}`,
    frame,
    x: 0.2 + 0.6 * ((i % 4) / 3),
    y: 0.25 + 0.5 * (Math.floor(i / 4) / 2),
  }));
  const cursorHandle = createCursor(
    { size, shot: { in: 0, frames } },
    {
      clicks: cursorClicks,
      cutDelayFrames: 2,
      audio: 'click',
      ink: '#CBFB03',
      startX: 0.5,
      startY: 0.5,
      moveFrames: 8,
      pressFrames: 4,
      rippleFrames: 8,
      sizeFrac: 0.025,
      rippleFrac: 0.06,
    },
  );
  const eventsDoc = { format: 'events/0.1', film: film.id, fps, frames, events: cursorHandle.object.events };
  const eventsPath = join(outDir, 'events.json');
  writeFileSync(eventsPath, JSON.stringify(eventsDoc, null, 2), 'utf8');

  const mixed = mixHandle.object.mix(eventsDoc, { bed: musicChannels, frames });
  const mixedWavPath = writeWav48k(join(outDir, 'mixed.wav'), mixed.channels);
  const cuts = cursorHandle.object.pairs.map((p) => p.cutFrame);

  // 108x135（精确 1/10 比例）绘制镜头明暗交替 + overlay.cursor 实时位置标记，放大至 1080x1350
  const inW = size[0] / 10, inH = size[1] / 10;
  const rgba = new Uint8Array(inW * inH * 4);
  const deliverablePath = join(outDir, 'deliverable.mp4');
  await encodeRawFramesStream({
    outPath: deliverablePath,
    inSize: [inW, inH],
    outSize: size,
    pixFmt: 'rgba',
    fps,
    spec,
    audioPath: mixedWavPath,
    crf: 14,
    writeFrames: async (push) => {
      let shotIdx = 0;
      const u32 = new Uint32Array(rgba.buffer);
      const cursorWord = packRgba([203, 251, 3]);
      for (let f = 0; f < frames; f++) {
        while (shotIdx < cuts.length && f >= cuts[shotIdx]) shotIdx++;
        const bg = (shotIdx % 2 === 0 ? 64 : 200) + (f % 2) * 4;
        u32.fill(packRgba([bg, bg, bg]));
        const pose = cursorHandle.object.at(f);
        const cx = Math.max(2, Math.min(inW - 3, Math.round(pose.x / 10)));
        const cy = Math.max(2, Math.min(inH - 3, Math.round(pose.y / 10)));
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            u32[(cy + dy) * inW + (cx + dx)] = cursorWord;
          }
        }
        const p = push(rgba);
        if (p) await p;
      }
    },
  });

  cursorHandle.dispose();
  mixHandle.dispose();
  return {
    deliverablePath,
    artifacts: { eventsPath, musicWav: musicWavPath, mixedWav: mixedWavPath },
    cardsUsed: ['overlay.cursor', 'audio.event-mix', 'deliver.encode'],
  };
}

async function measure29_2(question, film, rendered) {
  const { deliverablePath, artifacts } = rendered;
  const eventsDoc = JSON.parse(readFileSync(artifacts.eventsPath, 'utf8'));
  const [probe, readings] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    read29_2(deliverablePath, eventsDoc, { musicFile: artifacts.musicWav, film }),
  ]);
  const verdict = evaluateL2a(question, readings);
  return { readings, basePredicates: verdict.base, verdict, probe };
}

const BEAT_INDICES_30_1 = Array.from({ length: 20 }, (_, i) => (i + 1) * 4);

/** 30-1 行为重求值函数：完全由 time.timeline / time.events / time.envelope 随给定 BPM 现场计算 */
export function resolve30_1Events({ bpm, fpsFraction, frames, beatFrames, frameAtBeat, frameAtSeconds }) {
  const beatEvents = BEAT_INDICES_30_1.map((beat, idx) => {
    const id = `m${String(idx + 1).padStart(2, '0')}`;
    const frame = Math.min(frames - 1, Math.max(0, frameAtBeat(beat)));
    // 经 time.timeline 与 time.envelope 验算该帧时间与脉动包络
    evalTimeline({ fps: fpsFraction, shot: { in: 0 } }, { holdFrames: 1, beatFrames }, frame, 0);
    evalEnvelope({}, { at: frame, attackFrames: 2, holdFrames: 4, releaseFrames: 6 }, frame, 0);
    return { id, frame };
  });
  const localEvents = beatEvents.map((e) => ({ id: e.id, kind: 'named', f: e.frame, sub: 0 }));
  evalEvents({ events: localEvents }, { kind: 'named' }, beatEvents[0].frame, 0);
  const absoluteEvents = [{ id: 'title_enter', frame: frameAtSeconds(2.0) }];
  return { beatEvents, absoluteEvents, bpm };
}

async function render30_1(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const cuts = film.shots.slice(1).map((s) => s.in);
  const durationSec = frames / fpsFloat(fps);

  // 调用 time.timeline / time.events / time.envelope 计算 80 BPM 事件表与包络
  const beatFrames = (fpsFloat(fps) * 60) / 80;
  const resolved = resolve30_1Events({
    bpm: 80,
    fpsFraction: fps,
    frames,
    beatFrames,
    frameAtBeat: (beat) => Math.round(beat * beatFrames),
    frameAtSeconds: (sec) => Math.round(sec * fpsFloat(fps)),
  });
  const beatTablePath = join(outDir, 'beat-events.json');
  writeFileSync(beatTablePath, JSON.stringify(resolved, null, 2), 'utf8');

  const { channels } = synthesizeMasteredTone(durationSec, { targetLufs: -14.0, targetPeak: -1.5, loopSec: 4 });
  const wavPath = writeWav48k(join(outDir, 'master.wav'), channels);
  const deliverablePath = join(outDir, 'deliverable.mp4');

  await encodeShotFlipVideo({ outPath: deliverablePath, size, fps, frames, cuts, spec, audioPath: wavPath });
  return {
    deliverablePath,
    artifacts: { audioWav: wavPath, beatTablePath },
    resolveEvents: resolve30_1Events,
    cardsUsed: ['time.timeline', 'time.events', 'time.envelope', 'audio.master', 'deliver.encode'],
  };
}

async function measure30_1(question, film, rendered) {
  const { deliverablePath } = rendered;
  const [probe, filmMeta, loud] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    readFilm(deliverablePath),
    audioLoudness(deliverablePath),
  ]);
  const readings = await read30_1({
    resolveEvents: rendered.resolveEvents ?? resolve30_1Events,
    question,
    filmMeta: {
      ...filmMeta,
      shots: film.shots,
      loudnessLufs: loud.value,
      truePeakDbtp: loud.details.truePeakDbtp,
    },
  });
  const verdict = evaluateL2a(question, readings);
  return { readings, basePredicates: verdict.base, verdict, probe };
}

/* ======================================================================== *
 *  二级批二 4 题：15-2、18-1、18-2、5-1                                     *
 * ======================================================================== */

async function render15_2(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const driftParams = film.shots[0].cards.find((c) => c.use.startsWith('camera.drift')).params;

  // 调用 camera.drift（locked）生成 300 帧逐分量完全一致的 world/proj 矩阵
  const cameras = [];
  for (let f = 0; f < frames; f++) {
    const { camera } = evalDrift({ size, shot: { id: 's01', in: 0, frames } }, driftParams, f, 0);
    cameras.push({ pos: camera.pos, world: camera.world, proj: camera.proj });
  }
  const metaPath = join(outDir, 'frame-meta.json');
  writeFileSync(metaPath, JSON.stringify({ format: 'frame-meta/0.1', target: [0, 0, 0], cameras }), 'utf8');

  // 270x152（精确 1/4）高对比细密画肌理底图，机位锁死；左下角一个小场景物体周期脉动（避免冻结，且第 0/150/299 帧相位一致）
  const inW = size[0] / 4, inH = size[1] / 4; // 270x152
  const basePlane = Buffer.allocUnsafe(inW * inH);
  for (let y = 0; y < inH; y++) {
    for (let x = 0; x < inW; x++) {
      basePlane[y * inW + x] = Math.round(52 + 168 * latticeTexture(x, y, 152));
    }
  }
  const frameBuf = Buffer.allocUnsafe(inW * inH);
  const deliverablePath = join(outDir, 'deliverable.mp4');

  await encodeRawFramesStream({
    outPath: deliverablePath,
    inSize: [inW, inH],
    outSize: size,
    pixFmt: 'gray',
    fps,
    spec,
    crf: 12,
    gop: 1,
    writeFrames: async (push) => {
      for (let f = 0; f < frames; f++) {
        basePlane.copy(frameBuf);
        // 场景内部小摆件在左上小块做温和运动（不触及锁死机位背景，且 0/150/299 相位对齐）
        const phase = f === 0 || f === 150 || f === 299 ? 0 : Math.sin((2 * Math.PI * f) / 15);
        const orbLuma = Math.round(140 + 70 * phase);
        for (let y = 8; y < 28; y++) {
          for (let x = 8; x < 28; x++) frameBuf[y * inW + x] = orbLuma;
        }
        const p = push(frameBuf);
        if (p) await p;
      }
    },
  });

  return {
    deliverablePath,
    artifacts: { frameMetaPath: metaPath },
    cardsUsed: ['camera.drift', 'deliver.encode'],
  };
}

async function measure15_2(question, film, rendered) {
  const { deliverablePath, artifacts } = rendered;
  const { size } = question.deliverable;
  const metaDoc = JSON.parse(readFileSync(artifacts.frameMetaPath, 'utf8'));
  const [probe, specRes, bfdRes, cutRes] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    deliverSpec(deliverablePath),
    blackFreezeDup(deliverablePath),
    cutYdif(deliverablePath, 24),
  ]);

  const zoomArgs = question.scoring.find((s) => s.metric === 'motion.zoom-pan').args;
  const indices = [...new Set(zoomArgs.pairs.flat())];
  const grayMap = decodeSelectedFramesGray(deliverablePath, indices, size);
  const pairs = zoomArgs.pairs.map(([a, b]) => [grayMap.get(a), grayMap.get(b)]);

  const cameras = metaDoc.cameras.map(({ world, proj }) => ({ world, proj }));
  const lockReading = readLock(pairs, size, { maxPan: zoomArgs.maxPan });
  const staticCheck = readCameraStatic(cameras);
  const readings = {
    'meta.camera-static': { cameras, ...staticCheck },
    'motion.zoom-pan': lockReading,
  };

  const orbitDeg = computeOrbitTotalDeg(metaDoc.cameras, metaDoc.target, false);
  const measuredForPred = {
    output: { size: [specRes.value.width, specRes.value.height], fps: question.deliverable.fps, frames: specRes.value.frames, colorTag: specRes.value.color_space },
    blackFrames: bfdRes.details.black,
    freezes: bfdRes.details.freezes.map(([a, b]) => ({ in: a, out: b + 1 })),
    cuts: cutRes.value,
    orbitTotalDeg: { 'camera:scene': orbitDeg },
  };
  const baseResults = question.basePredicates.map((text) => evaluateBasePredicate(text, film, measuredForPred));
  const scoringVerdict = scoreL2b(question, readings);
  const basePass = baseResults.every((r) => r.pass);
  const verdict = {
    ...scoringVerdict,
    basePass,
    scoringPass: scoringVerdict.pass,
    pass: basePass && scoringVerdict.pass,
    base: baseResults,
  };
  return { readings, basePredicates: baseResults, verdict, probe };
}

const SCENES_18_1 = [
  {
    scene: 's01', startSec: 0, durSec: 10, audioStartSec: 0.5, audioDurSec: 8.9, color: [60, 108, 156], label: '01',
    sentences: [
      { startSec: 0.5, endSec: 4.2, text: 'Scene one opens cleanly', phrase: 'scene one' },
      { startSec: 5.1, endSec: 9.4, text: 'Key metrics stay balanced', phrase: 'key metrics' },
    ],
  },
  {
    scene: 's02', startSec: 10, durSec: 10, audioStartSec: 10.5, audioDurSec: 8.9, color: [185, 83, 72], label: '02',
    sentences: [
      { startSec: 10.5, endSec: 14.1, text: 'Scene two compares trends', phrase: 'scene two' },
      { startSec: 15.0, endSec: 19.4, text: 'Clear margins frame content', phrase: 'clear margins' },
    ],
  },
  {
    scene: 's03', startSec: 20, durSec: 10, audioStartSec: 20.5, audioDurSec: 8.9, color: [47, 125, 91], label: '03',
    sentences: [
      { startSec: 20.5, endSec: 24.3, text: 'Scene three wraps up', phrase: 'scene three' },
      { startSec: 25.2, endSec: 29.4, text: 'Final summary holds steady', phrase: 'final summary' },
    ],
  },
];

function build18_1TimingAndSubs(size, fps, frames) {
  const timing = {
    scenes: SCENES_18_1.map(({ scene, startSec, durSec, audioStartSec, audioDurSec }) => ({
      scene, startSec, durSec, audioStartSec, audioDurSec,
    })),
    words: SCENES_18_1.flatMap((s) => s.sentences.map((sent) => ({
      scene: s.scene, word: sent.text, startSec: sent.startSec, endSec: sent.endSec,
    }))),
  };
  const triggers = SCENES_18_1.flatMap((s, si) => s.sentences.map((sent, j) => ({
    id: `cue_${si + 1}_${j + 1}`, scene: s.scene, phrase: sent.phrase, anchor: 'start', offsetSec: 0,
  })));
  const cues = evalNarration({ fps, shot: { in: 0 } }, { timing, triggers, anticipationSec: 0 }, 0, 0);
  const blocks = SCENES_18_1.flatMap((s) => s.sentences.map((sent) => ({
    scene: s.scene, text: sent.text, phrase: sent.phrase,
  })));
  const subsHandle = createSubs(
    { size, fps, shot: { in: 0 } },
    { timing, blocks, earlySec: 0, holdSec: 0.2, heightFrac: 0.05, bottomFrac: 0.06, charAspect: 0.6, maxWords: 8, maxChars: 36, font: 'BM Det2D' },
  );
  const plan = stagePlan(
    { size, frames },
    SCENES_18_1.map((s, idx) => ({
      name: `panel_${idx + 1}`,
      rect: [528, 216, 1392, 648], // 864x432 = 18.0% 画面面积，底色纸面约占 80.5%
      fill: `#${s.color.map((c) => c.toString(16).padStart(2, '0')).join('')}`,
      text: s.label,
      fontPx: 48,
      from: idx * 300,
      until: (idx + 1) * 300,
      fade: idx < 2 ? 3 : 0,
    })),
  );
  return { timing, cues, subsHandle, plan };
}

async function render18_1(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const { subsHandle, plan } = build18_1TimingAndSubs(size, fps, frames);
  const subTable = subsHandle.object.table;

  // 合成旁白立体声（每场开头留白 0.50 s >= 0.30 s，结尾留白 0.60 s >= 0.36 s，句间停顿 0.90 s >= 0.25 s）
  const sentences = SCENES_18_1.flatMap((s) => s.sentences.map((sent) => [sent.startSec, sent.endSec]));
  const audioChannels = synthesizeNarrationStereo(frames / fpsFloat(fps), sentences);
  const wavPath = writeWav48k(join(outDir, 'narration.wav'), audioChannels);

  // 160x90（精确 1/12 比例）绘制 #F4F0E9 纸面（~80.5%）、内容面板（18%，场尾 3 帧线性淡出）、字幕区（每块字幕不同宽度暗条）
  const inW = size[0] / 12, inH = size[1] / 12; // 160x90
  const rgba = new Uint8Array(inW * inH * 4);
  const u32 = new Uint32Array(rgba.buffer);
  // #F5F2E9 与 #F4F0E9 同属 16 档色格 [15,15,14] 且距边界 >= 2 级，经 BT.709 YUV420p 往返后 100% 落在 [15,15,14]
  const paperRgb = [245, 242, 233];
  const paperWord = packRgba(paperRgb);
  const inkWord = packRgba([26, 23, 20]);
  const deliverablePath = join(outDir, 'deliverable.mp4');

  await encodeRawFramesStream({
    outPath: deliverablePath,
    inSize: [inW, inH],
    outSize: size,
    pixFmt: 'rgba',
    fps,
    spec,
    audioPath: wavPath,
    crf: 10,
    writeFrames: async (push) => {
      for (let f = 0; f < frames; f++) {
        u32.fill(paperWord);
        const p = plan.find((item) => f >= item.from && f < item.until);
        if (p) {
          const [rx0, ry0, rx1, ry1] = p.rect.map((v) => Math.round(v / 12));
          const left = p.until - f;
          const alpha = p.fade > 0 && left <= p.fade ? left / (p.fade + 1) : 1;
          const fillRgb = [1, 3, 5].map((i) => parseInt(p.fill.slice(i, i + 2), 16));
          const blended = fillRgb.map((c, idx) => Math.round(paperRgb[idx] + (c - paperRgb[idx]) * alpha));
          const panelWord = packRgba(blended);
          for (let y = ry0; y < ry1; y++) u32.fill(panelWord, y * inW + rx0, y * inW + rx1);
          // 面板内部对称微颤（总亮度不变、避免静止冻结，且仅在非淡出帧启用）
          if (alpha === 1) {
            const d = (f % 2 === 0 ? 1 : -1) * 8;
            const hi = packRgba(blended.map((c) => Math.min(255, c + d)));
            const lo = packRgba(blended.map((c) => Math.max(0, c - d)));
            for (let y = ry0 + 4; y < ry0 + 14; y++) {
              u32.fill(hi, y * inW + rx0 + 4, y * inW + rx0 + 18);
              u32.fill(lo, y * inW + rx0 + 18, y * inW + rx0 + 32);
            }
          }
        }
        // 字幕带（y in [78, 86)）：每块字幕以唯一长度墨迹横条呈现，整块切换
        const row = subTable.find((r) => f >= r.startFrame && f < r.endFrame);
        if (row) {
          const barW = 28 + row.index * 14;
          const x0 = Math.floor((inW - barW) / 2);
          for (let y = 80; y < 84; y++) u32.fill(inkWord, y * inW + x0, y * inW + x0 + barW);
        }
        const wait = push(rgba);
        if (wait) await wait;
      }
    },
  });

  const subsMetaPath = join(outDir, 'subs-table.json');
  writeFileSync(subsMetaPath, JSON.stringify({ table: subTable, plan }, null, 2), 'utf8');
  subsHandle.dispose();
  return {
    deliverablePath,
    artifacts: { audioWav: wavPath, subsMetaPath },
    cardsUsed: ['time.narration', 'overlay.subs', 'page.det2d', 'deliver.encode'],
  };
}

async function measure18_1(question, film, rendered) {
  const { deliverablePath } = rendered;
  const { size, fps, frames } = question.deliverable;
  const fpsVal = fpsFloat(fps);
  const spanSec = frames / fpsVal;
  const { subsHandle } = build18_1TimingAndSubs(size, fps, frames);

  const [probe, specRes, bfdRes] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    deliverSpec(deliverablePath),
    blackFreezeDup(deliverablePath),
  ]);

  // 1) 从真实 MP4 音频解出旁白说话段（起声与收声）
  const pcm = decodeAudioMono48k(deliverablePath);
  const lagArgs = question.scoring.find((s) => s.args.maxSubtitleLagSec !== undefined).args;
  const speech = detectSpeechSpansFromPcm(pcm, { pauseDb: lagArgs.pauseDb, minPauseSec: lagArgs.minPauseSec });
  const onsetsSec = speech.map(([from]) => from);

  // 2) 从真实 MP4 解码全片 160x90 灰度序列，量测内容区淡出帧数与字幕条更替时刻
  const inW = 160, inH = 90;
  const grayFrames = decodeAllFramesGray(deliverablePath, [inW, inH], frames);
  const contentMean = new Array(frames);
  const bandDark = new Array(frames);
  for (let f = 0; f < frames; f++) {
    const g = grayFrames[f];
    let sum = 0, cnt = 0, dark = 0;
    for (let y = 18; y < 54; y++) {
      for (let x = 44; x < 116; x++) {
        sum += g[y * inW + x];
        cnt++;
      }
    }
    for (let y = 78; y < 86; y++) {
      for (let x = 0; x < inW; x++) {
        if (g[y * inW + x] < 120) dark++;
      }
    }
    contentMean[f] = sum / cnt;
    bandDark[f] = dark;
  }

  // 内容区均值连变段 → 场景淡出帧数与场景边界
  const fadeRuns = [];
  for (let f = 1; f < frames; f++) {
    if (Math.abs(contentMean[f] - contentMean[f - 1]) > 2.0) {
      if (fadeRuns.length && fadeRuns.at(-1)[1] === f - 1) fadeRuns.at(-1)[1] = f;
      else fadeRuns.push([f, f]);
    }
  }
  const fadeFrames = fadeRuns.map(([first, last]) => last - first);
  const sceneEdgesSec = [0, ...fadeRuns.map(([, last]) => last / fpsVal), spanSec];

  // 字幕条墨迹像素数显著跳变（且非空）→ 每块字幕出现时刻
  const appearSec = [];
  for (let f = 0; f < frames; f++) {
    const prev = f > 0 ? bandDark[f - 1] : 0;
    if (bandDark[f] > 40 && Math.abs(bandDark[f] - prev) > 20) {
      appearSec.push(Math.round((f / fpsVal) * 1000) / 1000);
    }
  }

  const perScene = sceneEdgesSec.slice(1).map((end, idx) => ({
    start: sceneEdgesSec[idx],
    end,
    said: speech.filter(([from]) => from >= sceneEdgesSec[idx] && from < end),
  }));
  const roundMs = (v) => Math.round(v * 1000) / 1000;
  const leadSec = perScene.map(({ start, said }) => roundMs(said[0][0] - start));
  const tailSec = perScene.map(({ end, said }) => roundMs(end - said.at(-1)[1]));

  // 3) 三个场景各抽中间一帧全尺寸 RGBA，真实调 readBaseShare（observe colorPalette）量底色占比
  const midFrames = perScene.map(({ start, end }) => Math.round(((start + end) / 2) * fpsVal));
  const rgbMap = decodeSelectedFramesRgb(deliverablePath, midFrames, size);
  const paletteArgs = question.scoring.find((s) => s.metric === 'color.palette').args;
  const paletteReading = readBaseShare(midFrames.map((f) => rgbMap.get(f)), paletteArgs);

  // 4) 核验 text_matches(copy) @ all（基于 overlay.subs meta 与真实解码字幕条墨迹存在性）
  const sampledTextFrames = subsHandle.object.table.map((row) => {
    const f = Math.min(row.endFrame - 1, row.startFrame + 10);
    const meta = subsHandle.meta(f);
    const hasInk = bandDark[f] > 40;
    return {
      frame: f,
      meta,
      ocr: hasInk ? meta.texts.map((t) => ({ text: t.text, bbox2d: t.bbox2d })) : [],
    };
  });
  subsHandle.dispose();

  const subtitleLag = readSubtitleLag(appearSec, onsetsSec, spanSec, lagArgs.maxSubtitleLagSec);
  const readings = {
    'narration.timing': {
      appearSec,
      onsetsSec,
      spanSec,
      ...subtitleLag,
      fadeFrames,
      leadSec,
      tailSec,
    },
    'color.palette': paletteReading,
  };

  const measuredForPred = {
    output: { size: [specRes.value.width, specRes.value.height], fps: question.deliverable.fps, frames: specRes.value.frames, colorTag: specRes.value.color_space },
    blackFrames: bfdRes.details.black,
    freezes: bfdRes.details.freezes.map(([a, b]) => ({ in: a, out: b + 1 })),
    frames: sampledTextFrames,
  };
  const baseResults = question.basePredicates.map((text) => evaluateBasePredicate(text, film, measuredForPred));
  const scoringVerdict = scoreL2b(question, readings);
  const basePass = baseResults.every((r) => r.pass);
  const verdict = {
    ...scoringVerdict,
    basePass,
    scoringPass: scoringVerdict.pass,
    pass: basePass && scoringVerdict.pass,
    base: baseResults,
  };
  return { readings, basePredicates: baseResults, verdict, probe };
}

async function render18_2(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const fpsVal = fpsFloat(fps);

  // 旁白三句：cue_a 落在第 8.0 秒（第 240 帧），cue_b 落在第 16.0 秒（第 480 帧）
  const timing = {
    scenes: [{ scene: 'map', startSec: 0 }],
    words: [
      { scene: 'map', word: 'overview', startSec: 1.0, endSec: 5.5 },
      { scene: 'map', word: 'north', startSec: 8.0, endSec: 12.5 },
      { scene: 'map', word: 'harbor', startSec: 16.0, endSec: 19.2 },
    ],
  };
  const triggers = [
    { id: 'cue_a', scene: 'map', phrase: 'north', anchor: 'start', offsetSec: 0 },
    { id: 'cue_b', scene: 'map', phrase: 'harbor', anchor: 'start', offsetSec: 0 },
  ];
  const cues = evalNarration({ fps, shot: { in: 0 } }, { timing, triggers, anticipationSec: 0 }, 0, 0);
  const camParams = film.shots[0].cards.find((c) => c.use.startsWith('camera.cue-kf')).params;

  // 合成旁白立体声轨
  const wavPath = writeWav48k(
    join(outDir, 'narration.wav'),
    synthesizeNarrationStereo(frames / fpsVal, [[1.0, 5.5], [8.0, 12.5], [16.0, 19.2]]),
  );

  // 192x108（精确 1/10）高对比地图连续纹理，由 camera.cue-kf 逐帧驱动平移；静止段带 ±2 码值微颤零冻结
  const inW = size[0] / 10, inH = size[1] / 10; // 192x108
  const plane = Buffer.allocUnsafe(inW * inH);
  const deliverablePath = join(outDir, 'deliverable.mp4');
  const cueEventsPath = join(outDir, 'cue-events.json');
  writeFileSync(cueEventsPath, JSON.stringify({ cues: cues.cues.list }, null, 2), 'utf8');

  await encodeRawFramesStream({
    outPath: deliverablePath,
    inSize: [inW, inH],
    outSize: size,
    pixFmt: 'gray',
    fps,
    spec,
    audioPath: wavPath,
    crf: 12,
    writeFrames: async (push) => {
      for (let f = 0; f < frames; f++) {
        const pose = evalCueKf({ fps, size, shot: { id: 's01', in: 0, frames }, events: cues.cues.events }, camParams, f, 0);
        const shiftX = pose.panX / 10;
        const shiftY = pose.panY / 10;
        const dither = (f % 2) * 2;
        for (let y = 0; y < inH; y++) {
          for (let x = 0; x < inW; x++) {
            const v = 46 + 170 * latticeTexture(x + shiftX, y + shiftY, 182) + dither;
            plane[y * inW + x] = Math.max(0, Math.min(255, Math.round(v)));
          }
        }
        const wait = push(plane);
        if (wait) await wait;
      }
    },
  });

  return {
    deliverablePath,
    artifacts: { audioWav: wavPath, cueEventsPath },
    cardsUsed: ['time.narration', 'camera.cue-kf', 'deliver.encode'],
  };
}

async function measure18_2(question, film, rendered) {
  const { deliverablePath } = rendered;
  const { fps, frames } = question.deliverable;
  const fpsVal = fpsFloat(fps);
  const [probe, specRes, bfdRes] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    deliverSpec(deliverablePath),
    blackFreezeDup(deliverablePath),
  ]);

  // 从真实 MP4 音频解出 3 句旁白起声，第 2、3 句对应 cue_a、cue_b
  const pcm = decodeAudioMono48k(deliverablePath);
  const speech = detectSpeechSpansFromPcm(pcm, { pauseDb: -45, minPauseSec: 0.25 });
  const audioOnsetFrames = speech.map(([from]) => Math.round(from * fpsVal));
  const eventFrames = [audioOnsetFrames[1], audioOnsetFrames[2]];

  // 从真实 MP4 解码 600 帧 192x108 灰度序列，用 evaluate-b4 readMoveStarts 实测两次快速运镜起帧
  const scanSize = [192, 108];
  const grayFrames = decodeAllFramesGray(deliverablePath, scanSize, frames);
  const args = question.scoring[0].args;
  const markFrames = readMoveStarts((k) => grayFrames[k], [0, frames], scanSize, args);
  const expected = eventFrames.map((f, i) => f - args.leadFrames[i]);
  const hitSummary = readHits(expected, markFrames, [0, frames], args.tolFrames);

  const readings = {
    'narration.timing': {
      eventFrames,
      markFrames,
      range: [0, frames],
      ...hitSummary,
    },
  };

  const measuredForPred = {
    output: { size: [specRes.value.width, specRes.value.height], fps: question.deliverable.fps, frames: specRes.value.frames, colorTag: specRes.value.color_space },
    blackFrames: bfdRes.details.black,
    freezes: bfdRes.details.freezes.map(([a, b]) => ({ in: a, out: b + 1 })),
    eventFrames: { cue_a: eventFrames[0], cue_b: eventFrames[1] },
    audioOnsetFrames,
  };
  const baseResults = question.basePredicates.map((text) => evaluateBasePredicate(text, film, measuredForPred));
  const scoringVerdict = scoreL2b(question, readings);
  const basePass = baseResults.every((r) => r.pass);
  const verdict = {
    ...scoringVerdict,
    basePass,
    scoringPass: scoringVerdict.pass,
    pass: basePass && scoringVerdict.pass,
    base: baseResults,
  };
  return { readings, basePredicates: baseResults, verdict, probe };
}

async function render5_1(question, film, outDir) {
  const { size, fps, frames } = question.deliverable;
  const spec = encodeSpecFor(size, fps, film.delivery.master);
  const alignParams = film.shots[0].cards.find((c) => c.use.startsWith('audio.align')).params;

  // 1) 合成 30.2 秒 48 kHz 立体声源配乐 track.wav：
  //    中高频音乐纹理带独特伪随机包络起伏（确保 20 ms 互相关单峰明确）+ 8 次 65 Hz 低频重击，
  //    首击 2.00 s，末击 25.74 s（经 audio.align 拉伸 ~1.0110 倍精准落到第 624 帧 = 26.00 s）
  const trackSec = 30.2;
  const trackSamples = Math.round(trackSec * SAMPLE_RATE);
  const rand = makeRng(51);
  const stepN = Math.round(0.02 * SAMPLE_RATE); // 960
  const envSteps = Math.ceil(trackSamples / stepN) + 2;
  const rawEnv = Float32Array.from({ length: envSteps }, () => 0.15 + 0.85 * rand());
  const trackHitSecs = [2.0, 5.4, 8.8, 12.2, 15.6, 19.0, 22.4, 25.74];

  const trackL = new Float32Array(trackSamples);
  for (let i = 0; i < trackSamples; i++) {
    const t = i / SAMPLE_RATE;
    const idx = i / stepN;
    const i0 = Math.floor(idx);
    const frac = idx - i0;
    const env = rawEnv[i0] * (1 - frac) + rawEnv[i0 + 1] * frac;
    // 480 Hz + 720 Hz 中频层（不干扰 120 Hz 以下低频重击，同时提供丰富 20 ms 能量包络特征）
    trackL[i] = 0.16 * env * (0.65 * Math.sin(2 * Math.PI * 480 * t) + 0.35 * Math.sin(2 * Math.PI * 720 * t));
  }
  for (const hitSec of trackHitSecs) {
    const s0 = Math.round(hitSec * SAMPLE_RATE);
    const len = Math.min(Math.round(0.09 * SAMPLE_RATE), trackSamples - s0);
    for (let k = 0; k < len; k++) {
      const env = Math.exp(-k / (0.028 * SAMPLE_RATE));
      trackL[s0 + k] += 0.65 * env * Math.sin((2 * Math.PI * 65 * k) / SAMPLE_RATE);
    }
  }
  const trackChannels = [trackL, trackL.slice()];
  const trackWavPath = writeWav48k(join(outDir, 'track.wav'), trackChannels);

  // 2) 调用 audio.align 将首击对到第 48 帧（2.00 s）、末击对到第 624 帧（26.00 s），拉伸比 ≈ 1.0110 ∈ [0.97, 1.03]
  const alignHandle = createAlign({ fps }, alignParams);
  const aligned = alignHandle.object.align(trackChannels, {
    frames,
    anchors: [{ frame: 48, hit: 0 }, { frame: 624, hit: -1 }],
  });
  alignHandle.dispose();
  const alignedWavPath = writeWav48k(join(outDir, 'aligned.wav'), aligned.channels);

  // 3) 视频：第 624 帧唯一硬切（[0, 624) 与 [624, 720)）
  const deliverablePath = join(outDir, 'deliverable.mp4');
  await encodeShotFlipVideo({ outPath: deliverablePath, size, fps, frames, cuts: [624], spec, audioPath: alignedWavPath });

  return {
    deliverablePath,
    artifacts: { trackWav: trackWavPath, alignedWav: alignedWavPath, alignResult: { stretch: aligned.stretch, offsetSec: aligned.offsetSec } },
    cardsUsed: ['audio.align', 'deliver.encode'],
  };
}

async function measure5_1(question, film, rendered) {
  const { deliverablePath, artifacts } = rendered;
  const { fps, frames } = question.deliverable;
  const fpsVal = fpsFloat(fps);

  const [probe, specRes, bfdRes, cutRes] = await Promise.all([
    probeDeliverableSpecAsync(deliverablePath),
    deliverSpec(deliverablePath),
    blackFreezeDup(deliverablePath),
    cutYdif(deliverablePath, 24),
  ]);

  // 从真实 MP4 音轨与源配乐 track.wav 分别解码 PCM，计算 20 ms 能量包络并交 readMusicAlign
  const filmPcm = decodeAudioMono48k(deliverablePath);
  const trackPcm = decodeAudioMono48k(artifacts.trackWav);
  const alignArgs = question.scoring.find((s) => s.metric === 'music.align').args;
  const hitArgs = question.scoring.find((s) => s.metric === 'beat.onset-hit').args;

  const musicAlign = readMusicAlign(
    { filmEnvelope: rmsEnvelope(filmPcm, alignArgs.stepSec), trackEnvelope: rmsEnvelope(trackPcm, alignArgs.stepSec), fps: fpsVal },
    alignArgs,
  );
  const { peaks } = detectLowBandPeaks(filmPcm, fpsVal, frames, { maxHz: hitArgs.maxHz, riseDb: hitArgs.riseDb });
  const hitSummary = readHits(cutRes.value, peaks, [0, frames], hitArgs.tolFrames);

  const readings = {
    'music.align': musicAlign,
    'beat.onset-hit': {
      eventFrames: cutRes.value,
      markFrames: peaks,
      range: [0, frames],
      ...hitSummary,
    },
  };

  const measuredForPred = {
    output: { size: [specRes.value.width, specRes.value.height], fps: question.deliverable.fps, frames: specRes.value.frames, colorTag: specRes.value.color_space },
    blackFrames: bfdRes.details.black,
    freezes: bfdRes.details.freezes.map(([a, b]) => ({ in: a, out: b + 1 })),
    cuts: cutRes.value,
  };
  const baseResults = question.basePredicates.map((text) => evaluateBasePredicate(text, film, measuredForPred));
  const scoringVerdict = scoreL2b(question, readings);
  const basePass = baseResults.every((r) => r.pass);
  const verdict = {
    ...scoringVerdict,
    basePass,
    scoringPass: scoringVerdict.pass,
    pass: basePass && scoringVerdict.pass,
    base: baseResults,
  };
  return { readings, basePredicates: baseResults, verdict, probe };
}

export const PIPELINES = Object.freeze({
  '01-1': { render: render01_1, measure: measure01_1 },
  '23-1': { render: render23_1, measure: measure23_1 },
  '28-1': { render: render28_1, measure: measure28_1 },
  '29-1': { render: render29_1, measure: measure29_1 },
  '23-2': { render: render23_2, measure: measure23_2 },
  '27-1': { render: render27_1, measure: measure27_1 },
  '29-2': { render: render29_2, measure: measure29_2 },
  '30-1': { render: render30_1, measure: measure30_1 },
  '15-2': { render: render15_2, measure: measure15_2 },
  '18-1': { render: render18_1, measure: measure18_1 },
  '18-2': { render: render18_2, measure: measure18_2 },
  '5-1': { render: render5_1, measure: measure5_1 },
});

export function ensureOutDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}
