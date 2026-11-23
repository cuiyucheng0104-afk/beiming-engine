import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eventsTable } from '../kernel/eval/input.mjs';
import {
  CompError, PIECES, deliver, measureAac, measureLoudness, readWav, resolvePython, runAudioScript, runTool, tools, verifyDeliveryBundle,
} from './index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const isCode = (expected) => (err) => err instanceof CompError && err.code === expected;

function makeTempDir(t, prefix = 'beiming-x6-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const hasFfmpeg = (() => {
  try {
    return Object.values(tools()).every((bin) =>
      spawnSync(bin, ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }).status === 0);
  } catch {
    return false;
  }
})();
const needFfmpeg = { skip: !hasFfmpeg && '环境缺少 ffmpeg / ffprobe' };

const example = (name) => JSON.parse(readFileSync(new URL(`../kernel/contracts/${name}`, import.meta.url), 'utf8'));

/**
 * 03B 风格的事件表驱动 Python+numpy 程序化声音脚本夹具：
 * 通过 --events / --out 读取事件表，用 numpy 确定性合成环境基底、事件脉冲与和弦，
 * 支持输出预设响度（mastered）以及伴随的 report.json 和 stems/*.wav。
 */
const PROCEDURAL_SOUND_PY = String.raw`#!/usr/bin/env python3
import argparse, json, os, pathlib, struct, sys, wave
import numpy as np

SR = 48000

def write_pcm16_stereo(path, left, right):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    l16 = np.clip(np.round(left * 32767.0), -32768, 32767).astype('<i2')
    r16 = np.clip(np.round(right * 32767.0), -32768, 32767).astype('<i2')
    interleaved = np.empty(l16.size * 2, dtype='<i2')
    interleaved[0::2] = l16
    interleaved[1::2] = r16
    with wave.open(str(path), 'wb') as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(interleaved.tobytes())

def parse_fps(val):
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val)
    if '/' in s:
        n, d = s.split('/', 1)
        return float(n) / float(d)
    return float(s)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--events', default=os.environ.get('BEIMING_EVENTS', ''))
    ap.add_argument('--out', default=os.environ.get('BEIMING_AUDIO_OUT', ''))
    ap.add_argument('--amp', type=float, default=0.268)
    ap.add_argument('--preset', default='')
    ap.add_argument('--stems', action='store_true')
    args, _ = ap.parse_known_args()

    amp = args.amp
    if args.preset:
        with open(args.preset, 'r', encoding='utf-8') as pf:
            preset_obj = json.load(pf)
            amp = float(preset_obj.get('amp', amp))

    with open(args.events, 'r', encoding='utf-8') as f:
        ev = json.load(f)

    fps = parse_fps(ev.get('fps', os.environ.get('BEIMING_FPS', '30/1')))
    frames = int(ev.get('frames', ev.get('total_frames', os.environ.get('BEIMING_FRAMES', 45))))
    n_samples = int(round(frames * SR / fps))
    t = np.arange(n_samples, dtype=np.float64) / SR

    # 确定性种子环境声 + 双声道和弦基底（精确校准可落在 -14.0 LUFS / -2.6 dBTP 附近）
    rng = np.random.default_rng(20261123)
    amb_l = 0.015 * rng.standard_normal(n_samples)
    amb_r = 0.015 * rng.standard_normal(n_samples)
    tone_l = amp * (0.75 * np.sin(2.0 * np.pi * 220.0 * t) + 0.25 * np.sin(2.0 * np.pi * 330.0 * t))
    tone_r = amp * (0.75 * np.sin(2.0 * np.pi * 220.0 * t + 0.2) + 0.25 * np.sin(2.0 * np.pi * 440.0 * t))

    sfx_l = np.zeros(n_samples, dtype=np.float64)
    sfx_r = np.zeros(n_samples, dtype=np.float64)
    items = ev.get('events', [])
    for idx, item in enumerate(items):
        frame = float(item.get('frame', 0)) + float(item.get('sub', 0))
        center = int(round(frame * SR / fps))
        dur = min(int(0.08 * SR), max(0, n_samples - center))
        if dur > 0:
            lt = np.arange(dur, dtype=np.float64) / SR
            env = np.exp(-lt * 45.0)
            burst = 0.12 * env * np.sin(2.0 * np.pi * (520.0 + 60.0 * idx) * lt)
            sfx_l[center:center + dur] += burst
            sfx_r[center:center + dur] += burst

    left = np.clip(amb_l + tone_l + sfx_l, -0.74, 0.74)
    right = np.clip(amb_r + tone_r + sfx_r, -0.74, 0.74)
    out_path = pathlib.Path(args.out)
    write_pcm16_stereo(out_path, left, right)

    if args.stems:
        stems_dir = out_path.parent / 'stems'
        write_pcm16_stereo(stems_dir / 'ambient.wav', amb_l + tone_l, amb_r + tone_r)
        write_pcm16_stereo(stems_dir / 'sfx.wav', sfx_l, sfx_r)
        report = {
            'sr': SR,
            'frames': frames,
            'samples': n_samples,
            'event_count': len(items),
            'env_frames': os.environ.get('BEIMING_FRAMES', ''),
            'env_fps': os.environ.get('BEIMING_FPS', ''),
        }
        (out_path.parent / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')

if __name__ == '__main__':
    main()
`;

function createDeliveryFixture(dir, framesCount = 45) {
  const film = example('film/examples/minimal.json');
  film.output = { size: [32, 16], fps: '30/1', frames: framesCount };
  Object.assign(film.shots[0], { out: framesCount, colorRef: 'display', seed: 7 });
  film.events = [
    { id: 'cue-0', frame: 6, sync: 'onset' },
    { id: 'cue-1', frame: 18, sync: 'onset' },
    { id: 'cue-2', frame: 30, sync: 'onset' },
  ];
  film.audio = { mode: 'script', loudness: -14, truePeak: -1 };
  film.delivery = { master: 'h264-crf14-bt709', web: true, contact: true };
  const lock = example('lock/examples/minimal.json');
  const fullLock = example('lock/examples/check-full.json').lock;
  lock.cards['audio.master'] = fullLock.cards['audio.master'];
  lock.templates['delivery-web'] = fullLock.templates['delivery-web'];
  lock.seeds.s01 = film.shots[0].seed;

  const framesDir = join(dir, 'frames');
  mkdirSync(framesDir, { recursive: true });
  const pattern = join(framesDir, 'frame%03d.png');
  runTool(tools().ffmpeg, [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=s=32x16:r=30`,
    '-frames:v', String(framesCount), '-start_number', '0', pattern,
  ]);
  return { film, lock, events: eventsTable(film), frames: { s01: { pattern } } };
}

describe('X6-Unit: Python 解释器解析与 numpy 程序化声音脚本工序', () => {
  test('公共入口导出 resolvePython 与 runAudioScript（使用 pathToFileURL 动态导入）', async () => {
    const mod = await import(pathToFileURL(join(here, 'index.mjs')).href);
    assert.equal(typeof mod.resolvePython, 'function');
    assert.equal(typeof mod.runAudioScript, 'function');
  });

  test('resolvePython 自动发现含 numpy 的解释器，并对缺失的显式路径报 env.python-missing', (t) => {
    const dir = makeTempDir(t);
    const py = resolvePython();
    assert.equal(typeof py, 'string');
    assert.ok(py.length > 0);
    assert.equal(resolvePython(py), py);
    assert.equal(resolvePython({ python: py }), py);

    const checkNumpy = spawnSync(py, ['-c', 'import numpy; print(numpy.__version__)'], {
      shell: false, windowsHide: true, encoding: 'utf8',
    });
    assert.equal(checkNumpy.status, 0, `选中的 Python 应含 numpy：${checkNumpy.stderr}`);

    const missingPy = join(dir, 'absent-python-bin');
    assert.throws(() => resolvePython(missingPy), isCode('env.python-missing'));
    assert.throws(() => resolvePython({ env: { BEIMING_PYTHON: missingPy } }), isCode('env.python-missing'));
  });

  test('runAudioScript 支持内存事件表与 JSON 文件、确定性重放、单声道/立体声与伴随产物收集', (t) => {
    const dir = makeTempDir(t);
    const scriptPath = join(dir, 'sound.py');
    writeFileSync(scriptPath, PROCEDURAL_SOUND_PY);

    const eventsObj = {
      format: 'events/0.1',
      film: 'x6-unit',
      fps: '30/1',
      frames: 45,
      events: [
        { id: 'drop1', kind: 'named', from: 'film', frame: 5, sub: 0, sync: 'onset' },
        { id: 'drop2', kind: 'named', from: 'film', frame: 20, sub: 0.5, sync: 'onset' },
      ],
    };

    const run1 = runAudioScript({
      script: scriptPath,
      events: eventsObj,
      outPath: join(dir, 'run1', 'mix.wav'),
      args: ['--stems'],
      expectedFrames: 45,
      fps: '30/1',
    });
    assert.equal(run1.sampleRate, 48000);
    assert.equal(run1.channels, 2);
    assert.equal(run1.samples, 72000);
    assert.equal(run1.durationSec, 1.5);
    assert.equal(run1.stems.length, 2);
    assert.ok(run1.report);
    assert.equal(run1.report.frames, 45);
    assert.equal(run1.report.event_count, 2);
    assert.equal(run1.report.env_frames, '45');
    assert.equal(run1.report.env_fps, '30/1');

    // JSON 路径输入 + 确定性逐位重放
    const eventsFile = join(dir, 'events.json');
    writeFileSync(eventsFile, `${JSON.stringify(eventsObj, null, 2)}\n`);
    const run2 = runAudioScript({
      script: scriptPath,
      events: eventsFile,
      outPath: join(dir, 'run2', 'mix.wav'),
      args: ['--stems'],
      expectedFrames: 45,
      fps: 30,
    });
    assert.equal(run1.sha256, run2.sha256, '同一事件表与脚本重放 WAV 应逐位一致');
    assert.equal(run1.scriptSha256, run2.scriptSha256);
    assert.equal(run1.eventsSha256, run2.eventsSha256);

    // 48 kHz 单声道 WAV 也受支持并复制为双声道样本
    const monoScript = join(dir, 'mono.py');
    writeFileSync(monoScript, [
      'import os, wave, struct',
      'out = os.environ["BEIMING_AUDIO_OUT"]',
      'with wave.open(out, "wb") as w:',
      '    w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)',
      '    w.writeframes(struct.pack("<1000h", *([4000]*1000)))',
    ].join('\n'));
    const monoRes = runAudioScript({
      script: monoScript,
      events: { fps: 48, total_frames: 1 },
      workDir: join(dir, 'mono-work'),
      expectedFrames: 1,
      fps: 48,
    });
    assert.equal(monoRes.channels, 1);
    assert.equal(monoRes.samples, 1000);
    assert.equal(monoRes.wav.left.length, 1000);
    assert.equal(monoRes.wav.right.length, 1000);

    // 同目录确定性重跑：第二次仍应返回本次写出的 report.json，第三次关闭 --stems 时不残留旧 report 或旧 stems
    const sharedOut = join(dir, 'run1', 'mix.wav');
    const rerunSame = runAudioScript({
      script: scriptPath,
      events: eventsObj,
      outPath: sharedOut,
      args: ['--stems'],
      expectedFrames: 45,
      fps: '30/1',
    });
    assert.ok(rerunSame.report, '同目录重跑确定性脚本仍须返回本次产出的 report');
    assert.equal(rerunSame.stems.length, 2);

    const rerunNoStems = runAudioScript({
      script: scriptPath,
      events: eventsObj,
      outPath: sharedOut,
      expectedFrames: 45,
      fps: '30/1',
    });
    assert.equal(rerunNoStems.report, null, '本次未产出 report.json 时不得误认历史文件');
    assert.deepEqual(rerunNoStems.stems, [], '本次未产出 stems 时不得返回上次遗留的分轨');
    assert.equal(existsSync(join(dirname(sharedOut), 'report.json')), false, '关闭分轨重跑后磁盘不得残留旧 report.json');
    for (const oldStem of rerunSame.stems) {
      assert.equal(existsSync(oldStem), false, `关闭分轨重跑后磁盘不得残留旧分轨 ${oldStem}`);
    }
    assert.equal(existsSync(join(dirname(sharedOut), 'stems')), false, '关闭分轨重跑后空 stems 目录应一并清理');

    // 并发/共用 workDir 输出同目录 A.wav 与 B.wav：分轨路径与记录事件文件互不覆盖串音
    const sharedConcurrentDir = join(dir, 'shared-concurrent');
    const resA = runAudioScript({
      script: scriptPath,
      events: { ...eventsObj, events: [eventsObj.events[0]] },
      workDir: sharedConcurrentDir,
      outPath: join(sharedConcurrentDir, 'A.wav'),
      args: ['--amp', '0.15', '--stems'],
      expectedFrames: 45,
      fps: '30/1',
    });
    const resB = runAudioScript({
      script: scriptPath,
      events: { ...eventsObj, events: eventsObj.events },
      workDir: sharedConcurrentDir,
      outPath: join(sharedConcurrentDir, 'B.wav'),
      args: ['--amp', '0.25', '--stems'],
      expectedFrames: 45,
      fps: '30/1',
    });
    assert.notDeepEqual(resA.stems, resB.stems, '同目录不同输出 WAV 的分轨路径必须隔离');
    assert.equal(existsSync(resA.stems[0]), true);
    assert.equal(existsSync(resB.stems[0]), true);
    assert.equal(readFileSync(resA.stems[0]).equals(readFileSync(resB.stems[0])), false, 'A.wav 与 B.wav 的分轨内容不得互相覆盖');
    assert.equal(existsSync(resA.args[2]), true, '内存事件记录的 args[2] 应在磁盘可追溯');
    assert.equal(existsSync(resB.args[2]), true, '内存事件记录的 args[2] 应在磁盘可追溯');
    assert.notEqual(resA.args[2], resB.args[2]);

    // 失败重跑或伴随产物发布冲突（stems 为普通文件 / report.json 为目录）时不得覆盖旧 WAV，也不得残留临时文件
    const prevBytes = readFileSync(sharedOut);
    const failScript = join(dir, 'fail-rerun.py');
    writeFileSync(failScript, 'import sys\nsys.exit(3)\n');
    assert.throws(
      () => runAudioScript({ script: failScript, events: eventsObj, outPath: sharedOut }),
      isCode('failure.audio-script'),
    );
    assert.equal(existsSync(sharedOut), true, '失败重跑后原成品 WAV 必须完好保留');
    assert.ok(readFileSync(sharedOut).equals(prevBytes), '失败重跑不得改动原成品 WAV 字节');

    const conflictStemsPath = join(dirname(sharedOut), 'stems');
    writeFileSync(conflictStemsPath, 'not-a-directory');
    assert.throws(
      () => runAudioScript({
        script: scriptPath,
        events: eventsObj,
        outPath: sharedOut,
        args: ['--amp', '0.12', '--stems'],
        expectedFrames: 45,
        fps: '30/1',
      }),
      isCode('failure.audio-script'),
    );
    assert.ok(readFileSync(sharedOut).equals(prevBytes), 'stems 目标为普通文件导致发布失败时不得改写旧 WAV');
    assert.deepEqual(
      readdirSync(dirname(sharedOut)).filter((n) => n.startsWith('.beiming-')),
      [],
      '发布失败不得残留临时文件',
    );
    rmSync(conflictStemsPath, { force: true });

    const conflictReportDir = join(dirname(sharedOut), 'report.json');
    mkdirSync(conflictReportDir, { recursive: true });
    assert.throws(
      () => runAudioScript({
        script: scriptPath,
        events: eventsObj,
        outPath: sharedOut,
        args: ['--amp', '0.12', '--stems'],
        expectedFrames: 45,
        fps: '30/1',
      }),
      isCode('failure.audio-script'),
    );
    assert.ok(readFileSync(sharedOut).equals(prevBytes), 'report.json 目标为目录导致发布失败时不得改写旧 WAV');
    assert.deepEqual(
      readdirSync(dirname(sharedOut)).filter((n) => n.startsWith('.beiming-')),
      [],
      'report.json 为目录失败后不得残留临时文件',
    );
    rmSync(conflictReportDir, { recursive: true, force: true });

    // 默认 cwd 相对写出 report.json 与 stems/music.wav + report.file 指向最终已发布路径
    const relCwdScript = join(dir, 'rel-cwd.py');
    writeFileSync(relCwdScript, [
      'import json, os, pathlib, struct, wave',
      'out = os.environ["BEIMING_AUDIO_OUT"]',
      'with wave.open(out, "wb") as w:',
      '    w.setparams((2, 2, 48000, 1000, "NONE", ""))',
      '    w.writeframes(struct.pack("<2000h", *([2048]*2000)))',
      'pathlib.Path("stems").mkdir(parents=True, exist_ok=True)',
      'with wave.open("stems/music.wav", "wb") as w:',
      '    w.setparams((2, 2, 48000, 1000, "NONE", ""))',
      '    w.writeframes(struct.pack("<2000h", *([1024]*2000)))',
      'pathlib.Path("report.json").write_text(json.dumps({"file": out, "events": os.environ["BEIMING_EVENTS"]}), encoding="utf-8")',
    ].join('\n'));
    const relOut = join(dir, 'rel-cwd-out', 'rel.wav');
    const relRes = runAudioScript({
      script: relCwdScript,
      events: { fps: 48, total_frames: 1 },
      outPath: relOut,
      expectedFrames: 1,
      fps: 48,
    });
    assert.ok(relRes.report, '默认 cwd 相对写出的 report.json 必须被采集返回');
    assert.equal(relRes.report.file, relOut, 'report.file 应更新为已发布 WAV 路径而非已删除的暂存路径');
    assert.equal(existsSync(relRes.report.file), true);
    assert.equal(existsSync(relRes.report.events), true);
    assert.deepEqual(relRes.stems.map((s) => basename(s)), ['music.wav']);
    assert.equal(existsSync(relRes.stems[0]), true);
  });
});

describe('X6-Deliver: 合成收尾 deliver() 集成 audioScript 端到端交付六件套', () => {
  test('deliver() 集成未母带化与已母带化（mastered: true）Python 声音脚本，产出确定性六件套并通过响度核验', needFfmpeg, (t) => {
    const dir = makeTempDir(t);
    const scriptPath = join(dir, 'sound.py');
    writeFileSync(scriptPath, PROCEDURAL_SOUND_PY);
    const input = createDeliveryFixture(dir, 45);

    // 1. mastered: false（默认）：脚本产出混音经 masterAudio 归一与限幅后封装
    const b1 = deliver({
      ...input,
      audioScript: { script: scriptPath, args: ['--amp', '0.08', '--stems'] },
      outDir: join(dir, 'bundle-unmastered'),
    });
    verifyDeliveryBundle(b1.dir);

    // 2. mastered: true（含附加绝对路径参数 --preset）：跨目录重放 run.json 与 report.json 逐位相同且不泄漏本机路径
    const presetDirA = join(dir, 'preset-a');
    const presetDirB = join(dir, 'preset-b');
    mkdirSync(presetDirA, { recursive: true });
    mkdirSync(presetDirB, { recursive: true });
    const presetA = join(presetDirA, 'preset.json');
    const presetB = join(presetDirB, 'preset.json');
    writeFileSync(presetA, '{"amp": 0.268}\n');
    writeFileSync(presetB, '{"amp": 0.268}\n');

    const b2a = deliver({
      ...input,
      audioScript: {
        script: scriptPath,
        args: [
          '--stems',
          '--preset', presetA,
          '--win-root', '\\round-A\\preset.json',
          '--win-eq=\\round-A\\preset.json',
          '--work-rel=<work>\\sub\\preset.json',
        ],
        mastered: true,
      },
      outDir: join(dir, 'bundle-mastered-a'),
    });
    const b2b = deliver({
      ...input,
      audioScript: {
        script: scriptPath,
        args: [
          '--stems',
          '--preset', presetB,
          '--win-root', '\\round-B\\preset.json',
          '--win-eq=\\round-B\\preset.json',
          '--work-rel=<work>\\sub\\preset.json',
        ],
        mastered: true,
      },
      outDir: join(dir, 'bundle-mastered-b'),
    });
    verifyDeliveryBundle(b2a.dir);
    verifyDeliveryBundle(b2b.dir);

    const runA = readFileSync(join(b2a.dir, PIECES.run), 'utf8');
    const runB = readFileSync(join(b2b.dir, PIECES.run), 'utf8');
    assert.equal(runA, runB, '含绝对路径附加参数的跨目录交付 run.json 必须逐位一致');
    assert.ok(!runA.includes(dir), 'run.json 不得泄漏任何本机临时目录路径');
    assert.ok(!runA.includes('round-A') && !runA.includes('round-B'), 'run.json 不得泄漏 Windows 反斜杠根路径');
    assert.equal(
      readFileSync(join(b2a.dir, PIECES.report), 'utf8'),
      readFileSync(join(b2b.dir, PIECES.report), 'utf8'),
      '跨目录交付的 report.json 必须逐位一致',
    );

    const parsedRun = JSON.parse(runA);
    const scriptStep = parsedRun.steps.find((s) => s.step === 'audio-script');
    assert.ok(scriptStep, 'run.json 应记录 audio-script 步骤');
    assert.equal(scriptStep.script, '<script>');
    assert.equal(scriptStep.sampleRate, 48000);
    assert.equal(scriptStep.channels, 2);
    assert.equal(scriptStep.samples, 72000);
    assert.equal(scriptStep.mastered, true);
    assert.deepEqual(scriptStep.stems, ['ambient.wav', 'sfx.wav']);
    assert.deepEqual(scriptStep.args, [
      '<script>', '--events', '<events>', '--out', '<work>/audio-script/script-audio.wav',
      '--stems',
      '--preset', '<arg-path:0>',
      '--win-root', '<arg-path:1>',
      '--win-eq=<arg-path:2>',
      '--work-rel=<work>/sub/preset.json',
    ]);

    const audioStep = parsedRun.steps.find((s) => s.step === 'audio');
    assert.equal(audioStep.passes[0].step, 'script-mastered');

    for (const piece of [PIECES.master, PIECES.web]) {
      const mp4 = join(b2a.dir, piece);
      const ebu = measureLoudness(mp4);
      const aac = measureAac(mp4);
      assert.ok(ebu.integrated >= -15 && ebu.integrated <= -13, `${piece} ebur128 响度 ${ebu.integrated}`);
      assert.ok(ebu.truePeak <= -1, `${piece} ebur128 真峰值 ${ebu.truePeak}`);
      assert.ok(aac.integrated >= -15 && aac.integrated <= -13, `${piece} AAC 响度 ${aac.integrated}`);
      assert.ok(aac.truePeak <= -1, `${piece} AAC 真峰值 ${aac.truePeak}`);
    }
  });

  test('deliver() 在 mastered: true 但脚本产出响度或真峰值越界时拒绝发布并抛 contract.delivery-mismatch', needFfmpeg, (t) => {
    const dir = makeTempDir(t);
    const scriptPath = join(dir, 'sound.py');
    writeFileSync(scriptPath, PROCEDURAL_SOUND_PY);
    const input = createDeliveryFixture(dir, 45);

    const outTooQuiet = join(dir, 'reject-quiet');
    assert.throws(
      () => deliver({
        ...input,
        audioScript: { script: scriptPath, args: ['--amp', '0.01'], mastered: true },
        outDir: outTooQuiet,
      }),
      isCode('contract.delivery-mismatch'),
    );
    assert.equal(existsSync(outTooQuiet), false, '失败交付不得在目标目录残留文件');

    // mastered: true 的全零静音 WAV 与末尾截断 4 字节的 WAV 均必须拒绝发布
    const silentOrTruncScript = join(dir, 'bad-master.py');
    const outSnippet = 'import os\nout = os.environ["BEIMING_AUDIO_OUT"]\n';
    const rejectCases = [
      ['silent', 'contract.delivery-mismatch', `${outSnippet}import wave\nwith wave.open(out, "wb") as w:\n    w.setparams((2, 2, 48000, 72000, "NONE", ""))\n    w.writeframes(bytes(72000 * 4))\n`],
      ['truncated', 'failure.audio-script', `${PROCEDURAL_SOUND_PY}\n${outSnippet}os.truncate(out, os.path.getsize(out) - 4)\n`],
    ];
    for (const [caseName, expectedCode, pySource] of rejectCases) {
      writeFileSync(silentOrTruncScript, pySource);
      const caseOut = join(dir, `reject-${caseName}`);
      assert.throws(
        () => deliver({ ...input, outDir: caseOut, audioScript: { script: silentOrTruncScript, mastered: true } }),
        isCode(expectedCode),
      );
      assert.equal(existsSync(caseOut), false, `${caseName} 被拒后不得残留输出目录`);
    }

    // track 模式下即便提供响度合格的外部音轨，也不得掩盖 mastered: true 的全零脚本母带
    writeFileSync(silentOrTruncScript, rejectCases[0][2]);
    const externalLoudWav = runAudioScript({
      script: scriptPath,
      events: input.events,
      outPath: join(dir, 'loud-ext.wav'),
      expectedFrames: 45,
      fps: '30/1',
    });
    const trackFilm = structuredClone(input.film);
    trackFilm.audio = { mode: 'track', loudness: -14, truePeak: -1 };
    const maskedOut = join(dir, 'reject-masked-silent-track');
    assert.throws(
      () => deliver({
        ...input,
        film: trackFilm,
        events: eventsTable(trackFilm),
        tracks: [{ path: externalLoudWav.path, at: 0, gainDb: 0 }],
        audioScript: { script: silentOrTruncScript, mastered: true },
        outDir: maskedOut,
      }),
      isCode('contract.delivery-mismatch'),
    );
    assert.equal(existsSync(maskedOut), false, 'track 模式下全零脚本母带被拒后不得残留输出目录');

    // 无声片（film.audio 缺省 / mode === 'none'）传 audioScript 报 usage.bad-argument
    const silentFilm = structuredClone(input.film);
    delete silentFilm.audio;
    assert.throws(
      () => deliver({
        ...input,
        film: silentFilm,
        events: eventsTable(silentFilm),
        audioScript: { script: scriptPath },
        outDir: join(dir, 'reject-silent'),
      }),
      isCode('usage.bad-argument'),
    );

    // deliver 的 audioScript 字段级校验
    for (const badAudioScript of [
      null,
      'sound.py',
      [],
      { script: '' },
      { script: 'not-py.wav' },
      { script: scriptPath, at: -1 },
      { script: scriptPath, gainDb: Number.NaN },
      { script: scriptPath, mastered: 'yes' },
      { script: scriptPath, timeoutMs: 0 },
    ]) {
      assert.throws(
        () => deliver({ ...input, audioScript: badAudioScript, outDir: join(dir, 'reject-opt') }),
        isCode('usage.bad-argument'),
      );
    }
  });
});

describe('X6-Red: 零陷阱参数校验与异常脚本防御', () => {
  test('Proxy、getter/setter 陷阱、非法类型、空字节与缺失路径统一抛 usage.bad-argument', (t) => {
    const dir = makeTempDir(t);
    const scriptPath = join(dir, 'ok.py');
    writeFileSync(scriptPath, PROCEDURAL_SOUND_PY);
    const baseOpts = { script: scriptPath, events: { fps: '30/1', frames: 30, events: [] }, workDir: join(dir, 'w') };

    // Proxy 陷阱（含已撤销 Proxy.revocable）
    assert.throws(() => resolvePython(new Proxy({}, {})), isCode('usage.bad-argument'));
    assert.throws(() => runAudioScript(new Proxy(baseOpts, {})), isCode('usage.bad-argument'));
    assert.throws(() => runAudioScript({ ...baseOpts, events: new Proxy({}, {}) }), isCode('usage.bad-argument'));
    assert.throws(() => runAudioScript({ ...baseOpts, args: new Proxy([], {}) }), isCode('usage.bad-argument'));
    assert.throws(() => runAudioScript({ ...baseOpts, env: new Proxy({}, {}) }), isCode('usage.bad-argument'));
    const revocableTop = Proxy.revocable({ ...baseOpts }, {});
    revocableTop.revoke();
    assert.throws(() => runAudioScript(revocableTop.proxy), isCode('usage.bad-argument'));
    assert.throws(() => deliver(revocableTop.proxy), isCode('usage.bad-argument'));
    assert.throws(() => resolvePython(revocableTop.proxy), isCode('usage.bad-argument'));

    // Getter/setter 陷阱（含继承原型上的访问器，必须在不触发 getter 的前提下拒绝）
    let getterCalled = false;
    const trappedOpts = { ...baseOpts };
    Object.defineProperty(trappedOpts, 'script', {
      enumerable: true,
      get() { getterCalled = true; throw new Error('getter trap triggered'); },
    });
    assert.throws(() => runAudioScript(trappedOpts), isCode('usage.bad-argument'));
    assert.equal(getterCalled, false, '不得触发带陷阱的 getter');

    const inheritedSinkTrap = Object.create({
      get sinkFactory() { getterCalled = true; throw new Error('inherited sinkFactory getter triggered'); },
    });
    assert.throws(() => deliver(inheritedSinkTrap), isCode('usage.bad-argument'));
    assert.equal(getterCalled, false, 'deliver 不得触发原型链上的继承 getter');

    const trappedNested = { ...baseOpts, events: {} };
    Object.defineProperty(trappedNested.events, 'fps', {
      enumerable: true,
      get() { getterCalled = true; return 30; },
    });
    assert.throws(() => runAudioScript(trappedNested), isCode('usage.bad-argument'));
    assert.equal(getterCalled, false, '不得触发嵌套对象上的 getter');

    const trappedDeliver = {};
    Object.defineProperty(trappedDeliver, 'audioScript', {
      enumerable: true,
      get() { getterCalled = true; return { script: scriptPath }; },
    });
    assert.throws(() => deliver(trappedDeliver), isCode('usage.bad-argument'));
    assert.equal(getterCalled, false, 'deliver 不得触发 getter 陷阱');
    assert.throws(() => deliver(null), isCode('usage.bad-argument'));
    assert.throws(() => deliver(new Proxy({}, {})), isCode('usage.bad-argument'));

    // 不可读 .py 脚本（EACCES / mode 0000）应统一抛 usage.bad-argument
    const unreadablePy = join(dir, 'unreadable.py');
    writeFileSync(unreadablePy, PROCEDURAL_SOUND_PY);
    chmodSync(unreadablePy, 0o000);
    t.after(() => { try { chmodSync(unreadablePy, 0o644); } catch {} });
    assert.throws(() => runAudioScript({ ...baseOpts, script: unreadablePy }), isCode('usage.bad-argument'));

    // 循环引用
    const cyclic = { fps: 30 };
    cyclic.self = cyclic;
    assert.throws(() => runAudioScript({ ...baseOpts, events: cyclic }), isCode('usage.bad-argument'));

    const hugeDigits = '9'.repeat(310);

    // 非法选项值（含稀疏数组 Array(1) 与 310 位超长帧率字符串）
    for (const badInput of [
      null,
      undefined,
      'not-an-object',
      [],
      new Date(),
      { ...baseOpts, script: '' },
      { ...baseOpts, script: 'not-python.txt' },
      { ...baseOpts, script: `${scriptPath}\0evil.py` },
      { ...baseOpts, script: join(dir, 'missing.py') },
      { ...baseOpts, script: dir },
      { ...baseOpts, events: null },
      { ...baseOpts, events: [] },
      { ...baseOpts, events: join(dir, 'missing-events.json') },
      { script: scriptPath, events: { fps: 30 } },
      { ...baseOpts, args: 'not-array' },
      { ...baseOpts, args: Array(1) },
      { ...baseOpts, args: [123] },
      { ...baseOpts, args: ['--flag\0bad'] },
      { ...baseOpts, timeoutMs: 0 },
      { ...baseOpts, timeoutMs: -10 },
      { ...baseOpts, timeoutMs: 1.5 },
      { ...baseOpts, expectedFrames: 0, fps: 30 },
      { ...baseOpts, expectedFrames: 30, fps: -24 },
      { ...baseOpts, expectedFrames: 30, fps: 'bad-fps' },
      { ...baseOpts, expectedFrames: 1, fps: `${hugeDigits}/${hugeDigits}` },
      { ...baseOpts, events: { fps: `${hugeDigits}/${hugeDigits}` }, expectedFrames: 1 },
      { ...baseOpts, events: {}, expectedFrames: 30 },
      { ...baseOpts, cwd: join(dir, 'no-such-cwd') },
      { ...baseOpts, env: { BAD: 123 } },
      { ...baseOpts, env: { BAD: 'a\0b' } },
    ]) {
      assert.throws(() => runAudioScript(badInput), isCode('usage.bad-argument'));
    }
  });

  test('脚本退出非零、超时、未产出文件、损坏 WAV、错误采样率/声道/非有限样本/帧长不符及特殊字符路径防御', (t) => {
    const dir = makeTempDir(t);
    const events = { fps: '30/1', frames: 30, events: [] };

    const runPyBody = (name, body, extra = {}) => {
      const p = join(dir, name);
      writeFileSync(p, body);
      return runAudioScript({ script: p, events, workDir: join(dir, `w-${name}`), ...extra });
    };

    // 1. 非零退出码 -> failure.audio-script
    assert.throws(
      () => runPyBody('fail-exit.py', 'import sys\nsys.stderr.write("boom\\n")\nsys.exit(3)\n'),
      isCode('failure.audio-script'),
    );

    // 2. 退出 0 但未生成 WAV -> failure.audio-script
    assert.throws(
      () => runPyBody('no-out.py', 'import sys\nsys.exit(0)\n'),
      isCode('failure.audio-script'),
    );

    // 3. 超时 -> failure.audio-script
    assert.throws(
      () => runPyBody('hang.py', 'import time\ntime.sleep(10)\n', { timeoutMs: 80 }),
      isCode('failure.audio-script'),
    );

    // 4. 非 WAV 字节 -> failure.audio-script
    assert.throws(
      () => runPyBody('corrupt.py', 'import os, pathlib\npathlib.Path(os.environ["BEIMING_AUDIO_OUT"]).write_bytes(b"NOT_A_WAV")\n'),
      isCode('failure.audio-script'),
    );

    // 5. 采样率不是 48000 Hz (44100 Hz) -> failure.audio-script
    assert.throws(
      () => runPyBody('rate44k.py', [
        'import os, wave, struct',
        'with wave.open(os.environ["BEIMING_AUDIO_OUT"], "wb") as w:',
        '    w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100)',
        '    w.writeframes(struct.pack("<200h", *([0]*200)))',
      ].join('\n')),
      isCode('failure.audio-script'),
    );

    // 6. 声道数非法 (3 声道) -> failure.audio-script
    assert.throws(
      () => runPyBody('ch3.py', [
        'import os, wave, struct',
        'with wave.open(os.environ["BEIMING_AUDIO_OUT"], "wb") as w:',
        '    w.setnchannels(3); w.setsampwidth(2); w.setframerate(48000)',
        '    w.writeframes(struct.pack("<300h", *([0]*300)))',
      ].join('\n')),
      isCode('failure.audio-script'),
    );

    // 7. 0 样本空 WAV -> failure.audio-script
    assert.throws(
      () => runPyBody('zero-samples.py', [
        'import os, wave',
        'with wave.open(os.environ["BEIMING_AUDIO_OUT"], "wb") as w:',
        '    w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)',
        '    w.writeframes(b"")',
      ].join('\n')),
      isCode('failure.audio-script'),
    );

    // 8. 含 NaN 的 32-bit float WAV -> failure.audio-script
    assert.throws(
      () => runPyBody('nan-wav.py', [
        'import os, struct, pathlib',
        'data = struct.pack("<2f", float("nan"), 0.0)',
        'head = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(data), b"WAVE", b"fmt ", 16, 3, 2, 48000, 48000*8, 8, 32, b"data", len(data))',
        'pathlib.Path(os.environ["BEIMING_AUDIO_OUT"]).write_bytes(head + data)',
      ].join('\n')),
      isCode('failure.audio-script'),
    );

    // 9. 样本数与 expectedFrames 不符或截断 WAV -> failure.audio-script
    assert.throws(
      () => runPyBody('wrong-len.py', [
        'import os, wave, struct',
        'with wave.open(os.environ["BEIMING_AUDIO_OUT"], "wb") as w:',
        '    w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)',
        '    w.writeframes(struct.pack("<200h", *([0]*200)))',
      ].join('\n'), { expectedFrames: 30, fps: '30/1' }),
      isCode('failure.audio-script'),
    );

    assert.throws(
      () => runPyBody('truncated-frame.py', [
        'import os, wave',
        'out = os.environ["BEIMING_AUDIO_OUT"]',
        'with wave.open(out, "wb") as w:',
        '    w.setparams((2, 2, 48000, 48000, "NONE", ""))',
        '    w.writeframes(bytes(48000 * 4))',
        'os.truncate(out, os.path.getsize(out) - 4)',
      ].join('\n'), { expectedFrames: 30, fps: '30/1' }),
      isCode('failure.audio-script'),
    );

    // 10. RIFF 声明边界后若残留旧渲染的 data 块，解码结果必须严格以 RIFF 边界为准（与 Python wave 一致）
    const trailingDataRes = runPyBody('riff-trailing-data.py', [
      'import os, pathlib, struct',
      'out = os.environ["BEIMING_AUDIO_OUT"]',
      'pcm_valid = struct.pack("<3200h", *([1024] * 3200))',
      'pcm_stale = struct.pack("<1600h", *([2048] * 1600))',
      'fmt_chunk = struct.pack("<4sIHHIIHH", b"fmt ", 16, 1, 2, 48000, 48000 * 4, 4, 16)',
      'data_valid = struct.pack("<4sI", b"data", len(pcm_valid)) + pcm_valid',
      'data_stale = struct.pack("<4sI", b"data", len(pcm_stale)) + pcm_stale',
      'riff_body = b"WAVE" + fmt_chunk + data_valid',
      'riff_head = struct.pack("<4sI", b"RIFF", len(riff_body))',
      'pathlib.Path(out).write_bytes(riff_head + riff_body + data_stale)',
    ].join('\n'), { expectedFrames: 1, fps: 30 });
    assert.equal(trailingDataRes.samples, 1600, 'RIFF 边界内为 1600 采样，尾部残余块不得覆盖解码');
    assert.equal(Math.round(trailingDataRes.wav.left[0] * 32768), 1024, '首样本必须取 RIFF 边界内的 1024 而非尾部残余的 2048');

    // 11. 含空格、分号、引号、$() 的路径不经 shell 安全执行
    const weirdDir = join(dir, "odd dir; $(echo injected) 'quote' [1]");
    mkdirSync(weirdDir, { recursive: true });
    const weirdScript = join(weirdDir, 'sound.py');
    writeFileSync(weirdScript, PROCEDURAL_SOUND_PY);
    const safeRes = runAudioScript({
      script: weirdScript,
      events,
      outPath: join(weirdDir, 'out mix.wav'),
      expectedFrames: 30,
      fps: '30/1',
    });
    assert.equal(safeRes.samples, 48000);
  });
});

test('X6-03B-External: 未修改 03B 契约（--events / --out + report.json + stems/*.wav）脚本实测', (t) => {
  const external03bScript = process.env.BEIMING_03B_SOUND_SCRIPT;
  const external03bEvents = process.env.BEIMING_03B_EVENTS;
  if (!external03bScript && !external03bEvents) {
    t.skip('未设置 BEIMING_03B_SOUND_SCRIPT 与 BEIMING_03B_EVENTS，跳过外部 03B 真实验证');
    return;
  }
  assert.ok(external03bScript, '设置 BEIMING_03B_EVENTS 时必须同时提供 BEIMING_03B_SOUND_SCRIPT');
  const siblingOutEvents = join(dirname(external03bScript), '..', 'out', 'events.json');
  const eventsInput = external03bEvents
    || (existsSync(siblingOutEvents) ? siblingOutEvents : join(dirname(external03bScript), 'events.json'));

  const dir = makeTempDir(t);
  const res = runAudioScript({
    script: external03bScript,
    events: eventsInput,
    outPath: join(dir, '03b.wav'),
    expectedFrames: 600,
    fps: 30,
  });
  assert.equal(res.sampleRate, 48000);
  assert.equal(res.channels, 2);
  assert.equal(res.samples, 960000);
  assert.ok(res.report && typeof res.report === 'object', '03B 脚本应产出伴随 report.json');
  assert.equal(res.report.file, res.path, '03B 报告中的 file 字段应指向已发布主 WAV 路径');
  assert.equal(existsSync(res.report.file), true);
  assert.deepEqual(
    res.stems.map((p) => basename(p)),
    ['ambience.wav', 'music.wav', 'sfx.wav'],
    '03B 脚本应产出 ambience.wav、music.wav、sfx.wav 三条分轨',
  );
  for (const stemPath of res.stems) {
    const stemWav = readWav(readFileSync(stemPath));
    assert.equal(stemWav.left.length, 960000);
  }
  if (hasFfmpeg) {
    const loud = measureLoudness(res.path);
    assert.ok(loud.integrated >= -15 && loud.integrated <= -13, `03B 响度 ${loud.integrated} LUFS`);
    assert.ok(loud.truePeak <= -1, `03B 真峰值 ${loud.truePeak} dBTP`);
  }
});
