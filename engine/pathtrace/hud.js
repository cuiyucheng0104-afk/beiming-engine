// 北冥引擎 · 防冲灰三维纳米晶片 HUD 标准件（D 路线 · 北冥光追，决定 D13）
//
// 职责：构造在强聚光灯扫掠下零介电反射发灰的三维 HUD 晶片材质与跳字图集材质。
// 通过注入 WGSL 片段 `o.base = vec3<f32>(0.0); o.specular = 0.0;` 彻底屏蔽 PBR 默认 4% 菲涅尔反射，
// 并配合 `z <= 0.0015` 厚度约束消除近裁面百叶窗拉伸伪影。
//
// 导出接口：
//   WAFER_HUD_WGSL                                   单贴图晶片防冲灰自发光 WGSL 代码
//   HUD_LIVE_ATLAS_WGSL                              多行动态跳字图集防冲灰 WGSL 代码
//   HUD_FONT_STACK                                   D 路线内置三字体规范常量（英 / 数 / 中）
//   enforceWaferThickness(mesh, maxThickness?)       强制钳制网格局部 Z 轴厚度 <= 0.0015 米
//   createWaferHudMaterial(texMap, options?)         生成挂载防冲灰 WGSL 的标准材质对象
//   createLiveAtlasHudMaterial(atlasTex, options?)   生成挂载多行跳字图集 WGSL 的标准材质对象
//
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine

import { MAX_WAFER_THICKNESS_M } from './camera.js';

/** D 路线三维 HUD 推荐三字体锁（英文字头 / 等宽遥测数字 / 简体中文）。 */
export const HUD_FONT_STACK = Object.freeze({
  display: 'Barlow Condensed',
  mono: 'JetBrains Mono',
  cjk: 'Noto Sans SC',
});

/**
 * 防冲灰三维晶片 WGSL 材质体：
 * 显式写入 `o.base = vec3(0.0); o.specular = 0.0;`（WGSL 类型化写法 `vec3<f32>(0.0)`），
 * 屏蔽 PBR 默认 4% 介电菲涅尔高光，确保万坎德拉级前景聚光灯扫过时暗底晶片零泛白。
 */
export const WAFER_HUD_WGSL = `
    let t = msample_color(m, i, $HudTex, i.uv, exp2(i.uvd));
    let scanX = fract(i.time * $ScanSpeed);
    let scanBoost = 1.0 + $ScanPulse * exp(-abs(i.uv.x - scanX) * 26.0);
    // 铁律：o.base = vec3(0.0); o.specular = 0.0; 屏蔽 4% 介电菲涅尔冲灰
    o.base = vec3<f32>(0.0);
    o.specular = 0.0;
    o.emissive = t.rgb * $Intensity * scanBoost * i.power;
    o.roughness = 1.0;
    o.metallic = 0.0;
    o.opacity = t.a;`;

/** 16 行动态跳字滚动图集 WGSL 材质体。 */
export const HUD_LIVE_ATLAS_WGSL = `
    let rows = max(1.0, $Rows);
    let rowIdx = clamp(floor($Row + 0.5), 0.0, rows - 1.0);
    let uvS = vec2<f32>(i.uv.x, (rowIdx + clamp(i.uv.y, 0.004, 0.996)) / rows);
    let t = msample_color(m, i, $AtlasTex, uvS, exp2(i.uvd));
    let pulse = 1.0 + $ScanPulse * exp(-abs(i.uv.x - fract(i.time * 2.8)) * 22.0);
    // 铁律：o.base = vec3(0.0); o.specular = 0.0; 屏蔽 4% 介电菲涅尔冲灰
    o.base = vec3<f32>(0.0);
    o.specular = 0.0;
    o.emissive = t.rgb * $Intensity * pulse * i.power;
    o.roughness = 1.0;
    o.metallic = 0.0;
    o.opacity = t.a;`;

function makeShaderFunction(name, params, textures, code) {
  const fn = {
    name,
    params,
    textures,
    code,
    helpers: '',
    with(overrideParams = {}, slotTextures = {}) {
      return { fn, params: overrideParams, textures: slotTextures };
    },
  };
  return fn;
}

export const HUD_WAFER_SHADER = makeShaderFunction(
  'beiming_hud_wafer',
  { Intensity: 32.0, ScanSpeed: 1.6, ScanPulse: 0.28 },
  ['HudTex'],
  WAFER_HUD_WGSL,
);

export const HUD_LIVE_ATLAS_SHADER = makeShaderFunction(
  'beiming_hud_live_atlas',
  { Row: 0.0, Rows: 16.0, Intensity: 34.0, ScanPulse: 0.28 },
  ['AtlasTex'],
  HUD_LIVE_ATLAS_WGSL,
);

let waferMatSeq = 0;

function createBaseWaferMaterial(name, boost, alphaTest, shader) {
  const mat = {
    isMaterial: true,
    isMeshStandardMaterial: true,
    type: 'standard',
    needsUpdate: false,
    name,
    color: { r: 0, g: 0, b: 0 },
    roughness: 1,
    metalness: 0,
    emissive: { r: 1, g: 1, b: 1 },
    emissiveIntensity: boost,
    opacity: 1,
    map: null,
    normalMap: null,
    normalScale: [1, 1],
    roughnessMap: null,
    metalnessMap: null,
    aoMap: null,
    emissiveMap: null,
    side: 'double',
    get doubleSided() {
      return this.side === 'double';
    },
    flatShading: false,
    wireframe: false,
    vertexColors: false,
    userData: { maxThickness: MAX_WAFER_THICKNESS_M },
    alphaTest,
    transparent: false,
    maxThickness: MAX_WAFER_THICKNESS_M,
    shader,
    setBoost(nextBoost) {
      this.emissiveIntensity = nextBoost;
      this.shader = {
        fn: this.shader.fn,
        params: { ...this.shader.params, Intensity: nextBoost },
        textures: this.shader.textures,
      };
      this.needsUpdate = true;
      return this;
    },
  };
  return mat;
}

/**
 * 创建防冲灰三维纳米晶片 HUD 材质：
 * 注入 `o.base = vec3(0.0); o.specular = 0.0;` WGSL，使强聚光灯扫掠下暗底晶片永不发灰，
 * 并在材质元数据上标记 `maxThickness = 0.0015`（配合 placeInCameraFrustum / enforceWaferThickness 强制 <= 1.5mm）。
 */
export function createWaferHudMaterial(texMap, options = {}) {
  if (!texMap) {
    throw new TypeError('createWaferHudMaterial: texMap 贴图对象不能为空');
  }
  const boost = Number.isFinite(options.boost) ? options.boost : 32.0;
  const scanSpeed = Number.isFinite(options.scanSpeed) ? options.scanSpeed : 1.6;
  const scanPulse = Number.isFinite(options.scanPulse)
    ? options.scanPulse
    : (scanSpeed === 0 ? 0.0 : 0.28);
  const alphaTest = Number.isFinite(options.alphaTest) ? options.alphaTest : 0.33;
  const name = options.name || `wafer-hud-${++waferMatSeq}`;

  const shader = HUD_WAFER_SHADER.with(
    { Intensity: boost, ScanSpeed: scanSpeed, ScanPulse: scanPulse },
    { HudTex: texMap },
  );
  return createBaseWaferMaterial(name, boost, alphaTest, shader);
}

/** 创建多行实时滚动数显图集晶片材质（默认 16 行）。 */
export function createLiveAtlasHudMaterial(atlasTex, options = {}) {
  if (!atlasTex) {
    throw new TypeError('createLiveAtlasHudMaterial: atlasTex 贴图对象不能为空');
  }
  const row = Number.isFinite(options.row) ? options.row : 0;
  const rows = Number.isFinite(options.rows) && options.rows > 0 ? options.rows : 16;
  const boost = Number.isFinite(options.boost) ? options.boost : 34.0;
  const scanPulse = Number.isFinite(options.scanPulse) ? options.scanPulse : 0.28;
  const alphaTest = Number.isFinite(options.alphaTest) ? options.alphaTest : 0.33;
  const name = options.name || `wafer-atlas-${++waferMatSeq}`;

  const shader = HUD_LIVE_ATLAS_SHADER.with(
    { Row: row, Rows: rows, Intensity: boost, ScanPulse: scanPulse },
    { AtlasTex: atlasTex },
  );
  const base = createBaseWaferMaterial(name, boost, alphaTest, shader);
  return Object.assign(base, {
    setRow(nextRow) {
      base.shader = HUD_LIVE_ATLAS_SHADER.with(
        { ...base.shader.params, Row: nextRow },
        base.shader.textures,
      );
      base.needsUpdate = true;
    },
  });
}

/** 强制将近裁面附着 HUD 几何体的局部 Z 厚度锁在 `z <= 0.0015m`（1.5mm）以内。 */
export function enforceWaferThickness(mesh, maxThickness = MAX_WAFER_THICKNESS_M) {
  const limit = Math.min(Math.max(maxThickness, 1e-6), MAX_WAFER_THICKNESS_M);
  const curZ = Number(mesh.scale?.z);
  const nextZ = Number.isFinite(curZ) && curZ > 0 ? Math.min(curZ, limit) : limit;
  if (typeof mesh.scale.set === 'function') {
    mesh.scale.set(mesh.scale.x, mesh.scale.y, nextZ);
  } else {
    mesh.scale.z = nextZ;
  }
  return mesh;
}
