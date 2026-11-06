// Pop-up book: spine at the far end (z=0); the cover flips back to 90° and stands up as the stage backdrop
import * as THREE from 'three';
import { cv, paperFill, GRAIN } from './paper.js';
import { mulberry, clamp } from './lib.js';

export const BW = 0.44, BD = 0.30;       // page width (x) × depth (z)
export const BT = 0.0035, HB = 0.014;    // cover-board thickness, thickness of half the page block
export const PG = BT + HB;               // height of the lower half's page surface

export function texOf(c, o = {}) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = o.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  return t;
}

// page edges (thin horizontal lines)
function edgeCanvas() {
  const c = cv(512, 64), x = c.getContext('2d'); x.fillStyle = '#efe6d2'; x.fillRect(0, 0, 512, 64);
  const R = mulberry(9);
  for (let i = 0; i < 64; i += 1.3) { x.fillStyle = `rgba(150,130,100,${.08 + R() * .18})`; x.fillRect(0, i, 512, .6); }
  return c;
}

// 布面封面 + 烫金书名「纸龙」+ 纸龙圆章；同时生成粗糙度(g)/金属度(b)贴图
export const CLOTH = '#24584a', GOLD = '#e0b456';
export function coverCanvases(drawIcon) {
  const w = 2048, h = Math.round(2048 * BD / BW), c = cv(w, h), x = c.getContext('2d'), m = cv(w, h), y = m.getContext('2d');
  x.fillStyle = CLOTH; x.fillRect(0, 0, w, h);
  const R = mulberry(3);
  for (let i = 0; i < h; i += 3) { x.fillStyle = `rgba(0,0,0,${.05 + R() * .07})`; x.fillRect(0, i, w, 1.2); }
  for (let i = 0; i < w; i += 3) { x.fillStyle = `rgba(255,255,255,${.02 + R() * .04})`; x.fillRect(i, 0, 1.2, h); }
  for (let i = 0; i < 90; i++) { const px = R() * w, py = R() * h, r = 60 + R() * 300, g = x.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, `rgba(${R() < .5 ? '0,0,0' : '130,180,150'},${.06 * R()})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(px - r, py - r, 2 * r, 2 * r); }
  y.fillStyle = 'rgb(0,235,0)'; y.fillRect(0, 0, w, h);
  const both = fn => { x.save(); fn(x, GOLD); x.restore(); y.save(); fn(y, 'rgb(0,90,255)'); y.restore(); };
  both((k, col) => { k.strokeStyle = col; k.lineWidth = 10; k.strokeRect(90, 90, w - 180, h - 180); k.lineWidth = 4; k.strokeRect(120, 120, w - 240, h - 240);
    for (const [cx, cy] of [[120, 120], [w - 120, 120], [120, h - 120], [w - 120, h - 120]]) { k.beginPath(); k.arc(cx, cy, 34, 0, Math.PI * 2); k.fillStyle = col; k.fill(); }
    // 云纹角花
    k.lineWidth = 8; for (const [cx, cy, sx, sy] of [[200, 200, 1, 1], [w - 200, 200, -1, 1], [200, h - 200, 1, -1], [w - 200, h - 200, -1, -1]]) { k.beginPath(); k.arc(cx + sx * 40, cy + sy * 40, 40, 0, Math.PI * 1.5); k.stroke(); k.beginPath(); k.arc(cx + sx * 40, cy + sy * 40, 18, 0, Math.PI * 1.5); k.stroke(); } });
  both((k, col) => { k.fillStyle = col; k.textAlign = 'center'; k.textBaseline = 'middle';
    k.font = '900 430px "Noto Serif SC"'; k.fillText('纸', w * .66, h * .34); k.fillText('龙', w * .66, h * .7); });
  const cx = w * .27, cy = h * .52, r = 360;
  both((k, col) => { k.beginPath(); k.arc(cx, cy, r + 26, 0, Math.PI * 2); k.lineWidth = 14; k.strokeStyle = col; k.stroke(); k.beginPath(); k.arc(cx, cy, r + 52, 0, Math.PI * 2); k.lineWidth = 5; k.stroke(); });
  x.save(); x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.clip();
  x.fillStyle = '#f4e9cf'; x.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  x.fillStyle = '#9fd18a'; x.beginPath(); x.ellipse(cx, cy + r * .95, r * 1.3, r * .5, 0, 0, Math.PI * 2); x.fill();
  drawIcon(x, cx - r * .92, cy - r * .62, r * 1.84, r * 1.4);
  x.restore();
  y.save(); y.beginPath(); y.arc(cx, cy, r, 0, Math.PI * 2); y.fillStyle = 'rgb(0,200,0)'; y.fill(); y.restore();
  return { c, m };
}
// 书脊：u = 绕圆周（左 = 顶），v = 沿书脊（下 = 世界 +x）。烫金竖排外的横排书名
function spineCanvases() {
  const w = 256, h = 2048, c = cv(w, h), x = c.getContext('2d'), m = cv(w, h), y = m.getContext('2d');
  x.fillStyle = CLOTH; x.fillRect(0, 0, w, h);
  const R = mulberry(5); for (let i = 0; i < h; i += 3) { x.fillStyle = `rgba(0,0,0,${.04 + R() * .06})`; x.fillRect(0, i, w, 1.2); }
  y.fillStyle = 'rgb(0,235,0)'; y.fillRect(0, 0, w, h);
  const both = fn => { x.save(); fn(x, GOLD); x.restore(); y.save(); fn(y, 'rgb(0,90,255)'); y.restore(); };
  both((k, col) => {
    k.fillStyle = col; for (const v of [.06, .08, .92, .94]) k.fillRect(70, h * v, w - 140, 10);
    k.translate(w / 2, h * .72); k.rotate(-Math.PI / 2); k.textAlign = 'center'; k.textBaseline = 'middle';
    k.font = '900 132px "Noto Serif SC"'; k.fillText('纸  龙', 0, 4);
    k.beginPath(); k.arc(-420, 0, 34, 0, Math.PI * 2); k.fill(); k.beginPath(); k.arc(420, 0, 34, 0, Math.PI * 2); k.fill();
    k.fillRect(-700, -6, 200, 12); k.fillRect(500, -6, 200, 12);
  });
  return { c, m };
}

export function makeBook(cover) {
  const root = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: CLOTH, roughness: .85 });
  const edge = texOf(edgeCanvas()); edge.wrapS = edge.wrapT = THREE.RepeatWrapping;
  const edgeMat = new THREE.MeshStandardMaterial({ map: edge, roughness: .95 });
  const pageTop = new THREE.MeshStandardMaterial({ color: '#f3ead6', roughness: .95 });

  // lower half: cover board + page block
  const lb = new THREE.Mesh(new THREE.BoxGeometry(BW + .012, BT, BD + .006), cloth); lb.position.set(0, BT / 2, BD / 2 + .002);
  const lp = new THREE.Mesh(new THREE.BoxGeometry(BW, HB, BD - .002), [edgeMat, edgeMat, pageTop, pageTop, edgeMat, edgeMat]); lp.position.set(0, BT + HB / 2, BD / 2);
  for (const m of [lb, lp]) { m.castShadow = m.receiveShadow = true; root.add(m); }
  // spine
  const spine = new THREE.Mesh(new THREE.CylinderGeometry(PG, PG, BW + .012, 24, 1, false, Math.PI, Math.PI), cloth);
  spine.rotation.z = Math.PI / 2; spine.position.set(0, PG, -.001); spine.castShadow = true; root.add(spine);

  // 合上时的整根书脊（带烫金书名），只在书合着时显示
  const sc = spineCanvases(), st = texOf(sc.c), sm = texOf(sc.m, { linear: true });
  const spineFull = new THREE.Mesh(new THREE.CylinderGeometry(PG, PG, BW + .012, 40, 1, true, Math.PI / 2, Math.PI), new THREE.MeshStandardMaterial({ map: st, roughnessMap: sm, metalnessMap: sm, roughness: 1, metalness: 1, side: THREE.DoubleSide }));
  spineFull.rotation.z = Math.PI / 2; spineFull.position.set(0, PG, -.001); spineFull.castShadow = spineFull.receiveShadow = true; spineFull.visible = false; root.add(spineFull);
  const hinge = new THREE.Group(); hinge.position.set(0, PG, 0); root.add(hinge);
  const upper = new THREE.Group(); hinge.add(upper);
  const open = new THREE.Group(); open.rotation.x = Math.PI / 2; upper.add(open);
  // open-state coordinates (open frame = world orientation when standing up): backdrop page at z=0 facing +z, page block at z<0
  const up = new THREE.Mesh(new THREE.BoxGeometry(BW, BD - .002, HB), [edgeMat, edgeMat, edgeMat, edgeMat, pageTop, pageTop]); up.position.set(0, BD / 2, -HB / 2);
  const ub = new THREE.Mesh(new THREE.BoxGeometry(BW + .012, BD + .006, BT), cloth); ub.position.set(0, BD / 2 + .002, -HB - BT / 2);
  const coverTex = texOf(cover.c), mr = texOf(cover.m, { linear: true });
  const coverMat = new THREE.MeshStandardMaterial({ map: coverTex, roughnessMap: mr, metalnessMap: mr, roughness: 1, metalness: 1 });
  const cp = new THREE.Mesh(new THREE.PlaneGeometry(BW + .008, BD + .002), coverMat); cp.rotation.x = Math.PI; cp.position.set(0, BD / 2 + .002, -HB - BT - .0003);
  for (const m of [up, ub, cp]) { m.castShadow = m.receiveShadow = true; open.add(m); }

  // ground page (stage frame) and backdrop page (open frame), with the gutter curve
  const groundGeo = new THREE.PlaneGeometry(BW - .006, BD - .004, 1, 30); groundGeo.rotateX(-Math.PI / 2); groundGeo.translate(0, 0, BD / 2);
  gutter(groundGeo, 'z');
  const groundMat = new THREE.MeshStandardMaterial({ roughness: .92, color: '#ffffff' });
  const ground = new THREE.Mesh(groundGeo, groundMat); ground.position.y = .0003; ground.receiveShadow = true;
  const stage = new THREE.Group(); hinge.add(stage); stage.add(ground);
  const backGeo = new THREE.PlaneGeometry(BW - .006, BD - .004, 1, 30); backGeo.translate(0, BD / 2, 0); gutter(backGeo, 'y');
  const backMat = new THREE.MeshStandardMaterial({ roughness: .92, color: '#ffffff' });
  const back = new THREE.Mesh(backGeo, backMat); back.position.z = .0003; back.receiveShadow = true; open.add(back);
  const sky = new THREE.Group(); open.add(sky);

  // page turn: one curved sheet, front = old ground, back = new sky。
  // 卷曲：自由边领先的行波（边先翘、靠书沟的部分后跟），中段自由边越过竖直再回落 → S 形；
  // pinch：龙咬住自由边上 xg 处一点，把那一小块纸"拎"起来（页角帐篷形），由 G - 边点 的位移驱动。
  const NS = 48, NX = 72, LWID = BW - .006, mkLeafGeo = () => new THREE.PlaneGeometry(LWID, 1, NX, NS);
  const lf = mkLeafGeo(), lb2 = mkLeafGeo();
  const leafFront = new THREE.Mesh(lf, new THREE.MeshStandardMaterial({ roughness: .92, side: THREE.FrontSide }));
  const leafBack = new THREE.Mesh(lb2, new THREE.MeshStandardMaterial({ roughness: .92, side: THREE.BackSide }));
  const uvF = lf.attributes.uv, uvB = lb2.attributes.uv;
  for (let i = 0; i < uvF.count; i++) { const v = uvF.getY(i); uvB.setY(i, 1 - v); }
  uvB.needsUpdate = true;
  const X0 = Float32Array.from({ length: NX + 1 }, (_, ix) => -LWID / 2 + LWID * ix / NX);
  for (const m of [leafFront, leafBack]) { m.material.emissive = new THREE.Color(.42, .4, .38); m.castShadow = true; m.receiveShadow = true; m.visible = false; m.frustumCulled = false; stage.add(m); }
  const LEAD = .5, OVER = .55;
  const smo = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  function phiAt(s, u) {
    const base = Math.PI / 2 * smo((u - LEAD * (1 - s)) / (1 - LEAD));
    const over = OVER * Math.sin(Math.PI * clamp((u - .1) / .62)) * Math.pow(s, 2.2);   // 自由边越过竖直再回落
    return base + over;
  }
  // 各行（书沟→自由边）的 [y, z]
  function rows(u) {
    const LL = BD - .004; let zz = .002, yy = 0; const col = [[yy, zz]];
    for (let iy = 1; iy <= NS; iy++) { const s = (iy - .5) / NS, phi = phiAt(s, u); zz += Math.cos(phi) * LL / NS; yy += Math.sin(phi) * LL / NS; col.push([yy, zz]); }
    for (let i = 1; i < col.length; i++) col[i][1] += .0014 * smo(u);
    for (const c of col) { c[0] += .0009 - .0045 * Math.exp(-c[1] / .012) * (1 - clamp(u * 4)); }
    return col;
  }
  // u：翻页进度；P = { xg, d:[dx,dy,dz] } 自由边上 xg 处被拎起的位移（stage 坐标）
  function setLeaf(u, P = null, vis = u > 0 && u < 1) {
    leafFront.visible = leafBack.visible = vis; if (!vis) return;
    const col = rows(u), d = P ? P.d : [0, 0, 0], xg = P ? P.xg : 0;
    for (const g of [lf, lb2]) {
      const p = g.attributes.position;
      // PlaneGeometry: rows iy=0..NS (y from +0.5 to -0.5)，每行 NX+1 个点
      for (let iy = 0; iy <= NS; iy++) {
        const s = iy / NS, ws = s > .8 ? Math.pow((s - .8) / .2, 1.5) : 0;
        for (let ix = 0; ix <= NX; ix++) {
          const k = iy * (NX + 1) + ix, w = ws * Math.exp(-Math.pow((X0[ix] - xg) / .022, 2));
          p.setX(k, X0[ix] + w * d[0]); p.setY(k, col[iy][0] + w * d[1]); p.setZ(k, col[iy][1] + w * d[2]);
        }
      }
      p.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere();
    }
  }

  function setOpen(th) { upper.rotation.x = -th; spineFull.visible = th < .02; spine.visible = th >= .02; }
  // 翻页自由边（stage 坐标 [y, z]），与 setLeaf 同一积分
  function leafEdge(u) { const c = rows(u); return c[NS]; }
  return { root, hinge, upper, open, stage, sky, ground, back, groundMat, backMat, leafFront, leafBack, setLeaf, setOpen, leafEdge, coverMat, spineFull };
}

function gutter(g, axis) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const d = axis === 'z' ? p.getZ(i) : p.getY(i), dip = -.0045 * Math.exp(-d / .012);
    if (axis === 'z') p.setY(i, p.getY(i) + dip); else p.setZ(i, p.getZ(i) + dip);
  }
  g.computeVertexNormals();
}
