// GPU 分段计时（engine/offscreen/gputimer.mjs）与 offscreen profile：
// 纯函数的分段换算、没挂计时器时标记什么都不做、开计时不改画面、能分出 look 的各遍、命令行输出各遍耗时。
// 缺可选依赖或拿不到 GPU 适配器时，GPU 用例跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spansFrom, markGpu, attachGpuTimer, detachGpuTimer, createGpuTimer } from '../../engine/offscreen/gputimer.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FILM = `${ROOT}films/chendu/offscreen.mjs`;
const ms = n => BigInt(Math.round(n * 1e6));   // 毫秒 → 纳秒刻度

test('spansFrom：相邻时间戳之差是前一个标记那一段；同名段相加、按首次出现排序；末尾必须是 end()', () => {
  const r = spansFrom(['pre', 'scene', 'ink:ids', 'scene', null], [ms(0), ms(1), ms(3), ms(4), ms(9)]);
  assert.deepEqual(r.spans.map(s => s.label), ['pre', 'scene', 'ink:ids']);
  assert.deepEqual(r.spans.map(s => s.ms), [1, 7, 1]);
  assert.equal(r.totalMs, 9);
  assert.equal(r.clamped, 0);
  // 时间戳倒退（部分实现跨提交不保证单调）：该段记 0，计数出来，不出负数
  const back = spansFrom(['a', 'b', null], [ms(0), ms(5), ms(4)]);
  assert.deepEqual(back.spans.map(s => s.ms), [5, 0]);
  assert.equal(back.clamped, 1);
  assert.throws(() => spansFrom(['a', 'b'], [ms(0), ms(1)]), /end/);
  assert.throws(() => spansFrom(['a', null], [ms(0)]), RangeError);
});

test('markGpu：渲染器没挂计时器时什么也不做；挂上后按顺序转给计时器，摘掉后又不做', () => {
  const renderer = {}, seen = [];
  markGpu(renderer, 'scene');
  attachGpuTimer(renderer, { mark: l => seen.push(l) });
  markGpu(renderer, 'scene'); markGpu(renderer, 'kuwahara');
  detachGpuTimer(renderer);
  markGpu(renderer, 'compose');
  assert.deepEqual(seen, ['scene', 'kuwahara']);
});

test('createGpuTimer：设备没有 timestamp-query 时返回 null（调用方据此报环境错误）', () => {
  assert.equal(createGpuTimer({ features: new Set() }), null);
});

async function gpuHost(t, opts) {
  try {
    const { loadGpu } = await import('../../engine/offscreen/load.mjs');
    const { createHost } = await import('../../engine/offscreen/host.mjs');
    const gpu = await loadGpu();
    const host = await createHost({ gpu, ...opts });
    if (!host.device.features.has('timestamp-query')) { host.dispose(); t.skip('适配器不支持 timestamp-query'); return null; }
    return host;
  } catch (e) { if (String(e.code).startsWith('env.')) { t.skip(`离屏不可用：${e.message}`); return null; } throw e; }
}

test('真实作品《晨渡》：开计时画面逐字节不变；分得出主场景、墨线三遍、调色、Kuwahara、合成，各段非负且相加等于整帧', { timeout: 120000 }, async t => {
  const host = await gpuHost(t, { width: 320, height: 180, fps: 24, query: 'msaa=0' });
  if (!host) return;
  try {
    const work = await host.load(FILM);
    const plain = await host.renderFrame(work, 48);
    const timer = createGpuTimer(host.device);
    attachGpuTimer(host.renderer, timer);
    timer.mark('pre');
    const timed = await host.renderFrame(work, 48);
    timer.end();
    const r = await timer.read();
    detachGpuTimer(host.renderer);
    assert.deepEqual(timed, plain, '开计时不得改变画面');
    const labels = r.spans.map(s => s.label);
    for (const l of ['scene', 'ink:ids', 'ink:edge', 'ink:stroke', 'grade', 'kuwahara', 'compose']) assert.ok(labels.includes(l), `缺「${l}」段：${labels.join('、')}`);
    assert.ok(r.spans.every(s => s.ms >= 0));
    assert.ok(Math.abs(r.spans.reduce((a, s) => a + s.ms, 0) - r.totalMs) < 1e-6);
    assert.ok(r.totalMs > 0);
    // read() 之后清空，可以接着计下一帧
    timer.mark('pre'); timer.end();
    assert.deepEqual((await timer.read()).spans.map(s => s.label), ['pre']);
  } finally { host.dispose(); }
});

const cli = args => spawnSync(process.execPath, [`${ROOT}engine/offscreen/cli.mjs`, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });

test('offscreen profile：缺作品或帧号写错是用法错误（退出 2），不需要 GPU', () => {
  for (const args of [['profile', '--json'], ['profile', 'films/chendu/offscreen.mjs', '--frames', 'x', '--json']]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(' ')}\n${r.stderr}`);
    assert.match(JSON.parse(r.stdout).error.code, /^usage\./);
  }
});

test('offscreen profile：按帧输出各段 GPU 毫秒与中位数，第一帧之前先预热、不写任何文件', { timeout: 180000 }, async t => {
  const host = await gpuHost(t, { width: 64, height: 64 });
  if (!host) return;
  host.dispose();
  const r = cli(['profile', 'films/chendu/offscreen.mjs', '--frames', '0,48,90', '--size', '320x180', '--query', 'msaa=0', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout).data;
  assert.deepEqual(d.frames.map(f => f.frame), [0, 48, 90]);
  assert.ok(d.passes.length >= 7);
  const k = d.passes.find(p => p.label === 'kuwahara');
  assert.ok(k && k.medianMs >= 0 && k.share >= 0 && k.share <= 1);
  assert.ok(Math.abs(d.passes.reduce((a, p) => a + p.share, 0) - 1) < 0.02, '各段占比相加约为 1');
  assert.ok(d.medianFrameMs > 0);
  assert.equal(JSON.parse(r.stdout).outputs.length, 0);
});
