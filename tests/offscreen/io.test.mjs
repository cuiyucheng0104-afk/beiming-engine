// M7 T1 测试：同源跨端底座 io.mjs、零顶层 node:* 静态导入守卫，以及 PNG 8/16 位解码逐字节一致性。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  IS_NODE, REPO_URL, joinRef, readBytes, readJson,
  decodeRgbaPng, decodeRgbaPngSync, decodeLayerPng, decodeLayerPngSync,
  rangeCoversAny,
} from '../../engine/offscreen/io.mjs';
import { decodePng as refDecodePlatePng, encodePng } from '../../tools/plates/png.mjs';
import { decodePng as refDecodeLayerPng } from '../../engine/look/layers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function make16BitGrayPng(width, height, u16Values) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crcTab = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = b => {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = crcTab[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const mkChunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 2;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const v = u16Values[y * width + x];
      const o = y * (stride + 1) + 1 + x * 2;
      raw[o] = (v >>> 8) & 255;
      raw[o + 1] = v & 255;
    }
  }
  return Buffer.concat([sig, mkChunk('IHDR', ihdr), mkChunk('IDAT', zlib.deflateSync(raw)), mkChunk('IEND', Buffer.alloc(0))]);
}

test('同源模块树顶层不含任何静态 node:* 或 @napi-rs/canvas 导入', () => {
  const files = [
    'engine/offscreen/io.mjs',
    'engine/offscreen/film.mjs',
    'engine/offscreen/c2d.mjs',
    'engine/offscreen/paper.mjs',
    'engine/offscreen/preview.js',
    'engine/offscreen/bridge.mjs',
    'films/chendu/offscreen.mjs',
    ...fs.readdirSync(path.join(ROOT, 'engine/offscreen/tsl')).filter(f => f.endsWith('.js')).map(f => `engine/offscreen/tsl/${f}`),
  ];
  const staticNodeImport = /^\s*import\s+(?:[^'"]+from\s+)?['"](?:node:|@napi-rs\/canvas)/m;
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(staticNodeImport.test(src), false, `${rel} 不得含顶层静态 node:* 或 @napi-rs/canvas 导入`);
  }
});

test('io.mjs 路径与 JSON/字节读取：URL、仓库根路径与相对路径结果一致', async () => {
  assert.equal(IS_NODE, true);
  const byRel = await readJson('films/chendu/film.json');
  const byRoot = await readJson('/films/chendu/film.json');
  const byRootWithBase = await readJson('/films/chendu/film.json', import.meta.url);
  const byUrl = await readJson(pathToFileURL(path.join(ROOT, 'films/chendu/film.json')));
  assert.equal(byRel.id, 'chendu');
  assert.deepEqual(byRoot, byRel);
  assert.deepEqual(byRootWithBase, byRel);
  assert.deepEqual(byUrl, byRel);

  const subRef = joinRef('assets/plates', 'paper.png');
  const b1 = await readBytes(subRef);
  const b2 = await readBytes(new URL('assets/plates/paper.png', REPO_URL));
  assert.equal(b1.byteLength, b2.byteLength);
});

test('decodeRgbaPng 与 tools/plates/png.mjs 逐字节一致，坏文件抛错', async () => {
  const paperBytes = await readBytes('assets/plates/paper.png');
  const ref = refDecodePlatePng(Buffer.from(paperBytes));
  const gotSync = decodeRgbaPngSync(paperBytes);
  const gotAsync = await decodeRgbaPng(paperBytes);
  assert.equal(gotSync.width, ref.width);
  assert.equal(gotSync.height, ref.height);
  assert.deepEqual(gotSync.data, ref.data);
  assert.deepEqual(gotAsync.data, ref.data);

  const syn = encodePng({ width: 3, height: 2, channels: 3, data: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180]) });
  assert.deepEqual((await decodeRgbaPng(syn)).data, refDecodePlatePng(syn).data);
  await assert.rejects(() => decodeRgbaPng(new Uint8Array([1, 2, 3])), /不是 PNG/);
});

test('decodeLayerPng 保留完整 16 位 Uint16Array 精度并与 engine/look/layers.js 一致', async () => {
  const vals = new Uint16Array([0x0000, 0x0102, 0x1234, 0x7fff, 0xabcd, 0xffff]);
  const png = make16BitGrayPng(3, 2, vals);
  const ref = await refDecodeLayerPng(png);
  const gotS = decodeLayerPngSync(png);
  const gotA = await decodeLayerPng(png);
  assert.equal(gotA.depth, 16);
  assert.equal(gotA.channels, 1);
  assert.ok(gotA.data instanceof Uint16Array);
  assert.deepEqual(gotA.data, vals);
  assert.deepEqual(gotS.data, ref.data);
});

test('rangeCoversAny 准确匹配单码位与区间', () => {
  const cps = [0x6668, 0x6e21]; // 晨 渡
  assert.equal(rangeCoversAny('U+4E00-9FFF', cps), true);
  assert.equal(rangeCoversAny('U+0020-007F, U+6668', cps), true);
  assert.equal(rangeCoversAny('U+0020-007F', cps), false);
  assert.equal(rangeCoversAny('U+0020-007F', null), true);
});
