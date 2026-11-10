// 渲染器 v2 · 成功路径（R2 运行记录与档位、R3 编码链）：真的启动无头 Chrome 与 FFmpeg，在临时目录或临时“迷你仓库”里出片，不碰本仓库。
//   - 帧准确：测试片把帧号画成左上角的二进制色块，解码后逐帧读回——不丢帧、不重复、末帧在；--frames 只出区间；--workers 不改成片
//   - 色彩：色卡按有限范围 BT.709 编码并写明三项标记，按标记解码后每个色块与原 sRGB 值相差不超过 2 级
//   - 运行记录（附录 C8）：设备、图形后端、软件渲染与否、输出规格、逐帧哈希；status 只写 running（stage=rendered），QA 之后才是 passed
//   - 运行目录（附录 C4）：不写 --out 时出到 films/<名>/out/<运行号>/master.mp4，更新 out/latest 指针；AIGC 隐式标识写进成片
//   - still --frame N 与 video 第 N 帧是同一张图（截图哈希相同）；--texts 读回文字报告并核对形状
//   - 封装（lib/mux.mjs）：帧率 / 帧数不符退出码 4、画面能拷贝就拷贝、响度 −14±0.5 LUFS、真峰值 ≤ −1.0 dBTP、无声片
// 没装 FFmpeg 或浏览器时整组跳过。
//   node --test tests/render/pipeline.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, skip, tmp, segs, FIX, posix, probe, frames, framemd5, miniRepo } from './helpers.mjs';
import { parseImplicitLabel } from '../../tools/compliance/lib/aigc.mjs';

const PAGE = `${FIX}/page`;
const json = r => { try { return JSON.parse(r.stdout); } catch { throw new Error(`stdout 不是一个 JSON 对象：\n${r.stdout}\n${r.log}`); } };
const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');

/** 解码成 8 位灰度，读左上角 8 个 8×8 色块（白 = 1）得到每帧画的帧号 */
function frameNumbers(file, w = 64, h = 64) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 28 });
  const n = buf.length / (w * h), out = [];
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) if (buf[i * w * h + 4 * w + b * 8 + 4] > 128) v |= 1 << b;
    out.push(v);
  }
  return out;
}

test('video.mjs：帧准确、色彩标记、运行记录（附录 C8）、--frames 只出区间、--workers 不改成片', { skip, timeout: 240000 }, async t => {
  const dir = tmp();
  try {
    const out = join(dir, 'v.mp4');
    const r = await run('engine/render/video.mjs', [PAGE, '--size', '64x64', '--workers', '3', '--out', out, '--json', '--progress', 'none']);
    assert.equal(r.code, 0, r.log);
    const env = json(r);
    assert.equal(env.ok, true);
    assert.equal(env.outputs[0].kind, 'video');
    assert.equal(env.outputs[0].sha256, sha(out));
    assert.equal(env.data.frames, 24);
    await t.test('帧号逐帧读回：0…23，不丢不重，末帧在', () => {
      assert.deepEqual(frameNumbers(out), Array.from({ length: 24 }, (_, i) => i));
    });
    await t.test('yuv420p、有限范围、BT.709 三项标记', () => {
      const info = probe(out, 'stream=pix_fmt,color_range,color_space,color_primaries,color_transfer,codec_name');
      for (const want of ['codec_name=h264', 'pix_fmt=yuv420p', 'color_range=tv', 'color_space=bt709', 'color_primaries=bt709', 'color_transfer=bt709']) assert.ok(info.includes(want), info);
    });
    await t.test('运行记录：实测设备与后端、输出规格、逐帧哈希；渲染器不写 passed', () => {
      const rec = JSON.parse(readFileSync(`${out}.run.json`, 'utf8'));
      assert.equal(rec.schemaVersion, 1);
      assert.equal(rec.status, 'running');
      assert.equal(rec.stage, 'rendered');
      assert.equal(typeof rec.actualDevice, 'string');
      assert.ok(rec.actualDevice.length > 0);
      assert.match(rec.actualGraphicsBackend, /^ANGLE /);
      assert.equal(typeof rec.softwareFallback, 'boolean');
      assert.match(rec.actualEncoder, /libx264/);
      assert.deepEqual([rec.output.frames, rec.output.width, rec.output.height, rec.output.fps], [24, 64, 64, 24]);
      assert.equal(rec.output.sha256, sha(out));
      assert.equal(rec.output.pixFmt, 'yuv420p');
      assert.deepEqual(rec.output.color, { range: 'tv', space: 'bt709', primaries: 'bt709', transfer: 'bt709' });
      assert.equal(rec.frameHashes.values.length, 24);
      assert.ok(rec.frameHashes.values.every(h => /^[0-9a-f]{16}$/.test(h)));
      assert.equal(rec.technicalAcceptance.status, 'not-run');
      assert.equal(rec.creativeAcceptance.status, 'not-reviewed');
      for (const k of ['node', 'playwright', 'browser', 'ffmpeg']) assert.ok(rec.tools[k], `tools.${k}`);
      assert.ok(Array.isArray(rec.argv));
      assert.ok(rec.timing.totalSeconds > 0);
    });
    await t.test('--frames 5:13 只出 8 帧，内容就是第 5–12 帧', async () => {
      const o = join(dir, 'part.mp4');
      const p = await run('engine/render/video.mjs', [PAGE, '--size', '64x64', '--frames', '5:13', '--out', o, '--progress', 'none']);
      assert.equal(p.code, 0, p.log);
      assert.deepEqual(frameNumbers(o), [5, 6, 7, 8, 9, 10, 11, 12]);
      assert.equal(JSON.parse(readFileSync(`${o}.run.json`, 'utf8')).output.frames, 8);
    });
    await t.test('--workers 1 与 3 的成片逐帧相同（块的边界与路数无关）', async () => {
      const o = join(dir, 'w1.mp4');
      const p = await run('engine/render/video.mjs', [PAGE, '--size', '64x64', '--workers', '1', '--out', o, '--progress', 'none']);
      assert.equal(p.code, 0, p.log);
      assert.deepEqual(framemd5(o), framemd5(out));
    });
    await t.test('still --frame N 与 video 第 N 帧是同一张图（无损截图哈希相同）', async () => {
      const s = await run('engine/render/still.mjs', [PAGE, '--frame', '0,7,23', '--size', '64x64', '--out', join(dir, 'st'), '--json']);
      assert.equal(s.code, 0, s.log);
      const values = JSON.parse(readFileSync(`${out}.run.json`, 'utf8')).frameHashes.values;
      for (const n of [0, 7, 23]) assert.equal(sha(join(dir, 'st', `f${String(n).padStart(6, '0')}.png`)).slice(0, 16), values[n], `第 ${n} 帧`);
    });
    assert.deepEqual(segs(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('色卡：有限范围 BT.709 全链路，按标记解码后每个色块与原值相差不超过 2 级', { skip, timeout: 120000 }, async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'c.mp4');
    const r = await run('engine/render/video.mjs', [`${FIX}/colorchart`, '--size', '128x64', '--out', out, '--progress', 'none']);
    assert.equal(r.code, 0, r.log);
    const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-frames:v', '1', '-vf',
      'scale=in_range=limited:in_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
    const patches = [[16, 16, 16], [128, 128, 128], [235, 235, 235], [255, 255, 255], [224, 172, 140], [96, 160, 220], [40, 92, 64], [200, 60, 40]];
    let worst = 0;
    patches.forEach((want, i) => {
      for (let y = 6; y < 26; y++) for (let x = 6; x < 26; x++) {
        const px = (Math.floor(i / 4) * 32 + y) * 128 + (i % 4) * 32 + x;
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(rgb[px * 3 + c] - want[c]));
      }
    });
    assert.ok(worst <= 2, `色块最大误差 ${worst} 级`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('运行目录（附录 C4）：不写 --out 时出到 films/<名>/out/<运行号>/master.mp4，更新 latest 指针；film.json 声明 AIGC 时成片带隐式标识', { skip, timeout: 180000 }, async () => {
  const m = miniRepo('page', 'demo');
  try {
    const git = (...a) => execFileSync('git', ['-C', m.repo, ...a], { encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    writeFileSync(join(m.film, 'film.json'), JSON.stringify({ schemaVersion: 2, id: 'demo', title: '测试', route: 'c', backend: 'canvas',
      output: { width: 64, height: 64, fps: 24, frameCount: 24 }, aigc: { contains: true, kinds: ['visual'], tools: ['测试工具'] } }));
    const r = await run(m.script('video.mjs'), [m.film, '--json', '--progress', 'none'], { cwd: m.repo });
    assert.equal(r.code, 0, r.log);
    const env = json(r);
    const id = env.data.runId;
    assert.match(id, /^\d{8}-\d{6}-[0-9a-f]{7}(-dirty)?$/);
    assert.equal(env.data.runDir, `films/demo/out/${id}`);
    assert.equal(readFileSync(join(m.film, 'out', 'latest'), 'utf8'), `${id}\n`);
    const master = join(m.film, 'out', id, 'master.mp4');
    assert.equal(frames(master), 24);
    assert.equal(env.runJson, `films/demo/out/${id}/run.json`);
    const rec = JSON.parse(readFileSync(join(m.film, 'out', id, 'run.json'), 'utf8'));
    assert.deepEqual([rec.projectId, rec.route, rec.backend, rec.runId], ['demo', 'c', 'canvas', id]);
    assert.equal(rec.output.path, `films/demo/out/${id}/master.mp4`);
    const comment = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=comment', '-of', 'json', master], { encoding: 'utf8' })).format.tags.comment;
    const label = parseImplicitLabel(comment);
    assert.equal(label.ok, true, label.problems.join('；'));
    assert.equal(label.fields.ProduceID, `demo@${id}`);
    assert.match(label.statement, /含 AI 生成画面（生成工具：测试工具）/);
    assert.equal(rec.aigc.comment, comment);
    assert.deepEqual(readdirSync(join(m.film, 'out', id)).sort(), ['master.mp4', 'run.json']);
  } finally { m.cleanup(); }
});

test('still.mjs --texts：读回 window.TEXTS 并核对页面约定 v1 的形状（box、alpha、font）', { skip, timeout: 120000 }, async () => {
  const dir = tmp();
  try {
    const good = await run('engine/render/still.mjs', [PAGE, '--frame', '3', '--size', '64x64', '--texts', '--query', 'texts=good', '--out', join(dir, 'g'), '--json']);
    assert.equal(good.code, 0, good.log);
    assert.deepEqual(json(good).data.texts, [{ name: 'f000003.png', entries: 1, problems: [] }]);
    const rec = JSON.parse(readFileSync(join(dir, 'g', 'still.run.json'), 'utf8'));
    assert.deepEqual(rec.texts[0].entries, [{ text: '第3帧', box: [0, 8, 64, 16], alpha: 1, font: '12px sans-serif' }]);
    const legacy = await run('engine/render/still.mjs', [PAGE, '--frame', '3', '--size', '64x64', '--texts', '--query', 'texts=legacy', '--out', join(dir, 'l'), '--json']);
    assert.equal(legacy.code, 0, legacy.log);
    const e = json(legacy);
    assert.ok(e.warnings.some(w => w.code === 'texts-shape' && /旧写法/.test(w.message)), JSON.stringify(e.warnings));
    assert.ok(e.data.texts[0].problems.some(p => /缺 alpha/.test(p)) && e.data.texts[0].problems.some(p => /缺 font/.test(p)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--plan：试渲几帧给出耗时与磁盘估算，不写任何输出', { skip, timeout: 120000 }, async () => {
  const dir = tmp();
  try {
    const r = await run('engine/render/video.mjs', [PAGE, '--size', '64x64', '--plan', '--out', join(dir, 'x', 'v.mp4'), '--json']);
    assert.equal(r.code, 0, r.log);
    const p = json(r).data.plan;
    assert.equal(p.frames, 24);
    assert.ok(p.estSeconds > 0 && p.renderCaptureMs >= 0 && p.bytesPerFrame > 0, JSON.stringify(p));
    assert.deepEqual(readdirSync(join(dir, 'x')), [], '--plan 不留文件');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('封装 lib/mux.mjs：帧率 / 帧数不符退出码 4；画面拷贝不重编码；响度 −14±0.5、真峰值 ≤ −1.0；无声片；AIGC 标识', { skip, timeout: 180000 }, async t => {
  const dir = tmp();
  const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
  const mux = (...a) => run('engine/render/lib/mux.mjs', [...a, '--json']);
  const loud = file => {
    const m = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const get = k => Number([...m.matchAll(new RegExp(`^\\s+${k}:\\s+(-?[\\d.]+)`, 'gm'))].at(-1)?.[1]);
    return { I: get('I'), TP: get('Peak') };
  };
  const vmd5 = f => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' }).trim();
  try {
    // 完整标记要靠 setparams：FFmpeg 8 只给输出参数时，原色与传递特性仍是 unknown（与 video.mjs 的做法相同）
    const tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
    const vf = 'format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
    ff('-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=24', '-frames:v', '48', '-vf', vf, '-c:v', 'libx264', '-crf', '20', ...tags, join(dir, 'v24.mp4'));
    ff('-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=25', '-frames:v', '50', '-vf', vf, '-c:v', 'libx264', '-crf', '20', ...tags, join(dir, 'v25.mp4'));
    ff('-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=24', '-frames:v', '48', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-crf', '20', join(dir, 'untagged.mp4'));
    ff('-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(2*PI*440*t)*(0.6+0.4*sin(2*PI*0.7*t)):s=48000:d=2:c=stereo', join(dir, 'a.wav'));
    ff('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2', join(dir, 'silent.wav'));
    await t.test('25 fps 的画面按 24 封装：退出码 4，不留半成品', async () => {
      const r = await mux(join(dir, 'v25.mp4'), join(dir, 'a.wav'), join(dir, 'x.mp4'), '24', '0');
      assert.equal(r.code, 4, r.log);
      assert.equal(json(r).error.code, 'contract.input-fps-mismatch');
      assert.equal(existsSync(join(dir, 'x.mp4')), false);
      assert.deepEqual(readdirSync(dir).filter(n => n.includes('.partial')), []);
    });
    await t.test('--frames 与输入不符：退出码 4', async () => {
      const r = await mux(join(dir, 'v24.mp4'), join(dir, 'a.wav'), join(dir, 'x.mp4'), '--frames', '47');
      assert.equal(r.code, 4, r.log);
      assert.equal(json(r).error.code, 'contract.input-frames-mismatch');
    });
    await t.test('静音的混音：退出码 4（无声片要写 -）', async () => {
      const r = await mux(join(dir, 'v24.mp4'), join(dir, 'silent.wav'), join(dir, 'x.mp4'));
      assert.equal(r.code, 4, r.log);
      assert.equal(json(r).error.code, 'contract.audio-silent');
    });
    await t.test('已完整标记的 BT.709 画面：视频轨原样拷贝；响度 −14±0.5、真峰值 ≤ −1.0；AIGC 标识写进 comment', async () => {
      writeFileSync(join(dir, 'film.json'), JSON.stringify({ id: 'muxdemo', aigc: { contains: true, kinds: ['visual', 'music'] } }));
      const r = await mux(join(dir, 'v24.mp4'), join(dir, 'a.wav'), join(dir, 'o.mp4'), '24', '0', '--film', join(dir, 'film.json'), '--produce-id', 'muxdemo@test');
      assert.equal(r.code, 0, r.log);
      const env = json(r);
      assert.equal(env.data.video.copied, true);
      assert.equal(vmd5(join(dir, 'o.mp4')), vmd5(join(dir, 'v24.mp4')), '视频码流应逐字节相同');
      const l = loud(join(dir, 'o.mp4'));
      assert.ok(Math.abs(l.I + 14) <= 0.5, `I=${l.I}`);
      assert.ok(l.TP <= -1.0, `TP=${l.TP}`);
      const label = parseImplicitLabel(env.data.aigc.comment);
      assert.equal(label.ok, true, label.problems.join('；'));
      assert.equal(label.fields.ProduceID, 'muxdemo@test');
      assert.match(label.statement, /含 AI 生成画面；配乐含 AI 生成/);
      assert.equal(frames(join(dir, 'o.mp4')), 48);
    });
    await t.test('没有色彩标记的画面：换算成有限范围 BT.709 并写明三项标记（重编码一次）', async () => {
      const r = await mux(join(dir, 'untagged.mp4'), join(dir, 'a.wav'), join(dir, 'u.mp4'));
      assert.equal(r.code, 0, r.log);
      assert.equal(json(r).data.video.copied, false);
      const info = probe(join(dir, 'u.mp4'), 'stream=nb_read_packets,color_range,color_space,color_primaries,color_transfer');
      for (const want of ['nb_read_packets=48', 'color_range=tv', 'color_space=bt709', 'color_primaries=bt709', 'color_transfer=bt709']) assert.ok(info.includes(want), info);
    });
    await t.test('无声片（音频写 -）：只有画面，帧数不变', async () => {
      const r = await mux(join(dir, 'v24.mp4'), '-', join(dir, 's.mp4'));
      assert.equal(r.code, 0, r.log);
      assert.equal(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', join(dir, 's.mp4')], { encoding: 'utf8' }).trim(), 'video');
    });
    if (posix) {
      await t.test('mux.sh 兼容壳：参数原样转交（--help 退出 0）', () => {
        const r = spawnSync('sh', ['engine/render/mux.sh', '--help'], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /用法：node engine\/render\/lib\/mux\.mjs/);
      });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Vulkan 显示层残留的回归页：--settle raf2 时奇数帧左上角不残留上一帧的白块', { skip, timeout: 120000 }, async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'r.mp4');
    const r = await run('engine/render/video.mjs', [`${FIX}/residue`, '--size', '64x64', '--settle', 'raf2', '--out', out, '--progress', 'none']);
    assert.equal(r.code, 0, r.log);
    const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 });
    for (let f = 0; f < 24; f++) {
      const y = buf[f * 64 * 64 + 8 * 64 + 8];
      if (f % 2) assert.ok(y < 200, `第 ${f} 帧左上角是 ${y}（上一帧的白块残留）`);
      else assert.ok(y > 200, `第 ${f} 帧左上角应是白块，读到 ${y}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
