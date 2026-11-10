#!/usr/bin/env node
// 鲲与渡船 GLB 的结构检查：通用检查在 engine/native/bridge/validate.mjs，这里只写《北冥》两件资产的预期。
//   node examples/raea/tools/export-kun-validate.mjs examples/raea/media/kun.glb
//   node examples/raea/tools/export-kun-validate.mjs examples/raea/media/ferry.glb --static
// 退出码：0 通过 · 2 用法（没给文件、文件不存在）· 4 不通过。经符号链接、/tmp 别名、Windows 目录联接调用也照常执行（比较 realpath）。
import { CliError, EXIT, exitWith, isMain, log, runCli } from '../../../engine/native/cli.mjs';
import { validateGLB as validate } from '../../../engine/native/bridge/validate.mjs';

export const KUN_EXPECT = {
  animated: true, clip: 'Swim', duration: 10, skinnedMin: 2,
  nodes: ['kun-fin-R', 'kun-fin-L', 'kun-eyelid-upper-R', 'kun-eyelid-lower-L'],
  skinnedNodes: ['kun-flukes'], notAnimated: ['kun'],
};

export const validateGLB = (path, { animated = true } = {}) => validate(path, animated ? KUN_EXPECT : {});

const USAGE = `node examples/raea/tools/export-kun-validate.mjs <x.glb> [--static] [--json]
  鲲（默认，按 Swim 动画预期检查）或渡船（--static，只做结构检查）`;

if (isMain(import.meta.url)) {
  await exitWith(runCli({
    command: 'export-kun-validate', usage: USAGE, spec: { '--static': 'bool' },
    main: async a => {
      if (a._.length !== 1) throw new CliError(EXIT.USAGE, 'usage', '要给一个 .glb 文件', USAGE.split('\n')[0]);
      let s;
      try { s = await validateGLB(a._[0], { animated: !a.static }); }
      catch (e) { throw new CliError(/读不了/.test(e.message) ? EXIT.USAGE : EXIT.CONTRACT, 'glb', `${a._[0]}：${e.message}`); }
      log(JSON.stringify(s, null, 2));
      log(`通过：${s.sceneTriangles} 三角面，${s.animations.map(x => `${x.name} ${x.duration}s`).join('、') || '无动画'}`);
      return { info: s };
    },
  }));
}
