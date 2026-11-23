// 样板镜头：考题 18-1 的讲解场景（s3.test.mjs 实渲它）。1920×1080、30 帧每秒，纸色底上三场讲解，每场一个 SVG 徽标、
// 一行 DOM 标题、几张 DOM 卡片和整块更替的 DOM 字幕；第二场多一张 SVG 流程图，第三场多一张逐帧现画的 Canvas 2D 柱状图。
// 时间全用整数帧：每场开头留 LEAD 帧才出第一块字幕，最后一块字幕在场尾前 TAIL 帧收掉，场尾 FADE 帧淡出到纸色。
// 字体是仓库锁定的子集 fonts/NotoSansSC-var.woff2（OFL，许可见 fonts/LICENSE.md），不靠系统字体；它只有几十个字，文案只能用这些字：
// 换文案要先核对子集里有没有那个字，没有的字浏览器会悄悄换成系统字体。只有文字用墨色 INK，图形都用亮色（测试靠这个分出文字的墨迹）。
import { createTwoDStage, STAGE } from './two-d.js';

export const SIZE = [1920, 1080], FPS = '30/1', FRAMES = 180;
export const PAPER = STAGE.paper, INK = '#1E1B18';
export const LEAD = 9, TAIL = 11, FADE = 4;
const WHITE = '#FFFFFF', RED = '#D9654B', TEAL = '#5FA8A0', GOLD = '#E0B050';
const BARS = [45, 60, 72, 84, 90], GROW = 15;

// 声明了矩形的元素（SVG、Canvas 2D）：实体名到像素矩形。DOM 元素的矩形从排版结果量，不在这里
const BADGE = [120, 76, 232, 188], WIDE = [210, 290, 1710, 590];
export const RECTS = { s1_badge: BADGE, s2_badge: BADGE, s3_badge: BADGE, s2_flow: WIDE, s3_chart: [210, 290, 1710, 650] };

/** 字幕稿。每场：帧号范围 [in, out)、标题、卡片 [小字, 大字]、字幕（at 是出现的帧号，一块顶掉上一块）、别的固定文字 */
const SCRIPT = [
  { title: '概念短片', cards: [['样片', '已送'], ['品牌', '已回复'], ['提醒', '未发']], subs: ['样片已送品牌', '品牌已回复'], more: [] },
  { title: '远洋航距', cards: [['距吴淞口', '还有 120 km']], subs: ['吴淞口还远', '航距 120 km'], more: [['from', '吴淞口'], ['to', '远洋'], ['gap', '120 km']] },
  { title: '回复截止', cards: [['距截止', '还有 5 分钟']], subs: ['回复已有 90%', '提醒已发送'], more: BARS.map((v, i) => [`bar${i}`, `${v}%`]) },
];
export const SCENES = SCRIPT.map((s, i) => {
  const id = `s${i + 1}`, start = i * 60;
  return {
    id, in: start, out: start + 60, title: s.title, cards: s.cards,
    subs: s.subs.map((text, k) => ({ id: `${id}.sub${k}`, text, at: start + LEAD + k * 21 })),
    texts: [
      { id: `${id}.badge`, text: String(i + 1) }, { id: `${id}.title`, text: s.title },
      ...s.cards.flatMap(([k, v], n) => [{ id: `${id}.card${n}.k`, text: k }, { id: `${id}.card${n}.v`, text: v }]),
      ...s.more.map(([key, text]) => ({ id: `${id}.${key}`, text })),
    ],
  };
});

const CSS = `
.scene{position:absolute;left:0;top:0;width:1920px;height:1080px;font-family:"BM Sans";color:${INK};line-height:1.5}
.title{position:absolute;left:270px;top:66px;font-size:84px;font-weight:700;white-space:nowrap}
.row{position:absolute;left:210px;right:210px;display:flex;gap:60px}
.card{flex:1;background:${WHITE};border-radius:20px;overflow:hidden;padding-bottom:70px}
.line{padding-bottom:26px}
.bar{height:16px}
.k{display:block;margin:20px 40px 0;font-size:44px;font-weight:500}
.v{display:block;margin:0 40px;font-size:80px;font-weight:700}
.line .k,.line .v{display:inline-block;margin:14px 0 0 40px;font-size:56px}
.sub{position:absolute;left:0;right:0;top:860px;text-align:center;font-size:56px;font-weight:500}
`;
const text = (id, value, more = '') => `<span data-text-id="${id}" ${more}>${value}</span>`;
const svgText = (id, value, x, y, size) => `<text data-text-id="${id}" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="BM Sans" font-weight="700" font-size="${size}" fill="${INK}">${value}</text>`;
const badge = (s, color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 112 112"><circle cx="56" cy="56" r="50" fill="${PAPER}" stroke="${color}" stroke-width="10"/>${svgText(`${s.id}.badge`, s.texts[0].text, 56, 56, 60)}</svg>`;
const FLOW = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1500 300">
<rect x="0" y="40" width="420" height="220" rx="24" fill="${WHITE}"/><rect x="1080" y="40" width="420" height="220" rx="24" fill="${WHITE}"/>
<rect x="470" y="172" width="520" height="12" fill="${TEAL}"/><path d="M1040 178 L980 142 L980 214 Z" fill="${TEAL}"/>
${svgText('s2.from', '吴淞口', 210, 150, 80)}${svgText('s2.to', '远洋', 1290, 150, 80)}${svgText('s2.gap', '120 km', 730, 110, 56)}</svg>`;

/** 第三场的柱状图：开头 GROW 帧里柱子从 0 长到头，数字跟着柱顶走 */
function chart(scene) {
  return (c, { f, sub, width, height, text: label }) => {
    const grown = Math.min(1, (f + sub - scene.in + 1) / GROW), base = height - 20, slot = width / BARS.length;
    c.fillStyle = GOLD;
    c.fillRect(0, base, width, 6);
    c.font = '700 56px "BM Sans"';
    c.textAlign = 'center';
    BARS.forEach((v, i) => {
      const top = base - (v / 100) * 250 * grown;
      c.fillStyle = i % 2 ? RED : TEAL;
      c.fillRect(i * slot + 60, top, slot - 120, base - top);
      c.fillStyle = INK;
      label(`${scene.id}.bar${i}`, `${v}%`, (i + 0.5) * slot, top - 16);
    });
  };
}

export function build(ctx) {
  const elements = [];
  SCENES.forEach((s, i) => {
    const color = [RED, TEAL, GOLD][i];
    // 这一场的不透明度：场尾 FADE 帧一帧比一帧淡，下一场直接出现
    const shown = (f) => (f < s.in || f >= s.out ? 0 : f < s.out - FADE ? 1 : (s.out - f) / (FADE + 1));
    const cards = s.cards.map(([k, v], n) => `<div class="card ${s.cards.length === 1 ? 'line' : ''}" data-entity="${s.id}_card_${n}"><div class="bar" style="background:${color}"></div>${text(`${s.id}.card${n}.k`, k, 'class="k"')}${text(`${s.id}.card${n}.v`, v, 'class="v"')}</div>`).join('');
    elements.push({ kind: 'svg', name: `${s.id}_badge`, rect: BADGE, svg: badge(s, color), opacity: shown });
    if (i === 1) elements.push({ kind: 'svg', name: 's2_flow', rect: RECTS.s2_flow, svg: FLOW, opacity: shown });
    if (i === 2) elements.push({ kind: 'canvas2d', name: 's3_chart', rect: RECTS.s3_chart, draw: chart(s), opacity: shown });
    elements.push({
      kind: 'dom', opacity: shown,
      html: `<div class="scene"><div class="title" data-entity="${s.id}_title">${text(`${s.id}.title`, s.title)}</div><div class="row" style="top:${[320, 640, 700][i]}px">${cards}</div></div>`,
    });
    s.subs.forEach((sub, k) => {
      const until = s.subs[k + 1]?.at ?? s.out - TAIL;
      elements.push({
        kind: 'dom', opacity: (f) => (f >= sub.at && f < until ? shown(f) : 0),
        html: `<div class="scene"><div class="sub"><span data-entity="${s.id}_sub_${k}" data-text-id="${sub.id}">${sub.text}</span></div></div>`,
      });
    });
  });
  return createTwoDStage(ctx, {
    css: CSS, elements,
    fonts: [{ family: 'BM Sans', url: new URL('../../../fonts/NotoSansSC-var.woff2', import.meta.url).href, weight: '100 900' }],
  });
}
