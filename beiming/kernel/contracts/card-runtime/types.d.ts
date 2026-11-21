// 只当文档，不编译。条文以 CONTRACT.md 为准。两种语言写法相同。
import type { ShotCtx, Native } from '../shot/types';

/** 宿主量不出来的三样。里面的结构归每帧元数据契约。 */
export type MetaExtra = { texts?: unknown; anchors?: unknown; readings?: unknown };

export interface Handle {
  object?: Native;                         // 后期类的卡没有
  // 键是卡内的相对名；并进镜头时叫 <as>.<相对名>。至多一项带 root: true，它并进来就叫 <as>
  entities?: Record<string, Native | { object: Native; root: true }>;
  apply?(f: number, sub: number): void;    // 纯函数
  meta?(f: number): MetaExtra;             // 文字框的 id、读数的名字并进镜头时加 <as>. 前缀
  dispose(): void;
}

/** 形状一：工厂函数。由 ctx.cards.use(as, runtime?) 或固定装载脚本调。params 只从片子描述来，里面的时刻是镜头局部帧号。 */
export declare function create(ctx: ShotCtx, params: object): Handle;

/** 形状二：纯函数。由求值核在算 tracks 时调。f：镜头局部帧号；sub：[0, 1)；params 里的时刻也是镜头局部帧号。返回 tracks 的一段。 */
export declare function evaluate(inputs: object, params: object, f: number, sub: number): unknown;
