#!/usr/bin/env node
// 鲲与渡船 GLB 的结构检查：通用检查在 engine/native/bridge/validate.mjs，这里只写《北冥》两件资产的预期。
//   node examples/raea/tools/export-kun-validate.mjs examples/raea/media/kun.glb
//   node examples/raea/tools/export-kun-validate.mjs examples/raea/media/ferry.glb --static
// 退出码：0 通过 · 2 用法（没给文件、文件不存在）· 4 不通过。经符号链接、/tmp 别名、Windows 目录联接调用也照常执行
// （tools/lib/cli.mjs 的 isMain 比较真实路径，审查 R06）。
import { EXIT, bind, exitWith, fail, log } from '../../../engine/native/cli.mjs';
import { validateGLB as validate } from '../../../engine/native/bridge/validate.mjs';
import { defineCommand, isMain, runCli } from '../../../tools/lib/cli.mjs';

export const KUN_EXPECT = {
  animated: true, clip: 'Swim', duration: 10, skinnedMin: 2,
  nodes: ['kun-fin-R', 'kun-fin-L', 'kun-eyelid-upper-R', 'kun-eyelid-lower-L'],
  skinnedNodes: ['kun-flukes'], notAnimated: ['kun'],
};

export const validateGLB = (path, { animated = true } = {}) => validate(path, animated ? KUN_EXPECT : {});

export const command = defineCommand({
  name: 'raea:validate',
  summary: '《北冥》例片资产的 GLB 结构检查：鲲按 Swim 动画预期，渡船（--static）只做结构检查',
  usage: ['node examples/raea/tools/export-kun-validate.mjs <x.glb> [--static] [--json]'],
  positionals: [{ name: 'glb', label: '<x.glb>', describe: 'examples/raea/media/kun.glb 或 ferry.glb' }],
  options: { static: { type: 'boolean', describe: '不要求动画（渡船）' } },
  exitCodes: { 0: '通过', 2: '用法错误（文件不存在）', 4: '结构检查不通过' },
  async run(ctx) {
    bind(ctx);
    const file = ctx.args.glb;
    let s;
    try { s = await validateGLB(file, { animated: !ctx.opts.static }); }
    catch (e) { throw fail(/读不了/.test(e.message) ? EXIT.USAGE : EXIT.CONTRACT, 'glb', `${file}：${e.message}`, /读不了/.test(e.message) ? '确认文件路径；素材由 node examples/raea/tools/prepare.mjs 生成' : '重导：node examples/raea/tools/export-kun.mjs'); }
    log(JSON.stringify(s, null, 2));
    log(`通过：${s.sceneTriangles} 三角面，${s.animations.map(x => `${x.name} ${x.duration}s`).join('、') || '无动画'}`);
    return { data: s };
  },
});

if (isMain(import.meta.url)) await exitWith(runCli(command));
