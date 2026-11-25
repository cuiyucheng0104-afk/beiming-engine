// 第二镜头是纯色识别板，与主体镜头左上角的校准底色可区分。
export function build({ THREE, params, size: [w, h] }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(params.background);
  return { scene, camera: new THREE.PerspectiveCamera(40, w / h, 0.1, 100), entities: {},
    state() {}, meta: () => ({}), dispose() {} };
}
