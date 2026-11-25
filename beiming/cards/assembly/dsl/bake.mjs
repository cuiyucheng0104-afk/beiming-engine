// 烘焙落点每个配方只调用一次。outPath 省略时直接将结果交给 Blender 卡的 baked 参数。
export { bakeAssembly as evaluate } from '../../../sources/blender/bake.mjs';
