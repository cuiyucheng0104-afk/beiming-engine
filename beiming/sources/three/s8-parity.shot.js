// S8 双宿主对拍镜头（host:'any'）：在页面宿主（Chromium WebGL2）与离屏实验宿主（Node + Dawn WebGPU）上
// 用同一份源码渲染相同相机、点光源、标准材质与逐子帧运动，供 s8.test.mjs 核对 PSNR ≥ 50 dB 且差 5 级以上像素 ≤ 0.1%。
import { calibShot } from '../../calib/shot-three.js';

export const S8_PARITY_SPEC = {
  camera: {
    positionM: [0, 1.2, 4.2],
    lookAtM: [0, 0.2, 0],
    upDir: [0, 1, 0],
    yFovDeg: 40,
    widthPx: 320,
    heightPx: 180,
    nearM: 0.1,
    farM: 100,
  },
  backgroundLinear: [0.04, 0.06, 0.1],
  lights: [
    { id: 'key', kind: 'point', positionM: [2.5, 3.0, 2.5], colorLinear: [1.0, 0.95, 0.9], powerW: 600 },
  ],
  objects: [
    {
      id: 'floor',
      shape: 'plane',
      sizeM: [6, 6],
      positionM: [0, -0.8, -1],
      rotation: { axisDir: [1, 0, 0], angleRad: -1.2 },
      emissionLinear: [0.12, 0.16, 0.22],
    },
    {
      id: 'hero_box',
      shape: 'box',
      sizeM: [0.9, 0.9, 0.9],
      positionM: [-0.8, 0.2, 0],
      rotation: { axisDir: [0.4, 1, 0.2], angleRad: 0.5 },
      motion: {
        kind: 'spin',
        axisDir: [0, 1, 0],
        pivotM: [-0.8, 0.2, 0],
        angularVelocityRadPerFrame: 0.08,
      },
      emissionLinear: [0.05, 0.02, 0.02],
      material: {
        baseColorLinear: [0.75, 0.22, 0.18],
        roughnessRatio: 0.45,
        metallicRatio: 0.1,
      },
    },
    {
      id: 'orb',
      shape: 'sphere',
      radiusM: 0.55,
      positionM: [0.85, 0.25, -0.2],
      motion: {
        kind: 'linear',
        velocityMPerFrame: [0, 0.03, 0],
      },
      emissionLinear: [0.02, 0.05, 0.08],
      material: {
        baseColorLinear: [0.2, 0.55, 0.85],
        roughnessRatio: 0.35,
        metallicRatio: 0.2,
      },
    },
  ],
};

export function build(ctx) {
  const spec = ctx.params?.spec ?? S8_PARITY_SPEC;
  return calibShot(spec)(ctx);
}
