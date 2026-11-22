// 探针镜头，测试工具的一部分（s7.test.mjs 用），不是给片子用的：照 beiming/calib/ 的规格搭场景，给场景查询当被问的对象。
// ctx.params：scene 选校准规格，或者 spec 直接交一份同样写法的规格（搭落到地面以下的、超过 50 个实体的场景用）。
// 实体名把规格里的连字符换成下划线（实体名不许带连字符）；每个实体经 meta(f) 交一个锚点 center：它这一刻的世界位置。
import { calibShot } from '../../calib/shot-three.js';
import turntable from '../../calib/probe-axes-turntable/scene.json' with { type: 'json' };
import steps from '../../calib/probe-plane-steps/scene.json' with { type: 'json' };

const SPECS = { 'probe-plane-steps': steps, 'probe-axes-turntable': turntable };

export function build(ctx) {
  const spec = ctx.params.spec ?? SPECS[ctx.params.scene];
  if (!spec) throw new Error(`探针镜头不认识规格 ${ctx.params.scene}`);
  const objects = spec.objects.map((o) => ({ ...o, id: o.id.replaceAll('-', '_') }));
  const shot = calibShot({ ...spec, objects })(ctx);
  return { ...shot, meta: () => ({ anchors: Object.fromEntries(objects.map((o) => [`${o.id}#center`, shot.entities[o.id].position.toArray()])) }) };
}
