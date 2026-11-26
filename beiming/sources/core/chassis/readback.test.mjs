// 读回一致性：同一帧着色器写进输出缓冲的原值，和 render-pack --passes 落盘的通道文件逐位比。调试开关 BEIMING_CORE_FILM_DUMP
// 让 core-render 把读回的输出缓冲原样写出来（另带全局参数），测试照读回的写法（gpu.rs 的 Gpu::render 与 main.rs 的
// write_passes）在 JS 里从原值重算每个通道：累加的通道除以样本数（32 位浮点的除法，JS 里双精度除完再取整到 32 位，结果相同），
// 辅助的几格原样，降噪法线按相机的右、上、前三个轴逐个点乘（32 位，次序同 glam 的 Vec3::dot）。motion 不是着色器写的：
// 它由缓冲里辅助样本的命中点在宿主一侧求，这里拿缓冲里的命中点照输出通道契约 5.6 在双精度里重算，差不超过 1e-6 像素。
// 负对照：每个通道文件改一位，必须被查出来；拿另一份缓冲去对，必须对不上。
// 要渲染程序与显卡：BEIMING_CHASSIS_E2E=1 时现编、渲不出来算失败；否则只用编好的那份，没有或渲不出来就跳过。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { OUT, PRESETS, buildRenderer, sourceKey } from './build.mjs';
import { camera, f32s, inverse, mul, objects, point, screen } from './moving.mjs';
import { movingPack, translate, writePack } from './scenepack.mjs';

const E2E = process.env.BEIMING_CHASSIS_E2E === '1';
const EXE = process.platform === 'win32' ? '.exe' : '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-readback-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const [W, H] = [96, 54];
// 输出缓冲固定部分各格的位置（gpu.rs 的 FILM_*）
const SLOT = { combined: 0, albedo: 1, normal: 2, auxData: 6, auxNormal: 7, auxHit: 8 };

function renderer(t) {
  if (E2E) return buildRenderer().bin;
  const bin = path.join(OUT, 'bin', `core-render-${sourceKey([])}${EXE}`);
  if (fs.existsSync(bin)) return bin;
  t.skip('没有编好的渲染程序（设 BEIMING_CHASSIS_E2E=1 现编）');
  return null;
}

let n = 0;
function render(t, bin, pack, { frame, spp }) {
  const out = path.join(TMP, `r${n++}`);
  fs.mkdirSync(out);
  const env = { ...process.env, BEIMING_CORE_FILM_DUMP: path.join(out, 'film.bin') };
  delete env.THREERT_MERGED;
  const r = spawnSync(bin, ['render-pack', pack, '--frame', String(frame), '-o', path.join(out, 'out.png'), '--spp', String(spp), '--width', String(W), '--height', String(H), '--no-denoise', '--passes', path.join(out, 'passes'), '--presets', PRESETS], { encoding: 'utf8', env, maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    if (!E2E) { t.skip(`渲不出来（多半是没有显卡）：${r.stderr.trim().split('\n').at(-1)}`); return null; }
    assert.fail(r.stderr);
  }
  return out;
}

const f32 = b => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
const u32 = b => new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4);
const files = dir => Object.fromEntries(fs.readdirSync(dir).filter(f => f !== 'passes.json').map(f => [f, fs.readFileSync(path.join(dir, f))]));

/** 照读回的写法从缓冲原值重算各通道文件的内容（motion 除外），返回 { 文件名: 数组 } */
function fromFilm(film, params) {
  const F = Math.fround;
  const stride = film.length / (W * H * 4);
  assert.ok(Number.isInteger(stride) && stride >= 10, `缓冲的步长 ${stride}`);
  const [right, up, fwd] = [2, 3, 1].map(k => [0, 1, 2].map(c => params[k * 4 + c]));
  const fdot = (a, b) => F(F(F(a[0] * b[0]) + F(a[1] * b[1])) + F(a[2] * b[2]));
  const out = { 'color.f32': [], 'depth.f32': [], 'objectId.u32': [], 'objectId.coverage.f32': [], 'normal.f32': [], 'denoiseAlbedo.f32': [], 'denoiseNormal.f32': [] };
  for (let p = 0; p < W * H; p++) {
    const at = (slot, k) => { const v = film[(p * stride + slot) * 4 + k]; return Number.isFinite(v) ? v : 0; };
    const c = Math.max(film[(p * stride + SLOT.combined) * 4 + 3], 1);
    const mean = (slot, k) => F(at(slot, k) / c);
    out['color.f32'].push(mean(0, 0), mean(0, 1), mean(0, 2), mean(SLOT.albedo, 3));
    out['depth.f32'].push(at(SLOT.auxData, 0));
    out['objectId.u32'].push(at(SLOT.auxData, 1) >>> 0);
    out['objectId.coverage.f32'].push(mean(SLOT.normal, 3));
    out['normal.f32'].push(at(SLOT.auxNormal, 0), at(SLOT.auxNormal, 1), at(SLOT.auxNormal, 2));
    out['denoiseAlbedo.f32'].push(mean(SLOT.albedo, 0), mean(SLOT.albedo, 1), mean(SLOT.albedo, 2));
    const nrm = [0, 1, 2].map(k => mean(SLOT.normal, k));
    out['denoiseNormal.f32'].push(fdot(nrm, right), fdot(nrm, up), fdot(nrm, fwd));
  }
  return out;
}

/** 文件和重算的值逐位比，返回不相同的 [文件, 下标] 列表（每个文件最多记 3 处） */
function diffs(got, want) {
  const bad = [];
  for (const [file, values] of Object.entries(want)) {
    const a = file.endsWith('.u32') ? u32(got[file]) : f32(got[file]);
    assert.equal(a.length, values.length, file);
    const T = file.endsWith('.u32') ? Uint32Array : Float32Array;
    const b = T.from(values);
    const ba = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), bb = new Uint8Array(b.buffer);
    let k = 0;
    for (let i = 0; i < ba.length && k < 3; i += 4) if (ba[i] !== bb[i] || ba[i + 1] !== bb[i + 1] || ba[i + 2] !== bb[i + 2] || ba[i + 3] !== bb[i + 3]) { bad.push([file, i / 4]); k++; }
  }
  return bad;
}

const SPEC = { board: k => translate(0.05 * k, 0.02 * k, -0.1 * k), camera: k => translate(0.03 * k, 0, 3) };

test('读回一致性：通道文件和着色器写进输出缓冲的原值逐位相同，motion 和缓冲里的命中点重算的一致；每个文件改一位、换一份缓冲都查得出', (t) => {
  const bin = renderer(t);
  if (!bin) return;
  const pack = path.join(TMP, 'pack');
  writePack(pack, movingPack({ count: 3, ...SPEC }));
  const a = render(t, bin, pack, { frame: 1, spp: 8 });
  if (!a) return;
  const film = f32(fs.readFileSync(path.join(a, 'film.bin')));
  const params = f32(fs.readFileSync(path.join(a, 'film.bin.params')));
  const got = files(path.join(a, 'passes'));
  const want = fromFilm(film, params);
  assert.deepEqual(diffs(got, want), [], '通道文件和缓冲原值重算的不逐位相同');
  // 缓冲里确实有东西：编号两种都有，颜色不全是 0，样本数是 8
  const ids = new Set(u32(got['objectId.u32']));
  assert.ok(ids.has(1) && ids.has(2), `编号 ${[...ids]}`);
  assert.equal(film[3], 8, '第一个像素的样本数');

  // motion：缓冲里的命中点（第 8 格）照两帧的矩阵重算
  const stride = film.length / (W * H * 4);
  const mats = k => Object.fromEntries(objects(SPEC, k).map(o => [o.id, o.m]));
  const motion = f32(got['motion.f32']);
  let [max, hits] = [0, 0];
  for (let p = 0; p < W * H; p++) {
    const hit = [0, 1, 2, 3].map(k => film[(p * stride + SLOT.auxHit) * 4 + k]);
    const id = u32(got['objectId.u32'])[p];
    if (hit[3] === 0) { assert.deepEqual([motion[p * 2], motion[p * 2 + 1]], [0, 0]); continue; }
    hits++;
    const x = hit.slice(0, 3);
    const y = point(mul(mats(2)[id], inverse(mats(1)[id])), x);
    const [s0, s1] = [screen(camera(f32s(SPEC.camera(1)), W, H), x), screen(camera(f32s(SPEC.camera(2)), W, H), y)];
    max = Math.max(max, Math.abs(motion[p * 2] - (s1[0] - s0[0])), Math.abs(motion[p * 2 + 1] - (s1[1] - s0[1])));
  }
  t.diagnostic(`命中点 ${hits} 个，motion 和缓冲命中点重算的最大差 ${max.toExponential(3)} 像素`);
  assert.equal(hits, W * H, '墙铺满画面，每个像素都有命中点');
  assert.ok(max <= 1e-6, `motion 最大差 ${max}`);

  // 负对照一：每个文件改一位
  for (const file of Object.keys(want)) {
    const bad = { ...got, [file]: Buffer.from(got[file]) };
    bad[file][4 * 17] ^= 1;
    assert.deepEqual(diffs(bad, want), [[file, 17]], `${file} 改了一位没查出来`);
  }
  // 负对照二：换另一份缓冲（另一帧、另一个样本数）
  const b = render(t, bin, pack, { frame: 2, spp: 4 });
  const other = fromFilm(f32(fs.readFileSync(path.join(b, 'film.bin'))), f32(fs.readFileSync(path.join(b, 'film.bin.params'))));
  const crossed = new Set(diffs(got, other).map(([f]) => f));
  t.diagnostic(`换一份缓冲后对不上的文件：${[...crossed].join('、')}`);
  for (const f of ['color.f32', 'depth.f32', 'objectId.coverage.f32']) assert.ok(crossed.has(f), `换了缓冲 ${f} 居然还对得上`);
});
