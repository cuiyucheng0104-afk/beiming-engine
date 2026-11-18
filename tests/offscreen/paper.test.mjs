// 图片纸纹加载（engine/offscreen/paper.mjs）：解码成行序自上而下的 RGBA DataTexture、中性点是 Rec.709 亮度均值、读不了时报错带路径。不需要 GPU。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { loadPaper } from '../../engine/offscreen/paper.mjs';
import { encodePng } from '../../tools/plates/png.mjs';

test('loadPaper：行序、中性点、平铺与过滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-'));
  try {
    // 2×2：上一行纯红、纯绿，下一行纯蓝、白
    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const f = join(dir, 'p.png');
    writeFileSync(f, encodePng({ width: 2, height: 2, data }));
    const p = loadPaper(THREE, f);
    assert.deepEqual([p.width, p.height], [2, 2]);
    assert.deepEqual(Array.from(p.tex.image.data), Array.from(data));   // 第 0 行是图片的上一行
    assert.ok(Math.abs(p.mid - (0.2126 + 0.7152 + 0.0722 + 1) / 4) < 1e-9);
    assert.equal(p.tex.wrapS, THREE.RepeatWrapping);
    assert.equal(p.tex.minFilter, THREE.LinearFilter);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadPaper：风格锁定的 assets/plates/paper.png 中性点在 0.5 附近', () => {
  const p = loadPaper(THREE, fileURLToPath(new URL('../../assets/plates/paper.png', import.meta.url)));
  assert.deepEqual([p.width, p.height], [1024, 1024]);
  assert.ok(Math.abs(p.mid - 0.5) < 0.02, `mid ${p.mid}`);
});

test('loadPaper：文件不存在或不是 PNG 时抛 contract.paper，message 带路径', () => {
  for (const f of ['/nonexistent/paper.png', fileURLToPath(import.meta.url)]) {
    assert.throws(() => loadPaper(THREE, f), e => e.code === 'contract.paper' && e.message.includes(f));
  }
});
