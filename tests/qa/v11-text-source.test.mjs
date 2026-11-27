import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { mergePageQaChunks } from '../../engine/render/lib/page-qa.mjs';
import { parseVideoStreamSha256 } from '../../engine/render/lib/video-stream-hash.mjs';
import { qaInputs } from '../../tools/film/lib/deliver.mjs';
import { qaArgs } from '../../tools/film/lib/qa.mjs';
import { check, cleanup, clip, ffmpeg, haveBrowser, haveFfmpeg, qa, TEST_PROFILES, tmp, writeJson } from './helpers.mjs';

after(cleanup);
const spec = { width: 320, height: 180, fps: 24, frameCount: 3 };
const skipBrowser = !haveBrowser() && '需要 Chromium';
const skipVideo = !haveFfmpeg && '需要 FFmpeg ≥7';

function fixture() {
  const root = tmp(), dir = join(root, 'films/overlay'), runDir = join(dir, 'out/20261122-150000-abc0011');
  fs.mkdirSync(join(root, 'engine'));
  writeJson(join(root, 'package.json'), { private: true });
  fs.mkdirSync(join(runDir, 'work'), { recursive: true });
  const film = { route: 'd', pathtrace: { overlay: 'page' }, events: [], dir };
  writeJson(join(dir, 'film.json'), { route: film.route, pathtrace: film.pathtrace, schemaVersion: 2,
    output: { ...spec, profile: 't-360p24' } });
  const table = writeJson(join(runDir, 'work/texts.json'), { schemaVersion: 1, ...spec, frames: [{ frame: 0, items: [] }] });
  const master = join(runDir, 'master.mp4');
  function addPage(pageDir = dir) {
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(join(pageDir, 'index.html'), `<canvas></canvas><script>
      const ctx = document.querySelector('canvas').getContext('2d');
      window.DUR = ${spec.frameCount / spec.fps};
      window.render = () => ctx.fillText('OVERLAY', -5, 20);
      window.TEXTS = () => [{ id: 'overlay', text: 'OVERLAY', box: [-5, 8, 50, 16], alpha: 1 }];
      window.READY = true;</script>`);
    return pageDir;
  }
  const texts = (...args) => qa(['texts', '--run-dir', runDir, '--film', dir, '--profiles-file', TEST_PROFILES, ...args]);
  return { film, runDir, table, master, addPage, texts };
}

function assertOverlay(r) {
  assert.equal(r.code, 4, r.stderr);
  assert.deepEqual(check(r.env, 'texts.inframe').findings.map(f => [f.status, f.target, f.frames]), [['fail', 'overlay', [0, 3]]]);
}

test('D 路线 report 按出片器传入的 --page 检出叠字越界，即使母版旁有场景文字表', { skip: skipBrowser || skipVideo }, () => {
  const { film, master, runDir, addPage } = fixture();
  film.pageDir = addPage(join(film.dir, 'titles'));
  clip(master, { size: '320x180', dur: spec.frameCount / spec.fps, audio: 'none' });
  const inputs = qaInputs({ film, runDir, ...spec });
  const args = qaArgs({ master, film, runDir, ...inputs });
  assertOverlay(qa([...args, '--profiles-file', TEST_PROFILES, '--skip', 'delivery,visual,plates,sync', '--no-sheet']));
});

test('D 路线 texts 自动找到作品页面时，场景文字表也不能掩盖越界字', { skip: skipBrowser }, () => {
  const fx = fixture();
  fx.addPage();
  assertOverlay(fx.texts());
});

test('旧 D 场景文字表支持无页面自动发现和有页面时显式 --texts', () => {
  const fx = fixture();
  const auto = fx.texts();
  fx.addPage();
  const explicit = fx.texts('--texts', fx.table);
  for (const r of [auto, explicit]) {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.env.result.texts.mode, 'texts-json');
    assert.equal(r.env.result.texts.sampled, 1);
  }
});

test('D 路线的 page-render 表优先于页面，有母版时必须匹配视频码流', { skip: skipVideo }, () => {
  const fx = fixture();
  fx.addPage();
  const rows = Array.from({ length: spec.frameCount }, (_, f) => ({ f, texts: [], runs: [], dom: [], plates: [], contrast: [] }));
  const { texts } = mergePageQaChunks([{ rows, info: { dur: spec.frameCount / spec.fps, hasTexts: true },
    externalRequests: [], fonts: { faces: [], set: [], errors: [] } }], spec);
  writeJson(fx.table, texts);
  assert.equal(fx.texts().code, 0);
  clip(fx.master, { size: '320x180', dur: spec.frameCount / spec.fps, audio: 'none' });
  for (const hash of [undefined, '0'.repeat(64)]) {
    writeJson(fx.table, { ...texts, videoStreamSha256: hash });
    const r = fx.texts();
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.env.error.message, /指纹/);
  }
  const { stdout } = ffmpeg(['-i', fx.master, '-map', '0:v:0', '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-']);
  const hash = parseVideoStreamSha256(stdout);
  assert.ok(hash, `unexpected streamhash output: ${stdout}`);
  writeJson(fx.table, { ...texts, videoStreamSha256: hash });
  const bound = fx.texts();
  assert.equal(bound.code, 0, bound.stderr);
  assert.equal(bound.env.result.texts.sampled, spec.frameCount);
});
