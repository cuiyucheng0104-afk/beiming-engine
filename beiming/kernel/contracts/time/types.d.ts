// 只当文档，不编译。条文以 CONTRACT.md 为准。

/** 时间键。frame：整数，>= 0，单位帧；sub：[0, 1)，单位帧。 */
export type TimeKey = { frame: number; sub: number };

/** 帧率。"<分子>/<分母>"，十进制正整数，互质。秒 = (frame + sub) × 分母 ÷ 分子。 */
export type Fps = string;

/** 种子。整数，[0, 4294967295]。 */
export type Seed = number;

/** f：镜头局部帧号，整数，>= 0；n：整数，>= 1。返回 f − (f mod n)。一拍二写成 hold(f, 2)。 */
export declare function hold(f: number, n: number): number;
