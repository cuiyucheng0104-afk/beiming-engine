// 离屏出片 · 切片分发编排器 tools/offscreen/farm.mjs（性能规格 WP3，docs/offscreen/spec-perf-first-principles.md §3）：
// 切片规划（优先镜头切点、单镜过长按块长切）、单块失败只重试该块的槽位池、PTS 核验，以及（有 GPU 与 FFmpeg 时）本机双槽位端到端。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planShards, runShards, shotSeams, checkPts, mergeAndVerify } from '../../tools/offscreen/farm.mjs';
import { FFMPEG, FFPROBE, probe } from '../../engine/render/lib/ffmpeg.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FARM = join(ROOT, 'tools/offscreen/farm.mjs');
const OFFSCREEN = join(ROOT, 'engine/offscreen/cli.mjs');
const WORK = 'lab/offscreen/ink.mjs';
const run = (args, opts = {}) => spawnSync(process.execPath, [FARM, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 300000, ...opts });
const envelope = r => JSON.parse(r.stdout);
const tmp = () => mkdtempSync(join(tmpdir(), 'beiming-offscreen-farm-'));

// 真出片要可选依赖与 GPU，缺了跳过（与 cli.test.mjs 同一口径）
const probeGpu = spawnSync(process.execPath, ['--input-type=module', '-e',
  "try { const { loadGpu } = await import('./engine/offscreen/load.mjs'); const { createHost } = await import('./engine/offscreen/host.mjs'); (await createHost({ gpu: await loadGpu(), width: 64, height: 64 })).dispose(); } catch(e) { console.error(e.message); process.exitCode=e.code?.startsWith('env.')?3:1; }"],
{ cwd: ROOT, encoding: 'utf8', timeout: 60000 });
assert.ok(probeGpu.status === 0 || probeGpu.status === 3, `GPU 探测出现非环境错误：${probeGpu.stderr}`);
const noGpu = probeGpu.status === 3 && `离屏出片不可用：${probeGpu.stderr.trim()}`;
const ffmpegOk = spawnSync(FFMPEG(), ['-version'], { stdio: 'ignore' }).status === 0;
const noEncode = noGpu || (!ffmpegOk && '没有 FFmpeg（npm run setup；CI 的 windows-paths 任务不装）');

// ── planShards：切片规划（纯函数） ──

test('planShards：无切点按目标段数均分', () => {
  assert.deepEqual(planShards({ from: 0, to: 144, target: 2 }), [[0, 72], [72, 144]]);
});

test('planShards：优先对齐镜头切点（不追求等长）', () => {
  assert.deepEqual(planShards({ from: 0, to: 192, target: 2, seams: [72] }), [[0, 72], [72, 192]]);
  assert.deepEqual(planShards({ from: 0, to: 192, target: 3, seams: [72] }), [[0, 72], [72, 132], [132, 192]]);
});

test('planShards：单镜过长按固定块长切，每段 ≤ block', () => {
  assert.deepEqual(planShards({ from: 10, to: 610, target: 1, block: 240 }), [[10, 210], [210, 410], [410, 610]]);
});

test('planShards：目标段数多于块数时平分最长块，不动镜头对齐的边界', () => {
  assert.deepEqual(planShards({ from: 0, to: 144, target: 4, seams: [72] }),
    [[0, 36], [36, 72], [72, 108], [108, 144]]);
});

test('planShards：段数多于目标时按最小合并收拢，合并不得超过 block', () => {
  assert.deepEqual(planShards({ from: 0, to: 240, target: 2, seams: [72, 96, 120], block: 240 }), [[0, 120], [120, 240]]);
  // 全部相邻合并都会超过 block 时保持更多段，不硬凑目标段数
  const segs = planShards({ from: 0, to: 1000, target: 3, seams: [100, 900], block: 240 });
  assert.ok(segs.length > 3, `应保持多于 3 段：${JSON.stringify(segs)}`);
});

test('planShards：覆盖不变量——恰好拼回 [from,to)，边界单调无重叠，每段 ≤ block，段数 ≥ min(target, 总帧数)', () => {
  for (const [from, to, target, seams, block] of [
    [0, 192, 2, [72], 240], [0, 1000, 3, [100, 900], 240], [5, 9, 2, [], 240],
    [0, 48, 64, [], 240], [0, 600, 2, [], 300], [96, 192, 2, [72, 150], 240], [0, 7, 7, [], 240],
  ]) {
    const segs = planShards({ from, to, target, seams, block });
    let cur = from;
    for (const [a, b] of segs) { assert.equal(a, cur, `左端不衔接：${JSON.stringify(segs)}`); assert.ok(b > a); assert.ok(b - a <= block); cur = b; }
    assert.equal(cur, to, `没拼回区间右端：${JSON.stringify(segs)}`);
    assert.ok(segs.length >= Math.min(target, to - from), `段数不足：${JSON.stringify(segs)}`);
  }
});

test('planShards：seams 只取区间内部的整数切点（区间外与重复的忽略）', () => {
  assert.deepEqual(planShards({ from: 96, to: 192, target: 2, seams: [72, 150, 150, 200, 96.5] }), [[96, 150], [150, 192]]);
  // 切点等于 from / to 不算区间内部（否则可能切出空段）
  assert.deepEqual(planShards({ from: 0, to: 8, target: 3, seams: [0, 4] }), [[0, 2], [2, 4], [4, 8]]);
});

test('planShards：用法错误（空区间、止 ≤ 起、target/block < 1）', () => {
  for (const o of [{ from: 5, to: 5, target: 1, block: 240 }, { from: 9, to: 5, target: 1, block: 240 },
    { from: 0, to: 8, target: 0, block: 240 }, { from: 0, to: 8, target: 1, block: 0 }]) {
    assert.throws(() => planShards(o), e => e?.code?.startsWith('usage.') === true, JSON.stringify(o));
  }
});

// ── shotSeams：从 film.json 镜头表取切点 ──

test('shotSeams：取 film.json 镜头 in/out 落在 (from,to) 内的切点；没有镜头表返回空', () => {
  const film = { shots: [{ id: 'S1', in: 0, out: 72 }, { id: 'S2', in: 72, out: 192 }] };
  assert.deepEqual(shotSeams(film, { from: 0, to: 192 }), [72]);
  assert.deepEqual(shotSeams(film, { from: 0, to: 96 }), [72]);
  assert.deepEqual(shotSeams(film, { from: 96, to: 192 }), []);
  assert.deepEqual(shotSeams(null, { from: 0, to: 10 }), []);
  assert.deepEqual(shotSeams({ shots: '坏的' }, { from: 0, to: 10 }), []);
});

// ── checkPts：PTS 严格单调无空洞 ──

test('checkPts：等步长、首帧 0、数量正确 → ok；B 帧乱序输入按呈现时间判定', () => {
  assert.equal(checkPts([0, 512, 1024, 1536], { step: 512, expect: 4 }).ok, true);
  assert.equal(checkPts([512, 0, 1536, 1024], { step: 512, expect: 4 }).ok, true);
});

test('checkPts：空洞、重复（间隔 0）、首帧非 0、帧数不符都不过（变异检查）', () => {
  assert.equal(checkPts([0, 512, 1536], { step: 512, expect: 3 }).ok, false);      // 空洞
  assert.equal(checkPts([0, 513, 1025], { step: 512, expect: 3 }).ok, false);      // 拼接边界差 1 的 PTS 漂移
  assert.equal(checkPts([0, 0, 512, 1024], { step: 512, expect: 4 }).ok, false);   // 重复（不严格单调）
  assert.equal(checkPts([512, 1024, 1536], { step: 512, expect: 3 }).ok, false);   // 首帧不是 0
  assert.equal(checkPts([0, 512, 1024], { step: 512, expect: 4 }).ok, false);      // 帧数不符
  assert.equal(checkPts([], { step: 512, expect: 1 }).ok, false);                  // 空
});

// ── runShards：槽位池与容错 ──

test('runShards：单块失败只重试该块，已完成的不重跑', async () => {
  const calls = [];
  const results = await runShards({
    shards: [['a', 1], ['b', 2], ['c', 3]],
    slots: 2, retries: 1,
    runShard: async (shard, attempt) => {
      calls.push(shard[0]);
      if (shard[0] === 'b' && attempt === 0) return { ok: false, error: { code: 'failure.shard', message: 'boom' } };
      return { ok: true, shard };
    },
  });
  assert.equal(calls.filter(c => c === 'a').length, 1);
  assert.equal(calls.filter(c => c === 'c').length, 1);
  assert.equal(calls.filter(c => 'b' && c === 'b').length, 2);
  assert.deepEqual(results.map(r => r.ok), [true, true, true]);
  assert.equal(results[0].attempts, 1);
  assert.equal(results[1].attempts, 2);
});

test('runShards：重试用尽仍失败 → 该块 ok:false 带错误，其余照常完成', async () => {
  const results = await runShards({
    shards: [['a', 1], ['b', 2]],
    slots: 2, retries: 1,
    runShard: async (shard, attempt) => (shard[0] === 'b'
      ? { ok: false, error: { code: 'failure.shard', message: `第 ${attempt} 次失败` } }
      : { ok: true, shard }),
  });
  assert.deepEqual(results.map(r => r.ok), [true, false]);
  assert.equal(results[1].attempts, 2);
  assert.match(results[1].error.message, /1 次失败/);
});

test('runShards：slots 大于块数时不会多起工人', async () => {
  let active = 0, maxActive = 0;
  const results = await runShards({
    shards: [['a', 1], ['b', 2]],
    slots: 8, retries: 0,
    runShard: async shard => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 20));
      active--;
      return { ok: true, shard };
    },
  });
  assert.equal(maxActive, 2);
  assert.equal(results.every(r => r.ok), true);
});

// ── 命令行用法（不需要 GPU） ──

test('--help：退出 0，打印用法，不执行渲染', () => {
  const dir = tmp();
  try {
    const r = run(['render', '--help'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /offscreen-farm/);
    assert.match(r.stdout, /--transport/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('未知选项、--transport ssh、缺 --out/--frames、frames 写反：都是用法错误（退出 2）', () => {
  const dir = tmp(), out = join(dir, 'o.mp4');
  try {
    for (const [args, code] of [
      [['render', WORK, '--out', out, '--frames', '0:4', '--wat'], 'usage.unknown-option'],
      [['render', WORK, '--out', out, '--frames', '0:4', '--transport', 'ssh'], 'usage.bad-value'],
      [['render', WORK, '--frames', '0:4'], 'usage.missing-out'],
      [['render', WORK, '--out', out], 'usage.missing-frames'],
      [['render', WORK, '--out', out, '--frames', '5:2'], 'usage.bad-value'],
      [['render', WORK, '--out', out, '--frames', '0:8', '--slots', '0'], 'usage.bad-value'],
    ]) {
      const r = run([...args, '--json']);
      assert.equal(r.status, 2, `${args.join(' ')}\n${r.stderr}`);
      assert.equal(envelope(r).error.code, code, args.join(' '));
    }
    assert.equal(existsSync(out), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 合并与核验（要 FFmpeg，不要 GPU）：用 ffmpeg 造两段同参源片，走 farm 的合并与核验 ──

function makeSegment(dir, name, source) {
  // 与离屏编码链同口径：色彩标记走 setparams 滤镜（FFmpeg 8+ 只加输出参数时 primaries/transfer 会丢成 unknown）
  const r = spawnSync(FFMPEG(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', `${source}=duration=0.5:size=320x180:rate=24`,
    '-vf', 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    '-c:v', 'libx264', '-crf', '14', '-profile:v', 'high', '-g', '12', '-video_track_timescale', '12288',
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    join(dir, name)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return join(dir, name);
}

test('mergeAndVerify：两段同参 MP4 合并 → 帧数精确、PTS 严格单调、色彩标记完整、framemd5 与逐段连续', { skip: !ffmpegOk && '没有 FFmpeg' }, async () => {
  const dir = tmp();
  try {
    const a = makeSegment(dir, 'a.mp4', 'testsrc2'), b = makeSegment(dir, 'b.mp4', 'smptebars');
    const out = join(dir, 'merged.mp4');
    const res = await mergeAndVerify({ files: [a, b], out, from: 0, to: 24, fps: 24, width: 320, height: 180, timescale: 12288, workDir: dir });
    assert.equal(res.verify.frames, 24);
    assert.equal(res.verify.pts.ok, true);
    assert.equal(res.verify.colorOk, true);
    assert.equal(res.verify.md5Continuous, true);
    assert.equal(res.probe.video.frames, 24);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mergeAndVerify：帧数不符 / 切片画幅或帧率与请求不符 / 真实 MP4 的 PTS 有空洞都拦下（变异检查）', { skip: !ffmpegOk && '没有 FFmpeg' }, async () => {
  const dir = tmp();
  const req = { fps: 24, width: 320, height: 180, timescale: 12288, workDir: dir };
  try {
    const a = makeSegment(dir, 'a.mp4', 'testsrc2'), b = makeSegment(dir, 'b.mp4', 'smptebars');
    // 帧数不符 → contract
    await assert.rejects(() => mergeAndVerify({ ...req, files: [a, b], out: join(dir, 'm1.mp4'), from: 0, to: 25 }), e => e?.code?.startsWith('contract.') === true);
    // 第二片画幅不是本次请求的（另一个任务的切片混进来）→ contract.shard-mismatch，且不写出成片
    const r = spawnSync(FFMPEG(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=160x90:rate=24',
      '-c:v', 'libx264', '-crf', '14', '-g', '12', '-video_track_timescale', '12288', '-pix_fmt', 'yuv420p', join(dir, 'small.mp4')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    await assert.rejects(() => mergeAndVerify({ ...req, files: [a, join(dir, 'small.mp4')], out: join(dir, 'm2.mp4'), from: 0, to: 24 }), e => e?.code === 'contract.shard-mismatch' && /size=160x90/.test(e.message));
    assert.equal(existsSync(join(dir, 'm2.mp4')), false);
    // 各片彼此一致、但都不是请求的画幅 / 帧率 → 同样拒绝（只核对片与片一致是不够的）
    await assert.rejects(() => mergeAndVerify({ ...req, width: 640, height: 360, files: [a, b], out: join(dir, 'm3.mp4'), from: 0, to: 24 }), e => e?.code === 'contract.shard-mismatch');
    await assert.rejects(() => mergeAndVerify({ ...req, fps: 25, files: [a, b], out: join(dir, 'm4.mp4'), from: 0, to: 24 }), e => e?.code === 'contract.shard-mismatch' && /rate=24\/1/.test(e.message));
    // 真实容器级 PTS 空洞：第二片最后一帧 PTS 5632 → 6144
    const hole = join(dir, 'hole.mp4');
    const h = spawnSync(FFMPEG(), ['-y', '-v', 'error', '-i', b, '-c', 'copy', '-bsf:v', 'setts=pts=if(eq(PTS\\,5632)\\,6144\\,PTS)', '-video_track_timescale', '12288', hole], { encoding: 'utf8' });
    assert.equal(h.status, 0, h.stderr);
    await assert.rejects(() => mergeAndVerify({ ...req, files: [a, hole], out: join(dir, 'm5.mp4'), from: 0, to: 24 }), e => e?.code === 'contract.pts' && /间隔 1024/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 端到端：本机双槽位（要 GPU 与 FFmpeg） ──

test('端到端：ink 0:8 双槽位两片 → 合并帧数精确、PTS 单调，逐帧哈希与单机整段渲染逐字节一致（无接缝）', { skip: noEncode, timeout: 300000 }, async () => {
  const dir = tmp();
  try {
    const ref = spawnSync(process.execPath, [OFFSCREEN, 'render', WORK, '--out', join(dir, 'ref.mp4'),
      '--frames', '0:8', '--size', '320x180', '--frame-hashes', 'on', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    assert.equal(ref.status, 0, ref.stderr);
    const refHashes = JSON.parse(ref.stdout).data.frameHashes;
    assert.equal(refHashes.length, 8);

    const r = run(['render', WORK, '--out', join(dir, 'farm.mp4'), '--frames', '0:8', '--size', '320x180',
      '--slots', '2', '--seams', '4', '--work-dir', join(dir, 'shards'), '--json']);
    assert.equal(r.status, 0, r.stderr);
    const e = envelope(r);
    assert.equal(e.ok, true);
    assert.equal(e.data.shards.length, 2);
    assert.equal(e.data.shards.map(s => s.frames).reduce((x, y) => x + y, 0), 8);
    assert.equal(e.data.verify.frames, 8);
    assert.equal(e.data.verify.pts.ok, true);
    assert.equal(e.data.verify.colorOk, true);
    assert.equal(e.data.verify.md5Continuous, true);
    // 逐像素无接缝：各片无损读回哈希拼起来与单机整段渲染完全一致
    assert.deepEqual(e.data.frameHashes, refHashes);
    // 单块只跑一次（无失败重试）
    assert.ok(e.data.shards.every(s => s.attempts === 1));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('端到端：--keep 保留本次的切片子目录与逐段 sha256 留痕；默认只删本次建的子目录', { skip: noEncode, timeout: 300000 }, async () => {
  const dir = tmp();
  try {
    const keep = join(dir, 'keep');
    const r = run(['render', WORK, '--out', join(dir, 'farm.mp4'), '--frames', '0:8', '--size', '320x180',
      '--slots', '2', '--seams', '4', '--work-dir', keep, '--keep', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const e = envelope(r);
    assert.ok(e.data.shards.every(s => /^[0-9a-f]{64}$/.test(s.sha256)), '每片都要有 sha256 留痕');
    const sub = e.data.workDir;
    assert.ok(sub && sub.startsWith(keep), `workDir 应在 --work-dir 之下：${sub}`);
    assert.equal(existsSync(join(sub, 'shard-000000-000004.mp4')), true);
    assert.equal(existsSync(join(sub, 'shard-000004-000008.mp4')), true);
    const gone = join(dir, 'gone');
    const r2 = run(['render', WORK, '--out', join(dir, 'farm2.mp4'), '--frames', '0:8', '--size', '320x180',
      '--slots', '2', '--seams', '4', '--work-dir', gone, '--json']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(envelope(r2).data.workDir, null);
    assert.deepEqual(readdirSync(gone), [], '默认只删本次的子目录，--work-dir 本身保留且为空');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P0 回归：--work-dir 指向非空的已有目录，原有内容原样保留；--out 放在 work-dir 里也不丢成片', { skip: noEncode, timeout: 300000 }, async () => {
  const dir = tmp();
  try {
    const work = join(dir, 'work');
    mkdirSync(join(work, 'nested'), { recursive: true });
    writeFileSync(join(work, 'sentinel.txt'), 'keep me\n');
    writeFileSync(join(work, 'nested', 'deep.txt'), 'deep\n');
    const out = join(work, 'out.mp4');
    const r = run(['render', WORK, '--out', out, '--frames', '0:2', '--size', '64x64', '--work-dir', work, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(work, 'sentinel.txt'), 'utf8'), 'keep me\n');
    assert.equal(readFileSync(join(work, 'nested', 'deep.txt'), 'utf8'), 'deep\n');
    assert.equal(existsSync(out), true, '成片被删了');
    assert.equal(envelope(r).outputs[0].sha256, createHash('sha256').update(readFileSync(out)).digest('hex'));
    assert.deepEqual(readdirSync(work).sort(), ['nested', 'out.mp4', 'sentinel.txt'], '只应多出成片，不留本次的临时子目录');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P1 回归：两个任务并发共用 --work-dir、同帧区间只差画幅，各自拿到自己的画幅', { skip: noEncode, timeout: 300000 }, async () => {
  const dir = tmp();
  try {
    const shared = join(dir, 'shared');
    const go = (name, size) => new Promise(resolve => {
      const c = spawn(process.execPath, [FARM, 'render', WORK, '--out', join(dir, name), '--frames', '0:4', '--size', size,
        '--slots', '1', '--retries', '0', '--work-dir', shared, '--keep', '--json'], { cwd: ROOT });
      let stdout = '', stderr = '';
      c.stdout.on('data', d => { stdout += d; });
      c.stderr.on('data', d => { stderr += d; });
      c.on('close', code => resolve({ code, stdout, stderr }));
    });
    const [a, b] = await Promise.all([go('a.mp4', '320x180'), go('b.mp4', '640x360')]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const pa = (await probe(join(dir, 'a.mp4'))).video, pb = (await probe(join(dir, 'b.mp4'))).video;
    assert.deepEqual([pa.width, pa.height, pa.frames], [320, 180, 4]);
    assert.deepEqual([pb.width, pb.height, pb.frames], [640, 360, 4]);
    assert.notEqual(JSON.parse(a.stdout).data.workDir, JSON.parse(b.stdout).data.workDir, '两个任务必须用各自的子目录');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P2 回归：缺 FFmpeg（子进程退出 3）时 farm 也退出 3，错误类别是 env.*', { timeout: 300000 }, () => {
  const dir = tmp();
  try {
    const missing = join(dir, 'no-such-ffmpeg');
    const r = run(['render', WORK, '--out', join(dir, 'o.mp4'), '--frames', '0:1', '--size', '64x64', '--retries', '0', '--work-dir', dir, '--json'],
      { env: { ...process.env, FFMPEG: missing, FFPROBE: missing } });
    assert.equal(r.status, 3, r.stderr);
    const e = envelope(r);
    assert.equal(e.exitCode, 3);
    assert.match(e.error.code, /^env\./);
    assert.equal(existsSync(join(dir, 'o.mp4')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
