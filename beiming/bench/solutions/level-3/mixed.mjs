// X7 的离线测量路径：同一模块几何在两个机位投影，经主线透明页绘制、合成，再量最终像素。
// 在 display RGB 阶段取样，不声称这里运行了 Cycles 或封装了视频文件。
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three-webgpu';
import { measureEntity, placeAnchors } from '../../../host/page/measure.js';
import { measureOverlayAnchorCenter } from '../../../comp/mixed.mjs';
import { stitchGraph } from '../../../comp/stitch.mjs';
import { createFrameOverlay } from '../../../comp/x7-overlay.shot.js';
import { build as slateShot } from './31-1/slate.shot.js';

const rgb = (hex) => Buffer.from(hex.replace(/^#/, ''), 'hex');

function overlayBytes(params) {
  return Buffer.concat([
    readFileSync(path.resolve(import.meta.dirname, '../../../comp/x7-overlay.shot.js')),
    readFileSync(path.resolve(import.meta.dirname, '../../../cards/two-d/overlay-anchored/index.mjs')),
    Buffer.from(JSON.stringify(params)),
  ]);
}

function vertices({ center, size }) {
  return Array.from({ length: 8 }, (_, i) => center.map((v, axis) => v + ((i >> axis) & 1 ? 0.5 : -0.5) * size[axis]));
}

function projectModule(p, size, count, x) {
  const camera = new THREE.PerspectiveCamera(p.fovYDeg, size[0] / size[1], 0.1, 100);
  const geometry = p.parts.map(vertices);
  return Array.from({ length: count }, (_, f) => {
    camera.position.set(x + p.travelX * f / (count - 1), p.cameraY, p.cameraZ);
    camera.updateMatrixWorld();
    const view = camera.matrixWorldInverse.elements, proj = camera.projectionMatrix.elements;
    const parts = geometry.map((corners) => measureEntity(view, proj, size, corners).bbox2d);
    const bbox2d = measureEntity(view, proj, size, geometry.flat()).bbox2d;
    const anchors = placeAnchors(view, proj, size, [['module#pin', p.anchor]], ['module']).module;
    const meta = { format: 'meta/0.1', size, shotFrame: f,
      entities: [{ id: 1, name: 'module', class: 'part', role: 'hero', visible: 1, bbox2d, anchors }] };
    return { meta, parts };
  });
}

function rect(rgbFrame, [w, h], bounds, color) {
  const [x0, y0, x1, y1] = bounds.map((v, i) => Math.max(0, Math.min(i % 2 ? h : w, Math.ceil(v - 0.5))));
  for (let y = y0; y < y1; y++) rgbFrame.fill(color, (y * w + x0) * 3, (y * w + x1) * 3);
}

// 主线卡返回刚绘制的 bbox：只需在该区域按直通 alpha 合成；外面全透明。
function composite(frame, overlay, [w, h], bounds) {
  const [x0, y0, x1, y1] = bounds.map((v, i) => Math.max(0, Math.min(i % 2 ? h : w, i < 2 ? Math.floor(v) : Math.ceil(v))));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * w + x, a = overlay[4 * i + 3] / 255;
    for (let c = 0; c < 3; c++) frame[3 * i + c] = Math.round(frame[3 * i + c] * (1 - a) + overlay[4 * i + c] * a);
  }
}

function take(graph, film, cameraX, card) {
  const { size } = graph, [module, slate] = graph.shots, p = film.shots[0].params;
  const projected = projectModule(p, size, module.count, cameraX);
  const layer = card && createFrameOverlay({ size, frames: module.count }, projected.map(({ meta }) => meta), card.params);
  const rgba = Buffer.alloc(size[0] * size[1] * 4), frame = Buffer.alloc(size[0] * size[1] * 3);
  const bg = rgb(p.background), colors = p.parts.map((part) => rgb(part.color));
  const slateScene = slateShot({ THREE, size, params: film.shots[1].params });
  const bg2 = rgb(slateScene.scene.background.getHexString());
  const anchors = [], centers = [], boxes = [], corners = [];
  for (const segment of [module, slate]) for (let f = 0; f < segment.count; f++) {
    frame.fill(segment === module ? bg : bg2);
    if (segment === module) {
      const { meta, parts } = projected[f];
      parts.forEach((box, i) => rect(frame, size, box, colors[i]));
      if (layer) {
        rgba.fill(0);
        composite(frame, rgba, size, layer.object.draw(f, rgba));
      }
      const entity = meta.entities[0], [x, y] = entity.anchors.pin.screen;
      anchors.push([x, y]);
      boxes.push(entity.bbox2d);
      centers.push(measureOverlayAnchorCenter(frame, { size,
        roi: [Math.floor(x) - 10, Math.floor(y) - 10, Math.ceil(x) + 10, Math.ceil(y) + 10] }));
    }
    corners.push(Array.from(frame.subarray(0, 3)));
  }
  layer?.dispose();
  slateScene.dispose();
  return { anchors, centers, boxes, corners };
}

export function buildMixedReading(question, film, disabled = null) {
  if (question.id !== '31-1' || film.exam !== question.id) throw new Error('混用工程与题号不一致');
  const [first, second] = film.shots;
  const card = first.cards.find(({ use }) => use === 'overlay.anchored@1');
  const active = disabled === 'overlay.anchored' ? null : card;
  const delay = disabled === 'cut' ? 1 : 0;
  // 离线投影底图已经是显示编码；按主线硬切图整理、检查两段紧密相接的帧域。
  const shots = [{ ...first, out: first.out + delay, colorRef: 'display', pattern: 'module.%06d.png',
    ...(active && { overlay: { pattern: 'marks.%06d.png' } }) },
  { ...second, in: second.in + delay, pattern: 'slate.%06d.png' }];
  const graph = stitchGraph({ ...film.output, shots, checkFiles: false,
    transitions: film.transitions.map((t) => ({ ...t, at: t.at + delay })) });
  const original = overlayBytes(card.params);
  const takes = first.params.cameraX.map((x) => {
    const obs = take(graph, film, x, active);
    const bytes = overlayBytes(card.params);
    if (!original.equals(bytes)) throw new Error('双机位间二维代码或标注配置发生改变');
    return { overlayKey: createHash('sha256').update(bytes).digest('hex').slice(0, 24), ...obs };
  });
  const output = { size: graph.size, fps: `${graph.fps.num}/${graph.fps.den}`, frames: takes[0].corners.length, audio: film.audio.mode };
  return { output, takes };
}
