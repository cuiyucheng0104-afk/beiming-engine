// 探针镜头：测试工具的一部分（cards/m1a-cards.test.mjs 用），不是给片子用的镜头。一个带入口文件的镜头，经 ctx.cards.use 装片子描述里声明的卡，
// 把卡交回的 Handle 上实际有什么（成员、实体的相对名、哪个是根、meta 交了哪些键和文字框 id）摊成读数交出去，外面再包一层观测点。
// 读数只能是数，字符串按字符码摊开：<键>.n 是项数，<键>.<i>.n 是第 i 项的长度，<键>.<i>.<j> 是第 j 个字符码。
// params：uses 是要装的实例名（数组）；misuse 是故意做错的一件事：undeclared 装一个没声明过的实例，shadow 给 runtime 传一个和卡参数同名的键。
// 场景：一个边长 0.5 米的灰方块在相机前 4 米处绕 Y 轴转；实体类卡的 object 挂在相机下面。米，右手系，Y 向上。
import { observed } from '../../kernel/conformance/fixtures/observe.js';

const putList = (out, key, list) => {
  out[`${key}.n`] = list.length;
  list.forEach((text, i) => {
    out[`${key}.${i}.n`] = text.length;
    for (let j = 0; j < text.length; j++) out[`${key}.${i}.${j}`] = text.charCodeAt(j);
  });
};

/** 从读数里把一个列表读回来；没有就是 undefined */
export function getList(readings, key) {
  const n = readings[`${key}.n`];
  return n === undefined ? undefined : Array.from({ length: n }, (_, i) => String.fromCharCode(...Array.from({ length: readings[`${key}.${i}.n`] }, (_, j) => readings[`${key}.${i}.${j}`])));
}

export const build = observed((ctx) => {
  const { THREE } = ctx, { uses = [], misuse } = ctx.params;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, ctx.size[0] / ctx.size[1], 0.1, 100);
  scene.add(camera);
  const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5), material = new THREE.MeshBasicMaterial({ color: 0x777777 });
  const cube = new THREE.Mesh(geometry, material);
  cube.position.set(0, -0.6, -4);
  scene.add(cube);

  if (misuse === 'undeclared') ctx.cards.use('nobody');
  if (misuse === 'shadow') ctx.cards.use(uses[0], { text: 'X' });
  const handles = uses.map((as) => ({ as, handle: ctx.cards.use(as) }));
  // 同一个实例名再用一次，拿到的得是同一个 Handle
  const again = uses.map((as, i) => (ctx.cards.use(as) === handles[i].handle ? 1 : 0));
  for (const { handle } of handles) if (handle.object) camera.add(handle.object);

  return {
    scene, camera, entities: { cube },
    state(f, sub) {
      ctx.tracks.apply(f, sub);
      cube.rotation.y = (f + sub) * 0.05;
      for (const { handle } of handles) handle.apply?.(f, sub);
    },
    meta(f) {
      const readings = { 'probe.hasTracksCamera': ctx.tracks.camera ? 1 : 0 };
      handles.forEach(({ as, handle }, i) => {
        const entities = Object.entries(handle.entities ?? {}), extra = handle.meta?.(f) ?? {};
        readings[`probe.${as}.same`] = again[i];
        putList(readings, `probe.${as}.members`, Object.keys(handle));
        putList(readings, `probe.${as}.entities`, entities.map(([name]) => name));
        putList(readings, `probe.${as}.roots`, entities.filter(([, e]) => e?.root === true).map(([name]) => name));
        putList(readings, `probe.${as}.metaKeys`, Object.keys(extra));
        putList(readings, `probe.${as}.metaIds`, (extra.texts ?? []).map((t) => t.id));
      });
      return { readings };
    },
    dispose() {
      for (const { handle } of handles) handle.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
});
