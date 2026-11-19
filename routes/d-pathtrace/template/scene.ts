// 北冥光追 · 物理路径追踪（D 路线）起步模版场景：
//   S01 [0, 36)  微距掠射：线性高光灯刃贴面扫过五座斜切拉丝钨钢碑，第 12 帧（sweep-strike）掠过中央主棱
//   S02 [36, 72) 定格揭示：切至镜面黑曜石底座全景（48 SPP），第 40 帧（reveal-lock）点亮底座暖金能量环与左上安全区三维微晶铭牌
// 画面是整数帧 frame 的纯函数（evaluation: "absolute"），无跨帧可变状态。

import {
  BoxGeometry,
  Color,
  Group,
  MaterialFunction,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RectAreaLight,
  Scene,
  SkyGradient,
  SpotLight,
} from '@threert/scene';
import {
  definePathtraceFilm,
  frameSeed,
  placeInCameraFrustum,
  projectBoxToPixels,
} from '../../engine/pathtrace/index.js';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number): number => {
  const u = clamp((x - e0) / Math.max(1e-6, e1 - e0), 0, 1);
  return u * u * (3 - 2 * u);
};

// 各向异性 CNC 拉丝钨钢材质：按世界坐标生成斜向微米刀纹，并在掠射波前叠加冷银/暖金棱边流光
const BRUSHED_TUNGSTEN_SHADER = new MaterialFunction('beiming_brushed_tungsten', {
  params: { SweepX: -1.2, Flare: 0.0 },
  code: `
    let wp = i.wp;
    let grainCoord = wp.x * 0.86 + wp.y * 0.51;
    let brush = fract(sin(floor(grainCoord * 640.0) * 127.1 + floor(wp.z * 180.0) * 31.7) * 43758.5453);
    let groove = smoothstep(0.965, 1.0, abs(sin((wp.x - wp.y * 0.45) * 46.0)));
    let band = exp(-abs(wp.x - $SweepX) * 5.5);
    o.base = vec3<f32>(0.74, 0.82, 0.92) * (0.90 + 0.16 * brush - 0.14 * groove);
    o.roughness = clamp(0.14 + (brush - 0.5) * 0.05 + groove * 0.07 - band * 0.03, 0.08, 0.32);
    o.metallic = 0.95;
    o.emissive = vec3<f32>(0.72, 0.88, 1.0) * band * groove * $Flare * 14.0;`,
});

// 镜面抛光黑曜石底座材质：承接真实光追反射，并在第 40 帧点亮同心暖金锻造能量环
const OBSIDIAN_FLOOR_SHADER = new MaterialFunction('beiming_obsidian_floor', {
  params: { RingGlow: 0.0, LightX: 0.0 },
  code: `
    let p = i.wp.xz;
    let r = length(p);
    let gridX = smoothstep(0.988, 1.0, cos(p.x * 3.14159265 / 0.95));
    let gridZ = smoothstep(0.988, 1.0, cos(p.y * 3.14159265 / 0.95));
    let ringInner = smoothstep(0.024, 0.0, abs(r - 1.18));
    let ringOuter = smoothstep(0.016, 0.0, abs(r - 1.86));
    let seam = clamp(gridX + gridZ + ringInner + ringOuter, 0.0, 1.0);
    o.base = mix(vec3<f32>(0.045, 0.056, 0.072), vec3<f32>(0.014, 0.018, 0.024), seam);
    o.roughness = mix(0.085, 0.34, seam);
    o.metallic = 0.88;
    let sweep = 0.65 + 0.35 * exp(-abs(p.x - $LightX) * 1.4);
    o.emissive = vec3<f32>(1.0, 0.38, 0.06) * (ringInner * 1.25 + ringOuter * 0.55) * $RingGlow * sweep * 18.0;`,
});

// 零冲灰三维微晶铭牌材质：强制 o.base=0 且 o.specular=0，杜绝 4% 介电菲涅尔漫射泛白，输出高对比铂银字形刻度条
const WAFER_BADGE_SHADER = new MaterialFunction('beiming_wafer_title_badge', {
  params: { Boost: 32.0, Lock: 1.0 },
  code: `
    let uv = i.uv;
    let border = step(uv.x, 0.018) + step(0.982, uv.x) + step(uv.y, 0.07) + step(0.93, uv.y);
    let accentBar = step(0.035, uv.x) * step(uv.x, 0.062) * step(0.18, uv.y) * step(uv.y, 0.82);
    let colIdx = floor(uv.x * 16.0);
    let cellX = fract(uv.x * 16.0);
    let inTextSpan = step(0.10, uv.x) * step(uv.x, 0.92);
    let topRow = step(0.24, uv.y) * step(uv.y, 0.54) * step(0.14, cellX) * step(cellX, 0.82);
    let subRow = step(0.64, uv.y) * step(uv.y, 0.76) * step(0.14, cellX) * step(cellX, 0.68) * step(colIdx, 11.0);
    let glyph = clamp(topRow + subRow * 0.85, 0.0, 1.0) * inTextSpan;
    let frameRim = clamp(border, 0.0, 1.0) * 0.45;
    let emitCol = vec3<f32>(0.92, 0.96, 1.0) * (glyph + frameRim) + vec3<f32>(1.0, 0.44, 0.08) * accentBar;
    o.base = vec3<f32>(0.0);
    o.specular = 0.0;
    o.roughness = 1.0;
    o.metallic = 0.0;
    o.emissive = emitCol * $Boost * $Lock;
    o.opacity = 0.96;`,
});

function titleTargetBox(screenW: number, screenH: number): [number, number, number, number] {
  return [
    Math.round(screenW * 0.075),
    Math.round(screenH * 0.09),
    Math.round(screenW * 0.2),
    Math.round(screenH * 0.054),
  ];
}

export default definePathtraceFilm(({ width, height, fps, seed, film }) => {
  const scene = new Scene();
  scene.background = new Color(0x090d14);

  // 解析式冷钢天幕：无随机体积散射噪点，保证暗部与金属高光干净通透
  const sky = new SkyGradient({
    zenith: 0x121b2a,
    horizon: 0x2c3e56,
    ground: 0x090d14,
    intensity: 3.1,
  });
  sky.setGlow(0xff6a1a, 1.25, 0.22);
  scene.environment = sky;
  scene.fog = null;

  // 1. 镜面黑曜石底座
  const floorMat = new MeshPhysicalMaterial({
    name: 'obsidian-mirror-floor',
    color: new Color(0x18202b),
    metalness: 0.88,
    roughness: 0.09,
    clearcoat: 0.5,
    clearcoatRoughness: 0.07,
  });
  floorMat.shader = OBSIDIAN_FLOOR_SHADER.with({ RingGlow: 0.0, LightX: 0.0 });
  const floor = new Mesh(new PlaneGeometry(36, 36), floorMat);
  floor.rotation.x = -Math.PI * 0.5;
  floor.position.set(0, -0.62, 0);
  scene.add(floor);

  // 2. 五座斜切拉丝钨钢主碑与内嵌暖金导光核
  const tungstenMat = new MeshPhysicalMaterial({
    name: 'brushed-tungsten',
    color: new Color(0xdce8f6),
    metalness: 0.95,
    roughness: 0.14,
    clearcoat: 0.25,
    clearcoatRoughness: 0.12,
  });
  tungstenMat.shader = BRUSHED_TUNGSTEN_SHADER.with({ SweepX: -1.2, Flare: 0.0 });

  const plinthMat = new MeshStandardMaterial({
    name: 'gunmetal-plinth',
    color: new Color(0x232c3a),
    metalness: 0.9,
    roughness: 0.24,
  });

  const emberMat = new MeshStandardMaterial({
    name: 'amber-core-seam',
    color: new Color(0x240900),
    metalness: 0.15,
    roughness: 0.25,
    emissive: new Color(0xff6212),
    emissiveIntensity: 18,
  });

  const monolithGroup = new Group();
  monolithGroup.movable = true;
  scene.add(monolithGroup);

  const plinth = new Mesh(new BoxGeometry(2.15, 0.1, 0.92), plinthMat);
  plinth.position.set(0, -0.57, 0);
  monolithGroup.add(plinth);

  const specs: Array<{ x: number; h: number; w: number; d: number; z: number; yaw: number }> = [
    { x: -0.72, h: 0.78, w: 0.22, d: 0.26, z: -0.14, yaw: 0.28 },
    { x: -0.36, h: 1.02, w: 0.25, d: 0.28, z: -0.05, yaw: 0.15 },
    { x: 0.0, h: 1.28, w: 0.3, d: 0.32, z: 0.04, yaw: -0.08 },
    { x: 0.38, h: 1.06, w: 0.25, d: 0.28, z: -0.04, yaw: -0.18 },
    { x: 0.74, h: 0.82, w: 0.22, d: 0.26, z: -0.13, yaw: -0.3 },
  ];

  const monoliths: Mesh[] = [];
  for (const s of specs) {
    const body = new Mesh(new BoxGeometry(s.w, s.h, s.d), tungstenMat);
    body.movable = true;
    body.position.set(s.x, -0.52 + s.h * 0.5, s.z);
    body.rotation.y = s.yaw;
    monolithGroup.add(body);
    monoliths.push(body);

    const coreStrip = new Mesh(new BoxGeometry(0.022, s.h * 0.82, s.d + 0.012), emberMat);
    coreStrip.position.set(s.x, -0.52 + s.h * 0.5, s.z);
    coreStrip.rotation.y = s.yaw;
    monolithGroup.add(coreStrip);
  }

  // 3. 物理面光源阵列与穿梭聚光灯
  const keySoftbox = new RectAreaLight(new Color(0xe2effc), 78, 6.4, 3.6);
  keySoftbox.card = false;
  keySoftbox.movable = true;
  keySoftbox.position.set(-1.8, 2.2, 4.6);
  keySoftbox.lookAt(0, 0.05, 0);
  scene.add(keySoftbox);

  const topSoftbox = new RectAreaLight(new Color(0xd6e6f8), 58, 6.0, 3.8);
  topSoftbox.card = false;
  topSoftbox.movable = true;
  topSoftbox.position.set(1.2, 3.8, 2.4);
  topSoftbox.lookAt(0, 0.0, 0);
  scene.add(topSoftbox);

  const wandLight = new RectAreaLight(new Color(0xf5faff), 210, 0.42, 3.4);
  wandLight.card = false;
  wandLight.movable = true;
  wandLight.position.set(-1.4, 0.25, 2.1);
  wandLight.lookAt(0, 0.08, 0);
  scene.add(wandLight);

  const rimSpot = new SpotLight(new Color(0xff7b29), 3400, 0, 0.62, 0.5);
  rimSpot.movable = true;
  rimSpot.position.set(2.2, 1.1, -2.4);
  rimSpot.target!.position.set(0, 0.05, 0);
  scene.add(rimSpot);

  // 4. 左上安全区近裁面三维微晶铭牌（厚度由 placeInCameraFrustum 锁在 <= 1.5mm）
  const waferMat = new MeshStandardMaterial({
    name: 'wafer-title-badge',
    alphaTest: 0.1,
    side: 'double',
  });
  waferMat.shader = WAFER_BADGE_SHADER.with({ Boost: 32.0, Lock: 1.0 });
  const waferBadge = new Mesh(new BoxGeometry(1, 1, 1), waferMat);
  waferBadge.movable = true;
  waferBadge.visible = false;
  scene.add(waferBadge);

  const camera = new PerspectiveCamera(36, width / height, 0.04, 100);
  camera.position.set(-0.58, 0.08, 1.68);
  camera.lookAt(0.04, 0.04, 0);
  camera.setManualExposure(3.8);
  scene.add(camera);

  const baseSeed = Number.isInteger(seed) ? seed : Number(film?.pathtrace?.seed ?? 2026);
  const titleText = String(film?.title || '北冥光追');

  function applyState(frame: number, screenW: number, screenH: number, hideTexts: boolean): void {
    const f = clamp(Math.round(frame), 0, 71);
    const rnd01 = (frameSeed(baseSeed, f) & 0xffff) / 65535;
    camera.aspect = screenW / screenH;

    if (f < 36) {
      // S01 [0, 36)：近景微距掠射，第 12 帧高光灯刃正对中央主钨钢棱面（sweep-strike）
      const u = f / 35;
      const ease = smoothstep(0, 1, u);
      camera.fov = 36;
      camera.position.set(lerp(-0.56, 0.36, ease), lerp(0.06, 0.14, ease), lerp(1.66, 1.52, ease));
      camera.lookAt(lerp(-0.08, 0.08, ease), 0.05, 0.02);

      const sweepX = lerp(-0.96, 1.04, u);
      const strikePulse = Math.exp(-Math.pow((f - 12) / 3.2, 2));
      wandLight.intensity = 185 + 145 * strikePulse + rnd01 * 4;
      wandLight.position.set(sweepX * 1.45, 0.22, 1.95);
      wandLight.lookAt(sweepX * 0.45, 0.06, 0);

      keySoftbox.position.set(lerp(-2.0, -0.8, ease), 2.1, 4.2);
      keySoftbox.lookAt(0, 0.06, 0);
      rimSpot.intensity = 2800 + 1100 * strikePulse;

      tungstenMat.shader = BRUSHED_TUNGSTEN_SHADER.with({ SweepX: sweepX, Flare: 0.45 + 0.95 * strikePulse });
      floorMat.shader = OBSIDIAN_FLOOR_SHADER.with({ RingGlow: 0.18, LightX: sweepX });
      emberMat.emissiveIntensity = 14 + 16 * strikePulse;
      waferBadge.visible = false;
    } else {
      // S02 [36, 72)：全景黑曜石镜面揭示，第 40 帧底座暖金能量环与左上微晶铭牌锁止（reveal-lock）
      const u = (f - 36) / 35;
      const ease = smoothstep(0, 1, u);
      const lockProgress = smoothstep(36, 40, f);
      const lockFlash = f >= 40 ? Math.exp(-(f - 40) / 5.5) : 0;

      camera.fov = 40;
      camera.position.set(lerp(-0.14, 0.14, ease), lerp(0.36, 0.28, ease), lerp(3.78, 3.46, ease));
      camera.lookAt(0, -0.05, 0);

      const lightSweepX = lerp(-1.35, 1.35, u);
      keySoftbox.position.set(lightSweepX, 2.35, 4.8);
      keySoftbox.lookAt(0, 0.0, 0);

      wandLight.intensity = 150 + 90 * lockFlash;
      wandLight.position.set(lerp(1.2, -1.1, ease), 0.75, 2.85);
      wandLight.lookAt(0, 0.04, 0);
      rimSpot.intensity = 3400 + 1400 * lockFlash;

      tungstenMat.shader = BRUSHED_TUNGSTEN_SHADER.with({ SweepX: lightSweepX * 0.65, Flare: 0.35 + 0.65 * lockFlash });
      floorMat.shader = OBSIDIAN_FLOOR_SHADER.with({
        RingGlow: 0.25 + 0.85 * lockProgress + 0.45 * lockFlash,
        LightX: lightSweepX,
      });
      emberMat.emissiveIntensity = 18 + 14 * lockProgress + 10 * lockFlash;

      const badgeLock = 0.82 + 0.18 * lockProgress;
      waferMat.shader = WAFER_BADGE_SHADER.with({ Boost: 32.0, Lock: badgeLock });
      placeInCameraFrustum(waferBadge, camera, 0.85, titleTargetBox(screenW, screenH), screenW, screenH);
      waferBadge.visible = !hideTexts;
    }
  }

  return {
    scene,
    camera,
    options: { name: String(film?.id || 'pathtrace-film'), preset: 'cinematic' },
    renderFrame(frame, ctx) {
      applyState(frame, ctx.width || width, ctx.height || height, Boolean(ctx.hideTexts));
    },
    textsAt(frame, ctx) {
      const f = clamp(Math.round(frame), 0, 71);
      if (f < 36) return [];
      const curW = ctx.width || width;
      const curH = ctx.height || height;
      applyState(f, curW, curH, false);
      const fallback = titleTargetBox(curW, curH);
      const projected = projectBoxToPixels(waferBadge, camera, curW, curH) ?? fallback;
      const box: [number, number, number, number] = [
        Math.max(Math.round(curW * 0.06), Math.round(projected[0])),
        Math.max(Math.round(curH * 0.06), Math.round(projected[1])),
        Math.max(16, Math.round(projected[2])),
        Math.max(12, Math.round(projected[3])),
      ];
      return [
        {
          id: 'title',
          text: titleText,
          box,
          alpha: f >= 40 ? 1 : 0.94,
          font: 'Noto Sans SC',
        },
      ];
    },
  };
});
