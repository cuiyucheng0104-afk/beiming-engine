// 探针镜头，测试工具的一部分（s18.test.mjs 用），不是给片子用的：照 beiming/calib/ 的规格搭灰阶色卡或三个互相遮挡的方块。
// 物体是不受光的自发光体，颜色是场景线性值，不动。ctx.params：scene 选规格，或者 spec 直接交一份同样写法的规格（换相机位姿、搭细条用）；
// only 写一个实体名时只搭它（单独渲）。颜色那一遍（网格用的还是自己的材质）画进了什么目标，经 meta(f) 的读数交出去：
// target.halfFloat（是不是半浮点目标）、target.depthTexture（挂没挂深度纹理）、target.depthFloat（深度纹理是不是 32 位浮点），是 1、不是 0。
// 实体名把规格里的连字符换成下划线（实体名不许带连字符）；每个实体经 meta(f) 交一个锚点 center，就是规格里的 positionM。
import gray from '../../calib/probe-gray-chart/scene.json' with { type: 'json' };
import occlusion from '../../calib/probe-occlusion/scene.json' with { type: 'json' };

const SPECS = { 'probe-gray-chart': gray, 'probe-occlusion': occlusion };

export function build(ctx) {
  const { THREE } = ctx, spec = ctx.params.spec ?? SPECS[ctx.params.scene];
  if (!spec) throw new Error(`探针镜头不认识规格 ${ctx.params.scene}`);
  const { camera: cam, backgroundLinear } = spec;
  const objects = spec.objects.map((o) => ({ ...o, name: o.id.replaceAll('-', '_') })).filter((o) => !ctx.params.only || o.name === ctx.params.only);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color().setRGB(...backgroundLinear);
  const camera = new THREE.PerspectiveCamera(cam.yFovDeg, ctx.size[0] / ctx.size[1], cam.nearM, cam.farM);
  camera.position.set(...cam.positionM);
  camera.up.set(...cam.upDir);
  camera.lookAt(...cam.lookAtM);

  const entities = {}, disposable = [];
  let target = null;
  for (const o of objects) {
    if (!['box', 'plane'].includes(o.shape)) throw new Error(`探针镜头不认识物体 ${o.id} 的形状`);
    const geometry = o.shape === 'box' ? new THREE.BoxGeometry(...o.sizeM) : new THREE.PlaneGeometry(...o.sizeM);
    const material = new THREE.MeshBasicMaterial({ toneMapped: false });
    material.color.setRGB(...o.emissionLinear);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = o.name;
    mesh.position.set(...o.positionM);
    mesh.onBeforeRender = (renderer, _scene, _camera, _geometry, used) => {
      if (used !== material) return;
      const rt = renderer.getRenderTarget();
      target = { 'target.halfFloat': +(rt.texture.type === THREE.HalfFloatType), 'target.depthTexture': +Boolean(rt.depthTexture?.isDepthTexture), 'target.depthFloat': +(rt.depthTexture?.type === THREE.FloatType) };
    };
    scene.add(mesh);
    entities[o.name] = mesh;
    disposable.push(geometry, material);
  }

  return {
    scene,
    camera,
    entities,
    state() {},
    meta: () => ({ anchors: Object.fromEntries(objects.map((o) => [`${o.name}#center`, o.positionM])), ...(target && { readings: target }) }),
    dispose() { for (const x of disposable) x.dispose(); },
  };
}
