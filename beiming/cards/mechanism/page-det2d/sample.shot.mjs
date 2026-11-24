// 三个合成讲解场景，都是 30 fps、300 帧。只有文字用深墨色；色片左上角与各场字幕区域分开量。
// 这份镜头只为观测，和机制实现分开。模块经真实页面宿主装载。
/* global window, document, getComputedStyle, fetch */
import { FONT, stagePlan } from './config.mjs';
import { mountStage } from './three.mjs';

const stripes = [
  [1536, 264, '#404040'], [1440, 300, '#687878'], [1344, 348, '#806050'],
];

async function probe(ctx, page, stage) {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const refuses = (f) => { try { f(); } catch (e) { return e.code === 'usage.bad-argument'; } return false; };
  for (const schedule of ['setTimeout', 'setInterval', 'requestAnimationFrame']) check(refuses(() => window[schedule](() => {})), `${schedule} 活跃`);
  check(refuses(() => document.body.animate([], 100)), 'Web Animation 活跃');
  const css = document.createElement('style'), el = document.createElement('span');
  css.textContent = '@keyframes detprobe { to { opacity: 0 } }';
  el.style.animation = 'detprobe 1s infinite'; document.head.append(css); document.body.append(el);
  try { check(getComputedStyle(el).animationName === 'none', 'CSS 动画活跃'); } finally { el.remove(); css.remove(); }
  // 请求一个确实存在的本机文件。连它都不许从网络再取，无需向外部发送任何探针请求。
  const blocked = await fetch(FONT.path).then(() => false, () => true);
  check(blocked, '联网策略没有生效');
  const face = [...document.fonts].find((f) => f.family === FONT.family);
  check(face?.status === 'loaded', '没有已就绪的本地内联字体');
  document.fonts.delete(face);
  try { check(refuses(() => page.apply(0, 0)), '没有锁定字体仍能出帧'); } finally { document.fonts.add(face); await document.fonts.ready; }
  check(ctx.renderer.getContext().drawingBufferColorSpace === 'srgb' && !ctx.renderer.getContext().getContextAttributes().antialias, '颜色或 MSAA 未锁');
  check(Object.values(stage.entities).every((mesh) => mesh.material.map.magFilter === ctx.THREE.NearestFilter), '贴图插值未锁');
  check(Function.prototype.toString.call(window.Proxy).includes('[native code]'), '全局 Proxy 被替换');
  let getterHits = 0;
  const withGetter = Object.defineProperty({ name: 'bad', rect: [0, 0, 16, 16], fill: '#112233' }, 'text', {
    enumerable: true, get() { getterHits++; return 'AI'; },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  check(refuses(() => stagePlan(ctx, [withGetter])) && refuses(() => stagePlan(ctx, [revoked.proxy])) && refuses(() => stagePlan(ctx, Array(1))) && getterHits === 0, '页面声明未拦住访问器、空槽或已撤销代理');
}

export async function build(ctx) {
  const page = ctx.cards.use('page');
  const panels = stripes.flatMap(([w, h, fill], i) => {
    const from = i * 300, until = from + 300;
    return [
      { name: `tile${i}`, rect: [192, 216, 192 + w, 216 + h], fill, from, until, fade: i < 2 ? 4 : 0 },
      { name: `sub${i}`, rect: [384, 744, 1008, 900], fill: '#F4F0E9', text: `AI ${i + 1}`, fontPx: 120, from: from + 15, until: until - 15 },
    ];
  });
  const stage = await mountStage(ctx, page, ctx.params.panels ?? panels);
  if (ctx.params.probe) await probe(ctx, page, stage);
  return stage;
}
