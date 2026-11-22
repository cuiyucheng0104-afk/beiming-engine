// 探针镜头，测试工具的一部分（s3.test.mjs 用），不是给片子用的：照 ctx.params 在二维讲解舞台上搭任意元素。
// params：elements 是 two-d.js 的元素声明，只是过得了 JSON 的写法：canvas2d 不带 draw，改带 fill [底色, 左上角那一格的颜色]（不写就是透明的画布）、
// clip [x, y, 宽, 高]（画字之前设的裁剪区）和 label { id, text, font, at: [x, y] }（墨色的一段字），三样都可以不写；
// opacity 是按帧号取的数组（可以故意放不是数的东西）。另有 css、fonts、background 原样交给舞台。
import { createTwoDStage } from './two-d.js';

const INK = '#1E1B18';

export function build(ctx) {
  const { elements, ...rest } = ctx.params;
  return createTwoDStage(ctx, {
    ...rest,
    elements: elements.map(({ fill, clip, label, opacity, ...e }) => ({
      ...e,
      ...(opacity && { opacity: (f) => opacity[f] }),
      ...(e.kind === 'canvas2d' && {
        draw(c, { width, height, text }) {
          if (fill) {
            c.fillStyle = fill[0];
            c.fillRect(0, 0, width, height);
            c.fillStyle = fill[1];
            c.fillRect(0, 0, width / 2, height / 2);
          }
          if (clip) {
            c.beginPath();
            c.rect(...clip);
            c.clip();
          }
          if (!label) return;
          c.fillStyle = INK;
          c.font = label.font;
          text(label.id, label.text, ...label.at);
        },
      }),
    })),
  });
}
