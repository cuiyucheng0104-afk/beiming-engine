// 渲染器 v2 · R4 镜头级缓存、续跑与局部重渲（DF-M 的前置）：在临时“迷你仓库”里跑 tests/render/fixtures/shots（三个镜头，各自一个模块）。
//   - 第二次跑全部命中缓存，0 帧重渲；只改 S2 的模块只重渲 S2；改共享模块三个都重渲；改 film.json 里 S3 的事件只重渲 S3
//   - shots.mjs 逐镜头拼出的成片与 video.mjs 整片渲染逐帧相同（块的切法相同）
//   - --frames 72:120 只出 48 帧（区间跨镜头）；--shot S2 只出 S2 的 24 帧
//   - video.mjs --resume：中途被杀后再跑，只补渲没完成的块，成片与一次跑完逐帧相同；进度事件是 NDJSON
// 没装 FFmpeg 或浏览器时整组跳过。
//   node --test tests/render/shots.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, skip, frames, framemd5, miniRepo, segs, posix } from './helpers.mjs';

const json = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`stdout 不是一个 JSON 对象：\n${r.stdout}\n${r.log}`); } };
const edit = (file, from, to) => { const s = readFileSync(file, 'utf8'); assert.ok(s.includes(from), `${file} 里没有 ${from}`); writeFileSync(file, s.replace(from, to)); };

test('镜头缓存：命中 0 帧重渲；只改一个镜头的模块只重渲它；改共享模块全部重渲；成片与整片渲染逐帧相同', { skip, timeout: 300000 }, async t => {
  const m = miniRepo('shots', 'sx');
  try {
    const out = join(m.film, 'out', 'cut.mp4');
    const shots = (...extra) => run(m.script('shots.mjs'), [m.film, '--out', out, '--json', '--progress', 'none', ...extra], { cwd: m.repo });
    const rendered = r => json(r).data.renderedFrames;
    const cached = r => json(r).data.shots.filter(s => s.cached).map(s => s.id);

    const first = await shots();
    assert.equal(first.code, 0, first.log);
    assert.equal(rendered(first), 72);
    assert.equal(frames(out), 72);
    const md5First = framemd5(out);

    await t.test('第二次：三个镜头都命中缓存，0 帧重渲，成片逐帧相同', async () => {
      const r = await shots();
      assert.equal(r.code, 0, r.log);
      assert.equal(rendered(r), 0);
      assert.deepEqual(cached(r), ['S1', 'S2', 'S3']);
      assert.deepEqual(framemd5(out), md5First);
    });
    await t.test('与 video.mjs 整片渲染逐帧相同（块的切法相同）', async () => {
      const whole = join(m.base, 'whole.mp4');
      const r = await run(m.script('video.mjs'), [m.film, '--out', whole, '--progress', 'none'], { cwd: m.repo });
      assert.equal(r.code, 0, r.log);
      assert.deepEqual(framemd5(whole), md5First);
    });
    await t.test('只改 S2 的模块：只重渲 S2 的 24 帧', async () => {
      edit(join(m.film, 'shots', 's2.js'), "'#3c8cc8'", "'#3cc88c'");
      const r = await shots();
      assert.equal(r.code, 0, r.log);
      assert.equal(rendered(r), 24);
      assert.deepEqual(cached(r), ['S1', 'S3']);
      const now = framemd5(out);
      assert.deepEqual(now.slice(0, 24), md5First.slice(0, 24));
      assert.deepEqual(now.slice(48), md5First.slice(48));
      assert.notDeepEqual(now.slice(24, 48), md5First.slice(24, 48));
    });
    await t.test('改 film.json 里 S3 的事件：只重渲 S3', async () => {
      const f = join(m.film, 'film.json');
      const j = JSON.parse(readFileSync(f, 'utf8'));
      j.events.push({ id: 'late', frame: 60, shot: 'S3', visual: 'flash' });
      writeFileSync(f, JSON.stringify(j, null, 2));
      const r = await shots();
      assert.equal(r.code, 0, r.log);
      assert.equal(rendered(r), 24);
      assert.deepEqual(cached(r), ['S1', 'S2']);
    });
    await t.test('改共享模块 shared.js：三个镜头都重渲', async () => {
      edit(join(m.film, 'shared.js'), "'#20242c'", "'#24202c'");
      const r = await shots();
      assert.equal(r.code, 0, r.log);
      assert.equal(rendered(r), 72);
    });
    await t.test('--shots S1 --force：只重渲 S1，不拼成片也行', async () => {
      const r = await run(m.script('shots.mjs'), [m.film, '--shots', 'S1', '--force', '--json', '--progress', 'none'], { cwd: m.repo });
      assert.equal(r.code, 0, r.log);
      assert.equal(rendered(r), 24);
    });
    await t.test('不认识的镜头：用法错误，列出可用的', async () => {
      const r = await run(m.script('shots.mjs'), [m.film, '--shots', 'S9', '--json'], { cwd: m.repo });
      assert.equal(r.code, 2, r.log);
      assert.equal(json(r).error.code, 'usage.shot-unknown');
      assert.match(json(r).error.hint, /S1 \/ S2 \/ S3/);
    });
    assert.deepEqual(readdirSync(join(m.film, 'out', 'cache', 'shots')).filter(n => n.startsWith('.work-')), [], '工作目录要删掉');
  } finally { m.cleanup(); }
});

test('区间与镜头：--frames 72:120 只出 48 帧（跨镜头）；--shot S2 只出 S2 的 24 帧', { skip, timeout: 180000 }, async () => {
  const m = miniRepo('shots', 'sx');
  try {
    // 镜头表拉长到 144 帧（S3 延到 144），页面时长按 film.json 推出
    const f = join(m.film, 'film.json');
    const j = JSON.parse(readFileSync(f, 'utf8'));
    j.output.frameCount = 144; j.shots[2].out = 144;
    writeFileSync(f, JSON.stringify(j, null, 2));
    const a = await run(m.script('video.mjs'), [m.film, '--frames', '72:120', '--out', join(m.base, 'a.mp4'), '--json', '--progress', 'none'], { cwd: m.repo });
    assert.equal(a.code, 0, a.log);
    assert.equal(frames(join(m.base, 'a.mp4')), 48);
    assert.deepEqual(json(a).data.range, [72, 120]);
    const b = await run(m.script('video.mjs'), [m.film, '--shot', 'S2', '--out', join(m.base, 'b.mp4'), '--json', '--progress', 'none'], { cwd: m.repo });
    assert.equal(b.code, 0, b.log);
    assert.equal(frames(join(m.base, 'b.mp4')), 24);
    const c = await run(m.script('video.mjs'), [m.film, '--shot', 'S2', '--frames', '0:5', '--out', join(m.base, 'c.mp4'), '--json'], { cwd: m.repo });
    assert.equal(c.code, 2, c.log);
    assert.equal(json(c).error.code, 'usage.conflict');
  } finally { m.cleanup(); }
});

test('续跑：--resume 时中途被杀，再跑只补渲没完成的块，成片与一次跑完逐帧相同；--progress ndjson 每行一个 JSON 事件', { skip: skip || (!posix && '需要 POSIX 信号'), timeout: 300000 }, async () => {
  const m = miniRepo('page', 'slow');
  try {
    const out = join(m.base, 'r.mp4');
    const args = [m.film, '--size', '64x64', '--chunk', '24', '--workers', '1', '--query', 'dur=4&slow=40', '--out', out, '--resume', '--json'];
    // 第一次：等第一块写完（parts 目录里出现块的旁注文件）就 SIGTERM
    const first = await run(m.script('video.mjs'), [...args, '--progress', 'ndjson'], {
      cwd: m.repo, timeout: 60000,
      onStart: p => {
        const poll = setInterval(() => {
          if (p.exitCode !== null) return clearInterval(poll);
          const parts = `${out}.parts`;
          if (existsSync(parts) && readdirSync(parts).some(n => n.endsWith('.mp4.json'))) { clearInterval(poll); process.kill(p.pid, 'SIGTERM'); }
        }, 50);
      },
    });
    assert.equal(first.code, 143, first.log);
    // 进度与日志是每行一个 JSON；命令约定库收尾时另打的「错误[…]／提示」两行是给人看的纯文本（docs/CLI.md 第 2 节），解析时跳过
    const lines = first.stderr.split('\n').filter(Boolean);
    const events = lines.filter(l => l.startsWith('{')).map(l => JSON.parse(l));
    assert.ok(lines.filter(l => !l.startsWith('{')).every(l => /^(错误|提示)/.test(l)), lines.join('\n'));
    assert.ok(events.some(e => e.event === 'progress' && Number.isInteger(e.done) && e.total === 96), '进度事件');
    assert.ok(existsSync(`${out}.parts`), '--resume 时块目录要保留');
    assert.equal(existsSync(out), false);
    const second = await run(m.script('video.mjs'), [...args, '--progress', 'none'], { cwd: m.repo, timeout: 120000 });
    assert.equal(second.code, 0, second.log);
    const env = json(second);
    assert.ok(env.data.reusedChunks >= 1, `复用了 ${env.data.reusedChunks} 块`);
    assert.ok(env.data.renderedFrames < 96);
    assert.equal(existsSync(`${out}.parts`), false, '成功后块目录删掉（没加 --keep-segments）');
    const once = join(m.base, 'once.mp4');
    const third = await run(m.script('video.mjs'), [m.film, '--size', '64x64', '--chunk', '24', '--workers', '1', '--query', 'dur=4', '--out', once, '--progress', 'none'], { cwd: m.repo, timeout: 120000 });
    assert.equal(third.code, 0, third.log);
    assert.deepEqual(framemd5(out), framemd5(once));
    assert.deepEqual(segs(m.base), []);
  } finally { m.cleanup(); }
});
