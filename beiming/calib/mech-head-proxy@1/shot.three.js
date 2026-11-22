// three 页面宿主的镜头入口：规格是旁边的 scene.json，搭法在 ../shot-three.js。
import { calibShot } from '../shot-three.js';
import spec from './scene.json' with { type: 'json' };

export const build = calibShot(spec);
