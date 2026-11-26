import assert from 'node:assert/strict';
import test from 'node:test';
import { checkEmbedded, isFilmEntry } from '../../tools/standalone/build.mjs';

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
