// kit-road.js — 共享部件：关卡拱门、道路、胶片。多个场景共用，保证连续性（不要在场景里另画一份）。
'use strict';
(function () {
const F = window.F;

// ─── 11 道关卡的名字与布局（关卡场景 72–160 s 与收束场景共用） ─────────────
F.GATES = [
  { n: '〇', name: '立项', sub: '能力路线' },
  { n: '一', name: '读片', sub: '逐帧证据' },
  { n: '二', name: 'Brief', sub: '用户的约定' },
  { n: '三', name: 'Treatment', sub: '保住作用' },
  { n: '四', name: '素材设计', sub: '输入各负其责' },
  { n: '五', name: '编写与预览', sub: '先占位' },
  { n: '六', name: '估价', sub: '先看账单' },
  { n: '七', name: '生成', sub: '可持久、可并行' },
  { n: '八', name: '选段与固定', sub: '钉住结果' },
  { n: '九', name: '复审', sub: '按作用比对' },
  { n: '十', name: '交付', sub: '看过、听过才算完成' },
];
F.GATE_T0 = 72; F.GATE_LEN = 8;        // 第 i 关占 [72+8i, 80+8i)
F.GATE_SPACING = 16;                   // 相邻两关沿路相距 16 m
// 第 i 关拱门的位置：沿 -z 前进，x 缓慢左右摆动，门面朝 +z（朝来车方向）
F.gatePos = i => ({ x: 2.2 * Math.sin(i * .9), y: 0, z: -i * F.GATE_SPACING });
F.gateRotY = i => .12 * Math.cos(i * .9);

// 拱门：两根柱 + 门楣（刻关名）+ 门楣上的灯 + 右柱证据槽
// 返回 { group, pieces（分解组装）, lampMat, slot（世界坐标：证据块嵌入点）, light(k) }
F.buildGate = function (i, { assembleT0 = 0, assembleT1 = 1.6 } = {}) {
  const g = new THREE.Group();
  const p = F.gatePos(i); g.position.set(p.x, 0, p.z); g.rotation.y = F.gateRotY(i);
  const pieces = [];
  const add = (mesh, d, axis, t0off) => { g.add(mesh); pieces.push(F.piece(mesh, { d, axis, ang: .35, t0: assembleT0 + t0off, t1: assembleT0 + t0off + (assembleT1 - assembleT0) * .7, mode: 'gather' })); return mesh; };
  // 基座
  const baseL = F.block(1.3, .35, 1.3, F.mat.plasterShade, .05); baseL.position.set(-2.4, .175, 0);
  const baseR = baseL.clone(); baseR.position.x = 2.4;
  add(baseL, [-.8, -1.5, .6], [0, 0, 1], 0); add(baseR, [.8, -1.5, .6], [0, 0, 1], .05);
  // 柱子分三段（按层抬起的分解图逻辑）
  for (let k = 0; k < 3; k++) {
    for (const sx of [-1, 1]) {
      const seg = F.block(.82, 1.3, .82, F.mat.plaster, .05); seg.position.set(sx * 2.4, .35 + .65 + k * 1.3, 0);
      add(seg, [sx * (1.2 + k * .5), 2.4 + k * 1.6, .4], [sx, 0, 1], .08 + k * .1 + (sx > 0 ? .04 : 0));
    }
  }
  // 门楣（正面贴刻字贴图）
  const G = F.GATES[i];
  const tex = F.engrave(`${G.name}`, { w: 1024, h: 180, size: /[A-Za-z]/.test(G.name) ? 104 : 112, weight: 600 });
  const faceMat = new THREE.MeshStandardMaterial({ color: '#FFFFFF', map: tex, roughness: .92 });
  const lintelGeo = new THREE.RoundedBoxGeometry(6.2, 1.05, 1.1, 2, .05);
  const lintel = new THREE.Mesh(lintelGeo, F.mat.plaster); lintel.castShadow = lintel.receiveShadow = true;
  lintel.position.set(0, .35 + 3.9 + .525, 0);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(5.8, 5.8 * 180 / 1024), faceMat);
  face.position.set(0, 0, .556); lintel.add(face);
  // 门楣底边的金色灯带：放行时整条亮起
  const bandMat = new THREE.MeshStandardMaterial({ color: '#3A3A40', emissive: new THREE.Color(F.C.gold), emissiveIntensity: 0, roughness: .6 });
  const band = new THREE.Mesh(new THREE.BoxGeometry(5.9, .09, .06), bandMat); band.position.set(0, -.44, .57); lintel.add(band);
  add(lintel, [0, 5.2, 1.2], [1, 0, 0], .42);
  // 关号小牌（门楣上方）
  const numTex = F.engrave(`第${G.n}关`, { w: 512, h: 160, size: 84, weight: 500 });
  const cap = F.block(2.2, .62, .9, F.mat.plaster, .05); cap.position.set(0, .35 + 3.9 + 1.05 + .31, -.05);
  const capFace = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.0 * 160 / 512), new THREE.MeshStandardMaterial({ color: '#FFFFFF', map: numTex, roughness: .92 }));
  capFace.position.set(0, 0, .456); cap.add(capFace);
  add(cap, [0, 7, .6], [0, 0, 1], .5);
  // 灯：门楣顶上一枚八面体，放行时由冷灰变金
  const lampMat = new THREE.MeshStandardMaterial({ color: '#555A66', emissive: new THREE.Color(F.C.gold), emissiveIntensity: 0, roughness: .6 });
  const lamp = new THREE.Mesh(new THREE.OctahedronGeometry(.36, 0), lampMat); lamp.castShadow = true;
  lamp.position.set(0, .35 + 3.9 + 1.05 + .62 + .5, 0);
  add(lamp, [0, 9, 0], [0, 1, 0], .56);
  // 证据槽：右柱正面的凹口（一块深色石膏）
  const slotMesh = F.block(.5, .5, .12, F.mat.plasterDark, .02); slotMesh.position.set(2.4, 2.3, .42);
  add(slotMesh, [1.8, 3, 1], [0, 0, 1], .3);
  const slotWorld = () => { g.updateMatrixWorld(true); return slotMesh.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0, .12).applyQuaternion(g.quaternion)); };
  return {
    group: g, pieces, lampMat, lamp, slotMesh, slotWorld,
    // k: 0 冷灰 → 1 金色放行；flash: 锁定瞬间的额外亮度
    light(k, flash = 0) { lampMat.emissiveIntensity = 7 * k + 10 * flash; lampMat.color.set(k > .5 ? '#8A6A30' : '#555A66'); bandMat.emissiveIntensity = 5 * k + 8 * flash; bandMat.color.set(k > .5 ? '#6A5530' : '#3A3A40'); },
  };
};

// 证据块：一枚青蓝发光的立方体，从远处飞来嵌进证据槽
F.buildEvidenceBlock = function () {
  const m = new THREE.MeshStandardMaterial({ color: '#0E2A2A', emissive: new THREE.Color(F.C.teal), emissiveIntensity: 3.2, roughness: .4 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(.42, .42, .42), m); mesh.castShadow = true;
  return { mesh, mat: m };
};

// ─── 道路：一条低矮的石膏路基 + 两侧路缘，经过所有关卡 ─────────────────────
F.buildRoad = function (scene, { from = 12, to = -F.GATE_SPACING * 11 - 20 } = {}) {
  const grp = new THREE.Group();
  const n = 120;
  for (let k = 0; k < n; k++) {
    const z0 = from + (to - from) * k / n, z1 = from + (to - from) * (k + 1) / n, zm = (z0 + z1) / 2;
    const x = F.roadX(zm);
    const slab = F.block(4.6, .12, Math.abs(z1 - z0) - .06, F.mat.plasterShade, .02);
    slab.position.set(x, .06, zm); slab.rotation.y = Math.atan(F.roadDX(zm)); grp.add(slab);
    for (const sx of [-1, 1]) {
      const curb = F.block(.28, .22, Math.abs(z1 - z0) - .1, F.mat.plaster, .03);
      curb.position.set(x + sx * 2.6, .11, zm); curb.rotation.y = slab.rotation.y; grp.add(curb);
    }
  }
  scene.add(grp); return grp;
};
// 道路中线：穿过每座拱门中心（按 z 插值）
F.roadX = z => { const u = -z / F.GATE_SPACING; return 2.2 * Math.sin(u * .9); };
F.roadDX = z => { const u = -z / F.GATE_SPACING; return -2.2 * .9 * Math.cos(u * .9) / F.GATE_SPACING; };

// 路边的小建筑（有亮窗），让世界有生活感；按种子摆放，远离路面
F.buildTown = function (scene, { zFrom = 10, zTo = -200, seed = 7, density = 1 } = {}) {
  const r = F.rng(seed), grp = new THREE.Group();
  const winMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: new THREE.Color(F.C.window), emissiveIntensity: 2.2, roughness: 1 });
  for (let z = zFrom; z > zTo; z -= 5.5 / density) {
    for (const side of [-1, 1]) {
      if (r() < .25) continue;
      const w = 2 + r() * 2.5, h = 1.2 + r() * 3.2, d = 2 + r() * 2.5;
      const x = F.roadX(z) + side * (6.5 + r() * 7 + w / 2);
      const b = F.block(w, h, d, r() < .2 ? F.mat.plasterShade : F.mat.plaster, .05); b.position.set(x, h / 2, z + r() * 2); grp.add(b);
      // 朝路一侧的亮窗
      const rows = Math.max(1, Math.floor(h / .9)), cols = Math.max(1, Math.floor(d / .9));
      for (let a = 0; a < rows; a++) for (let c = 0; c < cols; c++) {
        if (r() < .45) continue;
        const win = new THREE.Mesh(new THREE.PlaneGeometry(.34, .44), winMat);
        win.position.set(x - side * (w / 2 + .01), .55 + a * .9, b.position.z - d / 2 + .45 + c * .9);
        win.rotation.y = -side * Math.PI / 2; grp.add(win);
      }
    }
  }
  scene.add(grp); return grp;
};

// ─── 胶片：13 格复刻画面（用户自己的角色），石膏边框 + 金色细框 ─────────────
// build() → { group, panes:[{mesh, mat, frame}], setLit(i, k), pieces（每格的分解组装） }
F.frameTexture = function (i) {
  const img = F.images[i]; if (!img) return null;
  const t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; t.anisotropy = 8; return t;
};
F.buildStrip = function ({ paneW = 1.6, gap = .18, count = 13 } = {}) {
  const g = new THREE.Group(), panes = [];
  const paneH = paneW / 2, total = count * paneW + (count - 1) * gap;
  const railMat = F.mat.plaster;
  // 上下片边（带齿孔的石膏条）
  for (const sy of [-1, 1]) {
    const rail = F.block(total + .6, .26, .12, railMat, .03); rail.position.set(0, sy * (paneH / 2 + .2), 0); g.add(rail);
    for (let k = 0; k < count * 3; k++) {
      const hole = new THREE.Mesh(new THREE.PlaneGeometry(.1, .08), F.mat.ink);
      hole.position.set(-total / 2 + (k + .5) * total / (count * 3), sy * (paneH / 2 + .2), .061); g.add(hole);
    }
  }
  for (let i = 0; i < count; i++) {
    const x = -total / 2 + paneW / 2 + i * (paneW + gap);
    const pg = new THREE.Group(); pg.position.set(x, 0, 0);
    const tex = F.frameTexture(i);
    const mat = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#FFFFFF', emissiveMap: tex, emissiveIntensity: 0, roughness: 1, toneMapped: true });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(paneW, paneH), mat); mesh.position.z = .02; pg.add(mesh);
    const back = F.block(paneW + .08, paneH + .08, .06, F.mat.plasterShade, .01); back.position.z = -.02; pg.add(back);
    // 金色细框
    const fm = F.goldMat(); const bars = [];
    for (const [w, h, x2, y2] of [[paneW + .08, .025, 0, paneH / 2 + .03], [paneW + .08, .025, 0, -paneH / 2 - .03], [.025, paneH + .08, paneW / 2 + .03, 0], [.025, paneH + .08, -paneW / 2 - .03, 0]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, .03), fm); b.position.set(x2, y2, .03); pg.add(b); bars.push(b);
    }
    g.add(pg); panes.push({ group: pg, mesh, mat, frameMat: fm });
  }
  return {
    group: g, panes, total, paneW, paneH,
    // k 0→1：画面由暗到亮；gold 0→1：金框亮度
    setLit(i, k, gold = 0) { const p = panes[i]; p.mat.emissiveIntensity = 1.0 * k; p.mat.color.set(k > 0 ? '#000' : '#1A2030'); p.frameMat.emissiveIntensity = 1.4 * gold; },
  };
};

// 播放复刻片序列（15 fps）到一格面板：给定片内时间 u（秒）
F.seqTexture = (() => {
  let tex = null, cvs = null, cx = null, last = -1;
  return function (u) {
    if (!F.seqImages.length) return null;
    if (!tex) { [cvs, cx] = F.canvas(480, 240); tex = new THREE.CanvasTexture(cvs); tex.colorSpace = THREE.SRGBColorSpace; }
    const idx = Math.max(0, Math.min(F.seqImages.length - 1, Math.floor(u * 15)));
    if (idx !== last) { cx.drawImage(F.seqImages[idx], 0, 0, 480, 240); tex.needsUpdate = true; last = idx; }
    return tex;
  };
})();

// 镜头工具：把 PerspectiveCamera 放到位置 p、看向 look
F.aimCam = function (cam, p, look, fov) {
  cam.position.set(p[0], p[1], p[2]); cam.up.set(0, 1, 0); cam.lookAt(look[0], look[1], look[2]);
  if (fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
  cam.updateMatrixWorld();
};
})();
