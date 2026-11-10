#!/usr/bin/env node
// 测试桩：模拟 P05 engine/production/film.js 的命令面，只供 tests/eval/ 使用。
//
//   node film.js check <作品目录> --json          按附录 C6 的最小规则校验 film.json
//   node film.js validate-result <run.json> --json 调用仓库里 engine/production/project.js 的 validateRenderResult
//
// check 的最小规则：schemaVersion 为 2；output.frameCount 为正整数；镜头是半开区间、首尾相接、覆盖 [0, frameCount)；
// 每个事件落在所属镜头内。真正的校验器由 P05 实现，规则更全。
// 环境变量 EVAL_STUB_FILM（JSON）可强制某个子命令返回 "usage"（exit 2），用来测「接口与约定不符」时的判定。

import fs from 'node:fs';
import path from 'node:path';
import { validateRenderResult } from '../../../../../../engine/production/project.js';

const argv = process.argv.slice(2);
const [sub, target] = argv;
const forced = JSON.parse(process.env.EVAL_STUB_FILM || '{}')[sub];
const envelope = (ok, exitCode, diagnostics, error = null) => ({ ok, exitCode, command: `film.js ${sub}`, error, outputs: [], runJson: null, warnings: [], data: { diagnostics } });
const emit = (value, code) => { process.stdout.write(JSON.stringify(value) + '\n'); process.exit(code); };

if (argv.includes('--help')) { process.stdout.write('测试桩：film.js check <作品目录> --json | validate-result <run.json> --json\n'); process.exit(0); }
if (forced === 'usage' || !['check', 'validate-result'].includes(sub) || !target) emit(envelope(false, 2, [], { code: 'usage', message: `用法错误：${argv.join(' ')}`, hint: '加 --help 查看用法' }), 2);

if (sub === 'check') {
  const file = path.join(target, 'film.json');
  if (!fs.existsSync(file)) emit(envelope(false, 4, [{ code: 'film-missing', message: '没有 film.json' }], { code: 'film-invalid', message: '没有 film.json', hint: null }), 4);
  let film;
  try { film = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { emit(envelope(false, 4, [{ code: 'json-invalid', message: e.message }], { code: 'film-invalid', message: 'film.json 不是合法 JSON', hint: null }), 4); }
  const diags = [];
  if (film.schemaVersion !== 2) diags.push({ code: 'schema-version', message: `schemaVersion 应为 2（收到 ${film.schemaVersion}）` });
  const n = film.output?.frameCount;
  if (!Number.isInteger(n) || n <= 0) diags.push({ code: 'frame-count', message: 'output.frameCount 必须是正整数' });
  const shots = Array.isArray(film.shots) ? film.shots : [];
  if (!shots.length) diags.push({ code: 'shots-empty', message: '没有镜头' });
  let cursor = 0;
  for (const s of shots) {
    if (s.in !== cursor) diags.push({ code: 'shots-gap', message: `镜头 ${s.id} 从 ${s.in} 开始，应从 ${cursor} 开始（半开区间首尾相接）` });
    if (!(s.out > s.in)) diags.push({ code: 'shot-empty', message: `镜头 ${s.id} 的 out 不大于 in` });
    cursor = s.out;
  }
  if (Number.isInteger(n) && shots.length && cursor !== n) diags.push({ code: 'shots-coverage', message: `镜头覆盖到 ${cursor}，应覆盖到 frameCount=${n}` });
  for (const e of Array.isArray(film.events) ? film.events : []) {
    const s = shots.find(x => x.id === e.shot);
    if (!s || e.frame < s.in || e.frame >= s.out) diags.push({ code: 'event-outside-shot', message: `事件 ${e.id} 的第 ${e.frame} 帧不在镜头 ${e.shot} 内` });
  }
  emit(envelope(!diags.length, diags.length ? 4 : 0, diags, diags.length ? { code: 'film-invalid', message: diags[0].message, hint: '按诊断修正 film.json' } : null), diags.length ? 4 : 0);
}

let result;
try { result = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { emit(envelope(false, 4, [{ code: 'json-invalid', message: e.message }], { code: 'result-invalid', message: 'run.json 读不了', hint: null }), 4); }
const r = validateRenderResult(result);
emit(envelope(r.ok, r.ok ? 0 : 4, r.diagnostics, r.ok ? null : { code: 'result-invalid', message: r.diagnostics.map(d => `[${d.code}] ${d.message}`).slice(0, 3).join('；'), hint: null }), r.ok ? 0 : 4);
