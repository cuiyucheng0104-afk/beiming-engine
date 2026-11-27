// 《齿轮熔炉》—— 蒸汽机械工坊里的一座铆钉铁台。入口：build(ctx)。
// 画法全在自己的三个文件里：metal.js（板金法）、plates.js（铺面、盘面、齿轮）、parts.js（小件）。不用任何外部图片，也不 import 别的擂台。
// 这个文件只管「搭」：合批的料斗（Rig）、会动的片（Live）、两座城堡、一圈铁水槽、后墙的大熔炉和齿轮组、灯光、后期、贴镜头的前景。
import { PPM } from './metal.js';
import * as PL from './plates.js';
import { parts, softs } from './parts.js';

// 调画面只改这一组数。棋子不吃光（永远是贴图原色），所以车间压得暗、暖的只留在盘外
const LOOK = {
  bg: '#07060a', fog: '#2b140c',
  amb: ['#8d94c8', 1.22],                                   // 环境：偏冷的暗蓝紫
  sky: ['#cfe8ff', 4.3],                                    // 屋顶格栅漏下来的冷天光（唯一投影的光）
  forge: ['#ffa050', 1.9],                                  // 后墙炉口打过来的暖光（从后往前，勾顶面的暖边）
  fill: ['#8494d0', 1.05],                                    // 朝镜头这一面的补光，免得正面死黑
  bloom: [.5, .7, .86],                                     // 泛光：强度、半径、亮过多少才晕
  tilt: { focus: .43, band: .22, amt: 2 },                  // 移轴：清楚的一带压在棋盘上
  tiltShort: { focus: .6, band: .3, amt: 1.4 },             // 手机横屏：棋盘占满画面、血量牌贴着上沿，清楚的一带放宽、上移
  grade: { sat: 1.16, con: 1.1, knee: .82, gain: [1.04, 1, .95], lift: [.008, .004, .004], edge: [.03, .012, .004] },
};
const SKY_FROM = [-4.5, 16, -4.5], G0 = -.6, RIM = .5;      // 天光从哪儿来；地面比盘底低多少；台沿多宽
const rnd = a => { const v = Math.sin(a * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
const NUP = [0, .92, .38], NY = [0, 1, 0], NZ = [0, 0, 1];  // 立片的法线往上仰：让天光和炉光都照得到

export function build(ctx) {
  const { THREE, scene, camera, amb, sun, tiles, castles, post, low, team, grid } = ctx;
  const { ROWS, COLS, LX, LZ, HALF: hx, DEPTH, SHORT, tileZ } = grid, hz = DEPTH / 2;
  const CX = hx + 1.3, WALLZ = -hz - 3, FZ = -hz - 2.3;      // 城堡的 x；后墙的 z；熔炉正面的 z
  const zf = hz + RIM + .6, zb = -hz - RIM - .55, xs = CX + 1.4, CW = .26;   // 铁水槽：前、后两道的 z，左右两道的 x，槽宽
  const HOT = low ? 1.12 : 1.5, DIM = low ? 1 : 1.12, NPART = low ? .5 : 1;   // 发光片的亮度（高画质档超过 1 的会晕开）；粒子数量
  const texOf = (cv, rep = true, lin = false) => { const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = t.minFilter = lin ? THREE.LinearFilter : THREE.NearestFilter; t.generateMipmaps = false; if (rep) t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };

  // ---------- 图集：所有小件和齿轮拼成一张 ----------
  const P = parts();
  for (const [n, ink] of [[56, 'iron'], [20, 'brass'], [30, 'brass'], [14, 'copper'], [40, 'iron'], [12, 'brass'], [44, 'brass'], [16, 'brass'], [36, 'copper'], [10, 'iron'], [24, 'copper'], [20, 'iron']]) P[`g${n}${ink[0]}`] = PL.gear(n, { ink, seed: n });
  P.mouth = PL.mouth();
  const AT = {}, atlas = (() => {
    const W = 1024, names = Object.keys(P).sort((a, b) => P[b].height - P[a].height), pos = {}; let x = 1, y = 1, rowH = 0;
    for (const n of names) { const c = P[n]; if (x + c.width + 1 > W) { x = 1; y += rowH + 1; rowH = 0; } pos[n] = [x, y]; x += c.width + 1; rowH = Math.max(rowH, c.height); }
    let H = 64; while (H < y + rowH + 1) H *= 2;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    for (const n of names) { const c = P[n], [px, py] = pos[n]; g.drawImage(c, px, py); AT[n] = { u0: px / W, u1: (px + c.width) / W, v1: 1 - py / H, v0: 1 - (py + c.height) / H, w: c.width / PPM, h: c.height / PPM }; }
    return texOf(cv, false);
  })();
  const A = n => { const a = AT[n]; if (!a) throw new Error('图集里没有这张小件：' + n); return a; };
  // 软边图（光晕、光柱、烟尘、地上的光斑）另拼一小张，线性过滤
  const SA = {}, softTex = (() => {
    const S = softs(), cv = document.createElement('canvas'); cv.width = cv.height = 128; const g = cv.getContext('2d');
    for (const [n, x, y] of [['halo', 0, 0], ['shaft', 49, 0], ['haze', 0, 66], ['pool', 82, 0]]) { const c = S[n]; g.drawImage(c, x, y); SA[n] = { u0: (x + .5) / 128, u1: (x + c.width - .5) / 128, v1: 1 - (y + .5) / 128, v0: 1 - (y + c.height - .5) / 128 }; }
    return texOf(cv, false, true);
  })();

  // ---------- 材质：一张贴图一种 ----------
  const lit = (cv, o = {}) => ({ mat: new THREE.MeshLambertMaterial({ map: o.tex ?? texOf(cv, o.rep !== false), vertexColors: true, alphaTest: o.cut ? .5 : 0, side: o.cut ? THREE.DoubleSide : THREE.FrontSide }), tw: cv.width, th: cv.height, cast: o.cast !== false, cut: !!o.cut });
  const glo = (cv, o = {}) => ({ mat: new THREE.MeshBasicMaterial({ map: o.tex ?? texOf(cv), vertexColors: true, alphaTest: o.cut ? .5 : 0, side: o.cut ? THREE.DoubleSide : THREE.FrontSide }), tw: cv.width, th: cv.height, glow: true, cast: false });
  const TW = Math.round(LX * PPM), TH = Math.round(LZ * PPM), RP = Math.round(RIM * PPM), ACV = { width: 1024, height: 1024 };
  const MAT = {
    floor: lit(PL.floor(), { cast: false }), wall: lit(PL.wall(), { cast: false }), plate: lit(PL.plate()), plateD: lit(PL.plate({ ink: 'soot', seed: 3, v: .44, rust: .74 })),
    steel: lit(PL.plate({ ink: 'steel', seed: 8, v: .4, w: 48, h: 48, pw: 24, ph: 24, rust: .78 })), hazard: lit(PL.hazard()), brick: lit(PL.brick()), copper: lit(PL.copper({ green: .68 })),
    hoopB: lit(PL.hoop()), hoopI: lit(PL.hoop({ ink: 'iron', v: .44, seed: 9 })), pipeI: lit(PL.pipe()), pipeC: lit(PL.pipe({ ink: 'copper', seed: 9, v: .5, wear: 'patina', thr: .6 })), pipeB: lit(PL.pipe({ ink: 'brass', seed: 12, v: .5, thr: .8 })),
    coil: lit(PL.coil()), belt: lit(PL.belt()), grating: lit(PL.grating()), tread: lit(PL.tread()), wood: lit(PL.wood()), coal: lit(PL.coal()), water: lit(PL.water(), { cast: false }),
    truss: lit(PL.truss(), { cut: true }), railing: lit(PL.railing(), { cut: true }),
    dais: lit(PL.daisTop({ w: ROWS * TW + RP * 2, h: COLS * TH + RP * 2, rim: RP, lanes: COLS, th: TH }), { rep: false, cast: false }),
    molten: glo(PL.molten()), glassT: glo(PL.glassTube()),
    aLit: lit(ACV, { tex: atlas, cut: true }), aGlow: glo(ACV, { tex: atlas, cut: true }),
  };

  // ---------- 明暗的底子：越往后越暗、越往两边越暗；离铁水和炉口近的地方染橙（烘出来的，不占点光） ----------
  const heat = [], _c = [1, 1, 1];                            // 每五个数一个热源：x y z 强度 半径
  const shade = (x, y, z) => {
    const d = (z < -hz ? Math.max(.5, 1 + (z + hz) * .13) * Math.max(.5, 1 - Math.max(0, y - 1.7) * .3) : 1) * Math.max(.55, 1 - Math.max(0, Math.abs(x) - CX - 2.2) * .1);   // 后场越高越暗：屋顶底下是烟熏的黑
    let h = 0; for (let i = 0; i < heat.length; i += 5) { const dx = x - heat[i], dy = y - heat[i + 1], dz = z - heat[i + 2], q = (dx * dx + dy * dy + dz * dz) / (heat[i + 4] * heat[i + 4]); if (q < 9) h += heat[i + 3] / ((1 + q) * (1 + q)); }
    h = Math.min(h, 1.8); _c[0] = d * (1 + 1.05 * h); _c[1] = d * (1 + .42 * h); _c[2] = d * (1 + .05 * h); return _c;
  };

  // ---------- 料斗：同一种材质的面全倒进一只斗，最后一斗一张网格。ox 是这只斗所在的组在世界里的 x（只给明暗用） ----------
  function Rig(ox = 0) {
    const bins = new Map(), bin = k => { let b = bins.get(k); if (!b) { if (!MAT[k]) throw new Error('没有这种材质：' + k); bins.set(k, b = { P: [], N: [], U: [], C: [], I: [] }); } return b; };
    const vert = (b, g, x, y, z, n, u, v, k) => {
      let r = 1, gg = 1, bb = 1; if (!g) { const c = shade(x + ox, y, z); r = c[0]; gg = c[1]; bb = c[2]; }
      if (typeof k === 'number') { r *= k; gg *= k; bb *= k; } else { r *= k[0]; gg *= k[1]; bb *= k[2]; }
      b.P.push(x, y, z); b.N.push(n[0], n[1], n[2]); b.U.push(u, v); b.C.push(r, gg, bb);
    };
    // 一个四边形：p 是四个角（从法线那一面看逆时针），uv 是四个角的贴图坐标，k 是亮度（数或三色）
    const quad = (key, p, n, uv, k = 1) => { const b = bin(key), g = MAT[key].glow, i = b.P.length / 3; for (let j = 0; j < 4; j++) vert(b, g, p[j * 3], p[j * 3 + 1], p[j * 3 + 2], n, uv[j * 2], uv[j * 2 + 1], k); b.I.push(i, i + 1, i + 2, i, i + 2, i + 3); };
    const R = {
      quad,
      // 方块：贴图按真实尺寸铺（每米 48 像素）。faces 挑要哪几面：t 顶、f 朝镜头、L 左、R 右、b 背。镜头看不到的面不出
      box(key, xa, ya, za, xb, yb, zb, { faces = 'tfLR', k = 1, swap = false } = {}) {
        const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb), y0 = Math.min(ya, yb), y1 = Math.max(ya, yb), z0 = Math.min(za, zb), z1 = Math.max(za, zb), m = MAT[key], S = PPM / m.tw, T = PPM / m.th, h = (y1 - y0) * T;
        if (faces.includes('t')) quad(key, [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0], NY, swap ? [-z1 * S, x0 * T, -z1 * S, x1 * T, -z0 * S, x1 * T, -z0 * S, x0 * T] : [x0 * S, -z1 * T, x1 * S, -z1 * T, x1 * S, -z0 * T, x0 * S, -z0 * T], k);
        if (faces.includes('f')) quad(key, [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1], NZ, [x0 * S, 0, x1 * S, 0, x1 * S, h, x0 * S, h], k);
        if (faces.includes('R')) quad(key, [x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1], [1, 0, 0], [-z1 * S, 0, -z0 * S, 0, -z0 * S, h, -z1 * S, h], k);
        if (faces.includes('L')) quad(key, [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0], [-1, 0, 0], [z0 * S, 0, z1 * S, 0, z1 * S, h, z0 * S, h], k);
        if (faces.includes('b')) quad(key, [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0], [0, 0, -1], [-x1 * S, 0, -x0 * S, 0, -x0 * S, h, -x1 * S, h], k);
      },
      // 圆管 / 圆筒 / 锥台：从 (x, y, z) 沿 axis 伸出 len，起头半径 r，末端半径 r1。caps：1 封末端，2 封起头，3 两头都封
      tube(key, x, y, z, len, r, axis = 'y', { sides = 8, r1 = r, caps = 0, k = 1 } = {}) {
        const m = MAT[key], b = bin(key), g = m.glow, rep = Math.max(1, Math.round(6.2832 * Math.max(r, r1) * PPM / m.tw)), T = PPM / m.th, o = [0, 0, 0], nn = [0, 0, 0];
        const rad = (a, rr, t, out) => { const c = Math.cos(a) * rr, s = Math.sin(a) * rr; if (axis === 'y') { out[0] = s; out[1] = t; out[2] = c; } else if (axis === 'x') { out[0] = t; out[1] = c; out[2] = s; } else { out[0] = c; out[1] = s; out[2] = t; } };
        const i0 = b.P.length / 3;
        for (let i = 0; i <= sides; i++) { const a = i / sides * 6.283185; rad(a, 1, 0, nn); rad(a, r, 0, o); vert(b, g, x + o[0], y + o[1], z + o[2], nn, i / sides * rep, 0, k); rad(a, r1, len, o); vert(b, g, x + o[0], y + o[1], z + o[2], nn, i / sides * rep, len * T, k); }
        for (let i = 0; i < sides; i++) { const q = i0 + i * 2; b.I.push(q, q + 2, q + 3, q, q + 3, q + 1); }
        for (const end of [1, 2]) if (caps & end) {
          const t = end === 1 ? len : 0, rr = end === 1 ? r1 : r, c0 = b.P.length / 3; rad(0, 0, end === 1 ? 1 : -1, nn); const nc = [nn[0], nn[1], nn[2]]; rad(0, 0, t, o); vert(b, g, x + o[0], y + o[1], z + o[2], nc, 0, 0, k);
          for (let i = 0; i <= sides; i++) { const a = i / sides * 6.283185; rad(a, rr, t, o); vert(b, g, x + o[0], y + o[1], z + o[2], nc, Math.cos(a) * rr * PPM / m.tw, Math.sin(a) * rr * T, k); }
          for (let i = 0; i < sides; i++) end === 1 ? b.I.push(c0, c0 + 1 + i, c0 + 2 + i) : b.I.push(c0, c0 + 2 + i, c0 + 1 + i);
        }
      },
      // 一面立着的、朝镜头的板（墙、栏杆、桁架）：贴图平铺
      pane(key, x0, y0, x1, y1, z, { k = 1, n = NZ } = {}) { const m = MAT[key], S = PPM / m.tw, h = (y1 - y0) * PPM / m.th; quad(key, [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z], n, [x0 * S, 0, x1 * S, 0, x1 * S, h, x0 * S, h], k); },
      // 图集里的一张小件：立着（底边中点在 x y z）或平放（flat，中心在 x y z，rot 绕竖轴转）。glow 给了就是发光片（数或三色）
      card(name, x, y, z, { s = 1, glow = 0, flat = 0, rot = 0, k = 1, mx = 0, yaw = 0, sx = 1, sy = 1 } = {}) {
        const a = A(name), hw = a.w * s * sx / 2, h = a.h * s * sy, key = glow ? 'aGlow' : 'aLit', kk = glow || k, u0 = mx ? a.u1 : a.u0, u1 = mx ? a.u0 : a.u1, uv = [u0, a.v0, u1, a.v0, u1, a.v1, u0, a.v1];
        if (flat) { const c = Math.cos(rot), sn = Math.sin(rot), hh = h / 2, ux = hw * c, uz = -hw * sn, vx = -hh * sn, vz = -hh * c; quad(key, [x - ux - vx, y, z - uz - vz, x + ux - vx, y, z + uz - vz, x + ux + vx, y, z + uz + vz, x - ux + vx, y, z - uz + vz], NY, uv, kk); }
        else { const ux = hw * Math.cos(yaw), uz = -hw * Math.sin(yaw); quad(key, [x - ux, y, z - uz, x + ux, y, z + uz, x + ux, y + h, z + uz, x - ux, y + h, z - uz], NUP, uv, kk); }
      },
      // 倒出来：一斗一张网格
      flush(parent) {
        for (const [key, b] of bins) {
          const m = MAT[key], geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(b.P, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.N, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.U, 2)); geo.setAttribute('color', new THREE.Float32BufferAttribute(b.C, 3)); geo.setIndex(b.I);
          const mesh = new THREE.Mesh(geo, m.mat); mesh.castShadow = !!m.cast; mesh.receiveShadow = !m.glow;
          if (m.cut && m.cast) mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: m.mat.map, alphaTest: .5 });
          parent.add(mesh);
        }
      },
    };
    return R;
  }

  // ---------- 会动的片：预留好缓冲，每帧整个重写（不 new 任何东西） ----------
  function Live(n, mat, normal = null) {
    const Pb = new Float32Array(n * 12), Ub = new Float32Array(n * 8), Cb = new Float32Array(n * 12), Ib = new Uint16Array(n * 6), geo = new THREE.BufferGeometry();
    for (let i = 0; i < n; i++) Ib.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    const aP = new THREE.BufferAttribute(Pb, 3), aU = new THREE.BufferAttribute(Ub, 2), aC = new THREE.BufferAttribute(Cb, 3); for (const a of [aP, aU, aC]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', aP); geo.setAttribute('uv', aU); geo.setAttribute('color', aC); geo.setIndex(new THREE.BufferAttribute(Ib, 1));
    if (normal) { const Nb = new Float32Array(n * 12); for (let i = 0; i < n * 4; i++) Nb.set(normal, i * 3); geo.setAttribute('normal', new THREE.BufferAttribute(Nb, 3)); }
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; scene.add(mesh); let k = 0;
    return {
      mesh, begin() { k = 0; },
      // a 是图集里的一格；c 是中心；u、v 是半宽、半高两个向量；rgb 是颜色
      put(a, cx, cy, cz, ux, uy, uz, vx, vy, vz, r, g, b) {
        if (k >= n) return; const o = k * 12, q = k * 8; k++;
        Pb[o] = cx - ux - vx; Pb[o + 1] = cy - uy - vy; Pb[o + 2] = cz - uz - vz; Pb[o + 3] = cx + ux - vx; Pb[o + 4] = cy + uy - vy; Pb[o + 5] = cz + uz - vz;
        Pb[o + 6] = cx + ux + vx; Pb[o + 7] = cy + uy + vy; Pb[o + 8] = cz + uz + vz; Pb[o + 9] = cx - ux + vx; Pb[o + 10] = cy - uy + vy; Pb[o + 11] = cz - uz + vz;
        Ub[q] = a.u0; Ub[q + 1] = a.v0; Ub[q + 2] = a.u1; Ub[q + 3] = a.v0; Ub[q + 4] = a.u1; Ub[q + 5] = a.v1; Ub[q + 6] = a.u0; Ub[q + 7] = a.v1;
        for (let j = 0; j < 12; j += 3) { Cb[o + j] = r; Cb[o + j + 1] = g; Cb[o + j + 2] = b; }
      },
      end() { geo.setDrawRange(0, k * 6); aP.needsUpdate = aU.needsUpdate = aC.needsUpdate = true; },
    };
  }
  const LL = Live(260, MAT.aLit.mat, NUP);                                                                    // 吃光的：齿轮、铁链、连杆、冷铁锭
  const LG = Live(low ? 300 : 460, MAT.aGlow.mat);                                                            // 发光的：火、火星、蒸汽、电弧、警示灯
  const LS = Live(96, new THREE.MeshBasicMaterial({ map: softTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));   // 叠加的软光
  const FG = Live(48, new THREE.MeshBasicMaterial({ map: atlas, alphaTest: .5, vertexColors: true, side: THREE.DoubleSide, fog: false }));   // 贴镜头的前景剪影
  FG.mesh.renderOrder = 5; if (low) FG.mesh.material.color.setScalar(.55);                                      // 低画质档没有移轴虚化，前景是实的：再压暗一截，别跟左上角的按钮字抢
  // 立着的片（中心在 x y z，rot 是在片子自己的平面里转）、平放的片
  const upQ = (L, a, x, y, z, s, r, g, b, rot = 0, sx = 1, sy = 1) => { const hw = a.w * s * sx / 2, hh = a.h * s * sy / 2, c = Math.cos(rot), sn = Math.sin(rot); L.put(a, x, y, z, hw * c, hw * sn, 0, -hh * sn, hh * c, 0, r, g, b); };
  const flatQ = (L, a, x, y, z, s, r, g, b, rot = 0) => { const hw = a.w * s / 2, hh = a.h * s / 2, c = Math.cos(rot), sn = Math.sin(rot); L.put(a, x, y, z, hw * c, 0, -hw * sn, -hh * sn, 0, -hh * c, r, g, b); };
  const glowQ = (x, y, z, hw, hh, r, g, b, a = SA.halo) => LS.put(a, x, y, z, hw, 0, 0, 0, hh, 0, r, g, b);   // 一团朝镜头的光晕
  const poolQ = (x, y, z, hw, hd, r, g, b) => LS.put(SA.pool, x, y, z, hw, 0, 0, 0, 0, -hd, r, g, b);         // 一摊地上的光
  const ANIM = [];                                                                                            // 每帧要跑的小段：fn(t, 第几拍)
  const tintOf = (x, y, z, k = 1) => { const c = shade(x, y, z); return [c[0] * k, c[1] * k, c[2] * k]; };

  // ---------- 铁水槽的走向（先算热源，后面搭东西时才染得上橙） ----------
  const hw = CW / 2, Lf = zb - hw - (FZ + .05), runs = [                                                        // 每一道：起点、终点（顺着流的方向）、到炉口已经流了多远
    [0, FZ + .05, 0, zb - hw, 0], [0, zb, -xs - hw, zb, Lf], [0, zb, xs + hw, zb, Lf],
    [-xs, zb + hw, -xs, zf - hw, Lf + xs], [xs, zb + hw, xs, zf - hw, Lf + xs], [-xs - hw, zf, -.55, zf, Lf + xs + zf - zb], [xs + hw, zf, .55, zf, Lf + xs + zf - zb]];
  for (const [ax, az, bx, bz] of runs) { const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / .55)); for (let i = 0; i <= n; i++) heat.push(ax + (bx - ax) * i / n, G0 + .1, az + (bz - az) * i / n, .34, .55); }
  heat.push(0, .1, FZ + .5, 1.5, 2.4);                                                                          // 大熔炉的炉口
  const QX = 3.1, QZ = -hz - 1.7; heat.push(QX - .4, G0 + .3, QZ, .8, .8);                                      // 坩埚底下的模子
  heat.push(CX - .15, .5, 1, .5, 1.1);                                                                          // 对面高炉的炉门

  // ====================================================================================================
  //  场地：地面、后墙、铁台
  // ====================================================================================================
  const W = Rig(0);
  W.box('floor', -15, G0 - .2, WALLZ, 15, G0, hz + 9, { faces: 't' });
  W.pane('wall', -15, G0, 15, G0 + 6, WALLZ, { k: low ? 1.2 : 1.45 });
  { // 贴墙的二层走道：铁格栅板、栏杆、斜撑，每隔一段一盏罩着铁笼的壁灯（灯光是烘进顶点色里的）
    const cy = 1.86, cz = WALLZ + .75;
    for (let x = -13.5; x < 14; x += 3) if (Math.abs(x) > 2.2) heat.push(x, 1.25, WALLZ + .3, .55, .8);
    for (const [x0, x1] of [[-15, -1.7], [1.7, 15]]) { W.box('grating', x0, cy - .06, WALLZ, x1, cy, cz, { faces: 'tf', k: 1.3 }); W.box('plateD', x0, cy - .16, cz - .04, x1, cy - .05, cz, { faces: 'f', k: 1.3 }); W.pane('railing', x0, cy, x1, cy + 46 / PPM, cz, { n: NUP, k: low ? .5 : .9 }); }   // 栏杆的警示踢脚板正好落在左上角按钮后面：压暗（低画质档没有虚化，压得更狠）
    for (let x = -13.5; x < 14; x += 3) if (Math.abs(x) > 2.2) { W.card('cageLamp', x, 1.1, WALLZ + .04, { s: 1.2 }); W.card('bulb', x, 1.17, WALLZ + .06, { glow: HOT, s: 1.2 }); W.box('steel', x + 1.4, cy - .7, WALLZ, x + 1.5, cy - .06, WALLZ + .12, { faces: 'fLR' }); }
  }
  const dw = ROWS * LX + RIM * 2, dd = DEPTH + RIM * 2;
  W.quad('dais', [-dw / 2, 0, dd / 2, dw / 2, 0, dd / 2, dw / 2, 0, -dd / 2, -dw / 2, 0, -dd / 2], NY, [0, 0, 1, 0, 1, 1, 0, 1]);   // 台面：盘外那一圈铆钉铁框和警示斜纹
  W.box('plate', -dw / 2, G0, -dd / 2, dw / 2, -.2, dd / 2, { faces: 'fLR' });                                   // 台身：铆接铁板
  W.box('hazard', -dw / 2 - .03, -.25, -dd / 2 - .03, dw / 2 + .03, -.004, dd / 2 + .03, { faces: 'tfLR' });       // 台沿一圈警示斜纹
  W.box('plateD', -dw / 2 - .12, G0, -dd / 2 - .12, dw / 2 + .12, G0 + .14, dd / 2 + .12, { faces: 'tfLR' });      // 台脚
  for (let x = -dw / 2 + .35; x < dw / 2; x += .78) { W.box('steel', x - .05, G0 + .14, dd / 2, x + .05, -.25, dd / 2 + .05, { faces: 'fLR' }); W.card('bolts', x, -.5 + (x * 7 % 1) * .1, dd / 2 + .06, { s: .5 }); }   // 台身正面一根根加强筋
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {                                                          // 四个角：一根包黄铜箍的铁桩，顶上一盏队伍色的小灯
    const x = sx * (dw / 2 + .02), z = sz * (dd / 2 + .02);
    W.tube('pipeI', x, G0, z, .78, .09, 'y', { sides: 6, caps: 1 }); W.tube('hoopB', x, .1, z, .08, .105, 'y', { sides: 6, caps: 1 });
    W.card(sx < 0 ? 'bulbT' : 'bulbR', x, .17, z + .01, { glow: DIM });
  }
  // 格子：整盘画一张，按格切开换到游戏自己的 20 块上
  const bt = PL.board({ rows: ROWS, lanes: COLS, tw: TW, th: TH });
  for (const t of tiles) { const cv = document.createElement('canvas'); cv.width = TW; cv.height = TH; cv.getContext('2d').drawImage(bt, -t.userData.r * TW, -t.userData.c * TH); t.material = new THREE.MeshLambertMaterial({ map: texOf(cv, false) }); }

  // ====================================================================================================
  //  铁水槽：从大熔炉流出来，分两路绕过铁台，在台前汇进地漏。发光、贴图顺着流
  // ====================================================================================================
  { const MT = PPM / 96, y = G0 + .06;
    for (const [ax, az, bx, bz, d0] of runs) { const k = az === zf && bz === zf ? Math.min(HOT, 1.05) : az < zb ? HOT : Math.min(HOT, 1.25);   // 越靠镜头压得越暗：前面那道就在手牌上沿，太亮会糊成一片
      const L = Math.hypot(bx - ax, bz - az), va = -d0 * MT, vb = -(d0 + L) * MT;
      if (az === bz) { const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), v0 = ax < bx ? va : vb, v1 = ax < bx ? vb : va; W.quad('molten', [x0, y, az + hw, x1, y, az + hw, x1, y, az - hw, x0, y, az - hw], NY, [0, v0, 0, v1, 1, v1, 1, v0], k); }
      else { const z0 = Math.min(az, bz), z1 = Math.max(az, bz), v0 = az < bz ? va : vb, v1 = az < bz ? vb : va; W.quad('molten', [ax - hw, y, z1, ax + hw, y, z1, ax + hw, y, z0, ax - hw, y, z0], NY, [0, v1, 1, v1, 1, v0, 0, v0], k); }
    }
    const cb = (x0, z0, x1, z1) => W.box('plateD', x0, G0, z0, x1, G0 + .13, z1, { faces: 'tfLR' }), e = hw + .08;   // 槽帮：两边各一道矮铁沿
    cb(-xs - e, zb - e, -hw, zb - hw); cb(hw, zb - e, xs + e, zb - hw); cb(-xs + hw, zb + hw, xs - hw, zb + e);          // 后面一道
    cb(-xs - e, zf + hw, xs + e, zf + e); cb(-xs + hw, zf - e, xs - hw, zf - hw);                                         // 前面一道
    for (const s of [-1, 1]) { cb(s * (xs + hw), zb - hw, s * (xs + e), zf + hw); cb(s * (xs - e), zb + e, s * (xs - hw), zf - e); cb(s * hw, FZ + .05, s * e, zb - e); }   // 两边和炉口那一截
    W.box('plateD', -.6, G0, zf - e - .1, .6, G0 + .2, zf + e + .1, { faces: 'tfLR' }); W.card('drain', 0, G0 + .205, zf, { flat: 1, glow: HOT * .8, s: 1.2 });   // 台前的地漏
    for (const [x, z, wx, wz] of [[-xs, .4, .5, .7], [xs, -.5, .5, .7], [-2.2, zb, .6, .5], [2.1, zb, .6, .5], [-xs, -hz - .2, .5, .5], [xs, hz, .5, .6]]) {   // 跨槽的铁格栅小桥
      W.box('grating', x - wx / 2 - (wz > wx ? .12 : 0), G0 + .13, z - wz / 2 - (wz > wx ? 0 : .12), x + wx / 2 + (wz > wx ? .12 : 0), G0 + .17, z + wz / 2 + (wz > wx ? 0 : .12), { faces: 'tfLR' }); }
    ANIM.push(t => { for (let i = 0; i < runs.length; i++) { const r = runs[i], n = i === 0 ? 1 : 3; for (let j = 0; j < n; j++) { const q = (j + .5) / n, f = .06 + .015 * Math.sin(t * 2.3 + i * 1.7 + j * 2.1); poolQ(r[0] + (r[2] - r[0]) * q, G0 + .15, r[1] + (r[3] - r[1]) * q, r[1] === r[3] ? 1.3 : .5, r[1] === r[3] ? .5 : 1.2, f * 1.6, f * .62, f * .12); } } });   // 槽边地上的橙光
  }

  // ====================================================================================================
  //  后墙：大熔炉、齿轮组、蒸汽机、管道
  // ====================================================================================================
  const GEARS = [];
  // 一串咬合的齿轮：第一只给位置和转速，后面每只写「咬在第几只上、在它的哪个方向」。半径 = 齿数 × 模数，转速按齿数反比、方向相反，相位对好齿
  function train(z, flat, y, w0, first, ...rest) {
    const list = [{ n: first[0], ink: first[1], p: first[2], q: first[3], th0: 0, w: w0 }];
    for (const [n, ink, from, deg] of rest) { const Aa = list[from], al = deg * Math.PI / 180, d = (Aa.n + n) * PL.MODULE; list.push({ n, ink, p: Aa.p + Math.cos(al) * d, q: Aa.q + Math.sin(al) * d, th0: al + Math.PI - Math.PI / n + (Aa.n / n) * (al - Aa.th0), w: -Aa.w * Aa.n / n }); }
    for (const g of list) { const a = A(`g${g.n}${g.ink[0]}`), x = g.p, yy = flat ? y : g.q, zz = flat ? -g.q : z; GEARS.push({ a, x, y: yy, z: zz, th0: g.th0, w: g.w, flat, c: tintOf(x, yy + (flat ? 0 : .3), zz + .2), d: tintOf(x, yy, zz, .38) }); }
    return list;
  }
  ANIM.push(t => { for (const g of GEARS) { const th = g.th0 + g.w * t; if (g.flat) { flatQ(LL, g.a, g.x + .02, g.y - .04, g.z + .02, 1, g.d[0], g.d[1], g.d[2], th); flatQ(LL, g.a, g.x, g.y, g.z, 1, g.c[0], g.c[1], g.c[2], th); } else { upQ(LL, g.a, g.x + .025, g.y - .035, g.z - .05, 1, g.d[0], g.d[1], g.d[2], th); upQ(LL, g.a, g.x, g.y, g.z, 1, g.c[0], g.c[1], g.c[2], th); } } });   // 每只画两层：后面一层压暗，当厚度

  { // —— 大熔炉：砖砌的炉体，正面一个铁拱圈的炉口，里面一床火 ——
    W.box('brick', -1.45, G0, WALLZ, 1.45, G0 + 3.2, FZ, { faces: 'tLR' }); W.card('mouth', 0, G0, FZ, { s: 2.9 / A('mouth').w });
    W.box('brick', -1.45, G0 + 1.86, WALLZ, 1.45, G0 + 3.2, FZ - .005, { faces: 'f' });
    W.box('plate', -1.25, G0 + 1.95, WALLZ, 1.25, G0 + 3.4, FZ + .16, { faces: 'tfLR' }); W.box('hazard', -1.25, G0 + 1.95, FZ + .16, 1.25, G0 + 2.2, FZ + .17, { faces: 'f' });   // 炉口上面的铁烟罩
    W.box('plateD', -.5, G0, FZ, .5, G0 + .16, FZ + .3, { faces: 'tfLR' });                                        // 出铁口的铁唇
    for (const s of [-1, 1]) { W.box('plate', s * 1.45, G0, FZ - .2, s * 1.62, G0 + 3.2, FZ + .08, { faces: 'tfLR' }); W.tube('pipeC', s * 1.75, G0, FZ - .1, 2.6, .08, 'y', { sides: 6 }); W.tube('hoopB', s * 1.75, G0 + 1.1, FZ - .1, .07, .11, 'y', { sides: 6 }); W.card('valve', s * 1.75, G0 + .62, FZ + .02, { s: .9 }); }
    W.card('coals', 0, G0 + .14, FZ - .12, { glow: HOT, s: 1.9 });
    const hearth = A('hearth'), bed = [0, 1, 2, 3].map(i => A('bed' + i)), fl = [0, 1, 2, 3].map(i => A('flame' + i)), cy = G0 + .92;
    ANIM.push((t, f) => {
      const k = (low ? 1 : 1.2) * (.8 + .1 * Math.sin(t * 5.3) + .07 * Math.sin(t * 11.7) + .08 * Math.sin(t * 1.9));          // 炉火明灭（跟着风箱喘）
      LG.put(hearth, 0, cy, FZ - .3, .78, 0, 0, 0, .98, 0, k * .9, k * .66, k * .5);
      upQ(LG, bed[f & 3], -.3, G0 + .52, FZ - .2, 1.15, k, k, k); upQ(LG, bed[(f + 2) & 3], .34, G0 + .46, FZ - .16, 1, k, k, k);
      for (let i = 0; i < 3; i++) upQ(LG, fl[(f + i) & 3], -.42 + i * .42, G0 + .78 + (i & 1) * .12, FZ - .1 - i * .01, 1.1, k, k, k);
      const h = low ? .1 : .13; glowQ(0, G0 + 1, FZ + .1, 2.4, 1.9, h * 1.5 * k, h * .6 * k, h * .12 * k);        // 炉口前一大团橙光
    });
  }
  { // —— 左墙的齿轮组：一只大铁轮带一串大小不一的铜轮 ——
    const z = WALLZ + .16; train(z, false, 0, .22, [56, 'iron', -4.62, .52], [20, 'brass', 0, -24], [30, 'brass', 1, 52], [14, 'copper', 0, 203], [40, 'iron', 3, 162], [12, 'brass', 4, 250], [16, 'brass', 4, 120]);
    for (const g of GEARS) { W.box('steel', g.x - .09, g.y - .09, WALLZ, g.x + .09, g.y + .09, WALLZ + .1, { faces: 'tfLR' }); W.card('pulley', g.x, g.y - .1, z + .03, { s: .55 }); }   // 每只的轴座和轴头
  }
  const EX = 2.45, EZ = WALLZ + .45;
  { // —— 右墙的蒸汽机：三只气缸，活塞杆上下往复，连杆带着曲轴和飞轮转 ——
    const cy = -.22, cr = .2, L = .708, yb = cy + 1.1, wv = 2.2;
    W.box('plateD', EX - .45, G0, WALLZ, EX + 2.2, cy - .24, EZ + .3, { faces: 'tfLR' }); W.box('hazard', EX - .45, cy - .34, EZ + .3, EX + 2.2, cy - .24, EZ + .31, { faces: 'f' });
    W.tube('pipeI', EX - .4, cy, EZ - .06, 3.3, .045, 'x', { sides: 6 });                                          // 曲轴
    W.box('plate', EX - .45, yb + .62, WALLZ, EX + 2.2, yb + .8, EZ + .2, { faces: 'tfLR' });                       // 气缸顶上的汽室
    const pul = A('pulley'), rod = A('conrod'), xh = A('xhead'), pr = A('prod');
    for (let i = 0; i < 3; i++) {
      const px = EX + i * .85; W.tube('pipeI', px, yb, EZ, .64, .2, 'y', { sides: 8 }); W.tube('hoopB', px, yb - .03, EZ, .08, .225, 'y', { sides: 8, caps: 2 }); W.tube('hoopB', px, yb + .34, EZ, .06, .215, 'y', { sides: 8 });
      W.box('steel', px - .3, cy - .24, EZ - .16, px - .22, cy + .08, EZ + .06, { faces: 'tfLR' }); W.box('steel', px + .22, cy - .24, EZ - .16, px + .3, cy + .08, EZ + .06, { faces: 'tfLR' });   // 轴承座
      W.card('gaugeRim', px, yb + .3, EZ + .23, { s: .7 }); W.card('dialW', px, yb + .344, EZ + .24, { s: .7, glow: .8 });
      const c = tintOf(px, cy + .5, EZ + .3, 1.15);
      ANIM.push(t => { const th = t * wv + i * 2.094, s = Math.sin(th), co = Math.cos(th), ax = px + cr * s, ay = cy + cr * co, hy = ay + Math.sqrt(L * L - cr * cr * s * s);
        upQ(LL, pul, px, cy, EZ + .02, 1.25, c[0], c[1], c[2], -th); LL.put(pr, px, (hy + yb) / 2, EZ + .03, .04, 0, 0, 0, (yb - hy) / 2 + .02, 0, c[0], c[1], c[2]);
        upQ(LL, rod, (ax + px) / 2, (ay + hy) / 2, EZ + .05, 1, c[0], c[1], c[2], Math.atan2(ax - px, hy - ay)); upQ(LL, xh, px, hy, EZ + .07, 1, c[0], c[1], c[2]); });
    }
    train(WALLZ + .2, false, 0, -wv, [44, 'brass', EX + 3.05, cy], [16, 'brass', 0, 62], [36, 'copper', 1, 8], [10, 'iron', 2, -50], [24, 'copper', 3, -12], [20, 'iron', 0, -8]);   // 飞轮和它带的一串
  }
  { // —— 墙上的管道丛：贴墙两根横的粗管（法兰、阀门、压力表），几根竖的立管 ——
    for (const [x0, x1] of [[-15, -1.7], [1.7, 15]]) { W.tube('pipeI', x0, G0 + .2, WALLZ + .16, x1 - x0, .12, 'x', { sides: 6 }); W.tube('pipeC', x0, 1.5, WALLZ + .12, x1 - x0, .075, 'x', { sides: 6 }); }
    for (let x = -14; x < 14.1; x += 1.4) if (Math.abs(x) > 2) { W.tube('hoopI', x, G0 + .2, WALLZ + .16, .09, .16, 'x', { sides: 6, caps: 3 }); if ((x * 10 | 0) % 3) W.tube('hoopB', x + .7, 1.5, WALLZ + .12, .07, .105, 'x', { sides: 6, caps: 3 }); }
    for (const x of [-10.6, -8.2, -2.05, 2.05, 6.9, 9.3, 11.6]) { W.tube('pipeI', x, G0, WALLZ + .22, 5.5, Math.abs(x) < 3 ? .1 : .19, 'y', { sides: 8 }); for (const y of [.1, 1.2]) W.tube('hoopB', x, y, WALLZ + .22, .09, Math.abs(x) < 3 ? .13 : .225, 'y', { sides: 8 }); }
  }

  // ====================================================================================================
  //  后场（铁台和后墙之间）：传送带、坩埚、风箱
  // ====================================================================================================
  const CZ = -hz - 1.75, BX0 = -xs - 3.6, BX1 = -2.2, BY = -.14;
  { // —— 传送带：从炉边往左送铁锭，刚出炉的通红，越走越暗 ——
    W.box('belt', BX0, BY - .05, CZ - .25, BX1, BY, CZ + .25, { faces: 't', swap: true }); W.box('plateD', BX0, BY - .2, CZ - .27, BX1, BY - .04, CZ + .27, { faces: 'fLR' });
    for (let x = BX0 + .2; x < BX1; x += .9) { W.box('steel', x - .04, G0, CZ + .2, x + .04, BY - .2, CZ + .27, { faces: 'fLR' }); W.box('steel', x - .04, G0, CZ - .27, x + .04, BY - .2, CZ - .2, { faces: 'fLR' }); W.card('pulley', x + .45, BY - .29, CZ + .28, { s: .7 }); }
    for (const x of [BX0, BX1]) W.tube('pipeI', x, BY - .09, CZ - .27, .54, .09, 'z', { sides: 8, caps: 1 });       // 两头的滚筒
    W.card('ingotStack', BX0 - .45, G0, CZ + .1, {}); W.card('ingotStack', BX0 - .2, G0, CZ + .45, { s: .9, mx: 1 }); W.card('beaconBase', BX1 - .2, BY + .0, CZ - .2, {});
    const hotA = A('ingotHot'), warmA = A('ingotWarm'), coldA = A('ingotCold'), Lb = BX1 - BX0 - .4, n = 7, cc = tintOf((BX0 + BX1) / 2, 0, CZ, 1.1);
    ANIM.push(t => { for (let i = 0; i < n; i++) { const q = ((t * .32 + i * Lb / n) % Lb) / Lb, x = BX1 - .2 - q * Lb, y = BY + hotA.h / 2 - .02;
      if (q < .3) upQ(LG, hotA, x, y, CZ, 1, HOT, HOT * (1 - q), HOT * (1 - q * 1.6)); else if (q < .6) upQ(LG, warmA, x, y, CZ, 1, 1.05 - (q - .3) * 1.4, .9 - (q - .3) * 1.4, .8 - (q - .3)); else upQ(LL, coldA, x, y, CZ, 1, cc[0], cc[1], cc[2]);
      if (q < .3) poolQ(x, BY + .02, CZ, .5, .4, .3 * (1 - q * 3), .1 * (1 - q * 3), 0); } });
    MAT.belt.spd = .32;
  }
  let pourK = 0;                                                                                                 // 坩埚这会儿倒没倒（给点光用）
  { // —— 坩埚：吊在门架上，隔一阵歪过去往模子里倒一道铁水 ——
    const py = .72, mx = QX - .38, my = G0 + .3;
    for (const x of [QX - .82, QX + .82]) { W.box('plate', x - .06, G0, QZ - .06, x + .06, 1.75, QZ + .06, { faces: 'fLR' }); W.box('steel', x - .14, G0, QZ - .12, x + .14, G0 + .1, QZ + .12, { faces: 'tfLR' }); }
    W.pane('truss', QX - .95, 1.5, QX + .95, 1.5 + 30 / PPM, QZ + .07, { n: NUP }); W.card('yoke', QX, py - .1, QZ - .03, { s: 1.15 }); W.card('link', QX, py + .6, QZ - .02, {}); W.card('link', QX, py + .84, QZ - .02, {}); W.card('pulley', QX, 1.42, QZ + .09, { s: .8 });
    W.box('plateD', mx - .36, G0, QZ - .2, mx + .36, G0 + .12, QZ + .2, { faces: 'tfLR' }); W.card('mould', mx, G0 + .1, QZ + .05, {}); W.card('pulley', mx - .24, G0, QZ + .21, { s: .5 }); W.card('pulley', mx + .24, G0, QZ + .21, { s: .5 });
    W.card('mould', mx - .8, G0, QZ + .25, { s: .9 }); W.card('ingotStack', QX + 1.25, G0, QZ + .3, { s: .9 }); W.card('tongs', QX + .98, G0, QZ + .12, {});
    const lad = A('ladle'), lg = A('ladleGlow'), mg = A('mouldGlow'), pours = [0, 1, 2, 3].map(i => A('pour' + i)), spl = [A('splash0'), A('splash1')], c = tintOf(QX, py, QZ + .3, 1.15);
    ANIM.push((t, f) => {
      const p = (t + 3.7) % 7, a = p < 2.5 ? 0 : p < 3.3 ? (p - 2.5) / .8 * .9 : p < 5.3 ? .9 : p < 6 ? (6 - p) / .7 * .9 : 0, pouring = p > 3.25 && p < 5.35, co = Math.cos(a), si = Math.sin(a);
      upQ(LL, lad, QX, py, QZ, 1, c[0], c[1], c[2], a); upQ(LG, lg, QX - .24 * si, py + .24 * co, QZ + .01, 1, HOT, HOT, HOT, a);
      const dt = (p - 5.3 + 7) % 7, lvl = pouring ? .5 + .5 * (p - 3.25) / 2.1 : Math.max(.28, 1 - dt / 4.4 * .72); pourK = pouring ? 1 : 0;
      upQ(LG, mg, mx, my, QZ + .06, 1, HOT * lvl, HOT * lvl * lvl, HOT * lvl * lvl * .8);
      if (pouring) { const lx = QX - .3 * co - .25 * si, ly = py - .3 * si + .25 * co, h = ly - my; LG.put(pours[f & 3], lx, my + h / 2, QZ + .04, .0625, 0, 0, 0, h / 2, 0, HOT, HOT, HOT); upQ(LG, spl[f & 1], lx, my + .09, QZ + .07, 1, HOT, HOT, HOT); glowQ(lx, my + .1, QZ + .2, .9, .7, .5, .2, .04); }
    });
  }
  { // —— 风箱：给大熔炉鼓风，一张一合 ——
    const bx = -2.25, bz = FZ + .55, a = A('bellows'), c = tintOf(bx, 0, bz, 1.1);
    W.box('wood', bx - .5, G0, bz - .2, bx + .5, G0 + .22, bz + .1, { faces: 'tfLR' }); W.tube('pipeB', bx + .45, G0 + .5, bz, .5, .05, 'x', { sides: 6 }); W.card('lever', bx - .62, G0, bz + .12, {});
    ANIM.push(t => { const k = .78 + .22 * Math.sin(t * 2.4), hh = a.h / 2 * k; LL.put(a, bx, G0 + .22 + hh, bz, a.w / 2, 0, 0, 0, hh, 0, c[0], c[1], c[2]); });
  }

  // ====================================================================================================
  //  两侧和前面：工具、煤、锤、水槽、桶、箱……（手摆的一组组，加一把随机撒的零碎）
  // ====================================================================================================
  const drum = (R, x, y, z, key = 'plateD', r = .2, h = .54) => { R.tube(key, x, y, z, h, r, 'y', { sides: 8, caps: 1 }); for (const q of [.04, h / 2, h - .06]) R.tube('hoopI', x, y + q, z, .04, r + .012, 'y', { sides: 8 }); };
  const crate = (R, x, y, z, s = .42) => R.box('wood', x - s / 2, y, z - s / 2, x + s / 2, y + s, z + s / 2, { faces: 'tfLR' });
  const NEEDLES = [], gauge = (R, x, y, z, kind = 'W', s = 1, g = null) => { R.card('gaugeRim', x, y - s * .2, z, { s }); R.card('dial' + kind, x, y - s * .135, z + .012, { s, glow: kind === 'W' ? .82 : DIM }); NEEDLES.push({ x, y, z: z + .024, s, g, a: A(kind === 'W' ? 'needle' : 'needleW') }); };
  ANIM.push((t, f) => { for (let i = 0; i < NEEDLES.length; i++) { const n = NEEDLES[i], ox = n.g ? n.g.position.x : 0, oy = n.g ? n.g.position.y : 0, rot = Math.sin(t * 1.3 + i * 2.1) * .7 + (rnd(f + i * 7.7) - .5) * .3, d = .0625 * n.s; upQ(LG, n.a, ox + n.x - Math.sin(rot) * d, oy + n.y + Math.cos(rot) * d, n.z, n.s, 1, 1, 1, rot); } });   // 压力表的指针：慢慢摆，按拍抖
  const BEACONS = [], beacon = (x, y, z, red = false) => { W.card('beaconBase', x, y, z, {}); BEACONS.push({ x, y: y + .15, z: z + .01, k: BEACONS.length, fr: [0, 1, 2, 3].map(i => A((red ? 'beaconR' : 'beacon') + i)), red }); };
  ANIM.push((t, f) => { for (const b of BEACONS) { const i = (f + b.k * 2) & 3, on = i !== 3; upQ(LG, b.fr[i], b.x, b.y, b.z, 1, HOT, HOT, HOT); if (on) glowQ(b.x, b.y, b.z + .05, .55, .55, b.red ? .3 : .34, b.red ? .05 : .16, b.red ? .04 : .02); } });   // 警示灯：四帧转一圈
  const PUFF = [0, 1, 2, 3].map(i => A('puff' + i)), NPUFF = low ? 3 : 6;
  // 一个喷汽口：隔 period 秒喷一阵，一团团往 (dx, dy) 方向冲出去再往上飘散
  const steam = (x, y, z, dx, dy, period, phase, s = 1, tint = [.62, .66, .74], g = null) => ANIM.push(t => { const ox = g ? g.position.x : 0, oy = g ? g.position.y : 0, base = (t + phase) % period; for (let i = 0; i < NPUFF; i++) { const age = base - i * .14; if (age < 0 || age > 1.7) continue; const k = age / 1.7, f = Math.min(3, k * 4 | 0); upQ(LG, PUFF[f], ox + x + dx * age * (1 - k * .45) + Math.sin(i * 2.4 + age * 2.2) * .05, oy + y + dy * age * (1 - k * .3) + age * age * .2, z + i * .004, s * (.5 + k * .95), tint[0], tint[1], tint[2]); } });
  const SPK = A('spark');
  // 一处迸火星的地方：n 颗，各有各的周期，抛物线落下，由黄白烧到暗红
  const sparks = (x, y, z, n, spread, up, period, g = null) => { n = Math.max(2, Math.round(n * NPART)); ANIM.push(t => { const ox = g ? g.position.x : 0, oy = g ? g.position.y : 0; for (let i = 0; i < n; i++) { const tt = t / period + rnd(i * 1.37 + x), cyc = Math.floor(tt), age = (tt - cyc) * period, life = .45 + rnd(i * 2.1 + cyc * 13.1) * .7; if (age > life) continue; const a = rnd(i * 3.3 + cyc * 7.7) * 6.283, sp = spread * (.35 + rnd(i * 5.1 + cyc)), py = y + up * (.5 + rnd(i * 9.7 + cyc * 1.3)) * age - 1.7 * age * age; if (py < G0) continue; const k = 1 - age / life; LG.put(SPK, ox + x + Math.cos(a) * sp * age, oy + py, z + Math.sin(a) * sp * age * .5, .021, 0, 0, 0, .021, 0, HOT, HOT * (.3 + .65 * k), HOT * (.08 + .5 * k * k)); } }); };
  // 一片往上飘的火星子（炉口、烟囱口）
  const embers = (x, y, z, n, w, h, period, g = null) => { n = Math.max(2, Math.round(n * NPART)); ANIM.push(t => { const ox = g ? g.position.x : 0, oy = g ? g.position.y : 0; for (let i = 0; i < n; i++) { const q = (t / period + i / n + rnd(i) * .3) % 1, k = 1 - q; LG.put(SPK, ox + x + (rnd(i * 3.1) - .5) * w + Math.sin(t * .9 + i * 1.7) * .12 * q, oy + y + q * h, z + (rnd(i * 5.3) - .5) * .5, .018, 0, 0, 0, .018, 0, HOT * k + .2, HOT * k * (.35 + .5 * k), HOT * k * k * .3); } }); };
  // 一根吊着的铁链，下面挂东西：整根像摆一样晃。end(x, y, 角度, t, 拍) 画链头挂的东西
  const LINK = A('link');
  const chain = (x, yTop, z, n, amp, period, phase, end = null, L = LL, tint = null) => { const c = tint ?? tintOf(x, yTop - n * .2, z, 1.1), step = LINK.h * .8; ANIM.push((t, f) => { const a = amp * Math.sin(t * 6.283 / period + phase), s = Math.sin(a), co = Math.cos(a); for (let i = 0; i < n; i++) { const d = (i + .5) * step; upQ(L, LINK, x + s * d, yTop - co * d, z, 1, c[0], c[1], c[2], a); } if (end) end(x + s * n * step, yTop - co * n * step, a, t, f); }); };
  const LAMPS = [];                                                                                               // 挂着的油灯：{ x y z（会被摆动改写）, light }
  const oilLamp = (x, yTop, z, n, phase, power = 0) => { const body = A('lampBody'), fire = A('lampFire'), L = { x, y: yTop, z, light: null, power, k: LAMPS.length }, c = tintOf(x, yTop - n * .2, z, 1.2); LAMPS.push(L);
    chain(x, yTop, z, n, .07, 3.6 + phase * .3, phase, (ex, ey, a, t) => { const fl = 1 + .1 * Math.sin(t * 9.1 + phase * 3) + .06 * Math.sin(t * 15.7 + phase); upQ(LL, body, ex + Math.sin(a) * .2, ey - Math.cos(a) * .2, z + .01, 1, c[0], c[1], c[2], a); upQ(LG, fire, ex + Math.sin(a) * .23, ey - Math.cos(a) * .23, z + .02, 1, HOT * fl, HOT * fl * .9, HOT * fl * .6, a); glowQ(ex + Math.sin(a) * .23, ey - Math.cos(a) * .23, z + .06, .75, .75, .36 * fl, .2 * fl, .05 * fl); L.x = ex; L.y = ey - .23; }); return L; };

  { // —— 左边（本方一侧）：工具间。工作台、工具架、砂轮、一台平放的齿轮箱、煤堆和煤车 ——
    const x0 = -xs - .75;
    W.card('toolrack', x0 - 1.1, G0, -2.35, {}); W.card('bench', x0 - .95, G0, -1.85, {}); W.card('grindstone', x0 - .2, G0, -.95, {}); W.card('bucket', x0 + .12, G0, -1.7, {}); W.card('oilcan', x0 - .5, G0 + .3, -1.83, { s: .8 });
    W.card('anvil', x0 - 1.9, G0, -1.2, { mx: 1 }); W.card('sledge', x0 - 2.3, G0, -1.15, {}); W.card('boltBox', x0 - 1.5, G0, -.75, {}); W.card('blueprint', x0 - 2.1, G0 + .35, -2.36, {});
    W.box('plateD', x0 - 1.45, G0, .1, x0 + .1, G0 + .34, 1.05, { faces: 'tfLR' }); W.box('hazard', x0 - 1.45, G0 + .22, 1.05, x0 + .1, G0 + .34, 1.06, { faces: 'f' });      // 齿轮箱的机座
    train(0, true, G0 + .39, .9, [24, 'copper', x0 - .82, -.55], [12, 'brass', 0, 20], [16, 'brass', 1, -50], [14, 'copper', 0, 190], [10, 'iron', 0, 100]);
    gauge(W, x0 - 1.2, G0 + .2, 1.07, 'T', .8); W.card('lever', x0 - .1, G0 + .34, .9, { s: .9 });
    W.tube('coal', x0 - 1.5, G0, 2.35, .46, .72, 'y', { sides: 9, r1: .06, caps: 1 }); W.tube('coal', x0 - .85, G0, 2.75, .3, .45, 'y', { sides: 7, r1: .05, caps: 1 }); W.card('shovel', x0 - .7, G0, 2.45, { s: 1 }); W.card('coalBits', x0 - .4, G0 + .012, 2.2, { flat: 1 });   // 煤堆
    W.card('rails', x0 - .2, G0 + .012, 1.85, { flat: 1, s: 2.2 }); W.box('plateD', x0 - .5, G0 + .14, 1.62, x0 + .2, G0 + .52, 2.05, { faces: 'tfLR' }); W.box('coal', x0 - .46, G0 + .5, 1.66, x0 + .16, G0 + .58, 2.01, { faces: 'tfLR' }); W.card('pulley', x0 - .32, G0, 2.06, { s: .75 }); W.card('pulley', x0 + .02, G0, 2.06, { s: .75 });   // 煤车
    drum(W, x0 + .1, G0, -2.6); drum(W, x0 - .32, G0, -2.75, 'copper'); drum(W, x0 - .1, G0 + .54, -2.68, 'plate', .19, .46); W.card('sack', x0 - 2.4, G0, 1.1, {}); W.card('sack', x0 - 2.75, G0, 1.3, { mx: 1, s: .9 }); crate(W, x0 - 2.6, G0, .2); crate(W, x0 - 2.55, G0 + .42, .22, .34); crate(W, x0 - 3.1, G0, .55, .5);
    W.card('pipeStack', x0 - 2.1, G0, 2.2, {}); W.card('spool', x0 - 2.7, G0, 2.6, {}); W.card('wheelbarrow', x0 - 3.2, G0, -.5, {}); W.card('ladder', x0 - 3.4, G0, -2.6, {}); W.card('fusebox', x0 - 2.9, G0 + .5, -2.62, {}); W.card('signBolt', x0 - 2.45, G0 + .7, -2.62, {});
    W.box('plate', x0 - 3.6, G0, -2.9, x0 + .4, G0 + 1.9, -2.7, { faces: 'tfLR' }); W.box('hazard', x0 - 3.6, G0 + 1.9, -2.9, x0 + .4, G0 + 2.0, -2.69, { faces: 'tf' });   // 工具间后面一道铆接铁隔墙
    beacon(x0 + .3, G0 + 2.0, -2.8); oilLamp(x0 - 1.1, 3.6, -.9, 9, .4, low ? 0 : 5);
    steam(x0 + .1, G0 + .34, .5, -.25, .5, 5.2, 1.3, .8);
  }
  { // —— 右边（对面一侧）：锻打间。杠杆锤和铁砧、冷却水槽、铁锭垛、铁桶 ——
    const x0 = xs + .75, ax = x0 + .35, pz = .15, pvx = ax + .47, pvy = G0 + .72;
    W.card('anvil', ax, G0, pz, {}); W.box('wood', pvx - .08, G0, pz - .2, pvx + .08, pvy + .12, pz - .06, { faces: 'tfLR' }); W.box('steel', pvx - .14, G0, pz - .26, pvx + .14, G0 + .1, pz, { faces: 'tfLR' });
    train(pz - .22, false, 0, 4.49, [16, 'brass', pvx + .55, pvy - .2], [10, 'iron', 0, 40]);
    const trip = A('trip'), hot = A('ingotHot'), c = tintOf(pvx, pvy, pz, 1.15);
    ANIM.push(t => { const p = (t / 1.4) % 1, lift = p < .8 ? Math.sin(p / .8 * 1.5708) : 1 - ((p - .8) / .2) ** 2; upQ(LL, trip, pvx, pvy + .02, pz - .03, 1, c[0], c[1], c[2], -.5 * lift);   // 杠杆锤：慢慢抬起，一下砸落
      upQ(LG, hot, ax - .02, G0 + .58, pz + .02, .6, HOT, HOT * .8, HOT * .5); if (p < .12) glowQ(ax, G0 + .6, pz + .1, .7 * (1 - p * 6), .5 * (1 - p * 6), .9, .5, .15); });
    { const n = Math.round(14 * NPART); ANIM.push(t => { const p = (t / 1.4) % 1, cyc = Math.floor(t / 1.4), age = p * 1.4; if (age > .7) return; for (let i = 0; i < n; i++) { const a = rnd(i * 3.1 + cyc * 1.7) * 3.1416, sp = 1.2 + rnd(i * 7.7 + cyc) * 1.6, life = .3 + rnd(i * 1.9 + cyc * 3.3) * .4; if (age > life) continue; const py = G0 + .58 + Math.sin(a) * sp * .8 * age - 2.4 * age * age, k = 1 - age / life; if (py < G0) continue; LG.put(SPK, ax + Math.cos(a) * sp * age, py, pz + .05 + (rnd(i * 9.1 + cyc) - .5) * age, .021, 0, 0, 0, .021, 0, HOT, HOT * (.4 + .6 * k), HOT * (.1 + .6 * k * k)); } }); }
    W.box('plate', x0 + .9, G0, 1.5, x0 + 2.3, G0 + .46, 2.3, { faces: 'tfLR' }); W.box('water', x0 + .96, G0 + .4, 1.56, x0 + 2.24, G0 + .47, 2.24, { faces: 't' }); W.card('tongs', x0 + .8, G0, 2.2, {}); W.card('bucket', x0 + 2.5, G0, 2.2, {});   // 冷却水槽
    steam(x0 + 1.5, G0 + .5, 1.9, .08, .45, 3.1, .4, .9, [.56, .62, .72]); steam(x0 + 1.9, G0 + .5, 1.75, -.06, .4, 4.3, 2.2, .7, [.5, .56, .66]);
    W.card('ingotStack', x0 + 1.3, G0, -1.2, {}); W.card('ingotStack', x0 + 1.75, G0, -.9, { mx: 1 }); W.card('ingotStack', x0 + 1.5, G0 + .5, -1.21, { s: .8 }); W.card('wheelbarrow', x0 + 2.4, G0, -.2, { mx: 1 }); W.card('sledge', x0 + .9, G0, .5, {}); W.card('tongs', x0 - .05, G0, .6, {});
    drum(W, x0 + .15, G0, 1.2, 'plate'); drum(W, x0 + .6, G0, 1.35, 'copper', .18, .5); drum(W, x0 + 2.8, G0, 1.2); drum(W, x0 + 3.2, G0, 1.5, 'plate', .22, .6); crate(W, x0 + 2.9, G0, -1.4, .5); crate(W, x0 + 2.85, G0 + .5, -1.4, .36); crate(W, x0 + 3.4, G0, -1.0);
    W.card('pipeStack', x0 + .3, G0, -2.0, {}); W.card('spool', x0 + 2.1, G0, -2.2, {}); W.card('toolrack', x0 + 3.2, G0, -2.5, { mx: 1 }); W.card('ladder', x0 + 1.2, G0, -2.62, {}); W.card('signFlame', x0 + .55, G0 + .8, -2.62, {}); W.card('signHaz', x0 + 1.9, G0 + .95, -2.62, {});
    W.box('plate', x0 - .3, G0, -2.9, x0 + 3.7, G0 + 1.9, -2.7, { faces: 'tfLR' }); W.box('hazard', x0 - .3, G0 + 1.9, -2.9, x0 + 3.7, G0 + 2.0, -2.69, { faces: 'tf' });
    beacon(x0 - .2, G0 + 2.0, -2.8, true); oilLamp(x0 + 1.4, 3.6, -.6, 9, 2.1, low ? 0 : 5);
    sparks(x0 + .35, G0 + .2, pz, 5, .5, 1.1, 2.3);
  }
  { // —— 后场的零碎：炉边的煤、铁桶、警示灯；墙上的牌子、钟、配电箱、梯子 ——
    W.tube('coal', 2.0, G0, FZ + .5, .4, .55, 'y', { sides: 8, r1: .05, caps: 1 }); W.card('shovel', 1.75, G0, FZ + .75, { mx: 1 }); W.card('bucket', -1.75, G0, FZ + .9, {}); drum(W, 5.6, G0, CZ + .3); drum(W, 6.05, G0, CZ + .1, 'copper');
    beacon(-1.62, G0 + 3.2 - 1.2, FZ + .1); beacon(1.62, G0 + 2, FZ + .1, true);
    for (const [n, x, y, o] of [['clock', -1.95, 1.0, {}], ['signHaz', -8.9, .5, {}], ['fusebox', 8.0, .1, {}], ['plate07', 1.9, -.25, {}], ['stencil', -9.6, 1.0, {}], ['porthole', 8.9, .9, {}], ['vent', -11.2, .4, {}], ['vent', 10.4, .2, {}], ['ladder', 10.9, -.6, { s: 1.25 }], ['ladder', -11.6, -.6, { s: 1.25 }], ['ladder', 4.4 + 3.3, -.6, { s: 1.25 }], ['blueprint', 9.8, .2, {}], ['signFlame', 1.95, .75, {}], ['plate07', -9.4, -.2, {}]]) W.card(n, x, y, WALLZ + (n === 'ladder' ? .3 : .03), o);
    gauge(W, -2.05, .55, WALLZ + .34, 'W', 1); gauge(W, 2.05, .3, WALLZ + .34, 'R', 1); gauge(W, 6.9, .7, WALLZ + .43, 'W', 1.1); gauge(W, -8.2, .7, WALLZ + .43, 'T', 1.1); W.card('valve', 6.9, -.1, WALLZ + .43, {}); W.card('valveB', -8.2, -.1, WALLZ + .43, {}); W.card('valveT', -10.6, .3, WALLZ + .43, {}); W.card('valve', 9.3, .4, WALLZ + .43, {});
    steam(-8.2, 1.25, WALLZ + .45, .5, .2, 6.1, 0, 1.1, [.5, .5, .56]); steam(EX + .85, .95 + .64, EZ + .1, .1, .6, 2.856, .3, .9, [.55, .56, .62]); steam(6.9, 1.2, WALLZ + .45, -.45, .25, 4.7, 2.6, 1, [.5, .5, .56]);
    embers(0, G0 + 1.5, FZ + .2, 16, 1.6, 1.9, 3.2); sparks(0, G0 + .3, FZ + .2, 10, .8, 1.6, 1.7); sparks(-xs, G0 + .12, 1.4, 4, .35, .9, 2.9); sparks(xs, G0 + .12, -1.2, 4, .35, .9, 3.4); sparks(-2.6, G0 + .12, zf, 3, .35, .9, 3.1); sparks(2.9, G0 + .12, zf, 3, .35, .9, 2.6);
    const hookA = A('hook'), hc1 = tintOf(-xs - .2, 1.6, CZ, 1.1), hc2 = tintOf(5.9, 1.8, CZ, 1.1);
    chain(-xs - .2, 4.2, CZ - .3, 13, .1, 4.4, .7, (x, y, a) => upQ(LL, hookA, x + Math.sin(a) * .25, y - Math.cos(a) * .25, CZ - .29, 1, hc1[0], hc1[1], hc1[2], a));   // 传送带上方的吊钩
    chain(5.9, 4.2, CZ, 12, .12, 5.1, 2.9, (x, y, a) => upQ(LL, hookA, x + Math.sin(a) * .25, y - Math.cos(a) * .25, CZ + .01, 1, hc2[0], hc2[1], hc2[2], a));
    chain(-3.3, 4.2, WALLZ + .9, 11, .08, 4.9, 4.2); oilLamp(4.6, 3.8, CZ + .5, 9, 3.3);
    // 前面：一道走道栏杆（在手牌后面只露两头），几只桶和箱
    for (const s of [-1, 1]) { W.pane('railing', s < 0 ? -12 : 2.6, G0, s < 0 ? -2.6 : 12, G0 + 46 / PPM, zf + 1.25, { n: NUP }); drum(W, s * 3.6, G0, zf + .75); drum(W, s * 4.05, G0, zf + .9, 'copper', .18, .48); crate(W, s * 5.3, G0, zf + .85, .46); W.card('bucket', s * 4.6, G0, zf + .6, {}); W.card('sack', s * 6.2, G0, zf + .8, { mx: s > 0 }); beacon(s * 2.75, G0 + 46 / PPM, zf + 1.26, s > 0); }
  }
  { // —— 撒一地的零碎：螺栓、扳手、煤渣、油渍、废铁、小齿轮……（平放），再加一些立着的小件 ——
    const free = (x, z, m = 0) => !(Math.abs(x) < CX + 1.15 + m && Math.abs(z) < hz + .9 + m) && !(Math.abs(z - zb) < .3 + m && Math.abs(x) < xs + .3) && !(Math.abs(z - zf) < .3 + m && Math.abs(x) < xs + .3) && !(Math.abs(Math.abs(x) - xs) < .3 + m && z > zb - .3 && z < zf + .3) && !(z < FZ + .2 && Math.abs(x) < 1.7) && !(Math.abs(x) < .4 && z < zb);
    const FLAT = ['bolts', 'wrench', 'coalBits', 'oilStain', 'pliers', 'scrap', 'bolts', 'hammer', 'chainCoil', 'cog8', 'coalBits', 'oilStain', 'cog10', 'hazTape', 'rails', 'cog14', 'bolts', 'drain'];
    for (let i = 0, n = 0; n < (low ? 110 : 170) && i < 900; i++) { const x = (rnd(i * 1.7) - .5) * 22, z = WALLZ + .3 + rnd(i * 2.9 + 5) * (zf + 1.1 - WALLZ); if (!free(x, z)) continue; const nm = FLAT[n % FLAT.length]; W.card(nm, x, G0 + .012 + (n % 9) * .001, z, { flat: 1, rot: nm === 'drain' ? 0 : rnd(i * 4.3) * 6.28, s: .8 + rnd(i * 9.1) * .5, glow: nm === 'drain' ? HOT * .55 : 0 }); n++; }
    const UPR = ['bucket', 'oilcan', 'sack', 'boltBox', 'spool', 'pipeStack', 'bucket', 'ingotStack', 'whistle', 'sack', 'cog20', 'boltBox'];
    for (let i = 0, n = 0; n < 34 && i < 500; i++) { const x = (rnd(i * 3.3 + 9) - .5) * 23, z = WALLZ + .8 + rnd(i * 5.1 + 2) * (zf + .4 - WALLZ); if (!free(x, z, .25) || (Math.abs(x) > xs && Math.abs(x) < xs + 4.6 && z > -3 && z < 3)) continue; W.card(UPR[n % UPR.length], x, G0, z, { mx: rnd(i) > .5, s: .85 + rnd(i * 2.2) * .3 }); n++; }
    for (const [x, z] of [[-xs - 4.4, 1.6], [xs + 4.5, .4], [-xs - 4.9, -1.2], [xs + 4.2, 2.6]]) { W.card('cog20', x, G0 + .05, z, { flat: 1 }); W.card('cog20', x + .03, G0 + .1, z - .02, { flat: 1, rot: .2 }); W.card('cog14', x - .02, G0 + .15, z + .02, { flat: 1, rot: .5 }); W.card('cog10', x, G0 + .2, z, { flat: 1 }); }   // 成摞的齿轮
  }
  W.flush(scene);

  // ====================================================================================================
  //  两座城堡（搭进游戏给的两个组里：挨打跟着抖，攻破跟着沉）
  // ====================================================================================================
  const LIGHTS = [];                                                                                              // 会明灭的点光：{ l, base, sp, ph, f(t) }
  const pl = (parent, color, power, reach, x, y, z, sp = 0) => { const l = new THREE.PointLight(color, power, reach, 2); l.position.set(x, y, z); parent.add(l); LIGHTS.push({ l, base: power, sp, ph: LIGHTS.length * 1.9 }); return l; };
  // 两座共用的底座：一块铆钉铁台（接在盘台外侧）、正面一道警示斜纹
  const plinth = (R, o) => { R.box('plateD', -o * .8, G0, -hz - .32, o * 1.08, -.03, hz + .32, { faces: 'fLR' }); R.box('tread', -o * .8, -.03, -hz - .32, o * 1.08, 0, hz + .32, { faces: 'tfLR' }); R.box('hazard', -o * .8, -.26, hz + .32, o * 1.08, -.03, hz + .33, { faces: 'f' }); R.box('plate', -o * .8, G0, hz + .32, o * 1.08, G0 + .16, hz + .44, { faces: 'tfLR' }); };

  { // —— 本方（青）：紫铜锅炉 + 特斯拉线圈塔。后面一座线圈塔，中间一只大锅炉，前面一只卧罐；靠盘那边一排青色发光的玻璃管 ——
    const g = castles[0], R = Rig(g.position.x), o = -1, zB = -hz * .62, zF = hz * .64, TEAL = team[0];
    plinth(R, o);
    // 线圈塔
    const tx = o * .22; R.tube('plate', tx, 0, zB, .46, .5, 'y', { sides: 10, caps: 1 }); R.tube('hoopB', tx, .4, zB, .08, .52, 'y', { sides: 10 });
    R.tube('coil', tx, .46, zB, 1.5, .19, 'y', { sides: 8 }); R.tube('hoopB', tx, .46, zB, .08, .24, 'y', { sides: 8, caps: 1 }); R.tube('hoopB', tx, 1.2, zB, .06, .215, 'y', { sides: 8 });
    R.tube('pipeB', tx, 1.94, zB, .08, .3, 'y', { sides: 10, r1: .42, caps: 2 }); R.tube('pipeB', tx, 2.02, zB, .12, .42, 'y', { sides: 10 }); R.tube('pipeB', tx, 2.14, zB, .08, .42, 'y', { sides: 10, r1: .28, caps: 1 }); R.tube('hoopB', tx, 2.22, zB, .16, .08, 'y', { sides: 6, caps: 1 });   // 顶上的放电环
    for (const s of [-1, 1]) { R.tube('hoopB', tx + s * .36, .46, zB + .3, .08, .09, 'y', { sides: 6, caps: 1 }); R.tube('glassT', tx + s * .36, .54, zB + .3, .8, .06, 'y', { sides: 6, k: DIM }); R.tube('hoopB', tx + s * .36, 1.34, zB + .3, .06, .08, 'y', { sides: 6, caps: 1 }); }
    R.box('plate', -.75, 0, zB - .62, .95, 1.0, zB - .52, { faces: 'tfLR' }); R.card('signBolt', -o * .55, .5, zB - .5, {}); R.card('fusebox', o * .82, .3, zB - .5, {}); for (let i = 0; i < 4; i++) R.card('ledT', -o * .5 + i * .09, .3, zB - .5, { glow: DIM });
    // 大锅炉
    const bx = o * .12, br = .66; R.tube('copper', bx, 0, 0, 1.3, br, 'y', { sides: 12 }); R.tube('copper', bx, 1.3, 0, .2, br, 'y', { sides: 12, r1: .48 }); R.tube('copper', bx, 1.5, 0, .14, .48, 'y', { sides: 12, r1: .2, caps: 1 });
    for (const y of [.06, .66, 1.24]) R.tube('hoopB', bx, y, 0, .08, br + .02, 'y', { sides: 12 });
    R.tube('hoopB', bx, 1.62, 0, .16, .07, 'y', { sides: 6, caps: 1 }); R.card('whistle', bx, 1.74, .01, {});
    R.card('porthole', bx, .52, br + .03, { s: 1.15 }); R.card('portGlowT', bx, .52 + .084, br + .02, { s: 1.15, glow: DIM });
    gauge(R, bx - .38, 1.02, br * .82 + .03, 'T', 1, g); gauge(R, bx + .38, 1.02, br * .82 + .03, 'T', 1, g); R.card('valveT', bx, .14, br + .04, {});
    // 前面的卧罐
    R.tube('copper', -.6, .5, zF, 1.25, .42, 'x', { sides: 10, caps: 3 }); for (const x of [-.52, .0, .52]) R.tube('hoopB', x, .5, zF, .07, .44, 'x', { sides: 10 });
    for (const x of [-.4, .45]) R.box('plate', x - .08, 0, zF - .3, x + .08, .22, zF + .3, { faces: 'tfLR' });
    gauge(R, 0, .56, zF + .45, 'T', 1.2, g); R.card('valveB', -.42, .32, zF + .45, { s: .9 }); R.tube('hoopB', o * .3, .9, zF, .34, .055, 'y', { sides: 6, caps: 1 }); R.card('whistle', o * .3, 1.2, zF + .01, {});
    // 连着三只罐的铜管
    R.tube('pipeC', o * .78, .22, zB, zF - zB, .085, 'z', { sides: 6 }); for (const z of [zB + .5, 0, zF - .5]) R.tube('hoopB', o * .78, .22, z, .07, .12, 'z', { sides: 6, caps: 3 }); R.tube('pipeC', o * .78, .22, zF * .5, .9, .06, 'y', { sides: 6, caps: 1 }); R.card('valveB', o * .78, .95, zF * .5 + .08, { s: .8 });
    // 靠盘一排玻璃管：每条路一根
    for (let c = 0; c < COLS; c++) { const z = tileZ(c), x = -o * .6; R.tube('hoopB', x, 0, z, .1, .1, 'y', { sides: 6, caps: 1 }); R.tube('glassT', x, .1, z, .62, .06, 'y', { sides: 6, k: DIM }); R.tube('hoopB', x, .72, z, .07, .08, 'y', { sides: 6, caps: 1 }); }
    R.flush(g); pl(g, TEAL, 3.2, 5.5, -o * .5, 1.3, .9, 1);
    // 电弧：隔一阵从放电环上跳几下青白的弧，带一下闪光
    const arcs = [0, 1, 2, 3].map(i => A('arc' + i)), zaps = [A('zap0'), A('zap1')], arcL = pl(g, '#9ffff0', 0, 7, tx, 2.6, zB + .4);
    LIGHTS.pop();                                                                                                 // 这盏由下面自己管
    ANIM.push((t, f) => { const ox = g.position.x, oy = g.position.y, p = t % 2.7, on = p < .55 && (f & 1 || p < .15), k = on ? 1 : 0;
      if (on) { upQ(LG, arcs[f & 3], ox + tx + (rnd(f) - .5) * .3, oy + 2.3 + .4, zB + .02, 1, HOT * .8, HOT, HOT, (rnd(f * 3.1) - .5) * .8, rnd(f * 1.3) > .5 ? 1 : -1); glowQ(ox + tx, oy + 2.4, zB + .3, 1.3, 1.1, .12, .42, .4); }
      arcL.intensity = k * (low ? 5 : 9);
      for (let c = 0; c < COLS; c++) if ((f + c * 3) % 11 === 0) upQ(LG, zaps[f & 1], ox + .6, oy + .86, tileZ(c) + .01, 1, HOT * .7, HOT, HOT);   // 玻璃管顶上偶尔一点小火花
      const h = .13 + .03 * Math.sin(t * 2.1); glowQ(ox + .5, oy + .6, 1.2, 1.3, 1, 0, h * .7, h * .62); });
    steam(o * .3, 1.42, zF, -.1, .6, 5.6, 3.1, .8, [.6, .66, .72], g); steam(bx, 1.96, 0, .12, .7, 7.3, 1.2, .9, [.58, .66, .72], g);
  }
  { // —— 对面（红）：高炉。中间一座箍着铁箍的砖炉，正面一扇拱形炉门，炉栅里烧得通红；后面一根砖烟囱；前面吊臂上挂着一只铁水包 ——
    const g = castles[1], R = Rig(g.position.x), o = 1, zB = -hz * .62, zF = hz * .68, RED = team[1];
    plinth(R, o);
    // 烟囱
    const cx = o * .5; R.box('brick', cx - .5, 0, zB - .45, cx + .5, .5, zB + .45, { faces: 'tfLR' }); R.tube('brick', cx, .5, zB, 2.15, .36, 'y', { sides: 10, r1: .29 }); for (const y of [.52, 1.3, 2.05]) R.tube('hoopI', y < 1 ? cx : cx, y, zB, .08, .37 - (y - .5) * .032, 'y', { sides: 10 });
    R.tube('plate', cx, 2.65, zB, .14, .33, 'y', { sides: 10, caps: 1 }); R.card('bulbR', cx, 2.74, zB, { glow: HOT * .8, s: 1.6 });
    // 炉身
    const fx = o * .08, fz = -.12, fr = .8; R.tube('brick', fx, 0, fz, 1.2, fr, 'y', { sides: 12 }); for (const y of [.04, .6, 1.14]) R.tube('hoopI', fx, y, fz, .09, fr + .02, 'y', { sides: 12 });
    R.tube('plate', fx, 1.2, fz, .34, fr, 'y', { sides: 12, r1: .46 }); R.tube('plateD', fx, 1.54, fz, .16, .46, 'y', { sides: 12, caps: 1 }); R.card('ladleGlow', fx, 1.705, fz, { flat: 1, glow: [.75, .2, .12], s: 1.3 });   // 炉顶的料口：暗红（就在血量牌底下，不能亮）
    // 炉门的门脸：一块凸出来的砖垛，正面嵌拱形炉门，门里是火
    const dx = fx - o * .1, dz = fz + fr + .05; R.box('brick', dx - .7, 0, fz + .2, dx + .7, 1.28, dz, { faces: 'tLR' }); R.box('plate', dx - .74, 1.28, fz + .2, dx + .74, 1.38, dz + .03, { faces: 'tfLR' });
    R.card('door', dx, 0, dz + .012, { s: 1.06 }); R.box('brick', dx - .7, 1.2, dz - .005, dx + .7, 1.28, dz, { faces: 'f' }); R.card('signFlame', dx + o * .0, 1.4, dz + .02, { s: .9 });
    for (const s of [-1, 1]) R.box('brick', dx + s * .7, 0, dz - .005, dx + s * .66, 1.28, dz, { faces: 'f' });
    // 吊臂和铁水包
    const jx = o * .96, lx = o * .62; R.box('plate', jx - .07, 0, zF - .07, jx + .07, 2.25, zF + .07, { faces: 'tfLR' }); R.box('plate', lx - .3, 2.12, zF - .05, jx + .07, 2.25, zF + .05, { faces: 'tfLR' }); R.pane('truss', lx - .3, 1.5, jx, 1.5 + 30 / PPM, zF + .06, { n: NUP, k: .9 }); R.card('pulley', lx, 2.0, zF + .07, { s: .8 });
    R.box('plateD', lx - .34, 0, zF - .2, lx + .34, .14, zF + .2, { faces: 'tfLR' }); R.card('mould', lx, .12, zF + .06, {}); R.card('mouldGlow', lx, .2, zF + .07, { glow: [HOT, HOT * .55, HOT * .3] });
    // 靠盘一排火盆：每条路一只铁盆，栅缝里透红
    for (let c = 0; c < COLS; c++) { const z = tileZ(c), x = -o * .6; R.box('plateD', x - .13, 0, z - .1, x + .13, .3, z + .1, { faces: 'tfLR' }); R.card('slot', x, .03, z + .104, {}); R.card('slotGlowR', x, .07, z + .102, { glow: HOT * .9 }); R.card('coals', x, .28, z + .02, { glow: [HOT, HOT * .55, HOT * .4], s: .36 }); }
    // 侧面的风管和阀
    R.tube('pipeI', o * .92, .25, zB + .5, -zB * 1.2, .1, 'z', { sides: 6 }); for (const z of [zB + .9, .2]) R.tube('hoopI', o * .92, .25, z, .08, .14, 'z', { sides: 6, caps: 3 }); R.card('valve', o * .92, .4, .7, {}); gauge(R, dx + o * .52, 1.0, dz + .02, 'R', .9, g); drum(R, o * .78, 0, -.5, 'plate', .17, .42);
    R.flush(g); pl(g, RED, 3.2, 5.5, -o * .5, 1.1, 1, 1);
    const hr = A('hearthR'), fl = [0, 1, 2, 3].map(i => A('flame' + i)), lad = A('ladle'), lg = A('ladleGlow'), yk = A('yoke'), c = tintOf(g.position.x + lx, 1.2, zF, 1.2);
    ANIM.push((t, f) => { const ox = g.position.x, oy = g.position.y, k = HOT * (.82 + .1 * Math.sin(t * 6.1) + .08 * Math.sin(t * 13.3));
      LG.put(hr, ox + dx, oy + .56, dz + .004, .5, 0, 0, 0, .55, 0, k, k, k);                                       // 炉门里那一面红
      for (let i = 0; i < 2; i++) upQ(LG, fl[(f + i * 2) & 3], ox + dx - .2 + i * .4, oy + .42, dz + .008, .8, k, k * .62, k * .5);
      for (let cc = 0; cc < COLS; cc++) upQ(LG, fl[(f + cc) & 3], ox - .6, oy + .44, tileZ(cc) + .03, .42, k, k * .5, k * .42);   // 火盆上的小火苗（染红）
      const h = .13 + .03 * Math.sin(t * 3.3); glowQ(ox - .5, oy + .55, 1.3, 1.3, 1, h, h * .16, h * .1); glowQ(ox + cx, oy + 2.8, zB + .2, .8, .7, .3, .08, .03); });
    chain(g.position.x + lx, 2.0, zF + .02, 3, .09, 3.9, 1.1, (x, y, a) => { const ox = g.position.x - CX, oy = g.position.y, s = Math.sin(a), co = Math.cos(a); upQ(LL, yk, x + ox + s * .28, y + oy - co * .28, zF + .01, 1, c[0], c[1], c[2], a); upQ(LL, lad, x + ox + s * .55, y + oy - co * .55, zF + .03, 1, c[0], c[1], c[2], a); upQ(LG, lg, x + ox + s * .31, y + oy - co * .31, zF + .04, 1, HOT, HOT * .8, HOT * .6, a); });
    embers(cx, 2.75, zB, 9, .3, 1.3, 2.6, g); steam(cx, 2.9, zB, .15, .5, 2.4, 0, 1, [.2, .15, .16], g); steam(cx, 2.9, zB, .2, .55, 2.4, 1.2, 1.1, [.17, .13, .14], g);
    sparks(lx, .25, zF + .1, 5, .4, 1.2, 2.1, g);
  }

  // ====================================================================================================
  //  光
  // ====================================================================================================
  scene.background.set(LOOK.bg); scene.fog = new THREE.Fog(LOOK.fog, 24, 50);
  const sd = new THREE.Vector3(...SKY_FROM).normalize();
  amb.color.set(LOOK.amb[0]); amb.intensity = LOOK.amb[1]; sun.color.set(LOOK.sky[0]); sun.intensity = LOOK.sky[1]; sun.position.copy(sd).multiplyScalar(30);
  sun.shadow.mapSize.setScalar(low ? 2048 : 4096); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 2, far: 64 }); sun.shadow.camera.updateProjectionMatrix(); sun.shadow.bias = -.0006; sun.shadow.normalBias = .03; sun.shadow.radius = 3;
  const forge = new THREE.DirectionalLight(LOOK.forge[0], LOOK.forge[1]); forge.position.set(.5, 4.2, -10); scene.add(forge);
  const fill = new THREE.DirectionalLight(LOOK.fill[0], LOOK.fill[1]); fill.position.set(2, 5, 10); scene.add(fill);
  const furnaceL = pl(scene, '#ff8a30', 12, 11, 0, .5, FZ + 1.3, 1), pourL = pl(scene, '#ff9a3a', 0, 5, QX - .4, G0 + .7, QZ + .4); LIGHTS.pop();
  for (const L of LAMPS) if (L.power) L.light = pl(scene, '#ffb45a', L.power, 5.5, L.x, L.y, L.z + .3, 1);
  { // 屋顶的铁格栅：一片只投影、不显形的镂空板，挡在天光和场地之间；盘面正上方留一整块空的
    const H = 11, ox = sd.x * H / sd.y, oz = sd.z * H / sd.y, cell = 1.3, bar = .56, O = { x0: -hx - .35, x1: hx + .35, z0: -hz - .4, z1: hz + .55 }, Pq = [], Iq = [];
    const push = (x0, x1, z0, z1) => { const i = Pq.length / 3; Pq.push(x0 + ox, H, z0 + oz, x1 + ox, H, z0 + oz, x0 + ox, H, z1 + oz, x1 + ox, H, z1 + oz); Iq.push(i, i + 2, i + 1, i + 1, i + 2, i + 3); };
    const cut = (x0, x1, z0, z1) => { if (x1 <= O.x0 || x0 >= O.x1 || z1 <= O.z0 || z0 >= O.z1) return push(x0, x1, z0, z1); if (x0 < O.x0) push(x0, O.x0, z0, z1); if (x1 > O.x1) push(O.x1, x1, z0, z1); const a = Math.max(x0, O.x0), b = Math.min(x1, O.x1); if (z0 < O.z0) push(a, b, z0, O.z0); if (z1 > O.z1) push(a, b, O.z1, z1); };
    for (let v = -13; v < 13; v += cell) { cut(-14, 14, v + .2, v + .2 + bar); cut(v + .1, v + .1 + bar, -13, 13); }
    cut(-20, -13.5, -14, 14); cut(13.5, 20, -14, 14);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(Pq, 3)); geo.setIndex(Iq);
    const gobo = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide })); gobo.castShadow = true; gobo.frustumCulled = false; scene.add(gobo);
  }
  // 冷光柱和里面的浮尘、后墙脚下的暖雾（都是叠加的软片）
  { const sh = [[-xs - 1.2, -2.2, 1.1], [-2.3, -hz - 1.3, .8], [1.4, -hz - 1.9, .9], [xs + 1.5, -1.4, 1.1], [-xs - 3, .8, .9], [xs + 3.2, 1.4, .8]], mote = A('mote'), nm = Math.round(22 * NPART);
    ANIM.push(t => {
      for (let i = 0; i < sh.length; i++) { const s = sh[i], k = (low ? .05 : .075) * (1 + .15 * Math.sin(t * .4 + i * 2)); LS.put(SA.shaft, s[0] - .75, 1.8, s[1], s[2] * .55, 0, 0, .78, 2.4, .5, k * .5, k * .78, k); }
      for (let i = 0; i < nm; i++) { const s = sh[i % sh.length], q = (t * .035 + rnd(i * 1.3)) % 1, k = .5 * Math.sin(q * 3.1416); LG.put(mote, s[0] - .4 + (rnd(i * 2.7) - .5) * 1.4 - q * .5 + Math.sin(t * .5 + i) * .08, 2.4 - q * 2.6, s[1] + (rnd(i * 4.1) - .5) * .6, .011, 0, 0, 0, .011, 0, k * .5, k * .8, k); }
      const w = low ? .06 : .08; LS.put(SA.haze, 0, .5, WALLZ + 1.5, 7.5, 0, 0, 0, 1.7, 0, w * 1.5, w * .55, w * .14); LS.put(SA.haze, -8, .9, -hz - 1.2, 4, 0, 0, 0, 1.6, 0, w * .9, w * .36, w * .12); LS.put(SA.haze, 8, .9, -hz - 1.2, 4, 0, 0, 0, 1.6, 0, w * .9, w * .36, w * .12);
    });
  }

  // ====================================================================================================
  //  后期
  // ====================================================================================================
  post.bloom.strength = LOOK.bloom[0]; post.bloom.radius = LOOK.bloom[1]; post.bloom.threshold = LOOK.bloom[2];
  { const tl = SHORT ? LOOK.tiltShort : LOOK.tilt; for (const p of [post.tiltH, post.tiltV]) { p.uniforms.focus.value = tl.focus; p.uniforms.band.value = tl.band; p.uniforms.amt.value = tl.amt; } }
  { const u = post.grade.uniforms, g = LOOK.grade; u.sat.value = g.sat; u.con.value = g.con; u.knee.value = g.knee; u.gain.value.setRGB(...g.gain); u.lift.value.setRGB(...g.lift); u.edge.value.setRGB(...g.edge); post.grade.enabled = true; }

  // ====================================================================================================
  //  贴镜头的前景：栏杆、粗管、桁架、大齿轮、铁链的暗色剪影，按画面坐标定位，只压在四角和上沿
  // ====================================================================================================
  const eye = new THREE.Vector3(), ray = new THREE.Vector3(), rgt = new THREE.Vector3(), upv = new THREE.Vector3(), look = new THREE.Vector3(0, .95, -.1), TANH = Math.tan(camera.fov * Math.PI / 360);
  // name：哪张小件；nx ny：画面坐标（-1..1）；d：离镜头多远；frac：占画面高度的几成；rot：转多少；mx：左右翻
  const fgPut = (a, nx, ny, d, frac, rot, mx, r, g, b) => { ray.set(nx, ny, .5).unproject(camera).sub(eye).normalize(); const hh = frac * d * TANH, hw = hh * a.w / a.h * (mx ? -1 : 1), c = Math.cos(rot), s = Math.sin(rot);
    FG.put(a, eye.x + ray.x * d, eye.y + ray.y * d, eye.z + ray.z * d, (rgt.x * c + upv.x * s) * hw, (rgt.y * c + upv.y * s) * hw, (rgt.z * c + upv.z * s) * hw, (upv.x * c - rgt.x * s) * hh, (upv.y * c - rgt.y * s) * hh, (upv.z * c - rgt.z * s) * hh, r, g, b); };
  const fgA = { rail: A('fgRail'), pipe: A('fgPipe'), truss: A('fgTruss'), gear: A('fgGear'), link: A('link'), hook: A('hook') }, FS = SHORT ? .8 : 1, FGCH = [[-.44, 3, 0], [.4, 2, 2]];
  function foreground(t) {
    camera.updateMatrixWorld(); eye.setFromMatrixPosition(camera.matrixWorld); rgt.setFromMatrixColumn(camera.matrixWorld, 0); upv.setFromMatrixColumn(camera.matrixWorld, 1);
    FG.begin();
    fgPut(fgA.truss, -.3, 1.03, 6.4, .2 * FS, 0, 0, .075, .05, .05); fgPut(fgA.truss, .3, 1.03, 6.4, .2 * FS, 0, 1, .075, .05, .05);        // 上沿一道桁架
    fgPut(fgA.pipe, -.86, .97, 5.6, .24 * FS, .05, 0, .09, .058, .05); fgPut(fgA.gear, .98, .98, 5.2, .5 * FS, t * .25, 0, .1, .065, .05);      // 左上的粗管、右上一只慢慢转的大齿轮
    fgPut(fgA.rail, -.86, SHORT ? -.6 : -.84, 5, .3 * FS, .04, 0, .1, .065, .055); fgPut(fgA.rail, .88, SHORT ? -.6 : -.84, 5, .3 * FS, -.04, 1, .1, .065, .055);   // 左下、右下的栏杆（压在画面下沿的两个角，中间是手牌）
    for (const [nx, n, ph] of FGCH) { const a = .05 * Math.sin(t * 1.3 + ph); for (let i = 0; i < n; i++) fgPut(fgA.link, nx + Math.sin(a) * (i + .5) * .06, 1 - (i + .5) * .075 * FS, 5.8, .08 * FS, a, 0, .1, .065, .055); fgPut(fgA.hook, nx + Math.sin(a) * (n + .7) * .06, 1 - (n + .85) * .075 * FS, 5.8, .14 * FS, a, 0, .1, .065, .055); }   // 上沿垂下来两根铁链（让开左上的按钮和两块血量牌）
    FG.end();
  }

  // ====================================================================================================
  //  每帧
  // ====================================================================================================
  let last = 0;
  const molT = MAT.molten.mat.map, glassT = MAT.glassT.mat.map, beltT = MAT.belt.mat.map, waterT = MAT.water.mat.map;
  function tick(t) {
    last = t; const f = Math.floor(t * 8);
    molT.offset.y = (t * .34 * PPM / 96) % 1; glassT.offset.y = -(f / 8 * .5) % 1; beltT.offset.y = (t * .32 * PPM / 24) % 1; waterT.offset.x = (t * .03) % 1; waterT.offset.y = Math.sin(t * .6) * .03;   // 铁水、玻璃管里的泡、传送带、水面
    LL.begin(); LG.begin(); LS.begin(); for (let i = 0; i < ANIM.length; i++) ANIM[i](t, f); LL.end(); LG.end(); LS.end();
    for (const L of LIGHTS) L.l.intensity = L.base * (L.sp ? 1 + .1 * Math.sin(9.1 * t + L.ph) + .06 * Math.sin(15.7 * t + L.ph * 2.3) + .05 * Math.sin(3.3 * t + L.ph) : 1);
    furnaceL.intensity *= .9 + .1 * Math.sin(t * 2.4); pourL.intensity = pourK * (7 + 2 * Math.sin(t * 17));
    for (const L of LAMPS) if (L.light) L.light.position.set(L.x, L.y, L.z + .3);
    foreground(t);
    const d = eye.distanceTo(look); scene.fog.near = d + 4; scene.fog.far = d + 30;
  }
  scene.updateMatrixWorld(true); tick(ctx.calm ? 1 : 0);                // 「减少动态效果」时画面就停在这一帧：挑电弧没亮的时刻，免得一团白光一直压在本方血量牌上
  const again = () => requestAnimationFrame(() => tick(last));          // 镜头是 build 之后才摆好的、窗口也会变：补摆一次（「减少动态效果」时游戏不调 tick，全靠这个）
  addEventListener('resize', again); again(); setTimeout(again, 400);
  return { tick };
}
