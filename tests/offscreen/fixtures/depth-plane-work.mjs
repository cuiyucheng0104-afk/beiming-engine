// 深度约定夹具：一块垂直于视线、离相机 globalThis.__DEPTH_Z 的大平面，用 pass() 的深度纹理 + three 的 perspectiveDepthToViewZ 换回视距，
// 输出 视距 / 100 当灰度（线性值，宿主按 sRGB 编码）。验证 TSL Kuwahara 的 far.depth 吃真实的 WebGPU 深度纹理时，换算出的视距就是真实距离。
export function build({ THREE, TSL, width: W, height: H, pipeline }) {
  const { pass, uv, vec4, perspectiveDepthToViewZ, uniform } = TSL;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  plane.position.z = -globalThis.__DEPTH_Z;
  scene.add(plane);
  const d = pass(scene, camera).getTextureNode('depth').sample(uv()).level(0).x;
  const g = perspectiveDepthToViewZ(d, uniform(0.1), uniform(100)).negate().div(100);
  const post = pipeline(vec4(g, g, g, 1));
  return { render() { post.render(); }, dispose() { plane.geometry.dispose(); plane.material.dispose(); } };
}
