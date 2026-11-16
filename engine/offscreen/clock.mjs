// 北冥引擎 · 离屏出片 · 确定性帧时钟：替 three.js 的 requestAnimationFrame，由出片宿主按帧号手动推进。
// three 只在动画循环的回调里推进节点帧号，pass(scene, camera) 按帧号去重：帧号不动，场景只渲第一次。Node 里没有浏览器的帧循环，
// 所以宿主把 three 登记的回调存下来，每出一帧调用一次（与浏览器「每帧一次」的节奏相同），时刻由帧号算出，不读系统时钟。
//   createFrameClock() → { self, tick(ms), pending() }
//     self       装成 globalThis.self（three 在构造渲染器时读它）：requestAnimationFrame(cb) → id、cancelAnimationFrame(id)
//     tick(ms)   调用此刻已登记的全部回调（参数是 ms），每个只调一次；回调里新登记的留到下一次 tick
//     pending()  还没被调用的回调数
export function createFrameClock() {
  const queue = new Map();
  let seq = 0;
  const self = {
    requestAnimationFrame: cb => { queue.set(++seq, cb); return seq; },
    cancelAnimationFrame: id => { queue.delete(id); },
  };
  return {
    self,
    tick(ms) {
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) cb(ms);
    },
    pending: () => queue.size,
  };
}
