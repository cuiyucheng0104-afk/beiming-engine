// three 页面镜头：把 overlay.anchored 的直通 RGBA 画进透明画布，实体坐标只来自当前三维帧的 meta。
import { create } from '../cards/two-d/overlay-anchored/index.mjs';
import { createTwoDStage } from '../sources/three/two-d.js';

export function createFrameOverlay({ size, frames }, meta, params) {
  if (!Array.isArray(meta) || meta.length !== frames || frames < 1) {
    throw Object.assign(new Error('需要逐帧提供 meta/0.1，按镜头局部帧号排列'), { code: 'usage.bad-argument' });
  }
  for (let f = 0; f < frames; f++) {
    if (meta[f]?.format !== 'meta/0.1' || meta[f].shotFrame !== f || !Array.isArray(meta[f].size)
        || meta[f].size.length !== 2 || meta[f].size[0] !== size?.[0] || meta[f].size[1] !== size?.[1]) {
      throw Object.assign(new Error(`第 ${f} 帧的 meta/0.1、局部帧号或画幅不匹配`), { code: 'usage.bad-argument' });
    }
  }
  return create({ size, shot: { frames }, frames: meta }, params);
}

export async function build(ctx) {
  const { size, frames } = ctx;
  const { meta, overlay } = ctx.params;
  const callouts = createFrameOverlay({ size, frames }, meta, overlay);
  const [width, height] = size;
  const rgba = new ImageData(width, height);
  const stage = await createTwoDStage(ctx, {
    elements: [{
      kind: 'canvas2d', name: 'callouts', rect: [0, 0, width, height],
      draw(c, { f }) {
        rgba.data.fill(0);
        callouts.object.draw(f, rgba.data);
        c.putImageData(rgba, 0, 0);
      },
    }],
  });
  stage.scene.background = null;
  return { ...stage, meta: (f) => callouts.meta(f) };
}
