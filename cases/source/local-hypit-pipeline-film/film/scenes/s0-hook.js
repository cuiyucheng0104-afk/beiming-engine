// s0-hook.js — 开场 0–8 s：13 块发光面板和石膏零件悬在金光周围，第一拍锁成胶片，之后每拍亮一格，镜头从金光核心往后拉。
'use strict';
(function () {
const F = window.F;
const T0 = 0, T1 = 8;
let strip, pieces = [], core, coreMat, coreLight, cam, halo;
const LIT0 = 1.0, LITSTEP = .5;       // 第 i 格在 1.0 + 0.5i 秒亮起（落拍）

F.addScene({
  id: 's0-hook', t0: T0, t1: T1,
  captions: [{ t0: 1.0, t1: 7.75, title: '每一关都有证据', body: 'Hypit 视频复刻管线 · 原理与 11 道证据关卡' }],
  build() {
    const scene = new THREE.Scene();
    F.makeEnv(scene, { fog: .02, keyDir: [-5, 8, 7], keyInt: 1.6, target: [0, 1.5, 0], shadowBox: 16 });
    // 金光核心
    coreMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: new THREE.Color(F.C.gold), emissiveIntensity: 6, roughness: 1 });
    core = new THREE.Mesh(new THREE.IcosahedronGeometry(.55, 3), coreMat); core.position.set(0, 2.25, -1.6); scene.add(core);
    coreLight = new THREE.PointLight(new THREE.Color(F.C.gold), 30, 18, 2); coreLight.position.copy(core.position); scene.add(coreLight);
    halo = new THREE.Mesh(new THREE.RingGeometry(.9, 1.0, 96), new THREE.MeshStandardMaterial({ color: '#000', emissive: new THREE.Color(F.C.gold), emissiveIntensity: 2.5, side: THREE.DoubleSide, transparent: true, opacity: .8 }));
    halo.position.copy(core.position); scene.add(halo);
    // 胶片
    strip = F.buildStrip({ paneW: 1.6 });
    strip.group.position.set(0, 2.25, 0); scene.add(strip.group);
    // 分解：每格面板、每段片边都从核心周围的飞散位置回到原位（t = -0.4 → 0.5 锁定）
    const r = F.rng(31);
    strip.group.children.forEach((ch, k) => {
      const hp = ch.position, ang = Math.atan2(hp.y + .01, hp.x + (k % 2 ? .3 : -.3));
      const rad = 1.6 + r() * 2.2;
      const d = [Math.cos(ang) * rad - hp.x * .55, Math.sin(ang) * rad + (r() - .5) * 2.2, -1.2 - r() * 2.5];
      pieces.push(F.piece(ch, { d, axis: [r() - .5, r() - .5, r() - .5], ang: .9 + r() * .8, t0: -.4 - r() * .15, t1: .5, mode: 'gather' }));
    });
    // 底板上的几块石膏基座，给空间一个落脚点
    for (let k = -2; k <= 2; k++) {
      const b = F.block(2.2, .5 + Math.abs(k) * .15, 2.2, F.mat.plasterShade, .05);
      b.position.set(k * 4.8, .25, -4 - Math.abs(k) * 1.5); scene.add(b);
    }
    F.buildTown(scene, { zFrom: -6, zTo: -60, seed: 11, density: .8 });
    cam = new THREE.PerspectiveCamera(40, F.W / F.H, .05, 400);
    // 声音事件
    F.ev(0, 'whoosh', { dur: 7.5 });
    F.ev(.5, 'hit'); F.ev(.5, 'lock', { n: 13 });
    for (let i = 0; i < 13; i++) F.ev(LIT0 + i * LITSTEP, 'tick', { i });
    F.ev(6.0, 'riser', { dur: 2.0 });
    return { scene, camera: cam };
  },
  seek(tl) {
    F.poseAll(pieces, tl);
    // 面板依次亮起；锁定瞬间金框闪一下
    const lockFlash = Math.max(0, 1 - Math.abs(tl - .55) / .25);
    for (let i = 0; i < 13; i++) {
      const on = F.easeOut((tl - (LIT0 + i * LITSTEP)) / .3);
      const flash = Math.max(0, 1 - Math.abs(tl - (LIT0 + i * LITSTEP)) / .2);
      strip.setLit(i, .1 + .9 * on, .12 + lockFlash * .7 + flash * .9);
    }
    // 核心：锁定前最亮，随后退到胶片后面做背光
    const pulse = 1 + .08 * Math.sin(tl * Math.PI * 4);
    coreMat.emissiveIntensity = F.lerp(9, 3.5, F.smooth((tl - .5) / 2)) * pulse;
    coreLight.intensity = F.lerp(45, 16, F.smooth((tl - .5) / 2));
    halo.scale.setScalar(1 + F.easeOut((tl - .5) / 1.2) * 5.5);
    halo.material.opacity = .55 * (1 - F.smooth((tl - .5) / 1.1));
    core.rotation.y = tl * .6;
    // 镜头：从核心附近拉开，最后停在左前方，胶片斜向纵深
    const x = F.keyed(tl, [[0, .5], [1.2, .2], [7.8, -7.2]]);
    const z = F.keyed(tl, [[0, 3.4], [1.2, 6.2], [7.8, 10.5]], true);
    const y = F.keyed(tl, [[0, 2.35], [7.8, 3.4]]);
    const lx = F.keyed(tl, [[0, 0], [1.2, 0], [7.8, 2.2]]);
    F.aimCam(cam, [x, y, z], [lx, F.keyed(tl, [[0, 2.25], [7.8, 1.9]]), -1], 40);
  },
  bloom: tl => .6 + .5 * Math.max(0, 1 - Math.abs(tl - .5) / .5),
});
})();
