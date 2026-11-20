// comp.display 在合成一侧的实现：线性光画面变成显示器上看的 8 位画面。
// 合成宿主怎么用 Handle 还没有契约，这里定的用法写在卡文件的 ports.requires 里：合成工具调 Handle.object.encode。

/** sRGB 的分段传递函数：线性光 [0, 1] 到显示空间 [0, 1] */
const srgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** params：scene 是场景参考的画面用哪个视图变换，display 是显示空间。这一版 display 只认 srgb */
export function create(ctx, params) {
  if (params.display !== 'srgb') throw new Error(`comp.display 这一版只出 srgb，给的是 ${params.display}`);
  return {
    object: {
      /**
       * rgba：32 位浮点，线性光 Rec.709，预乘透明度，逐行从上到下；size 是 [宽, 高]（像素）；colorRef 是这幅画面的参考（display 或 scene）。
       * 返回 8 位显示空间的 RGBA（sRGB），不透明：半透明的像素按预乘值叠在黑底上。
       */
      encode(rgba, size, colorRef) {
        if (rgba.length !== size[0] * size[1] * 4) throw new RangeError(`comp.display 拿到的画面有 ${rgba.length} 个数，${size[0]} × ${size[1]} 的画面应该是 ${size[0] * size[1] * 4} 个`);
        // shortcut: 场景参考的画面要过 params.scene 指的视图变换，查找表还没接；接上之前报错，不拿 sRGB 传递函数顶替
        if (colorRef !== 'display') throw new Error(`comp.display 这一版只做显示参考的画面，${colorRef} 参考的要过 ${params.scene}，还没接`);
        const out = new Uint8ClampedArray(rgba.length);
        for (let i = 0; i < rgba.length; i += 4) {
          for (let c = 0; c < 3; c++) out[i + c] = Math.round(srgb(Math.min(1, Math.max(0, rgba[i + c]))) * 255);
          out[i + 3] = 255;
        }
        return out;
      },
    },
    dispose() {},
  };
}
