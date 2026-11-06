// s5-finale.js — 收束 160–180 s：镜头从第十关后面升起并后拉，11 盏金灯沿路连成一线，
// 路的尽头是 13 格胶片 + 中央大屏（播放复刻片 0→8.3 s）；灯按节拍从近到远依次闪一遍，一道金线沿路接到胶片。
// 176–179.6 由核心渐隐到黑，这里只保持缓慢漂移。
'use strict';
(function () {
const F = window.F;
const T0 = 160, T1 = 180;
const N = 11;
const LOCK = 160.5;                    // 终点装置锁定（呼应开场 0.5 s）
const PLAY0 = 160.5, PLAYLEN = 8.3;    // 大屏随锁定开机，播放复刻片：160.5 → 168.8，之后停在最后一帧
const FLASH0 = 168.5;                  // 第 i 盏灯在 168.5 + 0.5 i 闪（从近到远）
const ARRIVE = 174.0;                  // 金线抵达胶片，全体一次齐亮（小节第一拍）
const ZT = -192;                       // 终点装置所在 z（路面到 -196 为止）

// ─── 三次 Hermite：关键帧 [t, 值(数组)]，内部速度按 Catmull-Rom，首尾速度可指定 ─────────
function hermitePath(keys, v0, v1) {
  const n = keys.length, dim = keys[0][1].length, vel = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) vel.push(v0 || keys[1][1].map((v, j) => (v - keys[0][1][j]) / (keys[1][0] - keys[0][0])));
    else if (i === n - 1) vel.push(v1 || keys[n - 1][1].map((v, j) => (v - keys[n - 2][1][j]) / (keys[n - 1][0] - keys[n - 2][0])));
    else vel.push(keys[i + 1][1].map((v, j) => (v - keys[i - 1][1][j]) / (keys[i + 1][0] - keys[i - 1][0])));
  }
  return t => {
    if (t <= keys[0][0]) return keys[0][1].slice();
    if (t >= keys[n - 1][0]) { const dt = t - keys[n - 1][0]; return keys[n - 1][1].map((v, j) => v + vel[n - 1][j] * dt); }
    let i = 0; while (t > keys[i + 1][0]) i++;
    const h = keys[i + 1][0] - keys[i][0], u = (t - keys[i][0]) / h, u2 = u * u, u3 = u2 * u;
    const a = 2 * u3 - 3 * u2 + 1, b = u3 - 2 * u2 + u, c = -2 * u3 + 3 * u2, d = u3 - u2;
    const out = [];
    for (let j = 0; j < dim; j++) out.push(a * keys[i][1][j] + b * h * vel[i][j] + c * keys[i + 1][1][j] + d * h * vel[i + 1][j]);
    return out;
  };
}

let cam, env, gates = [], sprites = [], glowMat, pieces = [], strip, screenMat, screenGold, fuse = [], fuseMat;
let camPath, lookPath, fovAt, fogAt, start, base, scene3;

// 外圈街区：离路 17–60 m 的低矮石膏楼 + 亮窗（实例化，远景里填满平原，让镜头始终在模型里面）
function buildOuterTown(scene) {
  const r = F.rng(77), boxes = [], wins = [];
  for (let z = 96; z > -330; z -= 6.5) {
    const beyond = z < -204;                          // 路的尽头之后：街区跨过路线
    for (const side of [-1, 1]) for (let row = 0; row < 3; row++) {
      if (r() < .42) continue;
      const w = 3 + r() * 5, h = 1.4 + r() * (row === 0 ? 3.5 : 5.5), d = 3 + r() * 4;
      const off = beyond ? 1 + row * 14 + r() * 8 : 17 + row * 14 + r() * 8;
      const x = F.roadX(Math.min(z, -196)) + side * (off + w / 2), zz = z + r() * 3;
      boxes.push([x, h, zz, w, d]);
      const rows = Math.max(1, Math.floor(h / 1.1)), cols = Math.max(1, Math.floor(d / 1.2));
      for (let a = 0; a < rows; a++) for (let c = 0; c < cols; c++) {
        if (r() < .55) continue;
        wins.push([x - side * (w / 2 + .012), .7 + a * 1.1, zz - d / 2 + .6 + c * 1.2, -side]);
      }
      if (beyond) for (let c = 0; c < Math.max(1, Math.floor(w / 1.2)); c++) {   // 尽头之后的楼：朝路（+z）的一面也开窗
        if (r() < .5) continue;
        wins.push([x - w / 2 + .6 + c * 1.2, .7 + Math.floor(r() * Math.max(1, h / 1.1 - .5)) * 1.1, zz + d / 2 + .012, 0]);
      }
    }
  }
  const bGeo = new THREE.RoundedBoxGeometry(1, 1, 1, 2, .03);
  const bm = new THREE.InstancedMesh(bGeo, F.mat.plaster, boxes.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  boxes.forEach(([x, h, z, w, d], i) => { m4.compose(new THREE.Vector3(x, h / 2, z), q.identity(), new THREE.Vector3(w, h, d)); bm.setMatrixAt(i, m4); });
  bm.castShadow = bm.receiveShadow = true; scene.add(bm);
  const winMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: new THREE.Color(F.C.window), emissiveIntensity: 2.2, roughness: 1 });
  const wm = new THREE.InstancedMesh(new THREE.PlaneGeometry(.4, .52), winMat, wins.length);
  wins.forEach(([x, y, z, s], i) => { e.set(0, s === 0 ? 0 : s * Math.PI / 2, 0); q.setFromEuler(e); m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1)); wm.setMatrixAt(i, m4); });
  scene.add(wm);
}

F.addScene({
  id: 's5-finale', t0: T0, t1: T1,
  captions: [
    { t0: 161, t1: 168, title: '结构可证 · 素材可换' },
    { t0: 168.5, t1: 175.6, title: '每一步，都有证据', body: 'Hypit 视频复刻管线' },
  ],
  build() {
    const scene = new THREE.Scene();
    env = F.makeEnv(scene, { fog: .022, keyDir: [-7, 10, 6], keyInt: 1.7, shadowBox: 18 });
    env.key.shadow.camera.far = 600;
    // 地面加大（格子与 600 m 底板同一套网格：每格 10 m），远景只见雾，不见模型边缘
    env.ground.geometry.dispose();
    env.ground.geometry = new THREE.PlaneGeometry(2400, 2400);
    const gmap = env.ground.material.map.clone(); gmap.repeat.set(240, 240); gmap.needsUpdate = true;
    env.ground.material.map = gmap;

    // 道路与小镇：参数与 s4-gates 相同，保证 160 s 硬切时同一个世界
    F.buildRoad(scene);
    const segLen = (12 - (-F.GATE_SPACING * 11 - 20)) / 120;
    for (let k = 1; k <= 30; k++) {                   // 往 +z 方向补一段路（后拉时看得到路的来处）
      const zm = 12 + (k - .5) * segLen, x = F.roadX(zm), ry = Math.atan(F.roadDX(zm));
      const slab = F.block(4.6, .12, segLen - .06, F.mat.plasterShade, .02); slab.position.set(x, .06, zm); slab.rotation.y = ry; scene.add(slab);
      for (const sx of [-1, 1]) { const c = F.block(.28, .22, segLen - .1, F.mat.plaster, .03); c.position.set(x + sx * 2.6, .11, zm); c.rotation.y = ry; scene.add(c); }
    }
    F.buildTown(scene, { zFrom: 20, zTo: -262, seed: 5 });
    F.buildTown(scene, { zFrom: 78, zTo: 21, seed: 17 });
    buildOuterTown(scene);
    base = { key: env.key.intensity, hemi: env.hemi.intensity, fill: env.fill.intensity };
    scene3 = scene;

    // 11 座拱门：全部已放行（金灯亮、门楣灯带亮），证据块已嵌在槽里，证据板立在左前方
    const glowTex = (() => {
      const [c, x] = F.canvas(128, 128), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,236,200,1)'); g.addColorStop(.18, 'rgba(255,206,130,.55)');
      g.addColorStop(.5, 'rgba(242,180,90,.12)'); g.addColorStop(1, 'rgba(242,180,90,0)');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    for (let i = 0; i < N; i++) {
      const gate = F.buildGate(i); scene.add(gate.group); gates.push(gate); gate.light(1);
      const ev = F.buildEvidenceBlock(); scene.add(ev.mesh);
      ev.mesh.position.copy(gate.slotWorld()); ev.mesh.rotation.set(3.1, 2.2, 0); ev.mesh.scale.setScalar(.95);
      if (F.boardAnchor) {
        const a = F.boardAnchor(i); scene.add(a.group);
        const board = F.block(4.6, 2.8, .16, F.mat.plaster, .05); board.position.set(0, 1.4, 0); a.group.add(board);
        for (const sx of [-1, 1]) { const leg = F.block(.22, .95, .22, F.mat.plasterShade, .03); leg.position.set(sx * 1.7, -.475, 0); a.group.add(leg); }
      }
      // 灯的光晕（远景里让金灯读成一串光点）
      const sm = new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(F.C.gold), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false });
      const sp = new THREE.Sprite(sm); gate.lamp.updateMatrixWorld(true);
      sp.position.copy(gate.lamp.getWorldPosition(new THREE.Vector3())); scene.add(sp); sprites.push(sp);
    }

    // 金线：沿路中线的细光带，按闪灯节拍从第〇关一路接到终点胶片
    fuseMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: new THREE.Color(F.C.gold), emissiveIntensity: 2.6, roughness: 1, fog: false });
    const zA = F.gatePos(0).z + 1.2, zB = ZT + 2.2, NF = 96;
    for (let k = 0; k < NF; k++) {
      const z0 = zA + (zB - zA) * k / NF, z1 = zA + (zB - zA) * (k + 1) / NF, zm = (z0 + z1) / 2;
      const m = new THREE.Mesh(new THREE.BoxGeometry(.14, .02, Math.abs(z1 - z0) + .02), fuseMat);
      m.position.set(F.roadX(zm), .128, zm); m.rotation.y = Math.atan(F.roadDX(zm)); scene.add(m);
      fuse.push({ mesh: m, z: z0 });
    }

    // ─── 终点装置：石膏台基 + 两根塔柱 + 大屏（复刻片）+ 13 格胶片 ─────────────────
    const term = new THREE.Group(); term.position.set(F.roadX(ZT), 0, ZT); scene.add(term);
    const add = (obj, d, axis, ang, dt) => { term.add(obj); pieces.push(F.piece(obj, { d, axis, ang, t0: LOCK - .75 + dt, t1: LOCK, mode: 'gather' })); return obj; };
    const plinth = F.block(31, .6, 3.4, F.mat.plasterShade, .06); plinth.position.set(0, .3, 0);
    add(plinth, [0, -1.2, -1.5], [1, 0, 0], .08, 0);
    const wall = F.block(21.6, 11.4, .6, F.mat.plaster, .08); wall.position.set(0, 9.4, -.9);
    add(wall, [0, 4.5, -3.5], [1, 0, 0], .22, .05);
    for (const sx of [-1, 1]) {
      const py = F.block(1.4, 15.6, 1.4, F.mat.plaster, .06); py.position.set(sx * 11.7, 7.8, -.7);
      add(py, [sx * 3.2, 2.5, -1.8], [0, 0, sx], .3, .02);
      const capB = F.block(2.0, .5, 2.0, F.mat.plasterShade, .05); capB.position.set(sx * 11.7, 15.85, -.7);
      add(capB, [sx * 3.6, 5.5, -1.8], [0, 0, sx], .35, .08);
    }
    // 大屏：复刻片 CanvasTexture 作为发光贴图
    const scrW = 20, scrH = 10;
    screenMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#FFFFFF', emissiveMap: F.seqTexture(0), emissiveIntensity: 0, roughness: 1 });
    const scr = new THREE.Group(); scr.position.set(0, 9.4, -.56);
    const scrMesh = new THREE.Mesh(new THREE.PlaneGeometry(scrW, scrH), screenMat); scrMesh.position.z = .02; scr.add(scrMesh);
    screenGold = F.goldMat();
    for (const [w, h, x2, y2] of [[scrW + .24, .09, 0, scrH / 2 + .09], [scrW + .24, .09, 0, -scrH / 2 - .09], [.09, scrH + .24, scrW / 2 + .09, 0], [.09, scrH + .24, -scrW / 2 - .09, 0]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, .08), screenGold); b.position.set(x2, y2, .04); scr.add(b);
    }
    add(scr, [0, 3.2, 3.0], [1, 0, 0], .3, .12);
    // 13 格胶片：立在台基前沿
    strip = F.buildStrip({ paneW: 2.0 });
    strip.group.position.set(0, .6 + .86, .9);
    add(strip.group, [0, -.5, 3.2], [1, 0, 0], -.2, .08);
    const r = F.rng(53);
    strip.panes.forEach((p, i) => {
      p.mat.fog = false; p.mat.needsUpdate = true;
      pieces.push(F.piece(p.group, { d: [(r() - .5) * .8, .3 + r() * .9, 1.6 + r() * 1.6], axis: [r() - .5, r() - .5, r() - .5], ang: .35, t0: LOCK - .7 + i * .015, t1: LOCK, mode: 'gather' }));
    });
    screenMat.fog = false;

    // ─── 镜头：接住 s4 的最后一帧（位置、速度、视线），升起越过第十关，再一路后拉到第〇关后上方 ──
    const rc = t => (F.roadCam ? F.roadCam(t) : { pos: [F.roadX(-161) + 1.3, 2.4, -161], look: [F.gatePos(10).x, 2.6, -190] });
    const pA = rc(T0 - 1e-4), pB = rc(T0 - .0101);
    start = { pos: pA.pos, look: pA.look };
    const v0 = pA.pos.map((v, j) => (v - pB.pos[j]) / .01);
    const gx = F.gatePos(10).x;
    camPath = hermitePath([
      [160.0, pA.pos],
      [161.3, [pA.pos[0] + .6, 8.6, -162.2]],
      [162.8, [4.2, 14.5, -149]],
      [164.4, [8, 22, -108]],
      [166.0, [17, 31, -40]],
      [167.4, [40, 40, 30]],
      [168.6, [58, 45, 68]],
      [180.0, [63, 48, 82]],
    ], v0, [.2, .3, 1.5]);
    lookPath = hermitePath([
      [160.0, pA.look],
      [161.3, [gx - .6, 6.8, -192]],
      [163.0, [0, 8.2, -184]],
      [165.5, [-1, 4.5, -168]],
      [168.6, [-2, 1.5, -102]],
      [180.0, [-2.5, 1.5, -98]],
    ], [0, 0, 0], [-.02, 0, .5]);
    fovAt = t => F.keyed(t, [[160, 45], [161.3, 44], [168.6, 18.5], [180, 17.5]]);
    fogAt = t => F.keyed(t, [[160, .022], [161.3, .016], [165.5, .006], [168.6, .0042]]);

    cam = new THREE.PerspectiveCamera(45, F.W / F.H, .05, 1500);

    // ─── 声音事件 ─────────────────────────────────────────────────────────────
    F.ev(160.0, 'hit');
    F.ev(160.0, 'whoosh', { dur: 8.5 });
    F.ev(LOCK, 'lock', { n: 13 });
    F.ev(166.5, 'riser', { dur: 2 });
    for (let i = 0; i < N; i++) F.ev(FLASH0 + i * .5, 'gate', { i, soft: true });
    F.ev(ARRIVE, 'hit'); F.ev(ARRIVE, 'lock');
    return { scene, camera: cam };
  },
  seek(tl, t) {
    F.poseAll(pieces, t);
    // 终点锁定的一闪
    const lockFlash = Math.max(0, 1 - Math.abs(t - (LOCK + .05)) / .3);
    const arrive = t < ARRIVE ? Math.max(0, 1 - (ARRIVE - t) / .08) : Math.exp(-(t - ARRIVE) / .35);
    for (let i = 0; i < 13; i++) strip.setLit(i, 1, .18 + .9 * lockFlash + .9 * arrive);
    // 大屏：162 开机，放复刻片 0 → 8.3 s，放完停在最后一帧
    const on = Math.max(.22, F.easeOut((t - PLAY0) / .35));
    const u = F.clamp(t - PLAY0, 0, PLAYLEN - 1 / 15);
    F.seqTexture(u);
    screenMat.emissiveIntensity = on * (1 + .15 * arrive);
    screenMat.color.set(on > 0 ? '#000' : '#1A2030');
    screenGold.emissiveIntensity = .5 + 1.2 * lockFlash + 1.4 * arrive + .6 * Math.max(0, 1 - Math.abs(t - PLAY0) / .3);

    // 灯：从近（第〇关）到远（第十关）依次闪
    for (let i = 0; i < N; i++) {
      const tf = FLASH0 + i * .5, d = t - tf;
      const f = d < 0 ? Math.max(0, 1 + d / .06) : Math.exp(-d / .3);
      const all = .55 * arrive;
      gates[i].light(1, 1.4 * f + all);
      sprites[i].scale.setScalar(2.6 * (1 + 2.6 * f + .6 * all));
      sprites[i].material.opacity = .55 + .45 * Math.max(f, all);
    }
    // 金线：前沿随闪灯推进（168.5 在第〇关 → 173.5 在第十关 → 174.0 抵达胶片）
    const zf = F.keyed(t, [[FLASH0 - .25, F.gatePos(0).z + 1.2], [FLASH0 + 5, F.gatePos(10).z], [ARRIVE, ZT + 2.2]]);
    const lin = t < FLASH0 - .25 ? -1 : 0;
    for (const s of fuse) s.mesh.visible = lin === 0 && s.z >= zf;
    fuseMat.emissiveIntensity = 2.6 + 3 * arrive;

    // 镜头
    const p = camPath(t), l = lookPath(t);
    F.aimCam(cam, p, l, fovAt(t));
    scene3.fog.density = fogAt(t);
    const dusk = F.smooth((t - 162) / 7);             // 后拉过程中天光收暗，金灯、窗光、大屏接管画面
    env.key.intensity = base.key * (1 - .55 * dusk); env.hemi.intensity = base.hemi * (1 - .45 * dusk); env.fill.intensity = base.fill * (1 - .5 * dusk);
    // 主光与阴影范围跟随视线（远景时放大阴影盒）
    const k = F.smooth((t - 161) / 7.5), box = F.lerp(18, 120, k);
    const tx = F.lerp(p[0], l[0], .5 + .3 * k), tz = F.lerp(p[2] - 8, l[2], k);
    env.key.target.position.set(tx, 0, tz);
    env.key.position.set(tx - 7 * (1 + 7 * k), 10 * (1 + 7 * k), tz + 6 * (1 + 7 * k));
    const sc = env.key.shadow.camera; sc.left = sc.bottom = -box; sc.right = sc.top = box; sc.updateProjectionMatrix();
    env.fill.position.set(tx + 7, 4, tz - 14);
  },
  bloom: (tl, t) => {
    const lockFlash = Math.max(0, 1 - Math.abs(t - (LOCK + .05)) / .4);
    const arrive = t < ARRIVE ? 0 : Math.exp(-(t - ARRIVE) / .5);
    return .6 + .4 * lockFlash + .3 * arrive;
  },
});
})();
