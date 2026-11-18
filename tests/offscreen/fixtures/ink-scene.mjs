// 墨线对拍用的场景：THREE 由调用方传入（GLSL 参考页用仓库的 r170，TSL 夹具用离屏的 r187），两边建出同一个场景。纯函数，不含随机。
// 覆盖：两个相交的方块、同组部件（outlineGroup，相接处不出内线）、描边球（outlineAlpha / outlineWidth）、实心遮挡物与地面（不描边）、
// 不挡线的加色面片、极远处的方块（线宽随深度变细）。
export function inkScene(THREE, W, H) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x808080);
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
  camera.position.set(0, 1.2, 9);
  camera.lookAt(0, 0, 0);
  const mat = c => new THREE.MeshBasicMaterial({ color: c });
  const add = (geo, color, pos, rot, userData = {}) => {
    const m = new THREE.Mesh(geo, mat(color));
    m.position.set(...pos); m.rotation.set(...rot); Object.assign(m.userData, userData);
    scene.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(2, 2, 2), 0xd04030, [-2.6, 0.2, 0], [0.4, 0.6, 0], { outline: true });
  add(new THREE.BoxGeometry(1.6, 1.6, 1.6), 0x3060d0, [-1.6, 0.4, 0.5], [0.2, -0.5, 0.3], { outline: true });
  add(new THREE.BoxGeometry(1.4, 1.4, 1.4), 0x30a050, [0.9, 0, 0], [0.1, 0.4, 0], { outline: true, outlineGroup: 'body', outlineWidth: 1.5 });
  add(new THREE.CylinderGeometry(0.5, 0.5, 2.2, 24), 0xc0a030, [1.7, 0.2, 0], [0, 0, 0.3], { outline: true, outlineGroup: 'body', outlineWidth: 1.5 });
  add(new THREE.SphereGeometry(0.9, 32, 16), 0x9040a0, [3.3, 1.1, -1], [0, 0, 0], { outline: true, outlineAlpha: 0.5, outlineWidth: 2 });
  add(new THREE.BoxGeometry(1, 1.2, 0.6), 0x555555, [1.1, -0.2, 2.6], [0, 0.3, 0]);   // 实心遮挡物：挡住同组部件的一角，自己不描边
  add(new THREE.PlaneGeometry(40, 40), 0x707060, [0, -1.6, 0], [-Math.PI / 2, 0, 0]);   // 地面：不描边，但挡线
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.4 }));
  glow.position.set(-2.2, 0.3, 3.5); scene.add(glow);   // 加色面片：auto 判成不挡线，它后面的线要照常出
  add(new THREE.BoxGeometry(6, 6, 6), 0x40a0a0, [-7, 2, -35], [0.3, 0.5, 0], { outline: true });
  return { scene, camera };
}
