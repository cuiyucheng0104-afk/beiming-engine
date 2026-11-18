// 只当文档，不编译。条文以 CONTRACT.md 为准。两种语言形状相同，Python 里镜头对象是字典。
import type { Fps, Seed } from '../time/types';
import type { Handle, MetaExtra } from '../card-runtime/types';

/** 母语对象：three 的 Object3D、Blender 的物体这类。 */
export type Native = unknown;

/** 命名随机流。取数方法待定。 */
export type RngStream = unknown;

export interface ShotCtx {
  tracks: { apply(f: number, sub: number): void; camera?: Native };
  cards: { use(ref: string, params?: object): Handle };   // ref："<卡名>@<版本>"
  params: object;
  seed: Seed;
  rng(arg: string): RngStream;                             // arg："<用途>/<对象>"
  assets: { load(ref: string): unknown };                  // ref："asset:<名>@<版本>"
  anchor(entity: string, anchor: string): [number, number, number];   // 世界坐标，米
  tokens: object;
  size: [number, number];                                  // [宽, 高]，像素
  fps: Fps;
  frames: number;                                          // 这个镜头的帧数
  THREE?: Native;                                          // three 帧源
  renderer?: Native;                                       // three 帧源
  bpy?: Native;                                            // Blender 帧源
  scene?: Native;                                          // Blender 帧源
}

export interface Shot {
  state(f: number, sub: number): void;   // f：镜头局部帧号；sub：[0, 1)
  meta(f: number): MetaExtra;
  dispose(): void;
  camera: Native;
  entities: Record<string, Native>;      // 键是实体名
  scene?: Native;                        // three 帧源必填
}

export declare function build(ctx: ShotCtx): Shot | Promise<Shot>;
