// B 路线资产桥回归（审查 CODE-16 ③、R01、R02、R08）：把例片的鲲与渡船重新导出到临时目录（不碰 examples/raea/media），
// 与 examples/raea/expected-assets.json 比对结构摘要（任何平台）与 sha256（登记过的平台）；核对眼睑睑缘一圈是墨线色（R01）、
// 报告记录了实际请求过的全部源文件与 three / Playwright / Chromium 版本（R08）、正式路径上没有残留 .part（R02）。
// 需要 playwright-core 的无头 Chromium（npm run setup）；没有时跳过。约 6–10 秒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformKey } from '../../engine/native/runtime.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXAMPLE = join(ROOT, 'examples/raea');

let chromiumOk = false;
try {
  const { chromium } = await import('playwright-core');
  chromiumOk = existsSync(process.env.BEIMING_CHROME || chromium.executablePath());
} catch { chromiumOk = false; }

test('例片资产桥：重导出与基准一致；睑缘是墨线色；报告完整；没有 .part 残留', { skip: !chromiumOk && '没有 playwright-core 的 Chromium（npm run setup）', timeout: 300000 }, async () => {
  const { exportModels } = await import('../../engine/native/bridge/export.mjs');
  const film = JSON.parse(readFileSync(join(EXAMPLE, 'film.json'), 'utf8'));
  const expected = JSON.parse(readFileSync(join(EXAMPLE, 'expected-assets.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'bne-bridge-'));
  try {
    const models = film.native.models.filter(m => m.module || m.recipe).map(m => ({ ...m, preview: undefined }));
    const reports = await exportModels(models, { baseDir: EXAMPLE, outDir: dir, log: () => {}, timeoutMs: 240000 });
    assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.part')), [], '不能留下 .part');
    for (const m of models) {
      const r = reports[m.to], want = expected.assets[m.to], sv = r.structuralValidation;
      assert.ok(want, `expected-assets.json 里没有 ${m.to}`);
      const got = { bytes: r.bytes, triangles: sv.sceneTriangles, vertices: sv.vertices, nodes: sv.nodes, materials: sv.materials, embeddedTextures: sv.embeddedTextures,
        skinnedMeshes: sv.skinnedMeshes, morphMeshes: sv.morphMeshes, clips: sv.animations.map(a => ({ name: a.name, duration: a.duration, channels: a.channels })) };
      const { sha256, ...shape } = want;
      assert.deepEqual(got, shape, `${m.to} 的结构与基准不同`);
      const plat = platformKey();
      if (sha256[plat]) assert.equal(r.sha256, sha256[plat], `${m.to} 在 ${plat} 上的字节与基准不同`);
      else console.log(`# ${m.to}：${plat} 没有登记哈希，本次 ${r.sha256}`);
      // R08：依赖记录来自实际请求，不写死
      assert.ok(Object.keys(r.sourceHashes).length >= 5, '源文件哈希太少');
      assert.ok(r.runtime.three.startsWith('r') && r.runtime.playwright && r.runtime.browser);
    }
    // R01：四片眼睑壳的睑缘 texel 都是墨线色，下睑没有上睑专用的第二道褶线
    const rim = reports['kun.glb'].roundTrip.eyelidRimInk;
    assert.equal(Object.keys(rim.shells).length, 4);
    for (const [name, s] of Object.entries(rim.shells)) {
      assert.ok(s.ratio < expected.eyelidRimInk.maxRatio, `${name} 睑缘比值 ${s.ratio}`);
      assert.ok(Math.abs(s.rimUV_v - 0.5) < 1e-3, `${name} 睑缘应在整球参数的赤道 v = 0.5，实际 ${s.rimUV_v}`);
      if (name.includes('lower')) assert.ok(s.fold2Ratio > 0.6, `${name} 出现了上睑的褶线`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
