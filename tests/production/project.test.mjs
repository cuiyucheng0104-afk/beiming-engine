import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ContractError,
  deriveOutput,
  executionStatus,
  normalizeRelativePath,
  parseProjectSpec,
  resolveProjectPath,
  validateProjectSpec,
  validateRenderResult,
} from '../../engine/production/project.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const readTemplate = name => JSON.parse(readFileSync(new URL(`../../docs/routes/templates/${name}`, import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const codes = result => result.diagnostics.map(d => d.code);

const beimingTemplate = () => readTemplate('project-beiming.json');
const raeaTemplate = () => readTemplate('project-raea.json');
const resultTemplate = () => readTemplate('render-result.json');

test('两条路线的项目模板都能通过契约校验，且 RAEA 不被强制要求 FrameState', () => {
  const beiming = validateProjectSpec(beimingTemplate(), { root: repoRoot });
  assert.deepEqual(beiming.diagnostics, []);
  const raea = validateProjectSpec(raeaTemplate(), { root: repoRoot });
  assert.deepEqual(raea.diagnostics, []);
  assert.equal(Object.hasOwn(raeaTemplate(), 'frameState'), false);
});

test('checkFiles 模式能核对真实入口文件存在', () => {
  assert.equal(validateProjectSpec(beimingTemplate(), { root: repoRoot, checkFiles: true }).ok, true);
  assert.equal(validateProjectSpec(raeaTemplate(), { root: repoRoot, checkFiles: true }).ok, true);
  const missing = clone(beimingTemplate());
  missing.entry = 'examples/does-not-exist.html';
  assert.deepEqual(codes(validateProjectSpec(missing, { root: repoRoot, checkFiles: true })), ['entry-missing']);
});

test('未知 schemaVersion 拒绝自动解释', () => {
  const spec = clone(beimingTemplate());
  spec.schemaVersion = 2;
  assert.deepEqual(codes(validateProjectSpec(spec)), ['schema-version-unknown']);
  spec.schemaVersion = '1';
  assert.deepEqual(codes(validateProjectSpec(spec)), ['schema-version-missing']);
});

test('路线与后端分别校验，beiming + raea 必须声明风格迁移状态', () => {
  const spec = clone(beimingTemplate());
  spec.backend = 'raea';
  spec.runtime.package = '0.1.0-canary.2';
  assert.ok(codes(validateProjectSpec(spec)).includes('style-migration-required'));

  spec.style.migration = { state: 'partial', evidence: ['docs/style-baselines/migration.md'] };
  assert.deepEqual(validateProjectSpec(spec).diagnostics, []);

  spec.style.migration = { state: 'verified', evidence: [] };
  assert.ok(codes(validateProjectSpec(spec)).includes('style-migration-invalid'));

  const raeaWithThree = clone(raeaTemplate());
  raeaWithThree.backend = 'three';
  assert.ok(codes(validateProjectSpec(raeaWithThree)).includes('backend-route-unsupported'));
});

test('拒绝越界路径与非法路径写法', () => {
  for (const entry of ['/etc/passwd', 'C:/Windows/win.ini', 'C:\\Windows\\win.ini', '../outside.html', 'a/../../outside.html', '..\\outside.html', 'entry\u0000.html']) {
    const spec = clone(beimingTemplate());
    spec.entry = entry;
    assert.ok(codes(validateProjectSpec(spec)).includes('path-escape'), entry);
    assert.equal(normalizeRelativePath(entry).ok, false, entry);
  }
  const out = clone(beimingTemplate());
  out.output.outputDir = '../delivery/';
  assert.ok(codes(validateProjectSpec(out)).includes('path-escape'));

  assert.deepEqual(normalizeRelativePath('examples/raea/film.tsx'), { ok: true, segments: ['examples', 'raea', 'film.tsx'], path: 'examples/raea/film.tsx', isDirectory: false });
  assert.equal(normalizeRelativePath('out/').isDirectory, true);
  assert.equal(normalizeRelativePath('out/').path, 'out');
});

test('resolveProjectPath 返回根内路径并拒绝穿出根目录', () => {
  const resolved = resolveProjectPath(repoRoot, 'examples/raea/film.tsx', { kind: 'entry' });
  assert.equal(resolved.relative, 'examples/raea/film.tsx');
  assert.ok(resolved.absolute.endsWith('film.tsx'));
  assert.throws(() => resolveProjectPath(repoRoot, '../escape.txt'), ContractError);
  assert.throws(() => resolveProjectPath(repoRoot, 'C:/abs.txt'), ContractError);
});

test('输出定义必须完整：偶数宽高、整数帧数、时长由帧数推导', () => {
  const spec = clone(beimingTemplate());
  assert.deepEqual(deriveOutput(spec.output), { frameCount: 240, fps: 24, durationSeconds: 10 });

  const odd = clone(beimingTemplate());
  odd.output.width = 1921;
  assert.ok(codes(validateProjectSpec(odd)).includes('output-dimension-odd'));

  const incomplete = clone(beimingTemplate());
  delete incomplete.output.frameCount;
  assert.ok(codes(validateProjectSpec(incomplete)).includes('output-incomplete'));

  const derivedOk = clone(beimingTemplate());
  derivedOk.output.duration = 10;
  assert.deepEqual(validateProjectSpec(derivedOk).diagnostics, []);

  const durationMismatch = clone(beimingTemplate());
  durationMismatch.output.duration = 9.5;
  assert.deepEqual(codes(validateProjectSpec(durationMismatch)), ['output-duration-derived']);
});

test('运行时版本与源码提交必须记录', () => {
  const spec = clone(beimingTemplate());
  delete spec.runtime.three;
  assert.ok(codes(validateProjectSpec(spec)).includes('runtime-incomplete'));
  delete spec.runtime.sourceCommit;
  const both = codes(validateProjectSpec(spec));
  assert.ok(both.filter(code => code === 'runtime-incomplete').length >= 2);
});

test('资产清单、音频目标与计划字段的缺失会被明确拒绝', () => {
  const assets = clone(beimingTemplate());
  delete assets.assets.manifest;
  assert.deepEqual(codes(validateProjectSpec(assets)), ['assets-incomplete']);

  const inlineOk = clone(beimingTemplate());
  delete inlineOk.assets.manifest;
  inlineOk.assets.inline = [{ id: 'plate-main', file: 'assets/plates/main.png' }];
  assert.deepEqual(validateProjectSpec(inlineOk).diagnostics, []);

  const audio = clone(beimingTemplate());
  audio.audio.targetLUFS = 'loud';
  assert.deepEqual(codes(validateProjectSpec(audio)), ['audio-invalid']);
});

test('ProjectSpec 不能把计划 GPU 写成已执行证据', () => {
  const spec = clone(beimingTemplate());
  spec.execution.actualDevice = 'RTX 5090';
  assert.ok(codes(validateProjectSpec(spec)).includes('execution-planned-as-actual'));

  const planned = executionStatus(beimingTemplate());
  assert.equal(planned.state, 'planned-only');
  assert.equal(planned.evidence, null);
  assert.deepEqual(planned.planned, { target: 'windows-rtx', graphicsBackend: 'ANGLE-vulkan' });

  const referenced = clone(beimingTemplate());
  referenced.execution.evidence = { file: 'docs/raea/publication-validation.json' };
  assert.equal(executionStatus(referenced).state, 'evidence-referenced');
});

test('parseProjectSpec 接受字符串输入，并对无效 JSON 给出结构化诊断', () => {
  assert.equal(parseProjectSpec(JSON.stringify(beimingTemplate())).projectId, 'beiming-style-reference');
  assert.throws(() => parseProjectSpec('{ not json'), error => error instanceof ContractError && error.diagnostics[0].code === 'json-invalid');
  assert.throws(() => parseProjectSpec('{"schemaVersion": 1}', { root: repoRoot }), error => error instanceof ContractError && error.diagnostics.length > 0);
});

test('未执行的渲染结果不能预填实测成功字段', () => {
  const template = resultTemplate();
  assert.deepEqual(validateRenderResult(template).diagnostics, []);

  const prefilled = clone(template);
  prefilled.actualDevice = 'RTX 5090';
  prefilled.output.sha256 = 'abc123';
  const diagnostics = codes(validateRenderResult(prefilled));
  assert.ok(diagnostics.includes('result-prefilled'));
});

test('技术验收与创作验收必须分别成立，accepted 以技术通过为前提', () => {
  const acceptedWithoutTechnical = clone(resultTemplate());
  Object.assign(acceptedWithoutTechnical, {
    status: 'accepted',
    projectId: 'beiming-style-reference',
    shotId: 'S001',
    route: 'beiming',
    backend: 'three',
    actualDevice: 'RTX 5090',
    actualGraphicsBackend: 'ANGLE-vulkan',
    actualEncoder: 'h264_nvenc',
    output: { file: 'out/video.mp4', sha256: 'a'.repeat(64), width: 1920, height: 1040, fps: 24, frames: 240, duration: 10 },
    technicalAcceptance: { status: 'failed', evidence: ['ffprobe'] },
    creativeAcceptance: { status: 'accepted', events: ['girl looks up'], styleComparison: ['shot_7.6.jpg'], issues: [] },
  });
  const diagnostics = codes(validateRenderResult(acceptedWithoutTechnical));
  assert.ok(diagnostics.includes('result-accepted-without-technical'));

  const accepted = clone(acceptedWithoutTechnical);
  accepted.technicalAcceptance = { status: 'passed', evidence: ['node tools/qa/check.mjs out/video.mp4'] };
  assert.deepEqual(validateRenderResult(accepted, { expectedFrameCount: 240 }).diagnostics, []);

  assert.deepEqual(codes(validateRenderResult(accepted, { expectedFrameCount: 239 })), ['result-frame-count-mismatch']);
});
