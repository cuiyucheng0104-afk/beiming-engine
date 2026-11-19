// 北冥引擎 · 物理路径追踪确定性场景 SDK 主入口类型声明（D 路线 · 北冥光追，决定 D13）
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine

export {
  MAX_WAFER_THICKNESS_M,
  frameSeed,
  placeInCameraFrustum,
  projectBoxToPixels,
  type FrustumCameraLike,
  type FrustumTargetLike,
  type Point3,
  type QuatLike,
  type Vec3Like,
  type WorldBoundsInput,
} from './camera.js';

export {
  HUD_FONT_STACK,
  HUD_LIVE_ATLAS_SHADER,
  HUD_LIVE_ATLAS_WGSL,
  HUD_WAFER_SHADER,
  WAFER_HUD_WGSL,
  createLiveAtlasHudMaterial,
  createWaferHudMaterial,
  enforceWaferThickness,
  type WaferHudMaterial,
  type WaferHudMaterialOptions,
  type WaferShaderFunction,
} from './hud.js';

export interface PathtraceShotSpec {
  id: string;
  in: number;
  out: number;
  [key: string]: unknown;
}

export interface PathtraceShotInfo {
  id: string;
  in: number;
  out: number;
  index: number;
  length: number;
}

export interface PathtraceFilmSpec {
  id?: string;
  title?: string;
  fps?: number;
  dur?: number;
  size?: [number, number];
  output?: {
    width?: number;
    height?: number;
    fps?: number;
    frameCount?: number;
    profile?: string;
  };
  shots?: PathtraceShotSpec[];
  pathtrace?: {
    preset?: string;
    spp?: number;
    animaticSpp?: number;
    denoise?: string;
    seed?: number;
    shotSpp?: Record<string, number>;
    overlay?: string;
  };
  [key: string]: unknown;
}

export interface PathtraceFilmInit {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  seed: number;
  film: PathtraceFilmSpec;
}

export interface PathtraceFrameContext {
  frame: number;
  t: number;
  fps: number;
  width: number;
  height: number;
  frameCount: number;
  shot: string;
  shotInfo: PathtraceShotInfo;
  localFrame: number;
  localT: number;
  shotProgress: number;
  hideTexts: boolean;
  seed: number;
}

export interface PathtraceTextItem {
  id?: string;
  text: string;
  box: [number, number, number, number];
  alpha?: number;
  font?: string;
}

export interface PathtraceFilmInstance {
  scene: unknown;
  camera: unknown;
  options?: Record<string, unknown>;
  renderFrame(frame: number, ctx: PathtraceFrameContext): void;
  textsAt?(frame: number, ctx: PathtraceFrameContext): PathtraceTextItem[];
}

export type PathtraceFilmFactory = (init: PathtraceFilmInit) => PathtraceFilmInstance;

export interface PathtraceRuntimeState {
  frame: number;
  hideTexts: boolean;
}

export interface PathtraceTextTrackSummary {
  id: string;
  text: string;
  firstFrame: number;
  lastFrame: number;
  frameCount: number;
  peakFrame: number;
  peakAlpha: number;
  peakBox: [number, number, number, number];
  font: string | null;
}

export interface PathtraceProbeResult {
  evaluation: 'absolute';
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  seed: number;
  frames: Array<{
    frame: number;
    t: number;
    shot: string;
    items: Array<{
      id: string;
      text: string;
      box: [number, number, number, number];
      alpha: number;
      font: string | null;
    }>;
  }>;
  summary: PathtraceTextTrackSummary[];
}

export interface NormalizedMeta {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  seed: number;
  preset: string;
  shots: PathtraceShotInfo[];
  film: PathtraceFilmSpec;
}

export interface DefinedPathtraceFilm {
  readonly __beimingPathtraceFilm: true;
  readonly evaluation: 'absolute';
  seed: number;
  state: PathtraceRuntimeState;
  handlers: {
    set(
      tx: { set(key: string, value: unknown): void },
      payload: Partial<PathtraceRuntimeState>,
    ): void;
  };
  setup(ctx?: { roomId?: string; seed?: number }): {
    scene: unknown;
    camera: unknown;
    options: Record<string, unknown>;
  };
  frame(f: { time: number; state?: Partial<PathtraceRuntimeState> }): void;
  createInstance(override?: {
    film?: PathtraceFilmSpec;
    width?: number;
    height?: number;
    fps?: number;
  }): { meta: NormalizedMeta; instance: PathtraceFilmInstance };
  probeFilm(override?: {
    film?: PathtraceFilmSpec;
    width?: number;
    height?: number;
    fps?: number;
  }): PathtraceProbeResult;
}

export declare function definePathtraceFilm(factory: PathtraceFilmFactory): DefinedPathtraceFilm;
