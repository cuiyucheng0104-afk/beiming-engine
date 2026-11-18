// M7 T3 测试：new-film 与 film new 的 --backend webgpu 同源离屏脚手架（A / C 路线），
// 在系统临时目录搭隔离沙盒（不触碰仓库根 films/），验证参数校验、演练、P05 校验及禁用浏览器下的 Dawn 探测与 QA。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';
import { loadCanvas } from '../../engine/offscreen/canvas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let skipGpu = null;
try {
  const gpu = await loadGpu();
  const h = await createHost({ gpu, width: 32, height: 32, fps: 24 });
  h.dispose();
  await loadCanvas();
} catch (e) {
  skipGpu = e.message;
}

function makeRepoSandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-m7-scaffold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  for (const rel of ['routes', 'engine', 'tools']) {
    fs.cpSync(path.join(ROOT, rel), path.join(dir, rel), { recursive: true });
  }
  for (const rel of ['node_modules', 'assets', 'media', 'fonts']) {
    fs.symlinkSync(path.join(ROOT, rel), path.join(dir, rel), process.platform === 'win32' ? 'junction' : 'dir');
  }
  fs.mkdirSync(path.join(dir, 'films'), { recursive: true });
  return dir;
}

const runIn = (repoDir, script, args, env = {}) => spawnSync(
  process.execPath,
  [path.join(repoDir, script), ...args],
  // 没有显卡的 Windows runner 用软件适配器，A 路线的逐帧读文字一步就超过 120 秒（PR #24 的 windows-paths 因此被杀，status 为 null）
  { cwd: repoDir, encoding: 'utf8', timeout: 360000, env: { ...process.env, ...env } },
);

test('--backend 参数校验：B 路线拒绝 webgpu（退出码 2），--dry-run 生成纯 offscreen 清单不写盘', () => {
  const badNew = runIn(ROOT, 'tools/new-film.mjs', ['b', 'bad-webgpu', '--backend', 'webgpu', '--json']);
  assert.equal(badNew.status, 2, badNew.stderr);
  assert.equal(JSON.parse(badNew.stdout).error.code, 'usage.bad-backend');

  const badFilm = runIn(ROOT, 'tools/film/cli.mjs', ['new', 'b', 'bad-webgpu', '--backend', 'webgpu', '--json']);
  assert.equal(badFilm.status, 2, badFilm.stderr);
  assert.equal(JSON.parse(badFilm.stdout).error.code, 'usage.bad-backend');

  for (const route of ['a', 'c']) {
    const name = `dry-m7-${route}`;
    const r = runIn(ROOT, 'tools/film/cli.mjs', ['new', route, name, '--title', '破晓', '--backend', 'webgpu', '--dry-run', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.data.film.backend, 'webgpu');
    assert.equal(j.data.filmJson.entry, 'offscreen.mjs');
    const rels = j.data.files.map(f => f.path);
    assert.ok(rels.includes(`films/${name}/offscreen.mjs`), `${route} 应包含 offscreen.mjs`);
    assert.ok(!rels.includes(`films/${name}/index.html`), `${route} 纯 webgpu 脚手架不应含 index.html`);
    assert.equal(fs.existsSync(path.join(ROOT, 'films', name)), false);
  }
});

test('C 路线 --backend webgpu：新建作品 → 禁用浏览器跑 film check、offscreen probe --events-out 与 qa texts', { skip: skipGpu || false }, t => {
  const repo = makeRepoSandbox(t);
  const name = 'm7-c-cloud';
  const envNoChrome = { BEIMING_CHROME: '/nonexistent/no-browser', BEIMING_GPU: 'software-ok' };

  const n = runIn(repo, 'tools/film/cli.mjs', ['new', 'c', name, '--title', '云山', '--backend', 'webgpu', '--json'], envNoChrome);
  assert.equal(n.status, 0, n.stderr);
  assert.equal(JSON.parse(n.stdout).data.validation.status, 'passed');

  const chk = runIn(repo, 'tools/film/cli.mjs', ['check', `films/${name}`, '--json'], envNoChrome);
  assert.equal(chk.status, 0, `${chk.stderr}\n${chk.stdout}`);
  const cj = JSON.parse(chk.stdout);
  assert.equal(cj.data.checks.find(c => c.id === 'offscreen')?.status, 'pass');

  const evTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-m7-ev-'));
  t.after(() => fs.rmSync(evTmp, { recursive: true, force: true }));
  const pr = runIn(repo, 'engine/offscreen/cli.mjs', ['probe', `films/${name}/offscreen.mjs`, '--events-out', evTmp, '--json'], envNoChrome);
  assert.equal(pr.status, 0, pr.stderr);
  const evDoc = JSON.parse(fs.readFileSync(path.join(evTmp, 'events.json'), 'utf8'));
  assert.equal(evDoc.dur, 8);
  assert.ok(Array.isArray(evDoc.ev) && evDoc.ev.length >= 6);
  assert.ok(fs.existsSync(path.join(evTmp, 'timeline.json')));

  const qa = runIn(repo, 'tools/qa/cli.mjs', ['texts', '--film', `films/${name}`, '--size', '640x360', '--json'], envNoChrome);
  assert.equal(qa.status, 0, `${qa.stderr}\n${qa.stdout}`);
  assert.equal(JSON.parse(qa.stdout).ok, true);
});

test('A 路线 --backend webgpu：新建作品 → 禁用浏览器跑 film check、qa texts 与 qa plates', { skip: skipGpu || false }, t => {
  const repo = makeRepoSandbox(t);
  const name = 'm7-a-dawn';
  const envNoChrome = { BEIMING_CHROME: '/nonexistent/no-browser', BEIMING_GPU: 'software-ok' };

  const n = runIn(repo, 'tools/film/cli.mjs', ['new', 'a', name, '--title', '晨渡', '--backend', 'webgpu', '--json'], envNoChrome);
  assert.equal(n.status, 0, n.stderr);
  fs.cpSync(path.join(ROOT, 'films/chendu/fonts'), path.join(repo, 'films', name, 'fonts'), { recursive: true });

  const chk = runIn(repo, 'tools/film/cli.mjs', ['check', `films/${name}`, '--json'], envNoChrome);
  assert.equal(chk.status, 0, `${chk.stderr}\n${chk.stdout}`);
  assert.equal(JSON.parse(chk.stdout).data.checks.find(c => c.id === 'offscreen')?.status, 'pass');

  const qt = runIn(repo, 'tools/qa/cli.mjs', ['texts', '--film', `films/${name}`, '--size', '640x360', '--json'], envNoChrome);
  assert.equal(qt.status, 0, `${qt.stderr}\n${qt.stdout}`);
  assert.equal(JSON.parse(qt.stdout).ok, true);

  const qp = runIn(repo, 'tools/qa/cli.mjs', ['plates', '--film', `films/${name}`, '--size', '640x360', '--json'], envNoChrome);
  assert.equal(qp.status, 0, `${qp.stderr}\n${qp.stdout}`);
  assert.equal(JSON.parse(qp.stdout).ok, true);
});
