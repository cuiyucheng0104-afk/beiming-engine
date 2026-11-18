// 校准场景的镜头代码：规格在旁边的 moving-cube.scene.json 里（从校准目录抄的相机、背景、物体），外面包着测试工具的观测点。
import { calibShot } from './calib-scene.js';
import { observed } from './observe.js';
import spec from './moving-cube.scene.json' with { type: 'json' };

export const build = observed(calibShot(spec));
