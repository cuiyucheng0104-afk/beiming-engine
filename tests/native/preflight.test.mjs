// B 路线出片入口的预检（engine/render/native.mjs --check-only，不启动 GPU）：用假的原生运行时（BNE_ALLOW_VERSION 放行）
// 在临时 git 仓库里造一部最小作品，核对预检的几条拒绝路径：
//   · 作品不在 git 工作树里 → exit 3（原生运行时会以 outside … project's folder 拒绝，入口提前说清楚）
//   · 素材在 prepare 之后被改过 → exit 4（contract.asset-hash）
//   · film.json 的素材清单在 prepare 之后改过（例如改了 edge 参数没重新准备）→ exit 4（contract.stale-assets），提示重做哪一类
//   · 都对 → exit 0，信封 data 里有运行时版本与交付档位
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { specHash } from '../../engine/native/prepare.mjs';

const ENTRY = fileURLToPath(new URL('../../engine/render/native.mjs', import.meta.url));
const ff = process.env.FFMPEG || 'ffmpeg';
const hasFFmpeg = spawnSync(ff, ['-hide_banner', '-version'], { timeout: 10000 }).status === 0 && /libx264/.test(spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000 }).stdout);
const sha = buf => createHash('sha256').update(buf).digest('hex');

function setup({ git = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bne-pre-'));
  const rt = join(root, 'rt', 'raea');
  mkdirSync(join(rt, 'bin'), { recursive: true });
  mkdirSync(join(rt, 'share', 'raea'), { recursive: true });
  const exe = join(rt, 'bin', process.platform === 'win32' ? 'raea.cmd' : 'raea');
  writeFileSync(exe, process.platform === 'win32' ? '@echo usage\r\n' : '#!/bin/sh\necho usage\n');
  chmodSync(exe, 0o755);
  writeFileSync(join(rt, 'share', 'raea', 'VERSION'), '9.9.9-test\n');
  const film = join(root, 'films', 'demo');
  mkdirSync(join(film, 'media'), { recursive: true });
  const native = { entry: 'film.tsx', images: [{ to: 'sky.png', from: 'sky-src.png' }] };
  writeFileSync(join(film, 'film.json'), JSON.stringify({ route: 'b', title: '预检', dur: 1, fps: 24, size: [1920, 1080], native }));
  writeFileSync(join(film, 'film.tsx'), "import { staticFile } from 'raea';\nexport const sky = staticFile('sky.png');\n");
  writeFileSync(join(film, 'media', 'sky.png'), 'not really a png');
  const prepared = { schemaVersion: 1, assets: { 'sky.png': sha(Buffer.from('not really a png')) }, specs: { images: specHash(native, 'images'), models: specHash(native, 'models'), sequences: specHash(native, 'sequences'), audio: specHash(native, 'audio') } };
  writeFileSync(join(film, 'media', 'prepared.json'), JSON.stringify(prepared));
  if (git) spawnSync('git', ['init', '-q'], { cwd: root, timeout: 30000 });
  const env = { ...process.env, RAEA_BIN: exe, BNE_ALLOW_VERSION: '9.9.9-test' };
  const run = () => spawnSync(process.execPath, [ENTRY, film, '--check-only', '--json'], { encoding: 'utf8', env, timeout: 60000 });
  return { root, film, run };
}
const envOf = r => JSON.parse(r.stdout);

test('预检通过：exit 0，信封里有运行时版本、档位与帧数', { skip: !hasFFmpeg && '本机没有带 libx264 的 FFmpeg' }, () => {
  const s = setup();
  try {
    const r = s.run();
    assert.equal(r.status, 0, r.stderr);
    const e = envOf(r);
    assert.equal(e.data.runtime.version, '9.9.9-test');
    assert.equal(e.data.runtime.verified, 'allowed');
    assert.equal(e.data.profile, 'web-1080p24');
    assert.equal(e.data.frames, 24);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('作品不在 git 工作树里：exit 3（env.not-worktree）', { skip: !hasFFmpeg && '本机没有带 libx264 的 FFmpeg' }, () => {
  const s = setup({ git: false });
  try {
    const r = s.run();
    if (spawnSync('git', ['-C', s.film, 'rev-parse', '--show-toplevel'], { timeout: 10000 }).status === 0) return;   // 临时目录本身在某个 git 工作树里时无法构造这个场景
    assert.equal(r.status, 3, r.stderr);
    assert.equal(envOf(r).error.code, 'env.not-worktree');
    assert.match(envOf(r).error.hint, /git/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('素材在 prepare 之后被改过：exit 4（contract.asset-hash）', { skip: !hasFFmpeg && '本机没有带 libx264 的 FFmpeg' }, () => {
  const s = setup();
  try {
    writeFileSync(join(s.film, 'media', 'sky.png'), 'changed');
    const r = s.run();
    assert.equal(r.status, 4, r.stderr);
    assert.equal(envOf(r).error.code, 'contract.asset-hash');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('素材清单在 prepare 之后改过（改了 edge 没重做）：exit 4（contract.stale-assets），提示 --only 那一类', { skip: !hasFFmpeg && '本机没有带 libx264 的 FFmpeg' }, () => {
  const s = setup();
  try {
    const j = JSON.parse(readFileSync(join(s.film, 'film.json'), 'utf8'));
    j.native.images[0].edge = { left: 0.2, round: 1 };
    writeFileSync(join(s.film, 'film.json'), JSON.stringify(j));
    const r = s.run();
    assert.equal(r.status, 4, r.stderr);
    const e = envOf(r);
    assert.equal(e.error.code, 'contract.stale-assets');
    assert.match(e.error.hint, /--only images/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('specHash：键的顺序不影响指纹，内容变了指纹就变', () => {
  assert.equal(specHash({ images: [{ to: 'a', from: 'b' }] }, 'images'), specHash({ images: [{ from: 'b', to: 'a' }] }, 'images'));
  assert.notEqual(specHash({ images: [{ to: 'a', edge: { left: 0.1 } }] }, 'images'), specHash({ images: [{ to: 'a', edge: { left: 0.2 } }] }, 'images'));
  assert.equal(specHash({}, 'audio'), specHash({ audio: null }, 'audio'));
});
