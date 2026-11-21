// 出片链声音闭环测试：Route C / Route A 新模版混音与分轨门禁、声音 QA 硬失败前置拦截（不跑 video）、对白自动构建与画面遥测接线。
// 在系统临时目录搭隔离仓库沙盒运行（与 tests/offscreen/webgpu-scaffold.test.mjs 同法），并发跑 tests/film/*.test.mjs 时完全不触碰根 films/。
//   node --test tests/film/audio-pipeline.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, gitStatus, removeLink } from './helpers.mjs';
import { browserOk } from '../ci/browser.mjs';
import { ffmpegBins } from '../../tools/env/lib/ffmpeg.mjs';

const PY_RUNNER = path.join(ROOT, 'tools/env/py.mjs');
const { ffmpeg, ffprobe } = ffmpegBins(process.env);
const hasBin = bin => spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0;
const hasPyAudio = spawnSync(process.execPath, [PY_RUNNER, '-c', 'import numpy, scipy, soundfile'], { cwd: ROOT, encoding: 'utf8' }).status === 0;
const skipPyAudio = hasPyAudio ? false : '缺少 Python 音频依赖（numpy / scipy / soundfile）';
const skipPipeline = skipPyAudio
  || (!hasBin(ffmpeg) || !hasBin(ffprobe) ? '缺少 ffmpeg / ffprobe' : false)
  || (!browserOk ? '缺少 Playwright 无头浏览器' : false);

// 并发跑 tests/film/*.test.mjs 时，兄弟进程会在根 films/p06t-* 建临时链接并在各自结束时删除；排除该前缀，核查本文件自身零泄漏。
const SIBLING_PREFIXES = ['films/p06t-'];
const statusBefore = new Set(gitStatus(SIBLING_PREFIXES) || []);
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-audio-pipeline-')));
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(SANDBOX, 'package.json'));
for (const rel of ['routes', 'engine', 'tools']) {
  fs.cpSync(path.join(ROOT, rel), path.join(SANDBOX, rel), { recursive: true, filter: src => !src.includes('__pycache__') });
}
const SANDBOX_LINKS = ['node_modules', 'assets', 'media', 'fonts', '.venv'];
for (const rel of SANDBOX_LINKS) {
  if (fs.existsSync(path.join(ROOT, rel))) {
    fs.symlinkSync(path.join(ROOT, rel), path.join(SANDBOX, rel), process.platform === 'win32' ? 'junction' : 'dir');
  }
}
fs.mkdirSync(path.join(SANDBOX, 'films'), { recursive: true });

after(() => {
  for (const rel of SANDBOX_LINKS) removeLink(path.join(SANDBOX, rel));
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

let seq = 0;
function makeWork(route, { title = '自检短片' } = {}) {
  const name = `ap-${route}-${process.pid}-${++seq}`;
  const rel = `films/${name}`;
  const dir = path.join(SANDBOX, rel);
  const r = spawnSync(process.execPath, [path.join(SANDBOX, 'tools/new-film.mjs'), route, name, '--title', title], {
    cwd: SANDBOX,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`new-film 失败：${r.stderr || r.stdout}`);
  return {
    name,
    rel,
    dir,
    cleanup() {
      if (!process.env.FILM_TEST_KEEP) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function sysTmp() {
  return fs.mkdtempSync(path.join(SANDBOX, 'tmp-'));
}

function runSandboxCli(args, { env = {}, timeout = 600000 } = {}) {
  const r = spawnSync(process.execPath, [path.join(SANDBOX, 'tools/film/cli.mjs'), ...args], {
    cwd: SANDBOX,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
    maxBuffer: 64 << 20,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 非单对象时为 null */ }
  return { code: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

function runPy(args, env = {}) {
  return spawnSync(process.execPath, [path.join(SANDBOX, 'tools/env/py.mjs'), ...args], {
    cwd: SANDBOX,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, ...env },
  });
}

test('1. Route C 新建作品跑 film mix：顺序执行 probe → mix → cuecheck，产出 mix.wav / 分轨 / qa.json / cuecheck.txt 且零告警通过', { skip: skipPipeline, timeout: 300000 }, () => {
  const w = makeWork('c');
  const tmp = sysTmp();
  try {
    const r = runSandboxCli(['mix', w.rel, '--gpu', 'software-ok', '--json'], { env: { TMPDIR: tmp, TMP: tmp, TEMP: tmp } });
    assert.equal(r.code, 0, `film mix 退出码 ${r.code}：${r.stderr.slice(-1500)}`);
    assert.ok(r.json?.ok, r.stdout);

    const stepMap = Object.fromEntries(r.json.data.steps.map(s => [s.id, s.status]));
    assert.deepEqual(r.json.data.steps.map(s => s.id), ['probe', 'mix', 'cuecheck']);
    assert.equal(stepMap.probe, 'done');
    assert.equal(stepMap.mix, 'done');
    assert.equal(stepMap.cuecheck, 'done');

    const runDir = path.join(SANDBOX, r.json.data.runDir);
    const mixWav = path.join(runDir, 'audio', 'mix.wav');
    const qaJsonPath = path.join(runDir, 'audio', 'qa.json');
    const cueTxtPath = path.join(runDir, 'audio', 'cuecheck.txt');
    const onsetsPath = path.join(runDir, 'audio', 'score_onsets.json');
    assert.ok(fs.existsSync(mixWav), '缺 audio/mix.wav');
    assert.ok(fs.existsSync(qaJsonPath), '缺 audio/qa.json');
    assert.ok(fs.existsSync(cueTxtPath), '缺 audio/cuecheck.txt');
    assert.ok(fs.existsSync(onsetsPath), '缺 audio/score_onsets.json');

    for (const stem of ['music.wav', 'foley.wav', 'amb.wav']) {
      assert.ok(fs.existsSync(path.join(runDir, 'audio', 'stems', stem)), `缺分轨 ${stem}`);
    }

    const qaReport = JSON.parse(fs.readFileSync(qaJsonPath, 'utf8'));
    assert.equal(qaReport.ok, true, JSON.stringify(qaReport.summary));
    assert.equal(qaReport.summary.fail, 0);
    assert.equal(qaReport.summary.warn, 0, `Route C 模版不应有软告警：${JSON.stringify(qaReport.checks.filter(c => c.status !== 'pass'))}`);
    assert.match(fs.readFileSync(cueTxtPath, 'utf8'), /CUECHECK OK/);

    const strictQa = runPy(['-m', 'engine.audio.qa', '--film', w.dir, '--wav', mixWav, '--fail-on-warn', '--no-report', '--json']);
    assert.equal(strictQa.status, 0, strictQa.stderr);
    assert.equal(JSON.parse(strictQa.stdout).data.ok, true);

    for (const left of ['events.json', 'timeline.json', 'kinematics.json', 'out/mix.wav', 'out/stems', 'out/score_onsets.json']) {
      assert.ok(!fs.existsSync(path.join(w.dir, left)), `作品目录残留 ${left}`);
    }
  } finally {
    w.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('2. Route A 升级版模版 sound.py：通过内部钟声/落笔声帧级起音核对，且四分轨过 engine.audio.qa --fail-on-warn（0 失败 0 告警）', { skip: skipPyAudio, timeout: 180000 }, () => {
  const w = makeWork('a');
  try {
    const s = runPy([path.join(w.dir, 'sound.py'), w.dir]);
    assert.equal(s.status, 0, s.stderr);
    const summary = JSON.parse(s.stdout.trim());
    assert.equal(summary.seconds, 8.0);
    assert.deepEqual(summary.stems, ['amb', 'foley', 'fx', 'music']);
    for (const eid of ['sun-break', 'title-in']) {
      const errF = summary.events?.[eid]?.errFrames;
      assert.ok(typeof errF === 'number' && errF >= -0.25 && errF <= 1.0, `${eid} 起音偏差超限：${errF}`);
    }

    const mixWav = path.join(w.dir, 'out', 'mix.wav');
    assert.ok(fs.existsSync(mixWav));
    for (const stem of ['amb.wav', 'fx.wav', 'foley.wav', 'music.wav']) {
      assert.ok(fs.existsSync(path.join(w.dir, 'out', 'stems', stem)), `缺分轨 ${stem}`);
    }

    const q = runPy(['-m', 'engine.audio.qa', '--film', w.dir, '--wav', mixWav, '--fail-on-warn', '--no-report', '--json']);
    assert.equal(q.status, 0, `${q.stderr}\n${q.stdout}`);
    const env = JSON.parse(q.stdout);
    assert.equal(env.ok, true);
    assert.equal(env.data.ok, true);
    assert.equal(env.data.summary.fail, 0);
    assert.equal(env.data.summary.warn, 0);
    const masking = env.data.checks.find(c => c.id === 'audio.masking');
    assert.ok(masking && masking.status === 'pass', `分轨掩蔽门应参与检查并通过：${JSON.stringify(masking)}`);
  } finally {
    w.cleanup();
  }
});

test('3. 前置快速失败闸门：过载削波或时长错误的 mix.wav 在 film mix 与 film build 中以退出码 4（contract.audio-qa-failed）立即失败，不跑 video', { skip: skipPipeline, timeout: 300000 }, () => {
  const w = makeWork('c');
  const tmp = sysTmp();
  try {
    const fjPath = path.join(w.dir, 'film.json');
    const raw = JSON.parse(fs.readFileSync(fjPath, 'utf8'));
    raw.audio = { mode: 'script', script: 'bad_sound.py', targetLUFS: -14, truePeakDbTP: -1.0 };
    delete raw.cuecheck;
    fs.writeFileSync(fjPath, JSON.stringify(raw, null, 2) + '\n');

    // 3a) 满幅削波 + 直流偏移混音：film build 在 mix 步直接失败，video 步根本不启动
    fs.writeFileSync(path.join(w.dir, 'bad_sound.py'), [
      'import os, numpy as np, soundfile as sf',
      'out = os.environ["BEIMING_AUDIO_OUT"]',
      'os.makedirs(os.path.dirname(out), exist_ok=True)',
      'dur = float(os.environ["BEIMING_DUR"])',
      'sr = 48000',
      't = np.arange(int(round(dur * sr))) / sr',
      'x = np.clip(np.sin(2 * np.pi * 440 * t) * 4.0 + 0.25, -1.0, 1.0)',
      'sf.write(out, np.stack([x, x], 1), sr, subtype="PCM_24")',
    ].join('\n') + '\n');

    const b = runSandboxCli(['build', w.rel, '--gpu', 'software-ok', '--no-cache', '--json'], { env: { TMPDIR: tmp, TMP: tmp, TEMP: tmp } });
    assert.equal(b.code, 4, `过载混音 build 应退出 4，实得 ${b.code}：${b.stderr.slice(-1000)}`);
    assert.equal(b.json?.error?.code, 'contract.audio-qa-failed');
    assert.match(b.json?.error?.message || '', /audio\.overload/);
    assert.ok(b.json?.runJson, '失败时仍应写出 run.json');

    const runRec = JSON.parse(fs.readFileSync(path.join(SANDBOX, b.json.runJson), 'utf8'));
    assert.equal(runRec.error?.step, 'mix');
    assert.ok(!runRec.steps.some(s => s.id === 'video'), `video 步骤不应启动：${JSON.stringify(runRec.steps)}`);
    const runDir = path.join(SANDBOX, runRec.runDir);
    assert.ok(!fs.existsSync(path.join(runDir, 'work', 'video.mp4')), '不该生成 work/video.mp4');
    assert.ok(fs.existsSync(path.join(runDir, 'audio', 'qa.json')), '应留下 audio/qa.json 供排查');

    // 3b) 时长不匹配的混音：film mix 同样退出 4（contract.audio-qa-failed）
    fs.writeFileSync(path.join(w.dir, 'bad_sound.py'), [
      'import os, numpy as np, soundfile as sf',
      'out = os.environ["BEIMING_AUDIO_OUT"]',
      'os.makedirs(os.path.dirname(out), exist_ok=True)',
      'sr = 48000',
      'n = sr * 2',
      't = np.arange(n) / sr',
      'x = np.sin(2 * np.pi * 220 * t) * 0.15',
      'x[0] = 0.0; x[-1] = 0.0',
      'sf.write(out, np.stack([x, x], 1), sr, subtype="PCM_24")',
    ].join('\n') + '\n');

    const m = runSandboxCli(['mix', w.rel, '--gpu', 'software-ok', '--no-cache', '--json'], { env: { TMPDIR: tmp, TMP: tmp, TEMP: tmp } });
    assert.equal(m.code, 4, `时长错误混音 mix 应退出 4，实得 ${m.code}：${m.stderr.slice(-1000)}`);
    assert.equal(m.json?.error?.code, 'contract.audio-qa-failed');
    assert.match(m.json?.error?.message || '', /audio\.length/);
  } finally {
    w.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('4. 自动对白构建与可选画面遥测：dialogue.json 自动生成配音/字幕/口型并向脚本暴露 BEIMING_DIALOGUE_DIR 与 BEIMING_KINEMATICS', { skip: skipPipeline, timeout: 300000 }, () => {
  const w = makeWork('c');
  const tmp = sysTmp();
  try {
    const fjPath = path.join(w.dir, 'film.json');
    const raw = JSON.parse(fs.readFileSync(fjPath, 'utf8'));
    raw.output = { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 72 };
    raw.dur = 3;
    raw.fps = 24;
    raw.posterFrame = 36;
    raw.audio = { mode: 'script', script: 'vo_sound.py', telemetry: true, telemetryScale: 16, targetLUFS: -14, truePeakDbTP: -1.0 };
    delete raw.cuecheck;
    fs.writeFileSync(fjPath, JSON.stringify(raw, null, 2) + '\n');

    fs.writeFileSync(path.join(w.dir, 'index.html'), [
      '<!doctype html><meta charset="utf-8"><title>对白遥测试映</title>',
      '<canvas id="c" width="1920" height="1080"></canvas>',
      '<script>',
      'const cv = document.getElementById("c"), g = cv.getContext("2d");',
      'window.FPS = 24; window.DUR = 3; window.EV = [];',
      'window.AUDIO_TELEMETRY = (t) => ({ hero: { x: +(t / 3 * 1.6 - 0.8).toFixed(4), scale: 0.35, visible: 1 } });',
      'window.render = (t) => {',
      '  g.fillStyle = "#101820"; g.fillRect(0, 0, cv.width, cv.height);',
      '  g.fillStyle = "#f2d16b"; g.fillRect((t / 3) * cv.width * 0.8, cv.height * 0.4, cv.width * 0.12, cv.height * 0.2);',
      '};',
      'window.TEXTS = () => [];',
      'window.READY = true;',
      '</script>',
    ].join('\n') + '\n');

    fs.writeFileSync(path.join(w.dir, 'dialogue.json'), JSON.stringify({
      schema: 'beiming.dialogue/1',
      speakers: {
        narrator: { provider: 'synthetic', voice: 'narrator' },
      },
      lines: [
        { id: 'L1', speaker: 'narrator', text: '北冥有鱼。', at: 6, end: 66 },
      ],
    }, null, 2) + '\n');

    fs.writeFileSync(path.join(w.dir, 'vo_sound.py'), [
      'import json, os, numpy as np, soundfile as sf',
      'from engine.audio import cues as CU',
      'from engine.audio.dsp import SR, N, pink',
      'from engine.audio.editorial import FourStemWorkstation',
      'from engine.audio.procedural import aerodynamic_whoosh',
      'here = os.path.dirname(os.path.abspath(__file__))',
      'dlg_dir = os.environ.get("BEIMING_DIALOGUE_DIR", "")',
      'kin_path = os.environ.get("BEIMING_KINEMATICS", "")',
      'stems_dir = os.environ.get("BEIMING_AUDIO_STEMS", "")',
      'out_wav = os.environ["BEIMING_AUDIO_OUT"]',
      'assert dlg_dir and os.path.isfile(os.path.join(dlg_dir, "voice.wav")), f"missing voice.wav in {dlg_dir}"',
      'assert kin_path and os.path.isfile(kin_path), f"missing kinematics in {kin_path}"',
      'film_cues = CU.load(here)',
      'assert film_cues.kinematics is not None and "hero" in film_cues.kinematics.tracks, "CU.load(HERE).kinematics missing hero"',
      'dur = float(os.environ["BEIMING_DUR"])',
      'ws = FourStemWorkstation(dur, fps=24.0, target_lufs=-14.0, max_tp=-1.5, telemetry=film_cues.kinematics)',
      'r = np.random.default_rng(7)',
      'bed = np.stack([pink(N(dur), r), pink(N(dur), r)], 1) * 0.02',
      'ws.set_scenes([{"id": "S1", "in_s": 0.0, "out_s": dur, "wave": bed, "poa": "open_sky"}], target_lufs=-32.0)',
      'whoosh, _ = aerodynamic_whoosh(dur=0.6, profile="wing_gust", seed=11)',
      'ws.bind_actor(film_cues.kinematics, "hero", whoosh, bus="fx", role="support", gain_db=-8.0)',
      'ws.set_dialogue(os.path.join(dlg_dir, "voice.wav"), voice_json=os.path.join(dlg_dir, "voice.json"))',
      'mix, stems, _ = ws.mixdown()',
      'os.makedirs(os.path.dirname(out_wav), exist_ok=True)',
      'os.makedirs(stems_dir, exist_ok=True)',
      'sf.write(out_wav, mix, SR, subtype="PCM_24")',
      'for k, st in stems.items():',
      '    sf.write(os.path.join(stems_dir, f"{k}.wav"), st, SR, subtype="PCM_24")',
      'with open(os.path.join(os.path.dirname(out_wav), "env_probe.json"), "w", encoding="utf-8") as f:',
      '    json.dump({"dialogueDir": dlg_dir, "kinematics": kin_path, "stemsDir": stems_dir}, f)',
    ].join('\n') + '\n');

    const r = runSandboxCli(['mix', w.rel, '--gpu', 'software-ok', '--json'], { env: { TMPDIR: tmp, TMP: tmp, TEMP: tmp } });
    assert.equal(r.code, 0, `带对白与遥测的 film mix 失败（${r.code}）：${r.stderr.slice(-1500)}`);

    const runDir = path.join(SANDBOX, r.json.data.runDir);
    assert.ok(fs.existsSync(path.join(runDir, 'kinematics.json')), 'probe --telemetry 应写出运行目录 kinematics.json');
    for (const fn of ['voice.wav', 'subtitles.srt', 'texts.json', 'lips.json', 'voice.json']) {
      assert.ok(fs.existsSync(path.join(runDir, 'audio', 'dialogue', fn)), `缺对白产物 ${fn}`);
    }
    const qaReport = JSON.parse(fs.readFileSync(path.join(runDir, 'audio', 'qa.json'), 'utf8'));
    assert.equal(qaReport.ok, true);
    const dlgCheck = qaReport.checks.find(c => c.id === 'audio.dialogue');
    if (dlgCheck) assert.equal(dlgCheck.status, 'pass', JSON.stringify(dlgCheck));

    const envProbe = JSON.parse(fs.readFileSync(path.join(runDir, 'audio', 'env_probe.json'), 'utf8'));
    assert.equal(path.resolve(envProbe.dialogueDir), path.join(runDir, 'audio', 'dialogue'));
    assert.equal(path.resolve(envProbe.kinematics), path.join(runDir, 'kinematics.json'));
    assert.equal(path.resolve(envProbe.stemsDir), path.join(runDir, 'audio', 'stems'));
    assert.ok(!fs.existsSync(path.join(w.dir, 'kinematics.json')), '运行结束后作品目录不留临时 kinematics.json');
  } finally {
    w.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('仓库卫生：声音出片链测试跑完，主仓库工作区没有多出任何未跟踪或被改文件', () => {
  const st = gitStatus(SIBLING_PREFIXES);
  if (st === null) return;
  assert.deepEqual(st.filter(l => !statusBefore.has(l)), []);
});
