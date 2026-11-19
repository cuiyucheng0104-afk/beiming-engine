// 只当文档，不编译。条文以 CONTRACT.md 为准。两种语言形状相同，Python 里镜头对象是字典。
import type { Fps, Seed } from '../time/types';
import type { Handle, MetaExtra } from '../card-runtime/types';

/** 母语对象：three 的 Object3D、Blender 的物体这类。 */
export type Native = unknown;

/** 命名随机流。name 是展开好的流名；取数方法待定。 */
export interface RngStream { readonly name: string }

export interface ShotCtx {
  tracks: { apply(f: number, sub: number): void; camera?: Native };   // 片子没给轨道时 apply 是空操作，camera 不出现
  cards: { use(as: string, runtime?: object): Handle };   // as：这个镜头 cards 里声明过的实例名；runtime：只放写不进 JSON 的东西
  params: object;
  seed: Seed;                                              // 这次装载生效的镜头种子：有锁取锁里记的，没有取镜头条目的 seed；rng 展开流名用的是同一个值
  rng(arg: string): RngStream;                             // arg："<用途>/<对象>"
  assets: { load(ref: string): unknown };                  // ref："asset:<名>@<版本>"；能用的是镜头条目的 assets 和镜头输入的 assets（全片的）；找不到必须报错，不交回空值
  anchor(entity: string, anchor: string): [number, number, number];   // 世界坐标，米；找不到必须报错
  tokens: object;                                          // 镜头输入现在不带画风令牌，现在是空对象
  size: [number, number];                                  // [宽, 高]，像素：镜头输入的 output.size；缩放不是 1 时跟不跟着缩放待定
  fps: Fps;                                                // 镜头输入的 output.fps
  frames: number;                                          // 这个镜头的帧数：镜头条目的 out 减 in
  readonly shot: { id: string; in: number; frames: number };   // in：全片帧号
  readonly events: Record<string, number>;                 // 取自镜头输入的 events 里的命名条目：键是 id，值是 frame 减去 in，可以在镜头之外；镜头输入不带时是空对象
  THREE?: Native;                                          // three 帧源
  renderer?: Native;                                       // three 帧源
  bpy?: Native;                                            // Blender 帧源
  hostScene?: Native;                                      // Blender 帧源
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
