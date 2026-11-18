// 命名随机流：一条序列只由流名决定，和别的流存不存在、调用先后无关。
// 纯函数，不依赖渲染库；页面和 node 两边都引用。

const ARG = /^[^/\s]+\/[^/\s]+$/;

/** 流名 = <镜头种子>/<镜头>/<用途>/<对象>；arg 是调用方给的 "<用途>/<对象>"。 */
export function streamName(seed, shotId, arg) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new RangeError(`镜头种子必须是 [0, 4294967295] 里的整数，给的是 ${seed}`);
  if (typeof arg !== 'string' || !ARG.test(arg)) throw new RangeError(`随机流的参数必须是 "<用途>/<对象>"，给的是 ${JSON.stringify(arg)}`);
  return `${seed}/${shotId}/${arg}`;
}

/**
 * 按流名开一条随机流。next() 返回 [0, 1) 里的数，u32() 返回 32 位无符号整数，name 是流名。
 * 流名先散列成四个 32 位状态（cyrb128），再用 sfc32 出数；每条流的状态只在自己的闭包里。
 */
export function stream(name) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < name.length; i++) {
    const k = name.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  let a = (h1 ^ h2 ^ h3 ^ h4) >>> 0, b = (h2 ^ h1) >>> 0, c = (h3 ^ h1) >>> 0, d = (h4 ^ h1) >>> 0;
  const u32 = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = ((c << 21) | (c >>> 11)) + t | 0;
    return t >>> 0;
  };
  return { name, u32, next: () => u32() / 4294967296 };
}
