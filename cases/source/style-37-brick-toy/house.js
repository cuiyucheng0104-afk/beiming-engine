// 小屋 → 崩塌（预先模拟的刚体）→ 同一批零件拼成船
import * as THREE from 'three';
import { COL, BRICK, PLATE, brickGeo, roundGeo, wedgeGeo, mesh } from './bricks.js';
import { B, HIT, BUILD, q, qr } from './timeline.js';
import { clamp, seg, eo, eio, ss, mulberry, hash } from '/core/lib.js';

export const RAFT = { x: -10, z: 8.5, ry: .35 };
export const BOAT_YAW = Math.PI;                      // 船头朝 -x（朝台灯）
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const QE = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
const Q0 = new THREE.Quaternion();
const Y = k => PLATE + (k - 1) * BRICK;              // 第 k 层砖底高度

// 「家」字印字砖的贴花
function jiaTex() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = '#1b3f8f'; g.font = '200px "ZCOOL KuaiLe"'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('家', 128, 140);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

export function makeHouse(scene) {
  const P = [];   // {id, m, h(高), half, house:{p,q}, boat:{p,q}|null}
  const add = (id, geo, color, h, half, hp, hq, bp = null, bq = Q0) => {
    const m = mesh(geo, color); scene.add(m);
    P.push({ id, m, h, half, house: { p: hp, q: hq ?? Q0 }, boat: bp ? { p: bp, q: bq } : null });
    return m;
  };
  const R90 = QE(0, Math.PI / 2, 0);
  // 地板 8×4（→ 船底）
  add('floor', brickGeo(8, 4, PLATE), COL.tan, PLATE, V(4, .2, 2), V(0, 0, 0), Q0, V(0, 0, 0));
  for (let k = 1; k <= 5; k++) {
    const y = Y(k), front = k === 5 ? COL.white : COL.red;
    // 后墙 1×8
    const bslot = { 1: V(0, PLATE, -1.5), 2: V(0, PLATE, 1.5), 3: V(0, PLATE + BRICK, -1.5), 4: V(0, PLATE + BRICK, 1.5) }[k] ?? null;
    add(`L${k}b`, brickGeo(8, 1), COL.red, BRICK, V(4, .6, .5), V(0, y, -1.5), Q0, bslot);
    // 侧墙 1×2（沿 z）
    for (const [s, sx] of [['L', -1], ['R', 1]]) {
      const ss_ = k === 1 ? V(sx * 3.5, PLATE, 0) : k === 2 ? V(sx * 3.5, PLATE + BRICK, 0) : null;
      add(`L${k}s${s}`, brickGeo(1, 2), COL.red, BRICK, V(.5, .6, 1), V(sx * 3.5, y, 0), Q0, ss_);
    }
    // 前墙：1–4 层左右两块 1×2（中间是门洞），第 5 层一整条白色门楣
    if (k < 5) for (const [s, sx] of [['L', -1], ['R', 1]]) {
      const col = k === 4 ? COL.white : COL.red;
      let bs = null, bq = R90;
      if (k === 1) bs = V(sx * 3.5, PLATE + 2 * BRICK, 0);          // 船尾座 / 船头
      if (k === 2 && s === 'L') bs = V(3.5, PLATE + 3 * BRICK, 0);  // 船头第二层
      add(`L${k}f${s}`, brickGeo(2, 1), col, BRICK, V(1, .6, .5), V(sx * 3, y, 1.5), Q0, bs, bq);
    } else add('L5f', brickGeo(8, 1), front, BRICK, V(4, .6, .5), V(0, y, 1.5));
  }
  // 屋顶三层蓝板 + 烟囱（→ 桅杆）
  const yr = Y(6);
  add('R1', brickGeo(10, 6, PLATE), COL.blue, PLATE, V(5, .2, 3), V(0, yr, -1));                        // → 小人的木筏
  add('R2', brickGeo(8, 4, PLATE), COL.blue, PLATE, V(4, .2, 2), V(0, yr + PLATE, 0));
  add('R3', brickGeo(6, 2, PLATE), COL.blue, PLATE, V(3, .2, 1), V(0, yr + 2 * PLATE, 0), Q0, V(0, PLATE, 0));   // → 甲板
  for (let i = 0; i < 4; i++) add(`ch${i}`, roundGeo(.5), COL.white, BRICK, V(.5, .6, .5), V(3.5, yr + 2 * PLATE + i * BRICK, -1.5), Q0, V(.5, 2 * PLATE + i * BRICK, -.5));
  // 门前台阶 4×1 板（→ 船桨）
  add('step', brickGeo(4, 1, PLATE), COL.tan, PLATE, V(2, .2, .5), V(0, 0, 3), Q0, V(-1.2, PLATE + 2 * BRICK, 0), R90);
  // 屋后：两块红色楔形砖（后门两侧的斜坡）+ 一块米色 1×3 板（后门踏板）→ 船头收尖 + 船尾舵
  add('wR', wedgeGeo(1), COL.red, 2 * BRICK, V(1.5, 1.2, 1), V(2.2, 0, -3.2), Q0, V(5.5, PLATE, 1));
  add('wL', wedgeGeo(-1), COL.red, 2 * BRICK, V(1.5, 1.2, 1), V(-2.2, 0, -3.2), QE(0, Math.PI, 0), V(5.5, PLATE, -1));
  add('rud', brickGeo(1, 3, PLATE), COL.tan, PLATE, V(.5, .2, 1.5), V(0, 0, -5.6), Q0, V(-4.55, .9, .2), QE(-Math.PI / 2, 0, 0));
  // 「家」字砖：2×2 光面砖竖着挂在门楣前；在船上成了桅杆顶的旗
  const tile = add('tile', brickGeo(2, 2, PLATE, { tile: true }), COL.white, PLATE, V(1, .2, 1), V(0, 6.1, 2.0), QE(Math.PI / 2, 0, 0),
    V(2, 5.4, .2), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)).multiply(QE(Math.PI / 2, 0, 0)));
  const decal = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8), new THREE.MeshPhysicalMaterial({ map: jiaTex(), transparent: true, roughness: .3, clearcoat: .8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  decal.rotation.x = -Math.PI / 2; decal.position.y = PLATE + .003; tile.add(decal);
  const byId = Object.fromEntries(P.map(p => [p.id, p]));

  // —— 崩塌：b12 水浪从右后方撞来，零件被推向左前方；预先模拟（重力偏低，恢复系数≈0.3） ——
  const tW = B(HIT.wave), G = 300, DT = 1 / 240, SIM_T = 3.6, STEP = 12;
  const flow = V(-.95, 0, .22).normalize(), side = V(flow.z, 0, -flow.x);
  const R = mulberry(41);
  const bodies = P.filter(p => p.id !== 'R1').map(p => {
    const com = p.house.p.clone().add(V(0, p.h / 2, 0).applyQuaternion(p.house.q));
    const lift = com.y;
    const v = flow.clone().multiplyScalar(9 + R() * 9 + lift * 1.1).addScaledVector(side, (R() - .5) * 9).add(V(0, 3 + R() * 6 + lift * 1.3, 0));
    if (!p.boat) { v.x *= 1.7; v.z = v.z * 1.2 - 6; }   // 用不上的零件冲得更远（往左后方），船位附近只留要用的
    if (p.id === 'floor') v.set(flow.x * 7, 1.5, flow.z * 7);
    if (p.id === 'L5f') v.set(-80, 40, -60);
    if (['L2fR', 'L3fR', 'L4sR', 'L4fR'].includes(p.id)) { const k = hash(p.house.p.y * 3.7 + p.house.p.x); v.set(-55 - k * 20, 26 + k * 8, -34 - k * 14); }   // 门前这几块冲到左后方，拼船/划船镜头前景不留杂物
    if (p.id === 'step') v.set(flow.x * 5 + 3, 4, flow.z * 5 + 4);
    const w = V((R() - .5) * 9, (R() - .5) * 7, (R() - .5) * 9);
    if (p.id === 'floor') w.set(0, .8, 0);
    return { p, pos: com, v, q: p.house.q.clone(), w, rest: false, hits: [] };
  });
  const corners = [-1, 1].flatMap(a => [-1, 1].flatMap(b => [-1, 1].map(c => V(a, b, c))));
  const samples = []; const _v = V(0, 0, 0), _q = new THREE.Quaternion();
  const GY = .1;
  const keepOut = (x, z) => {   // 船位（原点）和木筏要留空：零件被推开
    const dx = Math.max(0, Math.abs(x) - 7), dz = Math.max(0, Math.abs(z) - 4.5);
    if (dx === 0 && dz === 0) return V(x - .5, 0, z + 1.5).normalize();
    const rx = x - RAFT.x, rz = z - RAFT.z; if (Math.hypot(rx, rz) < 7.5) return V(rx, 0, rz).normalize();
    if (z > 3 && x > -8 && x < 30) return V(-1, 0, -.4).normalize();      // 镜头走廊（前方）留空
    if (x > -40 && x <= -7 && z > -4.5 && z < 5) return V(0, 0, -1);       // 船的航道（往 -x 划过去）留空：零件推到后面
    return null;
  };
  for (let f = 0, n = Math.round(SIM_T / DT); f <= n; f++) {
    const tt = f * DT;
    if (f % (240 / STEP) === 0) samples.push(bodies.map(s => [s.pos.x, s.pos.y, s.pos.z, s.q.x, s.q.y, s.q.z, s.q.w]));
    for (const s of bodies) {
      if (s.rest) continue;
      s.v.y -= G * DT; s.pos.addScaledVector(s.v, DT);
      const wl = s.w.length(); if (wl > 1e-5) { _q.setFromAxisAngle(_v.copy(s.w).divideScalar(wl), wl * DT); s.q.premultiply(_q); }
      const ko = keepOut(s.pos.x, s.pos.z); if (ko && s.pos.y < 6) s.pos.addScaledVector(ko, 14 * DT);
      let low = Infinity;
      for (const c of corners) { _v.set(c.x * s.p.half.x, c.y * s.p.half.y, c.z * s.p.half.z).applyQuaternion(s.q).add(s.pos); low = Math.min(low, _v.y); }
      if (low < GY) {
        s.pos.y += GY - low;
        if (s.v.y < -6 && s.hits.length < 3) s.hits.push({ t: tt, v: Math.min(1, -s.v.y / 40) });
        if (s.v.y < 0) s.v.y *= -.3;
        s.v.x *= .74; s.v.z *= .74; s.w.multiplyScalar(.6);
        const up = _v.set(0, 1, 0).applyQuaternion(s.q).clone();
        const ax = [V(0, Math.sign(up.y) || 1, 0), V(Math.sign(up.x) || 1, 0, 0), V(0, 0, Math.sign(up.z) || 1)];
        const best = s.p.half.y < .3 && s.p.id !== 'tile' ? ax[0] : ax.reduce((a, b) => (Math.abs(up.dot(b)) > Math.abs(up.dot(a)) ? b : a));   // 板件总是平躺
        _q.setFromUnitVectors(up, best); s.q.premultiply(new THREE.Quaternion().slerp(_q, .07));
        if (s.v.length() < 2.5 && wl < 1.5 && tt > .5 && !keepOut(s.pos.x, s.pos.z)) {
          s.rest = true; s.v.set(0, 0, 0); s.w.set(0, 0, 0);
          _q.setFromUnitVectors(_v.set(0, 1, 0).applyQuaternion(s.q).clone(), best); s.q.premultiply(_q);
          let lo = Infinity; for (const c of corners) { _v.set(c.x * s.p.half.x, c.y * s.p.half.y, c.z * s.p.half.z).applyQuaternion(s.q).add(s.pos); lo = Math.min(lo, _v.y); }
          s.pos.y += GY - lo;
        }
      }
    }
    for (let a = 0; a < bodies.length; a++) for (let b = a + 1; b < bodies.length; b++) {   // 水平互推，避免叠成一堆
      const A = bodies[a], Bb = bodies[b], dx = Bb.pos.x - A.pos.x, dz = Bb.pos.z - A.pos.z, dy = Math.abs(Bb.pos.y - A.pos.y), d = Math.hypot(dx, dz);
      const rr = (Math.max(A.p.half.x, A.p.half.z) + Math.max(Bb.p.half.x, Bb.p.half.z)) * .62;
      if (dy < 1.3 && d < rr && d > 1e-4 && (!A.rest || !Bb.rest)) {
        const push = (rr - d) * .5, nx = dx / d, nz = dz / d;
        if (!A.rest) { A.pos.x -= nx * push; A.pos.z -= nz * push; }
        if (!Bb.rest) { Bb.pos.x += nx * push; Bb.pos.z += nz * push; }
      }
    }
  }
  bodies.forEach((s, k) => { s.k = k; s.p.body = s; });
  const comToOrigin = (p, qq, h) => p.clone().sub(V(0, h / 2, 0).applyQuaternion(qq));
  function simPose(s, t) {   // 崩塌中的位姿（12 fps 步进，相对 b12）
    const f = Math.min(samples.length - 1, Math.max(0, Math.floor((t - tW) * STEP + 1e-6)));
    const a = samples[f][s.k]; const qq = new THREE.Quaternion(a[3], a[4], a[5], a[6]);
    return { p: comToOrigin(V(a[0], a[1], a[2]), qq, s.p.h), q: qq };
  }
  const restPose = s => simPose(s, tW + 99);

  // —— 船的世界变换 ——
  let boatXf = () => ({ p: V(0, .1, 0), yaw: BOAT_YAW, roll: 0 });
  const setBoatXf = f => { boatXf = f; };
  const boatMat = t => { const x = boatXf(t); return new THREE.Matrix4().compose(x.p, QE(x.pitch ?? 0, x.yaw, x.roll ?? 0), V(1, 1, 1)); };
  const slotWorld = (p, t) => { const M = boatMat(t); const pos = p.boat.p.clone().applyMatrix4(M); const qq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(M)).multiply(p.boat.q); return { p: pos, q: qq }; };

  // —— 重建：每块零件的落点时间、飞行时长 ——
  BUILD.forEach(([b, ids], i) => {
    const tL = B(b), gap = i ? tL - B(BUILD[i - 1][0]) : .9;
    const fd = b === 18 ? .5 : clamp(gap * 1.6, .22, .42);
    ids.forEach((id, j) => { const p = byId[id]; p.land = tL; p.fly = tL - fd - j * .02; });
  });

  function update(t, ctx) {
    const tq = q(t);
    for (const p of P) {
      let pos, qq;
      if (p.id === 'R1') {   // 木筏：被浪托起、滑到左前方、在水上轻轻起伏
        const u = clamp((qr(t, tW) - tW) / (B(HIT.raft) - tW));
        const from = p.house.p, to = V(RAFT.x, .08, RAFT.z);
        pos = from.clone().lerp(to, eo(u)); pos.y = from.y * (1 - ss(u)) + to.y * ss(u) + Math.sin(u * Math.PI) * 2.2;
        qq = QE(Math.sin(u * Math.PI) * .25, RAFT.ry * eo(u), Math.sin(u * Math.PI * 2) * .15);
        if (t >= B(HIT.raft)) { const w = tq - B(HIT.raft); pos.y += Math.sin(w * 3.1) * .05; qq = QE(Math.sin(w * 2.3) * .015, RAFT.ry, Math.sin(w * 2.9) * .02); }
      } else if (t < tW) { pos = p.house.p.clone(); qq = p.house.q.clone(); if (ctx.houseShake) { pos.x += ctx.houseShake * (hash(p.house.p.y * 9 + p.house.p.x) - .5); } }
      else if (!p.boat || t < p.fly) { const s = simPose(p.body, t); pos = s.p; qq = s.q; }
      else {
        const r = restPose(p.body), sw = slotWorld(p, t);
        if (t < p.land) {   // 弧线飞入（12 fps，相对起飞时刻步进）
          const u = clamp((qr(t, p.fly) - p.fly) / (p.land - p.fly)), w = Math.pow(u, 1.15);
          pos = r.p.clone().lerp(sw.p, w); pos.y += Math.sin(u * Math.PI) * (2.5 + r.p.distanceTo(sw.p) * .22);
          qq = r.q.clone().slerp(sw.q, eio(u));
        } else {   // 咔哒：压进去一点 → 回弹 → 归位
          const k = Math.floor((t - p.land) * 12 + 1e-6);
          pos = sw.p.clone(); qq = sw.q; pos.y += [-.12, .06, 0][Math.min(2, k)];
        }
      }
      p.m.position.copy(pos); p.m.quaternion.copy(qq);
    }
  }
  // 拍点核对用：第一帧到位（距槽位 < 0.2）的时刻
  function landedFrame(id, fps = 24) {
    const p = byId[id];
    for (let f = Math.floor(p.fly * fps); f < fps * 20; f++) {
      const t = f / fps; update(t, {}); const sw = slotWorld(p, t);
      if (p.m.position.distanceTo(sw.p) < .2 && t >= p.fly) return t;
    }
    return null;
  }
  // 崩塌落地声：模拟里的撞击 → 屏幕上第一次显示撞击后位姿的那一帧
  const impacts = bodies.flatMap(s => s.hits.map(h => ({ t: tW + Math.ceil(h.t * STEP - 1e-6) / STEP, v: h.v, id: s.p.id })));
  return { P, byId, update, slotWorld, setBoatXf, boatXf: t => boatXf(t), restPose: id => restPose(byId[id].body), impacts, landedFrame };
}
