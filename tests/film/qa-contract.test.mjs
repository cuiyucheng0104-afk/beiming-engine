// 编排器与机器 QA 门的口径（不开浏览器，几秒；要 ffmpeg / ffprobe，没有就跳过）：node --test tests/film/qa-contract.test.mjs
// 复核意见的 must：--profile 换成竖屏 30 fps 时，交给 QA 的若仍是原 film.json，真 QA 的 delivery.frame-count / frame-rate /
// duration / size 四项硬门必然不过（QA 有意要求作品描述与档位一致）。这里不渲染页面，直接合成一段 1080×1920@30 × 90 帧的成片：
//   1. 原 film.json（1920×1080@24 × 72）+ 竖屏档位 → 真 QA 这四项都不过（复现问题）；
//   2. 编排器写的生效描述 film.effective.json + 竖屏档位 → 真 QA 这四项都通过（修好了）；
//   3. 测试替身 qa-stub 对同样两种输入给出与真 QA 相同的结论（替身与真 QA 同一口径，端到端测试才不会再把问题盖住）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, QA_STUB } from './helpers.mjs';
import { ffmpegBins } from '../../tools/env/lib/ffmpeg.mjs';
import { parseFilm } from '../../tools/film/lib/spec.mjs';
import { writeEffectiveFilm } from '../../tools/film/lib/effective.mjs';

const { ffmpeg, ffprobe } = ffmpegBins(process.env);
const has = bin => spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0;
const skip = has(ffmpeg) && has(ffprobe) ? false : '没有 ffmpeg / ffprobe（设 FFMPEG / FFPROBE 或装进 PATH）';
const QA = path.join(ROOT, 'tools/qa/cli.mjs');
const SPEC_CHECKS = ['delivery.frame-count', 'delivery.frame-rate', 'delivery.duration', 'delivery.size'];
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function qa(cli, args) {
  const r = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FFMPEG: ffmpeg, FFPROBE: ffprobe }, timeout: 300000 });
  let env = null;
  try { env = JSON.parse(r.stdout); } catch { /* 下面断言 */ }
  assert.ok(env?.result?.checks, `${path.basename(cli)} ${args[0]} 没给出报告（退出码 ${r.status}）：${r.stderr.slice(-800)}`);
  return { code: r.status, status: Object.fromEntries(env.result.checks.map(c => [c.id, c.status])), report: env.result };
}

test('竖屏档位：真 QA 拿原 film.json 四项交付硬门必然不过，拿生效描述就通过；测试替身与真 QA 结论一致', { skip, timeout: 600000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'film-qa-contract-'));
  dirs.push(dir);
  const raw = {
    schemaVersion: 2, id: 'qa-contract', title: '口径', route: 'c', backend: 'canvas',
    output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 72 },
    shots: [{ id: 'S1', in: 0, out: 36 }, { id: 'S2', in: 36, out: 72 }], events: [], audio: { mode: 'none' },
    deliveries: ['web-1080p24'], aigc: { contains: false, note: '测试' },
  };
  fs.writeFileSync(path.join(dir, 'film.json'), JSON.stringify(raw, null, 2));
  // 编排器按竖屏档位出的成片：1080×1920、30 fps、90 帧（3 秒），BT.709 有限范围，无声（audio.mode = none）
  const mp4 = path.join(dir, 'master.mp4');
  const enc = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-frames:v', '90',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', mp4], { encoding: 'utf8' });
  assert.equal(enc.status, 0, enc.stderr);
  const film = parseFilm(raw, { dir });
  const eff = writeEffectiveFilm(dir, film, { profileId: 'vertical-1080x1920-30', width: 1080, height: 1920, fps: 30, frames: 90 });
  const profile = ['--profile', 'vertical-1080x1920-30'];

  const realOld = qa(QA, ['delivery', mp4, '--film', path.join(dir, 'film.json'), ...profile]);
  const realNew = qa(QA, ['delivery', mp4, '--film', eff.path, ...profile]);
  for (const id of SPEC_CHECKS) {
    assert.equal(realOld.status[id], 'fail', `真 QA 拿原 film.json：${id} 应当不过（复现复核的问题）`);
    assert.equal(realNew.status[id], 'pass', `真 QA 拿生效描述：${id} 应当通过，实际 ${realNew.status[id]}`);
  }
  // 测试替身：同样两种输入，四项结论与真 QA 相同（out 目录放在临时目录里）
  const stubOld = qa(QA_STUB, ['report', mp4, '--film', path.join(dir, 'film.json'), '--out', path.join(dir, 'qa-old'), ...profile]);
  const stubNew = qa(QA_STUB, ['report', mp4, '--film', eff.path, '--out', path.join(dir, 'qa-new'), ...profile]);
  for (const id of SPEC_CHECKS) {
    assert.equal(stubOld.status[id], realOld.status[id], `替身与真 QA 对 ${id}（原 film.json）结论不同`);
    assert.equal(stubNew.status[id], realNew.status[id], `替身与真 QA 对 ${id}（生效描述）结论不同`);
  }
  assert.equal(stubOld.code, 4);
  assert.equal(stubNew.code, 0, JSON.stringify(stubNew.report.checks.filter(c => c.status === 'fail')));
});
