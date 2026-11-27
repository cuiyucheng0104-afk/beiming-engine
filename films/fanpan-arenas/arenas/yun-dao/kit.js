// 《云上浮岛》的搭建工具：贴图转换、图集、实体合批（工地 Yard）、像素片合批（Cards，不动的和每帧重写的共用一套）、
// 带“按米铺贴图”的几何小件，以及“一座浮岛”的生成器。three 从外面传进来（不自己 import）。
import { PPM, hash } from './paint.js';

export function makeKit(THREE) {
  const K = {};

  // —— Pix / canvas → 贴图。像素贴图一律最近邻、不要 mipmap；只有远处的云毯（o.mip）例外：它铺得很远，不做 mipmap 会闪 ——
  K.tex = (src, o = {}) => {
    const t = new THREE.CanvasTexture(typeof src.canvas === 'function' ? src.canvas() : src); t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = o.smooth ? THREE.LinearFilter : THREE.NearestFilter; t.minFilter = o.mip ? THREE.LinearMipmapLinearFilter : o.smooth ? THREE.LinearFilter : THREE.NearestFilter; t.generateMipmaps = !!o.mip;
    if (o.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  // 吃光的贴图材质；userData.m 记着这张贴图铺开是几米 × 几米，下面的几何小件按它算 UV
  K.lam = (pix, o = {}) => { const m = new THREE.MeshLambertMaterial({ map: K.tex(pix), ...o }); m.userData.m = [pix.w / PPM, pix.h / PPM]; return m; };

  // —— 图集：把一堆小图排进一张大图（按高度排队、一行行码）。返回贴图和每张小图的 UV、世界尺寸（米） ——
  K.pack = (set, o = {}) => {
    const AW = o.width ?? 1024, pad = o.pad ?? 1, cvs = {}; for (const n in set) cvs[n] = typeof set[n].canvas === 'function' ? set[n].canvas() : set[n];
    const names = Object.keys(cvs).sort((a, b) => cvs[b].height - cvs[a].height), rects = {}; let x = pad, y = pad, rowH = 0;
    for (const n of names) { const c = cvs[n]; if (x + c.width + pad > AW) { x = pad; y += rowH + pad; rowH = 0; } rects[n] = [x, y]; x += c.width + pad; rowH = Math.max(rowH, c.height); }
    const cv = document.createElement('canvas'); cv.width = AW; cv.height = y + rowH + pad; const g = cv.getContext('2d'); for (const n of names) g.drawImage(cvs[n], rects[n][0], rects[n][1]);
    const at = {}; for (const n of names) { const [rx, ry] = rects[n], c = cvs[n]; at[n] = { u0: rx / AW, v0: 1 - ry / cv.height, u1: (rx + c.width) / AW, v1: 1 - (ry + c.height) / cv.height, w: c.width / PPM, h: c.height / PPM }; }
    return { tex: K.tex(cv, { smooth: o.smooth, repeat: false }), at };
  };

  // —— 镜头的朝向：朝镜头的片（face）和细线（line）要用。每帧 aim 一次；没 aim 之前按游戏的俯角 25° 估 ——
  const cam = { rx: 1, ry: 0, rz: 0, ux: 0, uy: .906, uz: -.423, fx: 0, fy: -.423, fz: -.906 };
  K.aim = camera => { const e = camera.matrixWorld.elements; cam.rx = e[0]; cam.ry = e[1]; cam.rz = e[2]; cam.ux = e[4]; cam.uy = e[5]; cam.uz = e[6]; cam.fx = -e[8]; cam.fy = -e[9]; cam.fz = -e[10]; };

  // —— 像素片：一层一张网格，预先留好 cap 张的位置。不动的摆一次就 end()；会动的每帧 begin() … end() 重写 ——
  // o: dyn 每帧重写 · rgba 带顶点色（染色 + 透明度）· normal 整层共用的法线（吃光的层要）· cast / receive 投影 · order 渲染次序
  K.Cards = (parent, material, cap, o = {}) => {
    const P = new Float32Array(cap * 12), U = new Float32Array(cap * 8), C = o.rgba ? new Float32Array(cap * 16) : null, I = new (cap * 4 > 65535 ? Uint32Array : Uint16Array)(cap * 6);
    for (let k = 0; k < cap; k++) { const a = k * 4, i = k * 6; I[i] = a; I[i + 1] = a + 2; I[i + 2] = a + 1; I[i + 3] = a + 1; I[i + 4] = a + 2; I[i + 5] = a + 3; }
    const g = new THREE.BufferGeometry(), attr = (a, n) => { const b = new THREE.BufferAttribute(a, n); if (o.dyn) b.setUsage(THREE.DynamicDrawUsage); return b; };
    g.setAttribute('position', attr(P, 3)); g.setAttribute('uv', attr(U, 2)); if (C) g.setAttribute('color', attr(C, 4));
    if (o.normal) { const N = new Float32Array(cap * 12); for (let i = 0; i < cap * 4; i++) N.set(o.normal, i * 3); g.setAttribute('normal', new THREE.BufferAttribute(N, 3)); }
    g.setIndex(new THREE.BufferAttribute(I, 1)); g.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(g, material); mesh.frustumCulled = false; mesh.castShadow = !!o.cast; mesh.receiveShadow = !!o.receive; if (o.order != null) mesh.renderOrder = o.order; parent.add(mesh);
    let n = 0, cr = 1, cg = 1, cb = 1, ca = 1, warned = false;
    const L = {
      mesh,
      begin() { n = 0; return L; },
      tint(r, g2, b, a = 1) { cr = r; cg = g2; cb = b; ca = a; return L; },
      // 最底层：直接给四个角（左上、右上、左下、右下）
      quad(r, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, flip = false) {
        if (!r) throw new Error('图集里没有这张小图');
        if (n >= cap) { if (!warned) { warned = true; console.warn('像素片的位置不够了', cap); } return L; }
        const i = n * 12, j = n * 8, u0 = flip ? r.u1 : r.u0, u1 = flip ? r.u0 : r.u1;
        P[i] = ax; P[i + 1] = ay; P[i + 2] = az; P[i + 3] = bx; P[i + 4] = by; P[i + 5] = bz; P[i + 6] = cx; P[i + 7] = cy; P[i + 8] = cz; P[i + 9] = dx; P[i + 10] = dy; P[i + 11] = dz;
        U[j] = u0; U[j + 1] = r.v0; U[j + 2] = u1; U[j + 3] = r.v0; U[j + 4] = u0; U[j + 5] = r.v1; U[j + 6] = u1; U[j + 7] = r.v1;
        if (C) for (let k = 0; k < 4; k++) { const c = n * 16 + k * 4; C[c] = cr; C[c + 1] = cg; C[c + 2] = cb; C[c + 3] = ca; }
        n++; return L;
      },
      // 立着的片：锚在底边中点。tilt 往后仰（弧度）· lean 顶边顺风歪出去多少米 · yaw 绕竖轴转
      up(r, x, y, z, s = 1, flip = false, lean = 0, tilt = .14, yaw = 0) {
        if (!r) throw new Error('图集里没有这张小图');
        const hw = r.w * s / 2, hh = r.h * s, cy = Math.cos(yaw), sy = Math.sin(yaw), ax = cy * hw, az = -sy * hw, st = Math.sin(tilt), tx = -st * sy * hh + lean, ty = Math.cos(tilt) * hh, tz = -st * cy * hh;
        return L.quad(r, x - ax + tx, y + ty, z - az + tz, x + ax + tx, y + ty, z + az + tz, x - ax, y, z - az, x + ax, y, z + az, flip);
      },
      // 挂着的片：锚在顶边中点，往下垂
      hang(r, x, y, z, s = 1, flip = false, lean = 0) { if (!r) throw new Error('图集里没有这张小图'); const hw = r.w * s / 2, hh = r.h * s; return L.quad(r, x - hw, y, z, x + hw, y, z, x - hw + lean, y - hh, z, x + hw + lean, y - hh, z, flip); },
      // 躺着的片：锚在中心
      flat(r, x, y, z, s = 1, yaw = 0) {
        if (!r) throw new Error('图集里没有这张小图');
        const hw = r.w * s / 2, hd = r.h * s / 2, cy = Math.cos(yaw), sy = Math.sin(yaw), ax = cy * hw, az = -sy * hw, bx = sy * hd, bz = cy * hd;
        return L.quad(r, x - ax - bx, y, z - az - bz, x + ax - bx, y, z + az - bz, x - ax + bx, y, z - az + bz, x + ax + bx, y, z + az + bz);
      },
      // 朝镜头的片：锚在中心。roll 在画面里转 · sx 只把宽度再乘一下
      face(r, x, y, z, s = 1, roll = 0, flip = false, sx = 1) {
        if (!r) throw new Error('图集里没有这张小图');
        const hw = r.w * s / 2 * sx, hh = r.h * s / 2, c = Math.cos(roll), q = Math.sin(roll);
        const Xx = (cam.rx * c + cam.ux * q) * hw, Xy = (cam.ry * c + cam.uy * q) * hw, Xz = (cam.rz * c + cam.uz * q) * hw, Yx = (cam.ux * c - cam.rx * q) * hh, Yy = (cam.uy * c - cam.ry * q) * hh, Yz = (cam.uz * c - cam.rz * q) * hh;
        return L.quad(r, x - Xx + Yx, y - Xy + Yy, z - Xz + Yz, x + Xx + Yx, y + Xy + Yy, z + Xz + Yz, x - Xx - Yx, y - Xy - Yy, z - Xz - Yz, x + Xx - Yx, y + Xy - Yy, z + Xz - Yz, flip);
      },
      // 一条细带子（绳、线）：从 0 到 1，宽 wd，带子面朝镜头
      line(r, x0, y0, z0, x1, y1, z1, wd) {
        const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0; let px = dy * cam.fz - dz * cam.fy, py = dz * cam.fx - dx * cam.fz, pz = dx * cam.fy - dy * cam.fx; const l = wd / 2 / (Math.hypot(px, py, pz) || 1); px *= l; py *= l; pz *= l;
        return L.quad(r, x0 + px, y0 + py, z0 + pz, x1 + px, y1 + py, z1 + pz, x0 - px, y0 - py, z0 - pz, x1 - px, y1 - py, z1 - pz);
      },
      end() { g.setDrawRange(0, n * 6); g.attributes.position.needsUpdate = g.attributes.uv.needsUpdate = true; if (C) g.attributes.color.needsUpdate = true; return L; },
    };
    return L;
  };

  // —— 工地：零件按材质分堆，done() 时一种材质拼成一张网格 ——
  K.Yard = parent => {
    const bins = new Map(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3(), at = new THREE.Vector3();
    const Y = {
      // 按矩阵放一个零件；from / to 只取几何体里的一段索引（一个方块的侧面和顶面用不同材质时用）
      putM(g, mat, m, from = 0, to = Infinity) {
        let b = bins.get(mat); if (!b) bins.set(mat, b = { p: [], n: [], u: [] });
        const Pa = g.attributes.position, Na = g.attributes.normal, Ua = g.attributes.uv, Ix = g.index, end = Math.min(to, Ix ? Ix.count : Pa.count);
        for (let k = from; k < end; k++) { const i = Ix ? Ix.getX(k) : k; v.fromBufferAttribute(Pa, i).applyMatrix4(m); b.p.push(v.x, v.y, v.z); v.fromBufferAttribute(Na, i).transformDirection(m); b.n.push(v.x, v.y, v.z); b.u.push(Ua.getX(i), Ua.getY(i)); }
        return Y;
      },
      put(g, mat, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, from = 0, to = Infinity) { m4.compose(at.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz, 'YXZ')), one); return Y.putM(g, mat, m4, from, to); },
      done() {
        const out = [];
        for (const [mat, b] of bins) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2));
          const mesh = new THREE.Mesh(g, mat), lit = !mat.isMeshBasicMaterial; mesh.castShadow = lit && !mat.userData.noCast; mesh.receiveShadow = lit; parent.add(mesh); out.push(mesh); }
        bins.clear(); return out;
      },
    };
    return Y;
  };

  // —— 几何小件：位置给的都是“底面中心”，贴图按米铺 ——
  const mOf = mat => mat.userData.m || [1, 1];
  // 方块。mat 给 [侧面, 顶面] 就分开贴（底面不要）
  K.box = (Y, mat, w, h, d, x, y, z, ry = 0, rx = 0, rz = 0) => {
    const side = Array.isArray(mat) ? mat[0] : mat, top = Array.isArray(mat) ? mat[1] : mat, g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv, dim = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) { const m = mOf(f === 2 || f === 3 ? top : side); for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dim[f][0] / m[0], uv.getY(i) * dim[f][1] / m[1]); } }
    g.translate(0, h / 2, 0);
    if (side === top) Y.put(g, side, x, y, z, ry, rx, rz); else { Y.put(g, side, x, y, z, ry, rx, rz, 0, 12); Y.put(g, top, x, y, z, ry, rx, rz, 12, 18); Y.put(g, side, x, y, z, ry, rx, rz, 24, 36); }
  };
  // 一根杆子 / 绳子：从一点到另一点的细方条
  const mR = new THREE.Matrix4(), qR = new THREE.Quaternion(), upV = new THREE.Vector3(0, 1, 0), dV = new THREE.Vector3(), pV = new THREE.Vector3(), oneV = new THREE.Vector3(1, 1, 1);
  K.rod = (Y, mat, x0, y0, z0, x1, y1, z1, th = .04) => {
    dV.set(x1 - x0, y1 - y0, z1 - z0); const len = dV.length(), g = new THREE.BoxGeometry(th, len, th), uv = g.attributes.uv, m = mOf(mat);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * th / m[0], uv.getY(i) * len / m[1]);
    mR.compose(pV.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), qR.setFromUnitVectors(upV, dV.normalize()), oneV); Y.putM(g, mat, mR);
  };
  // 圆筒（上下半径可以不一样）、圆锥、圆盘、球
  const wrapUV = (g, mat, r, h) => { const uv = g.attributes.uv, m = mOf(mat), rep = Math.max(1, Math.round(6.2832 * r / m[0])); for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rep, uv.getY(i) * h / m[1]); };
  K.tube = (Y, mat, rt, rb, h, x, y, z, seg = 8, ry = 0) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, true); wrapUV(g, mat, (rt + rb) / 2, h); g.translate(0, h / 2, 0); Y.put(g, mat, x, y, z, ry); };
  K.cone = (Y, mat, r, h, x, y, z, seg = 8, ry = 0) => { const g = new THREE.ConeGeometry(r, h, seg, 1, true); wrapUV(g, mat, r * .6, Math.hypot(r, h)); g.translate(0, h / 2, 0); Y.put(g, mat, x, y, z, ry); };
  K.disc = (Y, mat, r, x, y, z, seg = 8, ry = 0) => { const g = new THREE.CircleGeometry(r, seg).rotateX(-Math.PI / 2), uv = g.attributes.uv, p = g.attributes.position, m = mOf(mat); for (let i = 0; i < uv.count; i++) uv.setXY(i, p.getX(i) / m[0], p.getZ(i) / m[1]); Y.put(g, mat, x, y, z, ry); };
  K.ball = (Y, mat, r, x, y, z, sy = 1, ws = 20, hs = 14) => { const g = new THREE.SphereGeometry(r, ws, hs).scale(1, sy, 1); Y.put(g, mat, x, y, z); };

  // —— 一座浮岛：顶上一张草皮，下面是一圈圈往里收的崖壁（倒锥），每个面单独的法线，看着是凿出来的 ——
  // pts：岸线上的点 [[x, z], …]（相对岛心，绕一圈）· rings：[[从顶面往下多少米, 收到岸线的几成], …]，第一段（草皮的侧边）用 turfM，其余用 rockM
  // 返回每一圈每个点的世界坐标（挂树根、水晶时要）
  K.isle = (Y, turfM, rockM, pts, rings, x, y, z, seed = 0) => {
    const N = pts.length, ring = rings.map(([dy, sc], k) => pts.map(([px, pz], i) => { const j = k < 2 ? 1 : 1 + (hash(i * 13 + k * 7, seed) - .5) * .24; return [px * sc * j, -dy + (k < 2 || k === rings.length - 1 ? 0 : (hash(i * 5 + k * 3, seed + 1) - .5) * .4), pz * sc * j]; }));
    const mk = () => ({ p: [], n: [], u: [] }), tri = (b, A, B, C, ua, ub, uc, outY) => {
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]]; let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const cx = (A[0] + B[0] + C[0]) / 3, cz = (A[2] + B[2] + C[2]) / 3, bad = outY ? ny < 0 : nx * cx + nz * cz < 0;   // 顶面要朝上、崖面要朝外，绕反了就对调两个点
      const V = bad ? [A, C, B] : [A, B, C], T = bad ? [ua, uc, ub] : [ua, ub, uc], s = bad ? -1 : 1;
      for (let k = 0; k < 3; k++) { b.p.push(V[k][0], V[k][1], V[k][2]); b.n.push(nx * s, ny * s, nz * s); b.u.push(T[k][0], T[k][1]); }
    };
    const geo = b => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2)); return g; };
    const top = mk(), sod = mk(), cliff = mk(), tm = mOf(turfM), rm = mOf(rockM), O = [0, 0, 0], tuv = P => [(P[0] + x) / tm[0], (P[2] + z) / tm[1]];
    for (let i = 0; i < N; i++) { const A = ring[0][i], B = ring[0][(i + 1) % N]; tri(top, O, A, B, tuv(O), tuv(A), tuv(B), true); }
    const cum = [0]; for (let i = 0; i < N; i++) { const A = pts[i], B = pts[(i + 1) % N]; cum.push(cum[i] + Math.hypot(B[0] - A[0], B[1] - A[1])); }
    for (let k = 0; k < rings.length - 1; k++) { const b = k === 0 ? sod : cliff, m = k === 0 ? tm : rm, rep = Math.max(1, Math.round(cum[N] / m[0])) / cum[N];
      for (let i = 0; i < N; i++) { const A = ring[k][i], B = ring[k][(i + 1) % N], Cc = ring[k + 1][i], D = ring[k + 1][(i + 1) % N], u0 = cum[i] * rep, u1 = cum[i + 1] * rep, v0 = -rings[k][0] / m[1], v1 = -rings[k + 1][0] / m[1];
        tri(b, A, Cc, B, [u0, v0], [u0, v1], [u1, v0], false); tri(b, B, Cc, D, [u1, v0], [u0, v1], [u1, v1], false); } }
    Y.put(geo(top), turfM, x, y, z); Y.put(geo(sod), turfM, x, y, z); Y.put(geo(cliff), rockM, x, y, z);
    return ring.map(r => r.map(P => [P[0] + x, P[1] + y, P[2] + z]));
  };

  return K;
}
