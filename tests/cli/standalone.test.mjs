import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { checkEmbedded, isFilmEntry, verifyAssetIntegrity } from '../../tools/standalone/build.mjs';

test('Vite 的 POSIX 模块 ID 匹配 Windows 入口，不匹配同名的别处入口', () => {
  const entry = String.raw`示例工作区\演示\film\main.js`;
  assert.ok(isFilmEntry('示例工作区/演示/film/main.js', entry));
  assert.ok(!isFilmEntry('示例工作区/演示/other/main.js', entry));
});

test('没有注入资源、缺少任一字体或缺底板，都不能交付离线包', () => {
  const embedded = { manifest: { fonts: [{file:'x.woff2'}] }, 'fonts/x.woff2':'data:font/woff2;base64,d09GMg==', 'plates/paper.webp':'data:image/webp;base64,UklGRg==' };
  const parts = ['window.__WX_ASSETS=', embedded['fonts/x.woff2'], embedded['plates/paper.webp']];
  checkEmbedded(parts.join(' '), embedded);
  for (const required of parts) assert.throws(() => checkEmbedded(parts.filter(x => x !== required).join(' '), embedded), { code:'contract.assets' });
});

test('固定哈希校验：音频与许可文件字节数或 SHA-256 不符时直接拒包', () => {
  const data = Buffer.from('beiming-audio-bytes');
  const sha256 = createHash('sha256').update(data).digest('hex');
  assert.equal(verifyAssetIntegrity(data, { bytes: data.length, sha256 }, 'audio/test.ogg'), sha256);
  assert.throws(() => verifyAssetIntegrity(data, { bytes: data.length + 1, sha256 }, 'audio/test.ogg'), { code: 'contract.assets' });
  assert.throws(() => verifyAssetIntegrity(data, { bytes: data.length, sha256: '0'.repeat(64) }, 'audio/test.ogg'), { code: 'contract.assets' });
});
