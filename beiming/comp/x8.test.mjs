import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { eventsTable } from '../kernel/eval/index.mjs';
import { composeLayerLookFilm } from './layer-look.mjs';

const rgb = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGOQ0zCCIwbiOADB9AeBRPpuJgAAAABJRU5ErkJggg==';
const gray = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAEEAAAAADcCh3hAAAADklEQVR4nGNgYIRC3AwAATwAEbLr3s4AAAAASUVORK5CYII=';
const narrow = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAAEEAAAAADRFG2mAAAADklEQVR4nGNgYARCVAIAAGAACZs7M4MAAAAASUVORK5CYII=';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'beiming-x8-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const png = (name, encoded) => {
    const file = join(root, name + '.png');
    writeFileSync(file, Buffer.from(encoded, 'base64'));
    return file;
  };
  for (const frame of [7, 8, 9]) png('color-00' + frame, rgb);
  const depth = png('depth', gray);
  const objectId = png('id', gray);
  const normal = png('normal', rgb);
  const sequence = {
    pattern: join(root, 'color-%03d.png'), start: 7, kind: 'png', transfer: 'srgb',
    auxiliaryLayers: { depth: [depth, depth], objectId: [objectId, objectId], normal: [normal, normal], depthUnitM: 0.001 },
  };
  const fixtureJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const film = fixtureJson('../kernel/contracts/film/examples/minimal.json');
  const shot = { ...film.shots[0], colorRef: 'display' };
  film.output = { size: [4, 4], fps: '24/1', frames: 5 };
  film.shots = [{ ...shot, id: 'other', in: 0, out: 3, seed: 120 }, { ...shot, in: 3, out: 5 }];
  film.transitions = [{ id: 'cut-3', at: 3, type: 'cut' }];
  const lock = fixtureJson('../kernel/contracts/lock/examples/minimal.json');
  lock.seeds.other = 120;
  lock.shots.other = { shutterSamples: 1 };
  const outDir = join(root, 'delivery');
  mkdirSync(outDir);
  const calls = [];
  const opts = {
    film, events: eventsTable(film), lock, frames: { s01: sequence, other: { pattern: sequence.pattern, start: 7 } }, outDir,
    layerLook: { shotId: 's01', renderFrame: async (frame) => { calls.push(frame); return new Uint8Array(4 * 4 * 3); } },
  };
  return { root, png, calls, sequence, opts };
}

test('X8 只有逐镜头声明并提供完整辅助层才能启用', async (t) => {
  const { calls, sequence, opts } = fixture(t);
  for (const name of ['depth', 'objectId', 'normal']) {
    const auxiliaryLayers = { ...sequence.auxiliaryLayers };
    delete auxiliaryLayers[name];
    await assert.rejects(async () => composeLayerLookFilm({ ...opts, frames: { ...opts.frames, s01: { ...sequence, auxiliaryLayers } } }), new RegExp(name));
  }
  await assert.rejects(async () => composeLayerLookFilm({ ...opts, layerLook: { ...opts.layerLook, shotId: 'missing' } }), /镜头 missing/);
  assert.equal(calls.length, 0);
});

test('X8 预检镜头色彩、所有输入的尺寸及帧数，再调用渲染器', async (t) => {
  const { calls, png, sequence, opts } = fixture(t);
  const layers = sequence.auxiliaryLayers;
  const run = async (next) => composeLayerLookFilm({ ...opts, frames: { ...opts.frames, s01: { ...sequence, ...next } } });
  await assert.rejects(() => run({ transfer: 'linear' }), /sRGB/);
  await assert.rejects(() => run({ auxiliaryLayers: { ...layers, depth: layers.depth.slice(0, 1) } }), /depth.*2/);
  await assert.rejects(() => run({ auxiliaryLayers: { ...layers, depth: [layers.depth[0], png('narrow', narrow)] } }), /depth.*尺寸/);
  await assert.rejects(() => run({ auxiliaryLayers: { ...layers, normal: [layers.normal[0], layers.depth[1]] } }), /normal.*PNG/);
  await assert.rejects(() => run({ auxiliaryLayers: { ...layers, depth: [layers.depth[0], join(opts.outDir, 'missing.png')] } }), /depth.*缺失/);
  await assert.rejects(() => composeLayerLookFilm({ ...opts, film: { ...opts.film, shots: [opts.film.shots[0], { ...opts.film.shots[1], colorRef: 'scene' }] } }), /显示参考/);
  assert.equal(calls.length, 0);
});

test('X8 逐帧交付局部帧号和时间，渲染失败后清理已暂存的帧', async (t) => {
  const { root, calls, opts } = fixture(t);
  const before = readdirSync(root).sort();
  const failure = new Error('render-frame-failed');
  opts.layerLook.renderFrame = async (frame) => {
    calls.push(frame);
    if (frame.frame === 1) throw failure;
    return new Uint8Array(4 * 4 * 3);
  };
  await assert.rejects(async () => composeLayerLookFilm(opts), (error) => error === failure);
  assert.deepEqual(calls.map(({ frame, time, depthUnitM, size }) => [frame, time, depthUnitM, size]), [
    [0, 0, 0.001, [4, 4]], [1, 1 / 24, 0.001, [4, 4]],
  ]);
  assert.deepEqual(Object.keys(calls[0].layers).sort(), ['color', 'depth', 'normal', 'objectId']);
  assert.deepEqual(readdirSync(root).sort(), before);
  assert.deepEqual(readdirSync(opts.outDir), []);

  opts.layerLook.renderFrame = () => new Uint8Array(1);
  await assert.rejects(() => composeLayerLookFilm(opts), /RGB8/);
  assert.deepEqual(readdirSync(root).sort(), before);
});

test('X8 交付拒绝覆盖已有文件时删除风格化暂存帧', async (t) => {
  const { root, calls, opts } = fixture(t);
  const sentinel = join(opts.outDir, 'existing.txt');
  writeFileSync(sentinel, 'keep');
  const before = readdirSync(root).sort();
  await assert.rejects(() => composeLayerLookFilm(opts), /交付输出目录必须为空/);
  assert.equal(calls.length, 2);
  assert.deepEqual(readdirSync(root).sort(), before);
  assert.deepEqual(readdirSync(opts.outDir), ['existing.txt']);
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
});
