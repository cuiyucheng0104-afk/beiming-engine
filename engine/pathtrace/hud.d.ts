// 北冥引擎 · 防冲灰三维纳米晶片 HUD 标准件类型声明（D 路线 · 北冥光追，决定 D13）
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine

import type { Vec3Like } from './camera.js';

export declare const HUD_FONT_STACK: Readonly<{
  display: 'Barlow Condensed';
  mono: 'JetBrains Mono';
  cjk: 'Noto Sans SC';
}>;

export declare const WAFER_HUD_WGSL: string;
export declare const HUD_LIVE_ATLAS_WGSL: string;

export interface WaferShaderFunction {
  readonly name: string;
  readonly params: Record<string, number | [number, number, number, number]>;
  readonly textures: string[];
  readonly code: string;
  readonly helpers: string;
  with(
    params?: Record<string, number | [number, number, number, number]>,
    textures?: Record<string, unknown>,
  ): {
    fn: WaferShaderFunction;
    params: Record<string, number | [number, number, number, number]>;
    textures: Record<string, unknown>;
  };
}

export declare const HUD_WAFER_SHADER: WaferShaderFunction;
export declare const HUD_LIVE_ATLAS_SHADER: WaferShaderFunction;

export interface WaferHudMaterialOptions {
  /** 自发光亮度倍率（nits），默认 32。 */
  boost?: number;
  /** 水平扫描流光速度（Hz），默认 1.6；传 0 关闭流光。 */
  scanSpeed?: number;
  /** 扫描流光脉冲幅度，默认 0.28；传 0 为恒定亮度。 */
  scanPulse?: number;
  /** Alpha 裁切阈值，默认 0.33。 */
  alphaTest?: number;
  /** 材质调试名称。 */
  name?: string;
}

export interface WaferHudMaterial {
  readonly isMaterial: true;
  readonly isMeshStandardMaterial: true;
  type: 'standard';
  needsUpdate: boolean;
  name: string;
  color: { r: number; g: number; b: number };
  roughness: number;
  metalness: number;
  emissive: { r: number; g: number; b: number };
  emissiveIntensity: number;
  opacity: number;
  map: null;
  normalMap: null;
  normalScale: [number, number];
  roughnessMap: null;
  metalnessMap: null;
  aoMap: null;
  emissiveMap: null;
  side: 'double';
  readonly doubleSided: boolean;
  flatShading: boolean;
  wireframe: boolean;
  vertexColors: boolean;
  userData: Record<string, unknown>;
  alphaTest: number;
  transparent: boolean;
  maxThickness: number;
  shader: {
    fn: WaferShaderFunction;
    params: Record<string, number | [number, number, number, number]>;
    textures: Record<string, unknown>;
  };
  setBoost(boost: number): WaferHudMaterial;
}

export declare function createWaferHudMaterial(
  texMap: unknown,
  options?: WaferHudMaterialOptions,
): WaferHudMaterial;

export declare function createLiveAtlasHudMaterial(
  atlasTex: unknown,
  options?: {
    row?: number;
    rows?: number;
    boost?: number;
    scanPulse?: number;
    alphaTest?: number;
    name?: string;
  },
): WaferHudMaterial & { setRow(row: number): void };

export declare function enforceWaferThickness<T extends { scale: Vec3Like }>(
  mesh: T,
  maxThickness?: number,
): T;
