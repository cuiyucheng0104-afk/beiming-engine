// WP2.2 实片式对拍夹具：全部是不透明、写深度、共享 toonKind 材质的网格，ss=1/msaa=0 时可走 MRT。
import { toonKind } from '../../../engine/offscreen/tsl/toon.js';
import { createLook } from '../../../engine/offscreen/tsl/look.js';

export function build({ THREE, TSL, renderer, width: W, height: H, pipeline }) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x304050);
  const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
  camera.position.set(0, 0, 12); camera.lookAt(0, 0, 0);
  const kind = toonKind({ THREE, TSL }, { name: 'mrt-look-test' }), shared = kind.make({ color: '#7D78B8' });
  for (const [x, z, outline] of [[-2.4, 0, true], [0, -0.5, true], [2.4, 0.5, false]]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), shared);
    kind.bind(mesh, shared, { outline }); mesh.position.set(x, 0, z); scene.add(mesh);
  }
  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0 });
  const post = pipeline(look.output);
  return {
    render(f) { look.render(scene, camera, { t: f / 24, grade: { exposure: 1.2 } }); post.render(); },
    dispose() { look.dispose(); },
  };
}
