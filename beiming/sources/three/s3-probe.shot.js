// 探针镜头，测试工具的一部分（s3.test.mjs 用），不是给片子用的：照 ctx.params 在二维讲解舞台上搭任意元素。
// params：elements 是 two-d.js 的元素声明，只是过得了 JSON 的写法：canvas2d 不带 draw，改带 fill [底色, 左上角那一格的颜色]（不写就是透明的画布）、
// clip [x, y, 宽, 高]（画字之前设的裁剪区）和 label { id, text, font, at: [x, y] }（墨色的一段字），三样都可以不写；
// opacity 是按帧号取的数组（可以故意放不是数的东西）。另有 css、fonts、background 原样交给舞台。
// trials 为真时先在页面里把 TRIALS 的坏声明（过不了 JSON 的也在里面）各试装一遍，结果记进 readings，再照常搭 elements。
import { createTwoDStage } from './two-d.js';

const INK = '#1E1B18';

const ONE = { kind: 'dom', html: '<p data-entity="t">x</p>' }, HOLE = [ONE];
HOLE.length = 2;
const FONT = new URL('../../../fonts/NotoSansSC-var.woff2', import.meta.url).href;
// 名字: [该报的错误码, opts, ctx（不写就用真的）]。前五种该在调用当场抛，后两种装到一半才查得出、该经 Promise 报
const TRIALS = {
  slot: ['usage.bad-argument', { elements: Array(1) }],
  hole: ['usage.bad-argument', { elements: HOLE }],
  getter: ['usage.bad-argument', { elements: Object.defineProperty([], 0, { get: () => ONE, enumerable: true }) }],
  noCtx: ['usage.bad-argument', { elements: [ONE] }, null],
  noOpts: ['usage.bad-argument', null],
  // 第一款字体登记上了，第二款取不到
  font: ['usage.bad-argument', { elements: [ONE], fonts: [{ family: 'Probe', url: FONT }, { family: 'Gone', url: `${FONT}.gone.woff2` }] }],
  // 第一层排好、画好了，第二层的实体和它重名
  dup: ['contract.bad-value', { elements: [ONE, ONE], fonts: [{ family: 'Probe', url: FONT }] }],
};

/** 把 TRIALS 各试一遍。每种四个读数：sync 调用当场抛的（1 是该报的错误码，-1 是别的，0 没抛）、late 交回的 Promise 失败带的（同上）、nodes 和 fonts 事后页面多出来的节点数、字体数 */
async function runTrials(ctx) {
  const readings = {}, count = () => [document.querySelectorAll('*').length, document.fonts.size];
  for (const [name, [code, opts, at = ctx]] of Object.entries(TRIALS)) {
    const before = count(), hit = (err) => (err.code === code ? 1 : -1);
    let sync = 0, late = 0;
    try {
      await createTwoDStage(at, opts).then((stage) => stage.dispose(), (err) => { late = hit(err); });
    } catch (err) { sync = hit(err); }
    const after = count();
    Object.assign(readings, { [`${name}.sync`]: sync, [`${name}.late`]: late, [`${name}.nodes`]: after[0] - before[0], [`${name}.fonts`]: after[1] - before[1] });
  }
  return readings;
}

export function build(ctx) {
  const { elements, trials, ...rest } = ctx.params;
  if (trials) return runTrials(ctx).then(async (readings) => { const stage = await stageOf(ctx, elements, rest); return { ...stage, meta: (f) => ({ ...stage.meta(f), readings }) }; });
  return stageOf(ctx, elements, rest);
}

function stageOf(ctx, elements, rest) {
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
