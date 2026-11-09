// 鲲与渡船 GLB 的结构检查：通用检查在 engine/native/bridge/validate.mjs，这里只写《北冥》两件资产的预期。
//   node examples/raea/tools/export-kun-validate.mjs examples/raea/media/kun.glb
//   node examples/raea/tools/export-kun-validate.mjs examples/raea/media/ferry.glb --static
import { pathToFileURL } from 'node:url';
import { validateGLB as validate } from '../../../engine/native/bridge/validate.mjs';

export const KUN_EXPECT = {
  animated: true, clip: 'Swim', duration: 10, skinnedMin: 2,
  nodes: ['kun-fin-R', 'kun-fin-L', 'kun-eyelid-upper-R', 'kun-eyelid-lower-L'],
  skinnedNodes: ['kun-flukes'], notAnimated: ['kun'],
};

export const validateGLB = (path, { animated = true } = {}) => validate(path, animated ? KUN_EXPECT : {});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await validateGLB(process.argv[2], { animated: !process.argv.includes('--static') }), null, 2));
}
