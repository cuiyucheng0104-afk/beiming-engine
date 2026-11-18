// 底板对拍用的场景：THREE 与底板工具（A 路线 engine/stage/plates.js 或离屏 tsl/plates.js 的同名函数）由调用方传入，贴图也由调用方读好。
// 覆盖：不透明天空底板、透明云底板（plate / cropPlate 软边裁片 / cutoutPlane 抠像）、加色辉光（glowSprite，含 squash 与 core）、画布贴图（canvasLayer：矩形与线性渐变，不画字）。
export function platesScene({ THREE, P, W, H, sky, cloud }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202030);
  const camera = new THREE.PerspectiveCamera(30, W / H, 1, 1000);
  camera.position.set(0, 0, 100);
  const put = (m, x, y, w, h, z = 0) => { m.position.set(x, y, z); m.scale.set(w, h, 1); scene.add(m); return m; };
  put(P.plate(sky, 0), 0, 0, 72, 36, -20);
  put(P.plate(cloud, 1, { opacity: 0.8 }), -16, 8, 24, 12, -5);
  put(P.cropPlate(cloud, [0.1, 0.2, 0.5, 0.5], { order: 2, soft: 0.4, flip: true, tint: [1, 0.9, 0.95] }), 14, 9, 18, 12, -4);
  const cut = P.cutoutPlane(cloud, { order: 4, cut: 0.5 }); cut.position.set(-6, -8, 2); cut.scale.set(26, 13, 1); scene.add(cut);
  put(P.glowSprite('#FFA45C', { order: 5, amt: 1.2, core: 0.8, squash: 2.4 }), 12, -6, 16, 16, 4);
  put(P.glowSprite('#FFC46B', { order: 6, amt: 1.6, core: 1.8 }), 20, 2, 5, 5, 6);
  const { ctx, tex } = P.canvasLayer(256, 128);
  const g = ctx.createLinearGradient(0, 0, 256, 0); g.addColorStop(0, '#4F5BBF'); g.addColorStop(1, '#F2A0A6');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 128); ctx.fillStyle = 'rgba(42,45,82,0.8)'; ctx.fillRect(32, 12, 96, 40); ctx.clearRect(160, 70, 64, 48);   // 上下不对称：翻错了 y 测得出来
  put(P.plate(tex, 3), -22, -10, 20, 10, 0);
  return { scene, camera };
}
