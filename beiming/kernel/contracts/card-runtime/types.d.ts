// 只当文档，不编译。条文以 CONTRACT.md 为准。两种语言写法相同。
import type { ShotCtx, Native } from '../shot/types';

/** 宿主量不出来的三样。里面的结构归每帧元数据契约。 */
export type MetaExtra = { texts?: unknown; anchors?: unknown; readings?: unknown };

export interface Handle {
  object?: Native;                         // 后期类的卡没有
  entities?: Record<string, Native>;       // 名字加实例前缀后并进镜头的 entities
  apply?(f: number, sub: number): void;    // 纯函数
  meta?(f: number): MetaExtra;
  dispose(): void;
}

/** 形状一：工厂函数。由 ctx.cards.use("<卡名>@<版本>", 参数) 或固定装载脚本调。 */
export declare function create(ctx: ShotCtx, params: object): Handle;

/** 形状二：纯函数。由求值核在算 tracks 时调。f：镜头局部帧号；sub：[0, 1)。返回 tracks 的一段。 */
export declare function evaluate(inputs: object, params: object, f: number, sub: number): unknown;
