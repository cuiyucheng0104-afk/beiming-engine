// 照规格逐像素（过像素中心）求交，写出规格编号图：每像素一个字节，0 是背景。给 Blender 读数做对照。
// 用法：node specmask.mjs <scene.json> <输出.bin> <时刻 t，帧加子帧>
import { readFileSync, writeFileSync } from 'node:fs';
import { raycast } from '../../check.mjs';

const [scenePath, outPath, t] = process.argv.slice(2);
const s = JSON.parse(readFileSync(scenePath, 'utf8')), { widthPx: W, heightPx: H } = s.camera;
const idx = Object.fromEntries(s.objects.map(o => [o.id, o.idIndex]));
const buf = new Uint8Array(W * H);
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const h = raycast(s, [i + 0.5, j + 0.5], Number(t))[0];
  buf[j * W + i] = h ? idx[h.objectId] : 0;
}
writeFileSync(outPath, buf);
