// 探针镜头，测试工具的一部分（s7.test.mjs 用），不是给片子用的：照 beiming/calib/ 的规格搭场景，给场景查询当被问的对象。
// ctx.params：scene 选校准规格，或者 spec 直接交一份同样写法的规格（搭落到地面以下的、超过 50 个实体的场景用）。
// 实体名把规格里的连字符换成下划线（实体名不许带连字符）；每个实体经 meta(f) 交一个锚点 center：它这一刻的世界位置。
// 测边界另有两样：instanced 是 { 实体名: [[x, y, z], …] }，每个名字加一个实例网格实体，实例是边长 1 米的方块、各自平移到给的位置（不交 center 锚点）；
// anchors 是 { '实体名#锚点名': 坐标 }，照原样并进 meta(f) 交的锚点（可以故意写坏）；
// holes 是 { '实体名#锚点名': 下标 }，交 [0, 0, −3] 挖掉那个下标的带空位数组（空位过不了 JSON，只能在页面里造）；
// twoStep 是 { '实体名#锚点名': [x, y, z] }，交一个 Array 子类的实例：三个下标都在，迭代器却只交前两项（展开、解构、for..of 会丢 Z）。
import { calibShot } from '../../calib/shot-three.js';
import turntable from '../../calib/probe-axes-turntable/scene.json' with { type: 'json' };
import steps from '../../calib/probe-plane-steps/scene.json' with { type: 'json' };

const SPECS = { 'probe-plane-steps': steps, 'probe-axes-turntable': turntable };

export function build(ctx) {
  const spec = ctx.params.spec ?? SPECS[ctx.params.scene];
  if (!spec) throw new Error(`探针镜头不认识规格 ${ctx.params.scene}`);
  const objects = spec.objects.map((o) => ({ ...o, id: o.id.replaceAll('-', '_') }));
  const shot = calibShot({ ...spec, objects })(ctx), { THREE } = ctx;
  const swarms = Object.entries(ctx.params.instanced ?? {}).map(([name, at]) => {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), at.length);
    mesh.name = name;
    at.forEach((p, i) => mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(...p)));
    shot.scene.add(mesh);
    shot.entities[name] = mesh;
    return mesh;
  });
  const holed = ([key, i]) => { const world = [0, 0, -3]; delete world[i]; return [key, world]; };
  class TwoStep extends Array { *[Symbol.iterator]() { yield this[0]; yield this[1]; } }
  const twoStep = ([key, [x, y, z]]) => [key, TwoStep.of(x, y, z)];
  return {
    ...shot,
    meta: () => ({ anchors: { ...Object.fromEntries(objects.map((o) => [`${o.id}#center`, shot.entities[o.id].position.toArray()])), ...ctx.params.anchors, ...Object.fromEntries(Object.entries(ctx.params.holes ?? {}).map(holed)), ...Object.fromEntries(Object.entries(ctx.params.twoStep ?? {}).map(twoStep)) } }),
    dispose() {
      shot.dispose();
      for (const mesh of swarms) { mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose(); }
    },
  };
}
