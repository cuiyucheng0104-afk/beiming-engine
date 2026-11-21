// comp.finish 在合成一侧的实现：显示空间的成片上加颗粒和暗角。
// 合成宿主怎么用 Handle 还没有契约，这里定的用法写在卡文件的 ports.requires 里：先 apply(f, 0) 定帧，再调 Handle.object.process。

/**
 * ctx 用到 rng。params：grain 颗粒的幅度，vignette 四角变暗的比例，都没有单位，都在 [0, 1]。
 * 颗粒：每个像素三个通道加同一个数，这个数在 ±grain ÷ 2 × 255 之间均匀分布（8 位码值）；每帧一条命名随机流 finish/grain-f<帧号>，
 * 所以哪一帧先算都一样。暗角：像素乘 1 − vignette × d²，d 是像素中心到画面中心的距离除以画面中心到角的距离。
 */
export function create(ctx, params) {
  let frame = null;
  return {
    apply(f) { frame = f; },
    object: {
      /** rgba：8 位显示空间的 RGBA，逐行从上到下；size 是 [宽, 高]（像素）。返回同样大小的新画面，透明度原样 */
      process(rgba, size) {
        const [w, h] = size;
        if (rgba.length !== w * h * 4) throw new RangeError(`comp.finish 拿到的画面有 ${rgba.length} 个字节，${w} × ${h} 的画面应该是 ${w * h * 4} 个`);
        if (frame === null) throw new Error('comp.finish 要先 apply(f, 0) 定下是哪一帧');
        const out = new Uint8ClampedArray(rgba);
        if (!params.grain && !params.vignette) return out;
        const noise = params.grain ? ctx.rng(`finish/grain-f${frame}`) : null;
        const cx = w / 2, cy = h / 2, corner = cx * cx + cy * cy;
        for (let y = 0, i = 0; y < h; y++) {
          for (let x = 0; x < w; x++, i += 4) {
            const dim = 1 - params.vignette * (((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / corner);
            const n = noise ? (noise.next() - 0.5) * params.grain * 255 : 0;
            for (let c = 0; c < 3; c++) out[i + c] = Math.round(rgba[i + c] * dim + n);
          }
        }
        return out;
      },
    },
    dispose() {},
  };
}
