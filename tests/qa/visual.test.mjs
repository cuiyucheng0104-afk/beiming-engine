// qa visual：黑帧、静帧 12 帧、单帧 +20 亮度、多余切点各自以指定检查项不通过；作品描述声明的停顿 / 黑场 / 镜头表放行（P07 验收第 2 条）。
// 画面用 640×360 生成（分析时本来就缩到 ≤480 宽），快。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { haveFfmpeg, tmp, cleanup, clip, qa, check, writeJson, TEST_PROFILES } from './helpers.mjs';

const skip = haveFfmpeg ? false : '没有 FFmpeg ≥ 7（D09），跳过';
after(cleanup);

const S = '640x360';
const P = ['--profile', 't-360p24', '--profiles-file', TEST_PROFILES];
let dir;
// 每个样本放在自己的子目录：成片旁边有 film.json 时 QA 会自动认作这部片的作品描述
const sample = (name, opts, filmObj = null) => {
  const d = path.join(dir, name);
  fs.mkdirSync(d);
  const f = clip(path.join(d, `${name}.mp4`), { size: S, audio: 'none', ...opts });
  if (filmObj) writeJson(path.join(d, 'film.json'), filmObj);
  return f;
};
const film = (extra = {}) => ({
  schemaVersion: 2, id: 'qa-visual', title: '画面夹具', route: 'a',
  output: { profile: 't-360p24', width: 640, height: 360, fps: 24, frameCount: 96 },
  shots: [{ id: 'S1', in: 0, out: 96 }], audio: { mode: 'none' }, aigc: { contains: false }, ...extra,
});
const status = (r, id) => check(r.env, id)?.status;

before(() => { if (!skip) dir = tmp(); });

test('干净样本：画面各项硬门通过', { skip }, () => {
  const f = sample('clean', {}, film());
  const r = qa(['visual', f, ...P]);
  assert.equal(r.code, 0, JSON.stringify(r.env?.result?.checks?.filter(c => c.status === 'fail')));
  for (const id of ['visual.black', 'visual.freeze', 'visual.flicker', 'visual.cuts']) assert.equal(status(r, id), 'pass', id);
});

test('注入 12 帧黑场：visual.black 不通过，并报出帧区间', { skip }, () => {
  const f = sample('black', { vf: "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(n,30,41)'" }, film());
  const r = qa(['visual', f, ...P]);
  assert.equal(r.code, 4);
  const c = check(r.env, 'visual.black');
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.evidence.segments, [[30, 42]]);
});

test('声明过的黑场（qa.intentional kind=black）放行', { skip }, () => {
  const f = sample('black-ok', { vf: "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(n,30,41)'" },
    film({ qa: { intentional: [{ kind: 'black', from: 30, to: 42, reason: '转场黑场' }] } }));
  const r = qa(['visual', f, ...P]);
  assert.equal(status(r, 'visual.black'), 'pass');
});

test('静帧 12 帧：visual.freeze 不通过', { skip }, () => {
  // loop 的 start=40 让第 39 帧（从 0 数）多放 11 次：第 39–50 帧共 12 帧逐位相同（framemd5 核对过），再截回 96 帧
  const f = sample('freeze', { vf: 'loop=loop=11:size=1:start=40,setpts=N/24/TB' }, film());
  const r = qa(['visual', f, ...P]);
  assert.equal(r.code, 4);
  const c = check(r.env, 'visual.freeze');
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.evidence.segments, [[39, 51]]);
});

test('声明过的停顿（qa.intentional kind=freeze）放行', { skip }, () => {
  const f = sample('freeze-ok', { vf: 'loop=loop=11:size=1:start=40,setpts=N/24/TB' },
    film({ qa: { intentional: [{ kind: 'freeze', from: 39, to: 51, reason: '定格半秒等观众读字' }] } }));
  const r = qa(['visual', f, ...P]);
  assert.equal(status(r, 'visual.freeze'), 'pass');
});

test('单帧亮度 +20：visual.flicker 不通过，定位到那一帧', { skip }, () => {
  const f = sample('flash', { vf: "lutyuv=y='clip(val+20,0,255)':enable='eq(n,50)'" }, film());
  const r = qa(['visual', f, ...P]);
  assert.equal(r.code, 4);
  const c = check(r.env, 'visual.flicker');
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.findings.filter(x => x.status === 'fail').map(x => x.frames), [[50, 51]]);
});

test('多余切点：镜头表只有一个镜头、画面在第 48 帧硬切，visual.cuts 不通过；镜头表写上切点后通过', { skip }, () => {
  const src = "testsrc2=s={S}:r={R}:d=2[a];smptehdbars=s={S}:r={R}:d=2[b];[a][b]concat=n=2:v=1:a=0";
  const f = sample('cut', { src }, film());
  const r = qa(['visual', f, ...P]);
  assert.equal(r.code, 4);
  const c = check(r.env, 'visual.cuts');
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.evidence.detected.map(d => d.frame), [48]);
  const f2 = sample('cut-ok', { src }, film({ shots: [{ id: 'S1', in: 0, out: 48 }, { id: 'S2', in: 48, out: 96 }] }));
  const r2 = qa(['visual', f2, ...P]);
  assert.equal(status(r2, 'visual.cuts'), 'pass');
  assert.deepEqual(check(r2.env, 'visual.cuts').evidence.matched.map(m => m.offset), [0]);
});

test('镜头表写了切点、画面上没切：漏检只记注意（软项）', { skip }, () => {
  const f = sample('nocut', {}, film({ shots: [{ id: 'S1', in: 0, out: 48 }, { id: 'S2', in: 48, out: 96 }] }));
  const r = qa(['visual', f, ...P]);
  assert.equal(status(r, 'visual.cuts'), 'warn');
});
