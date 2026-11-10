// B 路线作品描述读取（engine/native/film.mjs）：v1 / v2、帧数契约、错误分类（给错目录 = 2，契约 = 4）、素材清单与源码引用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declaredAssets, hashAsset, readFilmSpec, referencedAssets } from '../../engine/native/film.mjs';
import { EXIT } from '../../engine/native/cli.mjs';

function film(json, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bne-film-'));
  writeFileSync(join(dir, 'film.json'), typeof json === 'string' ? json : JSON.stringify(json));
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), text); }
  return dir;
}
const cleanup = dir => rmSync(dir, { recursive: true, force: true });

test('v1：帧数 = round(dur × fps)，native 段缺省值', async () => {
  const dir = film({ route: 'b', title: '测试', dur: 4.5, fps: 24, size: [1920, 1080] });
  try {
    const s = await readFilmSpec(dir);
    assert.equal(s.frames, 108);
    assert.equal(s.dur, 4.5);
    assert.equal(s.native.entry, 'film.tsx');
    assert.equal(s.profile, null);
  } finally { cleanup(dir); }
});

test('v2：output.frameCount 为准，dur 与之冲突报契约错误', async () => {
  const dir = film({ schemaVersion: 2, id: 'x', title: 'x', route: 'b', output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 72 } });
  try {
    const s = await readFilmSpec(dir);
    assert.equal(s.frames, 72);
    assert.equal(s.dur, 3);
    assert.equal(s.profile, 'web-1080p24');
  } finally { cleanup(dir); }
  const bad = film({ route: 'b', dur: 2, output: { width: 1920, height: 1080, fps: 24, frameCount: 72 } });
  try { await assert.rejects(readFilmSpec(bad), e => e.exitCode === EXIT.CONTRACT); } finally { cleanup(bad); }
});

test('错误分类：没有 film.json / 路线不是 b → 2；字段不合法 → 4', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'bne-film-'));
  try { await assert.rejects(readFilmSpec(empty), e => e.exitCode === EXIT.USAGE); } finally { cleanup(empty); }
  const a = film({ route: 'a', dur: 1, fps: 24, size: [1920, 1080] });
  try { await assert.rejects(readFilmSpec(a), e => e.exitCode === EXIT.USAGE && /原生入口只处理/.test(e.message)); } finally { cleanup(a); }
  for (const j of [{ route: 'b', dur: 1, fps: 23.976, size: [1920, 1080] }, { route: 'b', dur: 1, fps: 24, size: [1921, 1080] }, { route: 'b', dur: 0, fps: 24, size: [1920, 1080] }, '{ not json']) {
    const d = film(j);
    try { await assert.rejects(readFilmSpec(d), e => e.exitCode === EXIT.CONTRACT, JSON.stringify(j)); } finally { cleanup(d); }
  }
});

test('declaredAssets：图片、模型、序列帧（图集 / 逐帧目录）与它们的说明 JSON、声音', async () => {
  const dir = film({
    route: 'b', dur: 1, fps: 24, size: [1920, 1080], native: {
      images: [{ to: 'a.png', from: 'x.png' }], models: [{ to: 'm.glb', module: 'm.js' }],
      sequences: [{ to: 's.png', page: '../..' }, { to: 'title', page: 'title', output: 'frames' }], audio: { script: 'sound.py' },
    },
  });
  try {
    const names = declaredAssets(await readFilmSpec(dir)).map(a => `${a.name}:${a.kind}`);
    assert.deepEqual(names, ['a.png:file', 'm.glb:file', 's.png:file', 's.json:file', 'title:frames', 'title.json:file', 'mix.wav:file']);
  } finally { cleanup(dir); }
});

test('referencedAssets：源码里的 staticFile 与 media/ 字面量；media/ 与 out/ 不扫', async () => {
  const dir = film({ route: 'b', dur: 1, fps: 24, size: [1920, 1080] }, {
    'film.tsx': "const a = staticFile('sky.png'); const w = { water: 'media/river.png' }; import s from './media/title.json';",
    'out/x.tsx': "staticFile('ignored.png')",
  });
  try { assert.deepEqual([...await referencedAssets(dir)].sort(), ['river.png', 'sky.png']); } finally { cleanup(dir); }
});

test('hashAsset：目录按「文件名 + 每个文件的哈希」稳定计算', async () => {
  const dir = film({ route: 'b', dur: 1, fps: 24, size: [1920, 1080] }, { 'seq/000001.png': 'b', 'seq/000000.png': 'a' });
  try {
    const h1 = await hashAsset(join(dir, 'seq'));
    writeFileSync(join(dir, 'seq', '000001.png'), 'c');
    assert.notEqual(await hashAsset(join(dir, 'seq')), h1);
  } finally { cleanup(dir); }
});
