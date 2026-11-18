// 北冥引擎 · 光追摄影机视锥贴合与屏幕像素投影类型声明（D 路线 · 北冥光追，决定 D13）
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine

export declare const MAX_WAFER_THICKNESS_M: 0.0015;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
  set?: (x: number, y: number, z: number) => unknown;
}

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
  set?: (x: number, y: number, z: number, w: number) => unknown;
  copy?: (q: { x: number; y: number; z: number; w: number }) => unknown;
}

export interface FrustumCameraLike {
  fov?: number;
  aspect?: number;
  near?: number;
  far?: number;
  position?: Vec3Like | readonly [number, number, number];
  up?: Vec3Like | readonly [number, number, number];
  target?: Vec3Like | readonly [number, number, number] | { position?: Vec3Like | readonly [number, number, number] };
  quaternion?: QuatLike;
  matrixWorld?: { elements: ArrayLike<number> };
  updateWorldMatrix?: (updateParents: boolean, updateChildren: boolean) => void;
  updateMatrixWorld?: () => void;
}

export interface FrustumTargetLike {
  position: Vec3Like;
  quaternion?: QuatLike;
  scale: Vec3Like;
  matrixWorld?: { elements: ArrayLike<number> };
  updateWorldMatrix?: (updateParents: boolean, updateChildren: boolean) => void;
  updateMatrixWorld?: () => void;
  geometry?: {
    attributes?: {
      position?: { array: ArrayLike<number>; itemSize?: number };
    };
    boundingBox?: {
      min: Vec3Like | readonly [number, number, number];
      max: Vec3Like | readonly [number, number, number];
    } | null;
  };
}

export type Point3 = Vec3Like | readonly [number, number, number];

export type WorldBoundsInput =
  | FrustumTargetLike
  | { min: Point3; max: Point3 }
  | { center: Point3; size: Point3 }
  | readonly [Point3, Point3];

export declare function frameSeed(seed: number, frame: number): number;

export declare function placeInCameraFrustum(
  mesh: FrustumTargetLike,
  camera: FrustumCameraLike,
  dist: number,
  pxBox: readonly [number, number, number, number],
  screenW: number,
  screenH: number,
): {
  position: [number, number, number];
  scale: [number, number, number];
  box: [number, number, number, number];
};

export declare function projectBoxToPixels(
  target: WorldBoundsInput,
  camera: FrustumCameraLike,
  screenW: number,
  screenH: number,
): [number, number, number, number] | null;
