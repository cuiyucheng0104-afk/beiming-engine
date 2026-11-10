// AI 生成内容标识（D11）：隐式标识的生成与解析、C2PA 块检测、底板来源链、入口文档措辞。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXPLICIT, implicitLabel, ffmpegMetadataArgs, parseImplicitLabel, hasC2pa, fileHasC2pa, platesProvenance, docClaims } from '../../tools/compliance/lib/aigc.mjs';
import { REPO, mkRepo, rm, runCli, parseEnvelope } from './helpers.mjs';

test('隐式标识：生成后能原样解析回来', () => {
  const s = implicitLabel({ producer: '北冥引擎 Beiming Engine', produceId: 'beiming-10s@20261110-160000-abc1234', kinds: ['visual', 'voice'], tools: ['Midjourney V8'] });
  assert.ok(s.startsWith('AIGC{"Label":"1","ContentProducer":'));
  const p = parseImplicitLabel(s);
  assert.equal(p.ok, true, p.problems.join('；'));
  assert.equal(p.label, '1');
  assert.equal(p.fields.ProduceID, 'beiming-10s@20261110-160000-abc1234');
  assert.ok(p.statement.includes(EXPLICIT.visual) && p.statement.includes(EXPLICIT.voice));
  assert.deepEqual(ffmpegMetadataArgs({ producer: 'a', produceId: 'b' }).slice(0, 1), ['-metadata']);
});

test('隐式标识：缺失、残缺、Label 不对都判不通过', () => {
  assert.equal(parseImplicitLabel(null).ok, false);
  assert.equal(parseImplicitLabel('encoded by x').ok, false);
  assert.equal(parseImplicitLabel('AIGC{"Label":"1"').ok, false);
  assert.match(parseImplicitLabel('AIGC{"Label":"9","ContentProducer":"a","ProduceID":"b"} 含 AI 生成画面').problems.join(), /Label/);
  assert.match(parseImplicitLabel('AIGC{"Label":"1","ContentProducer":"a","ProduceID":"b"}').problems.join(), /人读说明/);
  // 说明里带大括号也能正确配对
  assert.equal(parseImplicitLabel('AIGC{"Label":"1","ContentProducer":"a{b}","ProduceID":"c"} 含 AI 生成画面').ok, true);
  assert.throws(() => implicitLabel({ producer: 'a', produceId: 'b', kinds: ['smell'] }), /kinds/);
  assert.throws(() => implicitLabel({ producer: 'a' }), /produceId/);
});

function png(chunks) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig];
  for (const [type, data] of chunks) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    parts.push(len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4));
  }
  return Buffer.concat(parts);
}

test('C2PA：PNG 的 caBX 块、JPEG 的 APP11 JUMBF 段', () => {
  assert.equal(hasC2pa(png([['IHDR', Buffer.alloc(13)], ['caBX', Buffer.from('jumbc2pa')], ['IEND', Buffer.alloc(0)]])), 'png');
  assert.equal(hasC2pa(png([['IHDR', Buffer.alloc(13)], ['IDAT', Buffer.alloc(10)], ['IEND', Buffer.alloc(0)]])), null);
  const app11 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xeb, 0x00, 0x10]), Buffer.from('JP\0\0jumbc2pa..', 'latin1'), Buffer.from([0xff, 0xda])]);
  assert.equal(hasC2pa(app11), 'jpeg');
  assert.equal(hasC2pa(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xda])), null);
  assert.equal(hasC2pa(Buffer.from('not an image')), null);
});

test('C2PA：仓库里由生成服务签名的风格参考图能认出清单', () => {
  assert.equal(fileHasC2pa(path.join(REPO, 'assets/ref/sky_test.png')), 'png');
  assert.equal(fileHasC2pa(path.join(REPO, 'no-such.png')), null);
});

test('底板来源链：清单级记录、逐张来源、声明不含 AI', () => {
  const dir = mkRepo({ 'a.png': png([['IHDR', Buffer.alloc(13)], ['IEND', Buffer.alloc(0)]]), 'b.png': png([['caBX', Buffer.alloc(4)], ['IEND', Buffer.alloc(0)]]), 'c.png': png([['IEND', Buffer.alloc(0)]]) }, { commit: false });
  try {
    const pv = platesProvenance({ 生成: 'Midjourney V8', plates: [{ file: 'a.png' }, { file: 'b.png' }, { file: 'c.png', 来源: { 工具: 'GPT Image' } }, { file: 'd.png' }] }, dir);
    assert.equal(pv.record, '生成');
    assert.deepEqual(pv.plates.map(p => [p.file, p.c2pa, p.record, p.exists]), [['a.png', null, null, true], ['b.png', 'png', null, true], ['c.png', null, '来源', true], ['d.png', null, null, false]]);
    assert.equal(platesProvenance({ plates: [] }, dir).record, null);
    assert.equal(platesProvenance({ aigc: { contains: false }, plates: [] }, dir).contains, false);
  } finally { rm(dir); }
});

test('入口文档措辞：无限定的「手绘底板」报，有「AI 生成」限定或只说画风的不报', () => {
  assert.deepEqual(docClaims('画面语言：手绘底板视差').map(c => c.phrase), ['手绘底板']);
  assert.equal(docClaims('绘画底板由 AI 生成后手工整理，不是手绘底板').length, 0);
  assert.equal(docClaims('手绘质感的三渲二画面').length, 0);
  assert.equal(docClaims('底板与人物全部由代码逐帧绘制').length, 1);
  assert.equal(docClaims('第一行\n第二行写手绘的底板').map(c => c.line).join(), '2');
});

test('命令行：label 打印标识，check 对缺标识的成片退出码 4', () => {
  const r = runCli('tools/compliance/aigc.mjs', ['label', '--id', 't', '--run', 'r1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const env = parseEnvelope(r.stdout);
  assert.ok(parseImplicitLabel(env.result.comment).ok);
  assert.equal(runCli('tools/compliance/aigc.mjs', ['label']).code, 2, '缺 --id 是用法错误');
  assert.equal(runCli('tools/compliance/aigc.mjs', ['label', '--id', 't', '--kinds', 'smell']).code, 2);
  assert.equal(runCli('tools/compliance/aigc.mjs', ['check', path.join(REPO, 'no-such.mp4')]).code, 3);
  const ff = spawnSync('ffprobe', ['-version']);
  if (ff.status !== 0) return;      // 没装 FFmpeg 的机器跳过成片核对（环境自检会单独报告）
  const tmp = mkRepo({}, { commit: false });
  try {
    const encode = (out, extra) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=0.1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...extra, out]).status === 0;
    const bare = path.join(tmp, 'bare.mp4'), out = path.join(tmp, 'ok.mp4');
    if (!encode(bare, []) || !encode(out, env.result.ffmpegArgs)) return;   // 没有 libx264 的 FFmpeg 跳过
    assert.equal(runCli('tools/compliance/aigc.mjs', ['check', bare]).code, 4, '没有隐式标识的成片不通过');
    const ok = runCli('tools/compliance/aigc.mjs', ['check', out, '--json']);
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(parseEnvelope(ok.stdout).result.items[0].label, '1');
  } finally { rm(tmp); }
});

test('《北冥》底板清单：有清单级生成记录，列出的底板文件都在', () => {
  const man = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/plates/plates.json'), 'utf8'));
  const pv = platesProvenance(man, path.join(REPO, 'assets/plates'));
  assert.ok(pv.record, '清单顶层要有生成来源记录');
  assert.ok(pv.plates.length > 0 && pv.plates.every(p => p.exists));
});
