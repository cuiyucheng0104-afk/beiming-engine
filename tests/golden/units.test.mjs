// 金标准与确定性工具的单元测试（不开浏览器，1 秒内跑完）：node --test tests/golden/units.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { decodePNG, encodePNG, pixelSha256 } from '../../tools/baseline/lib/png.mjs';
import { compareImages, judge, diffHeatmap, downscale, contactSheet } from '../../tools/baseline/lib/metrics.mjs';
import { validateSets, loadSets, setHash, expandSet, resolveTimes, frameId, frameFile } from '../../tools/baseline/lib/sets.mjs';
import { backendOf, isSoftware, deviceSlug } from '../../tools/baseline/lib/platform.mjs';
import { framesDigest, toBaseline, validateManifest, diffFrames } from '../../tools/baseline/lib/manifest.mjs';
import { stripCode, scanFiles } from '../../tools/baseline/lib/scan.mjs';
import { parseArgs, parseSize } from '../../tools/baseline/lib/cli.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const img = (w, h, f) => { const rgb = Buffer.alloc(w * h * 3); for (let i = 0; i < w * h; i++) { const [r, g, b] = f(i % w, Math.floor(i / w)); rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; } return { width: w, height: h, rgb }; };

// 手写一张 RGBA PNG，五行分别用过滤类型 0–4，验证解码器的反过滤
function rgbaPngAllFilters(px, w, h) {
  const bpp = 4, stride = w * bpp, rows = [];
  const raw = r => px.subarray(r * stride, (r + 1) * stride);
  for (let y = 0; y < h; y++) {
    const ft = y % 5, cur = raw(y), prev = y ? raw(y - 1) : Buffer.alloc(stride), out = Buffer.alloc(stride + 1);
    out[0] = ft;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let p;
      if (ft === 0) p = 0; else if (ft === 1) p = a; else if (ft === 2) p = b; else if (ft === 3) p = (a + b) >> 1;
      else { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[x + 1] = (cur[x] - p) & 255;
    }
    rows.push(out);
  }
  const chunk = (t, d) => { const h8 = Buffer.alloc(8); h8.writeUInt32BE(d.length); h8.write(t, 4, 'latin1'); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(Buffer.concat([h8.subarray(4), d]))); return Buffer.concat([h8, d, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('PNG：RGB 编码后能原样解回；RGBA 的五种过滤都解对', () => {
  const a = img(37, 23, (x, y) => [(x * 7) & 255, (y * 11) & 255, (x * y) & 255]);
  const back = decodePNG(encodePNG(a));
  assert.equal(back.width, 37); assert.equal(back.height, 23);
  assert.ok(back.rgb.equals(a.rgb));
  const w = 9, h = 10, px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i >> 3) * 5) & 255;
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  const d = decodePNG(rgbaPngAllFilters(px, w, h));
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) assert.equal(d.rgb[i * 3 + c], px[i * 4 + c], `像素 ${i} 通道 ${c}`);
  assert.throws(() => decodePNG(Buffer.from('not a png')), /不是 PNG/);
});

test('像素哈希只看像素：公式固定，不受 PNG 压缩影响', () => {
  const a = img(4, 2, () => [1, 2, 3]);
  const want = crypto.createHash('sha256').update('RGB8 4x2\n').update(a.rgb).digest('hex');
  assert.equal(pixelSha256(a), want);
  assert.equal(pixelSha256(decodePNG(encodePNG(a))), want);
});

test('逐像素差、PSNR、SSIM 与容差判定', () => {
  const a = img(64, 48, (x, y) => [(x * 4) & 255, (y * 5) & 255, 128]);
  const same = compareImages(a, { ...a, rgb: Buffer.from(a.rgb) });
  assert.equal(same.identical, true); assert.equal(same.ssim, 1); assert.equal(same.psnr, null);
  const b = { ...a, rgb: Buffer.from(a.rgb) };
  b.rgb[0] += 2; b.rgb[300] += 1;                       // 一个像素差 2 级、一个差 1 级
  const s = compareImages(a, b);
  assert.equal(s.identical, false); assert.equal(s.differing, 2); assert.equal(s.maxDiff, 2);
  assert.equal(s.fracAbove1, 1 / (64 * 48)); assert.equal(s.fracAbove2, 0);
  const mse = (4 + 1) / (64 * 48 * 3);
  assert.ok(Math.abs(s.psnr - 10 * Math.log10(65025 / mse)) < 1e-2);
  assert.ok(s.ssim > 0.999 && s.ssim < 1);
  assert.equal(judge(s, { maxFracAbove1: 0.001 }).ok, true);
  assert.equal(judge(s, { maxFracAbove1: 0 }).ok, false);
  const noisy = { ...a, rgb: Buffer.from(a.rgb.map((v, i) => Math.max(0, Math.min(255, v + ((i * 7919) % 41) - 20)))) };
  const n = compareImages(a, noisy);
  assert.ok(n.ssim < 0.95, `加噪后 SSIM 应明显下降，实为 ${n.ssim}`);
  assert.equal(judge(n, { ssimMin: 0.97 }).ok, false);
  assert.equal(compareImages(a, img(32, 48, () => [0, 0, 0])).sizeMismatch, true);
  const heat = diffHeatmap(a, b);
  assert.deepEqual([heat.rgb[0], heat.rgb[1] < 235], [255, true]);
  assert.equal(downscale(a, 16).width, 16);
  const sheet = contactSheet([[a, b, heat]], { tileW: 32 });
  assert.ok(sheet.width >= 96 && sheet.height >= 24);
});

test('仓库里的 sets.json 合法，三套金标准帧数与约定一致', () => {
  const sets = loadSets(`${ROOT}tools/baseline/sets.json`);
  const count = name => expandSet(sets, name).reduce((s, g) => s + (Array.isArray(g.times) ? g.times.length : g.times.count || g.times.uniformMid || g.times.frames.length), 0);
  assert.equal(count('beiming-core'), 44);   // 40 帧 + 原生 4K 4 帧
  assert.equal(count('lab'), 60);            // 10 页 × 6
  assert.equal(count('templates'), 12);
  const core = expandSet(sets, 'beiming-core');
  const t = resolveTimes(core[0].times, 10, 24);
  assert.equal(t[0].t, 0.05); assert.equal(t[39].t, 9.8); assert.equal(t[1].t, 0.3);
  assert.deepEqual(core[1].times, [1.6, 4.0, 7.6, 9.9]);
  assert.deepEqual(resolveTimes({ uniformMid: 6 }, 4, 24).map(e => e.t), [0.333333, 1, 1.666667, 2.333333, 3, 3.666667]);
  assert.deepEqual(resolveTimes({ frames: [72] }, 10, 24), [{ t: 3, f: 72 }]);
});

test('集合哈希：改帧会变、改说明不变；结构错误给出中文原因', () => {
  const sets = loadSets(`${ROOT}tools/baseline/sets.json`);
  const h = setHash(sets, 'lab');
  const s2 = structuredClone(sets); s2.sets.lab.description = '换个说明';
  assert.equal(setHash(s2, 'lab'), h);
  s2.sets.lab.shots[0].times = { uniformMid: 5 };
  assert.notEqual(setHash(s2, 'lab'), h);
  const bad = structuredClone(sets); bad.sets.x = { shots: [{ page: 'nope', size: [1921, 1080], times: {} }] };
  const errs = validateSets(bad).join('\n');
  assert.match(errs, /不存在的页面 nope/); assert.match(errs, /size/); assert.match(errs, /times/);
});

test('帧编号与文件名：可读、可移植、不撞名', () => {
  const g = { pageId: 'lab:kun', query: 'test=kun', clip: null };
  assert.equal(frameId(g, 1920, 1040, { t: 1 / 3 }), 'lab:kun?test=kun@1920x1040#t=0.3333');
  assert.equal(frameId({ pageId: 'film', query: '', clip: [1, 2, 3, 4] }, 3840, 2080, { t: 7.6, f: 182 }), 'film@3840x2080[1,2,3,4]#f=182');
  const a = frameFile('lab:kun?test=kun@1920x1040#t=0.3333'), b = frameFile('lab:kun?test=kun@1920x1040#t=0.3334');
  assert.match(a, /^[A-Za-z0-9._=-]+\.png$/); assert.notEqual(a, b);
});

test('平台键：从 WebGL 渲染器串认出后端与设备', () => {
  const metal = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)';
  const ss = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
  const vk = 'ANGLE (NVIDIA, Vulkan 1.4.312 (NVIDIA GeForce RTX 5090 (0x00002B85)), NVIDIA-576.88.0.0)';
  const dx = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)';
  assert.deepEqual([backendOf(metal), backendOf(ss), backendOf(vk), backendOf(dx), backendOf('llvmpipe (LLVM 15.0.7, 256 bits)')], ['metal', 'swiftshader', 'vulkan', 'd3d11', 'llvmpipe']);
  assert.deepEqual([deviceSlug(metal), deviceSlug(ss), deviceSlug(vk), deviceSlug(dx)], ['apple-m5-pro', 'swiftshader-device-subzero', 'nvidia-geforce-rtx-5090', 'nvidia-geforce-rtx-5090']);
  assert.equal(isSoftware('swiftshader'), true); assert.equal(isSoftware('metal'), false);
});

test('基线清单：摘要可复算，手改帧会被发现，审批字段必填', () => {
  const cap = {
    set: 'fixtures', setHash: 'a'.repeat(64), platformKey: 'darwin-metal', device: 'apple-m5-pro', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, x)',
    browser: '153.0.8010.12', env: { os: 'darwin' }, source: { commit: 'b'.repeat(40), dirty: false }, capturedAt: '2026-11-10T00:00:00Z',
    frames: [{ id: 'p@2x2#t=0.0000', page: 'p', t: 0, w: 2, h: 2, width: 2, height: 2, pixelSha256: 'c'.repeat(64), pngSha256: 'd'.repeat(64), bytes: 9, file: 'frames/x.png' }],
  };
  const m = toBaseline(cap, { by: '集成负责人', reason: '首次建立', commit: 'b'.repeat(40), at: '2026-11-10T00:00:00Z' });
  assert.deepEqual(validateManifest(m), []);
  assert.equal(m.frames[0].file, undefined, '清单里不能有本机路径');
  assert.equal(m.framesDigest, framesDigest(m.frames));
  const tampered = structuredClone(m); tampered.frames[0].pixelSha256 = 'e'.repeat(64);
  assert.match(validateManifest(tampered).join(), /framesDigest/);
  const noApproval = structuredClone(m); delete noApproval.approval.by;
  assert.match(validateManifest(noApproval).join(), /approval/);
  const dirty = structuredClone(m); dirty.source.dirty = true;
  assert.match(validateManifest(dirty).join(), /已提交/);
  assert.deepEqual(diffFrames([{ id: 'a', pixelSha256: '1' }, { id: 'b', pixelSha256: '2' }], [{ id: 'b', pixelSha256: '3' }, { id: 'c', pixelSha256: '4' }]),
    { added: ['c'], removed: ['a'], changed: ['b'] });
});

test('静态扫描：只认代码里的不确定 API，注释与字符串不算，可行内豁免或登记', () => {
  const src = [
    '// 不用 Math.random',
    "const s = 'Date.now() 只是字符串';",
    'const a = Math.random();',
    'const t0 = performance.now(); // determinism-ok: 计时',
    'const d = new Date();',
    'const k = `${Date.now()}`;',
  ].join('\n');
  const code = stripCode(src);
  assert.equal(code.split('\n').length, 6);
  assert.ok(!/Math\.random/.test(code.split('\n')[0]) && !/Date\.now/.test(code.split('\n')[1]));
  const dir = fs.mkdtempSync(`${ROOT}out/.scan-test-`);
  try {
    fs.writeFileSync(`${dir}/a.js`, src);
    const rel = dir.slice(ROOT.length) + '/a.js';
    const r = scanFiles(ROOT, [rel], [{ file: rel, api: 'new Date', re: /new Date/, reason: '测试登记' }]);
    assert.deepEqual(r.findings.map(f => [f.line, f.api, f.allowed]), [[3, 'Math.random', false], [4, 'performance.now', true], [5, 'new Date', true], [6, 'Date.now', false]]);
    assert.equal(r.errors.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('严格参数：未知参数、缺值、重复单值参数都是用法错误', () => {
  const spec = { flags: { '--set': 'list', '--jobs': 'int', '--json': 'bool' }, positionals: [0, 1] };
  assert.deepEqual(parseArgs(['--set', 'a,b', '--set=c', 'x', '--jobs', '3'], spec).opts.set, ['a', 'b', 'c']);
  assert.throws(() => parseArgs(['--nope'], spec), e => e.exitCode === 2);
  assert.throws(() => parseArgs(['--jobs'], spec), e => e.exitCode === 2);
  assert.throws(() => parseArgs(['--jobs', '2', '--jobs', '3'], spec), e => e.exitCode === 2);
  assert.throws(() => parseArgs(['--jobs', 'x'], spec), e => e.exitCode === 2);
  assert.throws(() => parseArgs(['a', 'b'], spec), e => e.exitCode === 2);
  assert.throws(() => parseArgs(['--json=1'], spec), e => e.exitCode === 2);
  assert.deepEqual(parseSize('3840x2080'), [3840, 2080]);
  assert.throws(() => parseSize('1921x1080'), e => e.exitCode === 2);
});

test('页面快照：只导出指定路径，字节与提交里一致，不建 worktree', async t => {
  const { isGitRepo, exportPaths, git } = await import('../../tools/baseline/lib/git.mjs');
  if (!isGitRepo(ROOT)) return t.skip('不在 git 工作树里');
  const dir = fs.mkdtempSync(`${ROOT}out/.snap-test-`);
  const before = git(['worktree', 'list', '--porcelain'], { cwd: ROOT });
  try {
    const r = exportPaths(ROOT, 'HEAD', ['tests/golden/fixtures', 'tools/baseline/sets.json'], dir);
    assert.ok(r.files >= 4, `至少导出 3 个夹具页与 sets.json，实际 ${r.files}`);
    for (const f of ['tests/golden/fixtures/pure/index.html', 'tools/baseline/sets.json']) {
      const want = execFileSync('git', ['cat-file', 'blob', `HEAD:${f}`], { cwd: ROOT });   // 原字节，不经 trim
      const got = fs.readFileSync(`${dir}/${f}`);
      assert.equal(crypto.createHash('sha256').update(got).digest('hex'), crypto.createHash('sha256').update(want).digest('hex'), f);
    }
    assert.equal(fs.existsSync(`${dir}/engine`), false, '没要的路径不导出');
    assert.equal(git(['worktree', 'list', '--porcelain'], { cwd: ROOT }), before, '不改仓库的 worktree 列表');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
