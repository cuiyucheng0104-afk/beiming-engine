// 灵感送达 — Desktop Flythrough. One take over a dotted lilac mat on an oak desk, no voice.
// A pixel bulb printed on a sticky note ("灵感？") pops up, hops into a drawer that hides a miniature city, lights it up,
// boards a paper plane, and after one held breath of silence flies across the desk to a notebook, where a stamp presses 已送达.
// Every time below comes from timeline.js (112.5 BPM, a beat = 16 frames).
import * as THREE from 'three';
import { card, pill, rbox } from './world.js';
import { makeMonster } from './voxel.js';
import * as K from './cards.js';
import { clamp, lerp, seg, ss, eo, ei, eio, back, hash, V, arc, pop, beatBounce, squash, hops } from './anim.js';
import { DUR as TDUR, T, b, BEAT, S16, HIT } from './timeline.js';

export const DUR = TDUR;
export const VO = [];
export const END = { credit: DUR + 10 };   // no sign-off in a user's film
export const GLYPHS = '灵感送达？已便签笔记本收件箱抽屉城';
export const MAT = [2.52, 1.44];
const C = K.COL, YAX = V(0, 1, 0), TOP = .005;

// ── the desk ──
export const CARDS = {
  note: { c: V(-.70, 0, .14), w: .28, h: .30, yaw: .10, thick: .004 },
  book: { c: V(.74, 0, .20), w: .44, h: .32, yaw: -.07, thick: .007 },
};
const at = (n, u, v, y = null) => { const d = CARDS[n]; return V(u / 1000 - d.w / 2, y ?? d.thick, v / 1000 - d.h / 2).applyAxisAngle(YAX, d.yaw).add(d.c); };
const TW = { c: V(-.08, 0, -.36), w: .42, d: .32, base: .05, mid: .062, lid: .014, open: .22 };
const TRAY = { w: .38, d: .29, floor: .004, wall: .052 };   // the drawer tray (inside the tower's middle layer)
const FLOOR_Y = TW.base + .002 + TRAY.floor;               // top of the tray floor
const MUG = V(.44, 0, -.13), PAD = V(1.1, 0, .52), LAMP = { base: V(-1.0, 0, -.46), head: V(-.86, .37, -.13) };

// ── pixel art: the bulb (12 × 15) ──
const BULB = [
  '....yyyy....', '..yyYYYYyy..', '.yYWWYYYYYy.', '.YWWYYYYYYY.', 'yYWYYYYYYYYy', 'yYYKYYYYKYYy', 'yYYKYYYYKYYy', 'yYYYYYYYYYYy',
  '.yYYYPPYYYy.', '.yYYYYYYYYy.', '..yYYYYYYy..', '...gGGGGg...', '...MMMMMM...', '...gGGGGg...', '....MMMM....'];
const BPAL = { Y: C.lemon, y: '#e9a93a', W: '#fffbea', K: '#0d0d0d', P: C.apricot, G: '#807a96', g: '#6d6884', M: '#b9b3cc' };
const toArt = (rows, pal) => { const cells = []; rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch !== '.') cells.push([i, j, pal[ch]]); })); return { w: rows[0].length, h: rows.length, cells }; };

// ── card art ──
function drawNote(c, st) {
  const w = 280, h = 300;
  c.clearRect(0, 0, w, h);
  c.fillStyle = C.lemon; K.rr(c, 0, 0, w, h, 6); c.fill();
  c.fillStyle = 'rgba(180,120,20,.10)'; c.fillRect(0, 0, w, 44);   // the glue strip
  c.save(); K.rr(c, 0, 0, w, h, 6); c.clip(); K.grain(c, w, h, 3.1, null, 'rgba(120,80,10,.05)', 'rgba(255,250,220,.35)'); c.restore();
  K.txt(c, 'NOTE · 01', 22, 24, { size: 15, wt: 600, col: 'rgba(29,26,46,.55)', ls: 4 });
  K.txt(c, '便签', w - 22, 24, { size: 16, wt: 700, font: K.CJK, col: 'rgba(29,26,46,.55)', align: 'right' });
  const q = st.q || 0;
  const tw = K.txt(c, '灵感', 26, 238, { size: 84, wt: 900, font: K.CJK, col: C.ink });
  c.save(); c.translate(26 + tw + 34, 236); c.scale(1 + .28 * q, 1 + .28 * q); c.rotate(-.12 * q);
  K.txt(c, '？', 0, 0, { size: 84, wt: 900, font: K.CJK, col: C.accent, align: 'center' }); c.restore();
  c.fillStyle = 'rgba(29,26,46,.18)'; c.fillRect(26, 280, 120, 3);
}
function drawBook(c, st) {
  const w = 440, h = 320;
  K.cardBase(c, w, h, 'inbox', '笔记本', { headH: 92 });
  c.strokeStyle = '#e4e0f0'; c.lineWidth = 2;
  for (let y = 132; y < h - 16; y += 30) { c.beginPath(); c.moveTo(24, y); c.lineTo(w - 24, y); c.stroke(); }
  c.fillStyle = '#e9476a00'; c.strokeStyle = 'rgba(128,122,150,.45)'; c.lineWidth = 2;
  for (const [x, y, l] of [[30, 120, 150], [30, 150, 110], [30, 180, 130]]) { c.fillStyle = 'rgba(128,122,150,.22)'; K.rr(c, x, y - 7, l, 9, 4); c.fill(); }
  // the landing box (dashed), where the plane will touch down
  c.save(); c.setLineDash([9, 8]); c.strokeStyle = st.stamp ? 'rgba(107,76,230,.25)' : 'rgba(107,76,230,.6)'; c.lineWidth = 3; K.rr(c, 208, 112, 206, 150, 16); c.stroke(); c.restore();
  K.txt(c, '收件箱', 30, 270, { size: 22, wt: 700, font: K.CJK, col: C.mute });
  if (st.stamp) {   // the green stamp: a plane glyph and 已送达, pressed at a slight angle
    const s = st.stamp;
    c.save(); c.translate(250, 196); c.rotate(-.09); c.globalAlpha = .92;
    c.strokeStyle = C.green; c.lineWidth = 7; K.rr(c, -150, -62, 300, 124, 22); c.stroke();
    c.lineWidth = 3; K.rr(c, -140, -52, 280, 104, 16); c.stroke();
    c.fillStyle = C.green; c.beginPath(); c.moveTo(-122, 18); c.lineTo(-64, -26); c.lineTo(-84, 30); c.lineTo(-98, 14); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(-98, 14); c.lineTo(-64, -26); c.lineTo(-104, 34); c.closePath(); c.globalAlpha = .6; c.fill(); c.globalAlpha = .92;
    K.txt(c, '已送达', 44, 2, { size: 64, wt: 900, font: K.CJK, col: C.green, align: 'center', ls: 4 });
    c.globalCompositeOperation = 'destination-out';   // ink texture: a few dry specks
    for (let i = 0; i < 90; i++) { c.fillStyle = `rgba(0,0,0,${.25 + hash(i * 3.3) * .5})`; c.fillRect(-150 + hash(i * 1.7) * 300, -62 + hash(i * 2.9) * 124, 2 + hash(i) * 3, 2 + hash(i * 5) * 3); }
    c.restore();
    if (s < 1) { c.fillStyle = `rgba(252,251,255,${1 - s})`; c.fillRect(90, 120, 330, 160); }
  }
}
function drawCity(c) {   // the drawer floor: lilac blocks, white streets, a violet runway pointing right
  const w = 380, h = 290;
  c.fillStyle = '#ddd8ee'; c.fillRect(0, 0, w, h);
  K.grain(c, w, h, 5.5, null);
  c.fillStyle = '#f7f6fc';
  for (const x of [72, 150, 228]) c.fillRect(x - 9, 0, 18, h);
  for (const y of [86, 168]) c.fillRect(0, y - 9, w, 18);
  c.fillStyle = 'rgba(128,122,150,.35)';
  for (const x of [72, 150, 228]) for (let y = 6; y < h; y += 22) c.fillRect(x - 1, y, 2, 10);
  // the plaza and runway (front right)
  c.fillStyle = '#f7f6fc'; K.rr(c, 244, 196, 128, 84, 14); c.fill();
  c.fillStyle = C.accent; for (let x = 256; x < 368; x += 18) c.fillRect(x, 236, 10, 5);
  K.txt(c, '灵感城', 254, 210, { size: 14, wt: 700, font: K.CJK, col: C.mute });
}

export function build(ctx) {
  const { world, ev } = ctx, scene = world.scene;
  ctx.fx = { flash: 0 };
  const mat = (col, r = .5, extra = {}) => new THREE.MeshStandardMaterial({ color: col, roughness: r, ...extra });

  // cards
  const cv = {}, cd = {}, state = {};
  const mk = (n, draw, init) => { const d = CARDS[n], [c, x] = K.canvas(d.w * 1000, d.h * 1000, 3.4); cv[n] = x; draw(x, init); state[n] = JSON.stringify(init); const g = card(world, c, d.w, d.h, d.thick); g.position.copy(d.c); g.rotation.y = d.yaw; scene.add(g); cd[n] = g; };
  const re = (n, draw, st) => { const k = JSON.stringify(st); if (k === state[n]) return; state[n] = k; draw(cv[n], st); cd[n].userData.redraw(); };
  mk('note', drawNote, {}); mk('book', drawBook, {});
  cd.note.children[0].material.color.set(C.lemon);

  // the tower (a desk organiser): base slab, a drawer layer, a printed lid; the drawer slides out towards the camera
  const tower = new THREE.Group(); tower.position.copy(TW.c); scene.add(tower);
  { const base = new THREE.Mesh(rbox(TW.w, TW.base, TW.d, .008), mat(C.card, .7)); base.position.y = TW.base / 2; tower.add(base);
    const back_ = new THREE.Mesh(rbox(TW.w, TW.mid, .012, .004), mat('#ece9f6', .7)); back_.position.set(0, TW.base + TW.mid / 2, -TW.d / 2 + .006); tower.add(back_);
    for (const sx of [-1, 1]) { const s = new THREE.Mesh(rbox(.012, TW.mid, TW.d, .004), mat('#ece9f6', .7)); s.position.set(sx * (TW.w / 2 - .006), TW.base + TW.mid / 2, 0); tower.add(s); }
    const lid = new THREE.Mesh(rbox(TW.w, TW.lid, TW.d, .006), mat(C.card, .7)); lid.position.y = TW.base + TW.mid + TW.lid / 2; tower.add(lid);
    const [c, x] = K.canvas(420, 320, 3); K.cardBase(x, 420, 320, 'drawer', '抽屉', { headH: 92, tagSize: 20, cnSize: 30 });
    for (let i = 0; i < 4; i++) { x.fillStyle = 'rgba(128,122,150,.22)'; K.rr(x, 28, 130 + i * 40, 220 - i * 30, 12, 6); x.fill(); }
    const top = new THREE.Mesh(new THREE.PlaneGeometry(TW.w - .01, TW.d - .01), new THREE.MeshStandardMaterial({ map: world.tex(c), transparent: true, roughness: .8 })); top.rotation.x = -Math.PI / 2; top.position.y = TW.base + TW.mid + TW.lid + .0003; top.receiveShadow = true; tower.add(top);
    tower.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); }
  const drawer = new THREE.Group(); tower.add(drawer);
  { const floor = new THREE.Mesh(rbox(TRAY.w, TRAY.floor, TRAY.d, .0015), mat('#ddd8ee', .8)); floor.position.y = TW.base + .002 + TRAY.floor / 2; drawer.add(floor);
    const [c, x] = K.canvas(380, 290, 3); drawCity(x);
    const print = new THREE.Mesh(new THREE.PlaneGeometry(TRAY.w - .004, TRAY.d - .004), new THREE.MeshStandardMaterial({ map: world.tex(c), roughness: .85 })); print.rotation.x = -Math.PI / 2; print.position.y = FLOOR_Y + .0002; print.receiveShadow = true; drawer.add(print);
    for (const sx of [-1, 1]) { const s = new THREE.Mesh(rbox(.005, TRAY.wall, TRAY.d, .002), mat('#f1eff8', .7)); s.position.set(sx * (TRAY.w / 2 - .0025), TW.base + .002 + TRAY.wall / 2, 0); drawer.add(s); }
    const bk = new THREE.Mesh(rbox(TRAY.w, TRAY.wall, .005, .002), mat('#f1eff8', .7)); bk.position.set(0, TW.base + .002 + TRAY.wall / 2, -TRAY.d / 2 + .0025); drawer.add(bk);
    const front = new THREE.Mesh(rbox(TW.w - .004, TW.mid - .004, .01, .004), mat('#f6f4fb', .6)); front.position.set(0, TW.base + TW.mid / 2, TW.d / 2 - .002); drawer.add(front);
    const knob = new THREE.Mesh(rbox(.07, .014, .012, .005), mat(C.accent, .45)); knob.position.set(0, TW.base + TW.mid / 2, TW.d / 2 + .008); drawer.add(knob);
    drawer.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); }
  const trayAt = (x, z, y = FLOOR_Y) => V(x, y, z + drawer.position.z).add(TW.c);   // drawer-local → world (the tower has no yaw)

  // the city: rounded blocks in sky, lilac and white, with front windows and skylights that light one per 16th
  const BLD = [];
  { const SPOT = V(-.03, 0, .07);   // where the bulb lands
    for (let gx = 0; gx < 5; gx++) for (let gz = 0; gz < 4; gz++) {
      const x = -.152 + gx * .076, z = -.105 + gz * .07;
      if (x > .02 && z > .02) continue;                                  // plaza and runway
      if (Math.abs(x - SPOT.x) < .05 && Math.abs(z - SPOT.z) < .04) continue;   // the bulb's landing square
      const k = BLD.length, hh = .016 + hash(k * 3.7 + 1) * .03 + (gz === 0 ? .006 : 0), fw = .044 + hash(k * 1.3) * .012, fd = .04 + hash(k * 2.1) * .012;
      BLD.push({ x, z, h: Math.min(.05, hh), fw, fd, col: [C.sky, '#b9aef0', '#f7f6fc', '#8fcbee', '#cfc7f5'][k % 5], d: Math.hypot(x - SPOT.x, z - SPOT.z) });
    }
    BLD.sort((a, b2) => a.d - b2.d).forEach((o, k) => o.order = k); }
  const city = new THREE.Group(); drawer.add(city);
  const winList = [];
  for (const o of BLD) {
    const m = new THREE.Mesh(rbox(o.fw, o.h, o.fd, .004), mat(o.col, .55)); m.position.set(o.x, FLOOR_Y + o.h / 2, o.z); m.castShadow = m.receiveShadow = true; city.add(m);
    const rows = Math.max(1, Math.floor((o.h - .006) / .011));
    for (let r = 0; r < rows; r++) for (let cI = 0; cI < 2; cI++) winList.push({ p: V(o.x - o.fw * .22 + cI * o.fw * .44, FLOOR_Y + .007 + r * .011, o.z + o.fd / 2 + .0006), face: 'z', o });
    winList.push({ p: V(o.x, FLOOR_Y + o.h + .0006, o.z), face: 'y', o });
  }
  const winGeo = new THREE.PlaneGeometry(1, 1), winMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });
  const wins = new THREE.InstancedMesh(winGeo, winMat, winList.length); city.add(wins);
  { const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    winList.forEach((w, i) => { if (w.face === 'y') { q.setFromAxisAngle(V(1, 0, 0), -Math.PI / 2); s.set(w.o.fw * .5, w.o.fd * .5, 1); } else { q.identity(); s.set(.0085, .0065, 1); } m4.compose(w.p, q, s); wins.setMatrixAt(i, m4); }); }
  const WIN_OFF = new THREE.Color('#9a93bd'), WIN_ON = new THREE.Color('#ffe08a'), WIN_ACC = new THREE.Color(C.accent);
  let winState = '';
  const drawWins = n => { if (winState === n) return; winState = n; winList.forEach((w, i) => wins.setColorAt(i, w.o.order < n ? (w.face === 'y' && w.o.order === 0 ? WIN_ACC : WIN_ON) : WIN_OFF)); wins.instanceColor.needsUpdate = true; };
  drawWins(0);
  // little cars on the streets (busy stop)
  const cars = [0, 1, 2].map(k => { const m = new THREE.Mesh(rbox(.014, .008, .009, .003), mat([C.apricot, C.lemon, '#f7f6fc'][k], .5)); m.castShadow = true; city.add(m); return m; });

  // the paper plane: a dart (nose +z), white paper, flat-shaded folds
  const plane = new THREE.Group(); scene.add(plane);
  const planeBody = new THREE.Group(); plane.add(planeBody);
  { const L = .072, tz = -.07, tipX = .056, tipY = .014, keel = -.022;
    const P = [[0, 0, L], [0, 0, tz], [-tipX, tipY, tz], [tipX, tipY, tz], [0, keel, tz]];
    const tri = (a, b2, c2) => [...P[a], ...P[b2], ...P[c2]];
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([...tri(0, 2, 1), ...tri(0, 1, 3), ...tri(0, 1, 4)], 3)); g.computeVertexNormals();
    const pm = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#f2f5ff', roughness: .85, side: THREE.DoubleSide, flatShading: true })); pm.castShadow = pm.receiveShadow = true; planeBody.add(pm);
    // a thin ink edge on every fold, so the white dart reads against the lilac mat and the warm desk
    const inkM = new THREE.MeshStandardMaterial({ color: C.ink, roughness: .6 });
    for (const [a, b2] of [[0, 2], [0, 3], [2, 1], [1, 3], [0, 4], [4, 1]]) { const pa = V(...P[a]), pb = V(...P[b2]), d = pb.clone().sub(pa);
      const e = new THREE.Mesh(new THREE.CylinderGeometry(.00075, .00075, d.length(), 6), inkM); e.position.copy(pa).add(pb).multiplyScalar(.5); e.quaternion.setFromUnitVectors(YAX, d.normalize()); planeBody.add(e); }
    const crease = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([V(0, .0006, L), V(0, .0006, tz)]), new THREE.MeshBasicMaterial({ color: C.accent }));
    const line = new THREE.Line(crease.geometry, new THREE.LineBasicMaterial({ color: C.accent })); planeBody.add(line);
    // a violet stripe on each wing (the print that tells it apart)
    const sg = new THREE.BufferGeometry(); const sp = []; for (const sx of [-1, 1]) { const a = [0, .0007, L * .2], bb = [sx * tipX * .86, tipY * .86 + .0007, tz * .9], cc = [sx * tipX * .7, tipY * .7 + .0007, tz * .95]; sp.push(...a, ...(sx > 0 ? [...cc, ...bb] : [...bb, ...cc])); }
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); sg.computeVertexNormals();
    planeBody.add(new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ color: C.accent, roughness: .7, side: THREE.DoubleSide }))); }
  const KEEL = .022;

  // the bulb: a 12 × 15 voxel toy; its glass glows (emission per cell: only the warm cells)
  const bulb = makeMonster(toArt(BULB, BPAL), .006, 'bulb', .9); scene.add(bulb.root);
  { const bm = bulb.mesh.material; bm.emissive = new THREE.Color('#ffd36a'); bm.emissiveIntensity = 0;
    bm.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n totalEmissiveRadiance *= step(vColor.b, 0.2) * (0.6 + vColor.rgb);\n#endif'); }; }
  const glowL = new THREE.PointLight(0xffd27a, 0, .22, 2); scene.add(glowL);
  const halo = (() => { const [c, x] = K.canvas(128, 128, 1); const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,226,140,.9)'); g.addColorStop(.35, 'rgba(255,214,110,.35)'); g.addColorStop(1, 'rgba(255,214,110,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(.095, .095), new THREE.MeshBasicMaterial({ map: world.tex(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); m.renderOrder = 4; scene.add(m); return m; })();

  // title tent beside the note
  const tent = new THREE.Group(); scene.add(tent);
  const TENT = { w: .17, h: .062, lean: .2 };
  { const [c, x] = K.canvas(680, 248, 2); x.fillStyle = C.card; x.fillRect(0, 0, 680, 248); K.grain(x, 680, 248, 9, 3000); x.fillStyle = C.accent; x.fillRect(0, 0, 16, 248);
    K.txt(x, '灵感送达', 52, 102, { size: 112, wt: 900, font: K.CJK, ls: 10 }); K.txt(x, 'IDEA · DELIVERED', 58, 200, { size: 38, wt: 600, col: C.accent, ls: 8 });
    const face = new THREE.MeshStandardMaterial({ map: world.tex(c), roughness: .8 }), plain = new THREE.MeshStandardMaterial({ color: C.card, roughness: .85 });
    const f = new THREE.Mesh(new THREE.BoxGeometry(TENT.w, TENT.h, .0012), [plain, plain, plain, plain, face, plain]), bk = new THREE.Mesh(new THREE.BoxGeometry(TENT.w, TENT.h, .0012), plain);
    const dz = Math.sin(TENT.lean) * TENT.h / 2, hy = Math.cos(TENT.lean) * TENT.h / 2;
    f.position.set(0, hy, dz); f.rotation.x = -TENT.lean; bk.position.set(0, hy, -dz); bk.rotation.x = TENT.lean; f.castShadow = bk.castShadow = f.receiveShadow = true; tent.add(f, bk);
    tent.position.set(-.99, 0, .33); tent.rotation.y = .55; }

  // the end title: a large paper card that falls onto the open middle of the desk on beat 34 and lies still to the last frame
  const TITLE = { c: V(.03, 0, .31), w: .52, h: .25, thick: .005 };
  const title = (() => { const [c, x] = K.canvas(520, 250, 3.4); K.cardBase(x, 520, 250, null, null); x.fillStyle = C.accent; K.rr(x, 0, 0, 18, 250, 9); x.fill();
    K.txt(x, '灵感送达', 54, 106, { size: 104, wt: 900, font: K.CJK, ls: 8 });
    K.txt(x, 'IDEA · DELIVERED', 58, 200, { size: 26, wt: 600, col: C.accent, ls: 6 });
    K.tick(x, 470, 196, 40, C.green, 9);
    const g = card(world, c, TITLE.w, TITLE.h, TITLE.thick); g.position.copy(TITLE.c); scene.add(g); return g; })();

  // the desk lamp (back left): a weighted base, two arms, a cone head with a warm bulb; it clicks on at beat 1
  const lamp = new THREE.Group(); scene.add(lamp);
  const lampHead = new THREE.Group();
  const lampBulbM = new THREE.MeshStandardMaterial({ color: '#fff3d6', emissive: '#ffd690', emissiveIntensity: 0, roughness: .3 });
  { const lm = mat('#3b3550', .35, { metalness: .2 }), base = new THREE.Mesh(new THREE.CylinderGeometry(.075, .085, .018, 40), lm); base.position.copy(LAMP.base).setY(.009); lamp.add(base);
    const elbow = V(LAMP.base.x + .03, .3, LAMP.base.z + .02);
    const rod = (a, b2) => { const d = b2.clone().sub(a), m = new THREE.Mesh(new THREE.CylinderGeometry(.007, .007, d.length(), 14), lm); m.position.copy(a).add(b2).multiplyScalar(.5); m.quaternion.setFromUnitVectors(YAX, d.clone().normalize()); lamp.add(m); };
    rod(V(LAMP.base.x, .018, LAMP.base.z), elbow); rod(elbow, LAMP.head);
    const j = new THREE.Mesh(new THREE.SphereGeometry(.012, 16, 12), lm); j.position.copy(elbow); lamp.add(j);
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(.022, .07, .085, 40, 1, true), new THREE.MeshStandardMaterial({ color: C.apricot, roughness: .5, side: THREE.DoubleSide })); lampHead.add(cone);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(.024, 20, 12, 0, 6.29, 0, 1.6), cone.material); cap.position.y = .04; lampHead.add(cap);
    const bulbM = new THREE.Mesh(new THREE.SphereGeometry(.026, 20, 14), lampBulbM); bulbM.position.y = -.025; lampHead.add(bulbM);
    lampHead.position.copy(LAMP.head); lampHead.lookAt(CARDS.note.c); lampHead.rotateX(-Math.PI / 2); lamp.add(lampHead);
    lamp.traverse(o => { if (o.isMesh) o.castShadow = true; }); }
  const spot = new THREE.SpotLight(0xffd59a, 0, 1.6, .55, .85, 1.2); spot.position.copy(LAMP.head); spot.target.position.copy(CARDS.note.c).add(V(.02, 0, .02)); scene.add(spot, spot.target);
  const pool = (() => { const [c, x] = K.canvas(256, 256, 1); const g = x.createRadialGradient(128, 128, 0, 128, 128, 128); g.addColorStop(0, 'rgba(255,214,150,.55)'); g.addColorStop(.6, 'rgba(255,214,150,.18)'); g.addColorStop(1, 'rgba(255,214,150,0)'); x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(.62, .5), new THREE.MeshBasicMaterial({ map: world.tex(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity: 0 })); m.rotation.set(-Math.PI / 2, 0, .3); m.position.copy(CARDS.note.c).add(V(-.03, .0062, -.02)); m.renderOrder = 1; scene.add(m); return m; })();

  // props: a pen and an eraser in front, a lemon note pad by the lamp, a mug with steam, the stamp on its ink pad
  {
    const pen = new THREE.Group(); const body = new THREE.Mesh(new THREE.CylinderGeometry(.0065, .0065, .16, 20), mat('#3b3550', .35)); body.rotation.z = Math.PI / 2; pen.add(body);
    const cap_ = new THREE.Mesh(new THREE.CylinderGeometry(.0072, .0072, .05, 20), mat(C.accent, .4)); cap_.rotation.z = Math.PI / 2; cap_.position.x = -.06; pen.add(cap_);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(.0065, .02, 20), mat('#c9ccd4', .3, { metalness: .6 })); tip.rotation.z = -Math.PI / 2; tip.position.x = .09; pen.add(tip);
    pen.position.set(-.33, .0065, .52); pen.rotation.y = .32; pen.traverse(o => o.castShadow = true); scene.add(pen);
    const er = new THREE.Mesh(rbox(.05, .014, .022, .004), mat(C.apricot, .7)); er.position.set(.24, .007, .55); er.rotation.y = -.4; er.castShadow = true; scene.add(er);
    for (let i = 0; i < 5; i++) { const n = new THREE.Mesh(rbox(.11, .0016, .11, .002), mat(i === 4 ? '#f6d977' : C.lemon, .85)); n.position.set(-1.12, .0008 + i * .0016, -.12); n.rotation.y = .2 + i * .04; n.castShadow = n.receiveShadow = true; scene.add(n); }
    const mug = new THREE.Group(); const cup = new THREE.Mesh(new THREE.CylinderGeometry(.05, .046, .1, 40, 1, true), mat(C.sky, .45, { side: THREE.DoubleSide })); cup.position.y = .05; mug.add(cup);
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(.046, 40), mat(C.sky, .45)); bottom.rotation.x = -Math.PI / 2; bottom.position.y = .002; mug.add(bottom);
    const coffee = new THREE.Mesh(new THREE.CircleGeometry(.047, 40), mat('#6b4a32', .25)); coffee.rotation.x = -Math.PI / 2; coffee.position.y = .085; mug.add(coffee);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(.025, .007, 12, 24, Math.PI), mat(C.sky, .45)); handle.rotation.z = -Math.PI / 2; handle.position.set(.05, .05, 0); mug.add(handle);
    mug.position.copy(MUG); mug.rotation.y = 2.1; mug.traverse(o => o.castShadow = o.receiveShadow = true); scene.add(mug);
    const ink = new THREE.Group(); const box = new THREE.Mesh(rbox(.2, .014, .14, .005), mat('#3b3550', .5)); box.position.y = .007; ink.add(box);
    const felt = new THREE.Mesh(rbox(.18, .003, .12, .002), mat('#2f8a63', .9)); felt.position.y = .0145; ink.add(felt);
    ink.position.copy(PAD); ink.rotation.y = -.15; ink.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } }); scene.add(ink);
  }
  // the stamp: a dark block with green rubber and an apricot knob; origin at the bottom of the rubber
  const stamp = new THREE.Group(); scene.add(stamp);
  { const rub = new THREE.Mesh(rbox(.15, .008, .1, .003), mat(C.green, .8)); rub.position.y = .004; stamp.add(rub);
    const blk = new THREE.Mesh(rbox(.16, .03, .11, .006), mat('#3b3550', .45)); blk.position.y = .023; stamp.add(blk);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(.014, .02, .05, 20), mat('#c98a5a', .5)); neck.position.y = .062; stamp.add(neck);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(.03, 24, 16), mat(C.apricot, .45)); knob.position.y = .1; knob.scale.y = .85; stamp.add(knob);
    stamp.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } }); }
  const STAMP_REST = PAD.clone().setY(.016), STAMP_HIT = at('book', 250, 196, CARDS.book.thick + .0006);
  // steam over the mug: small translucent cubes rising and fading in a loop
  const steam = new THREE.InstancedMesh(rbox(.012, .012, .012, .004), new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: .55, roughness: .9 }), 9); scene.add(steam);

  // soft window light on the desk (warm, additive)
  { const [c, x] = K.canvas(512, 512, 1); x.filter = 'blur(26px)'; x.fillStyle = 'rgba(255,236,205,1)';
    for (const [a, b2] of [[60, 60], [270, 60], [60, 270], [270, 270]]) x.fillRect(a, b2, 180, 180); x.filter = 'none';
    const lm = new THREE.MeshBasicMaterial({ map: world.tex(c), transparent: true, opacity: .18, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    for (const [px, pz, s, r] of [[-.3, .3, 1.0, .5], [.9, -.2, .9, .5]]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s * .8), lm); m.rotation.set(-Math.PI / 2, 0, r); m.position.set(px, .0003, pz); m.renderOrder = 1; scene.add(m); } }

  // ── the flight: rest in the drawer → over the mug (barrel roll) → down onto the notebook ──
  const REST = () => trayAt(.1, .068, FLOOR_Y + KEEL);
  const LAND = at('book', 300, 190, CARDS.book.thick + KEEL);
  const restW = trayAt(.1, .068 + 0, FLOOR_Y + KEEL); restW.z = TW.c.z + TW.open + .068;   // the drawer is fully open by then
  const FLY = new THREE.CatmullRomCurve3([restW, V(.17, .17, restW.z - .005), V(.31, .25, -.07), V(.45, .275, -.12), V(.61, .21, -.01), V(.71, .1, .14), LAND.clone()], false, 'centripetal');   // over the mug's centre, well clear of its rim
  const flyU = t => { const p = seg(t, T.launch, T.tap1); return lerp(p, 1 - Math.pow(1 - p, 2.2), .7); };
  const trail = new THREE.InstancedMesh(new THREE.SphereGeometry(.0042, 10, 8), new THREE.MeshStandardMaterial({ color: C.accent, roughness: .4, emissive: C.accent, emissiveIntensity: .3 }), 46); scene.add(trail);

  // impact rings (violet; the stamp's is green)
  const RINGS = [{ t: T.bulbPop, p: at('note', 140, 160, .0012), s: .25, col: C.accent }, { t: T.planePop, p: REST().setY(FLOOR_Y + .001), s: .22, col: C.accent, drawer: 1 },
    { t: T.tap1, p: LAND.clone().setY(CARDS.book.thick + .0012), s: .3, col: C.accent }, { t: T.slam, p: STAMP_HIT.clone().setY(CARDS.book.thick + .0012), s: .8, col: C.green },
    { t: T.titleDrop[1], p: TITLE.c.clone().setY(.0012), s: .9, col: C.accent }];
  const rings = RINGS.map(r => { const m = new THREE.Mesh(new THREE.RingGeometry(.96, 1, 96), new THREE.MeshBasicMaterial({ color: r.col, transparent: true, depthWrite: false, fog: false })); m.rotation.x = -Math.PI / 2; m.renderOrder = 2; scene.add(m); return { m, r }; });
  // paper confetti squeezed out by the stamp
  const DEB = [...Array(26)].map((_, k) => { const a = k / 26 * Math.PI * 2 + hash(k) * .4; return { dir: V(Math.cos(a), 0, Math.sin(a) * .75), sp: .16 + hash(k * 3.1) * .2, up: .3 + hash(k * 7.7) * .4, col: [C.lemon, '#b9aef0', '#fdfcff', C.green, C.sky][k % 5] }; });
  const debris = new THREE.InstancedMesh(rbox(.007, .007, .007, .0014), new THREE.MeshStandardMaterial({ roughness: .5 }), DEB.length); debris.castShadow = true; scene.add(debris);
  DEB.forEach((d, k) => debris.setColorAt(k, new THREE.Color(d.col)));

  // ── the bulb's path ──
  const NOTE_SPOT = at('note', 140, 168);
  const D1 = V(-.48, 0, .12), D2 = V(-.29, 0, .09);
  const CITY_SPOT = () => trayAt(-.03, .07);
  const bulbHops = () => [
    { t0: T.hop1[0], t1: T.hop1[1], from: NOTE_SPOT, to: D1, h: .1 },
    { t0: T.hop2[0], t1: T.hop2[1], from: D1, to: D2, h: .07 },
    { t0: T.hop3[0], t1: T.hop3[1], from: D2, to: CITY_SPOT(), h: .16 },
  ];
  const ON_PLANE = V(0, .0012, -.018);
  const ASIDE = at('book', 120, 205);

  // ── text meant to be read ──
  const uv = (n, u0, v0, u1, v1) => () => [at(n, u0, v0), at(n, u1, v0), at(n, u0, v1), at(n, u1, v1)];
  const tentBox = (y0, y1) => () => { const f = tent.children[0]; f.updateMatrixWorld(); return [[-.5, y0], [.5, y0], [-.5, y1], [.5, y1]].map(([x, y]) => V(x * TENT.w, (.5 - y) * TENT.h, .0007).applyMatrix4(f.matrixWorld)); };
  ctx.read = [
    ['title', '灵感送达', 0, 2.5, tentBox(.1, .62)],
    ['note', '灵感？', 1.2, 3.5, uv('note', 20, 190, 270, 285)],
    ['stamp', '已送达', T.stampBack[0] + .07, DUR + 1, uv('book', 100, 134, 400, 258)],
    ['title', '灵感送达', T.titleDrop[1], DUR + 1, () => [[40, 40], [460, 40], [40, 150], [460, 150]].map(([u, v]) => V(u / 1000 - TITLE.w / 2, TITLE.thick, v / 1000 - TITLE.h / 2).add(title.position))],
  ];

  // ── sound events ──
  const blinks = [];   // the bulb blinks every couple of seconds while awake
  for (let k = 0; k < 9; k++) { const tb = Math.round((4.0 + k * 1.75 + hash(k * 9.1) * .3) / S16) * S16;   /* blinks sit on the 16th grid too */ if (tb < DUR - .3 && !(tb > T.silence[0] && tb < T.launch)) blinks.push(tb); }
  ev.push({ t: T.lampOn, type: 'lamp' }, { t: T.bulbPop, type: 'pop', k: 0, big: 1 }, { t: T.qFlash, type: 'qflash' },
    ...['hop1', 'hop2', 'hop3'].flatMap((h, i) => [{ t: T[h][0], type: i === 2 ? 'jump' : 'hop', k: i }, { t: T[h][1], type: 'land', v: i === 2 ? .45 : .35 }]),
    { t: T.drawerOpen[0], type: 'drawer', d: T.drawerOpen[1] - T.drawerOpen[0] },
    { t: T.bulbLight, type: 'glow' }, ...BLD.map((o, k) => ({ t: T.windows[0] + k * S16, type: 'win', k })),
    { t: T.hop4[0], type: 'hop', k: 3 }, { t: T.hop4[1], type: 'land', v: .3 }, { t: T.planePop, type: 'pop', k: 2 },
    { t: T.creak, type: 'creak' }, { t: T.launch, type: 'launch' }, { t: T.roll[0], type: 'roll', d: T.roll[1] - T.roll[0] },
    { t: T.tap1, type: 'tap', k: 0 }, { t: T.tap2, type: 'tap', k: 1 },
    { t: T.hop5[0], type: 'hop', k: 4 }, { t: T.hop5[1], type: 'land', v: .35 },
    { t: T.stampUp[0], type: 'jump', k: 9 }, { t: b(31.5), type: 'drop' }, { t: T.slam, type: 'slam' },
    { t: T.stampBack[0], type: 'hop', k: 5 }, { t: T.stampBack[1], type: 'land', v: .7 },
    { t: T.titleDrop[0], type: 'tdrop', d: T.titleDrop[1] - T.titleDrop[0] }, { t: T.titleDrop[1], type: 'title' },
    ...HIT.cc.map((bb, k) => ({ t: b(bb), type: 'cc', k })),
    ...blinks.map(t => ({ t, type: 'blink' })));
  ev.sort((a, b2) => a.t - b2.t);

  // ── subjects for the camera ──
  const bulbPos = () => { const p = new THREE.Vector3(); bulb.root.getWorldPosition(p); return p; };
  Object.assign(ctx.subj, {
    tent: () => tent.position.clone().add(V(.03, .03, .02)),
    open: () => tent.position.clone().lerp(CARDS.note.c, .55).add(V(0, .03, 0)),
    note: () => at('note', 140, 190, .02),
    bulb: () => bulbPos().add(V(0, .035, 0)),
    drawerFront: () => V(TW.c.x - .06, .05, TW.c.z + TW.d / 2 + .05),
    city: () => trayAt(0, .02, .045),
    plane: () => plane.position.clone().add(V(0, .02, 0)),
    land: () => at('book', 230, 175, .02),
    final: () => V(.02, 0, -.02),
  });

  // ── per frame ──
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), tmp = new THREE.Vector3();
  const tq = Math.round;   // canvas states are quantised
  return t => {
    // cards
    re('note', drawNote, { q: tq(Math.max(0, Math.sin(Math.PI * seg(t, T.qFlash, T.qFlash + .4))) * 8) / 8 });
    re('book', drawBook, t >= T.slam ? { stamp: t >= T.stampBack[0] ? 1 : .0001 } : {});

    // lamp: clicks on at beat 1 (a quick flicker), blinks once in the curtain call
    { let on = t >= T.lampOn ? 1 : 0; if (t > T.lampOn && t < T.lampOn + .1) on = (Math.floor((t - T.lampOn) / .033) % 2) ? .3 : 1;
      const cc = b(HIT.cc[2]); if (t > cc && t < cc + .2) on = .15;
      lampBulbM.emissiveIntensity = 2.2 * on; spot.intensity = .32 * on; pool.material.opacity = .5 * on; }

    // tower: the drawer slides out at beat 11.5 → 12, stays open
    drawer.position.z = TW.open * back(seg(t, T.drawerOpen[0], T.drawerOpen[1]), 1.2);
    // windows light one per 16th from the bulb outwards
    drawWins(t < T.windows[0] ? 0 : Math.min(BLD.length, 1 + Math.floor((t - T.windows[0]) / S16 + 1e-6)));
    cars.forEach((m, k) => { const u = ((t * .05 + k * .37) % 1), lane = k % 2; const z = lane ? -.105 + .19 * 0 + .086 * 0 : 0;
      if (k === 0) m.position.set(-.19 + u * .38, FLOOR_Y + .004, -.145 + .086 - .0); else if (k === 1) m.position.set(-.072 - .0, FLOOR_Y + .004, .145 - u * .29); else m.position.set(.19 - u * .38, FLOOR_Y + .004, -.145 + .168);
      m.rotation.y = k === 1 ? Math.PI / 2 : 0; m.visible = drawer.position.z > .05; });

    // the plane: printed flat on the runway → pops up at beat 20 → crouches in the silence → launches at beat 24 → rolls → taps twice → pressed into print
    {
      let pos, dir = V(1, 0, 0), sy = 1, roll = 0, bank = 0, pitch = 0;
      const pp = pop(t, T.planePop, .4, .03);
      sy = t < T.planePop ? .04 : Math.max(.04, pp.hinge) * pp.sq;
      if (t < T.launch) {
        pos = REST(); pos.y = FLOOR_Y + KEEL * sy + pp.y;
        const crouch = ss(seg(t, T.silence[0], T.creak + .2)) * (1 - ei(seg(t, T.launch - .1, T.launch)));
        const tremble = t > T.creak && t < T.launch ? .0012 * Math.sin(t * 83) * ss(seg(t, T.creak, T.launch - .2)) : 0;   // the paper strains under the load
        pos.x -= .036 * crouch + tremble; pitch = -.36 * crouch; sy *= 1 - .2 * crouch;
      } else if (t < T.tap1) {
        const u = flyU(t); pos = FLY.getPointAt(u); dir = FLY.getTangentAt(u);
        const d1 = FLY.getTangentAt(Math.min(1, u + .02)), d0 = FLY.getTangentAt(Math.max(0, u - .02));
        bank = clamp(-(Math.atan2(d1.x, d1.z) - Math.atan2(d0.x, d0.z)) * 6, -.6, .6);
        roll = Math.PI * 2 * eio(seg(t, T.roll[0], T.roll[1]));
      } else {
        pos = LAND.clone(); dir = FLY.getTangentAt(1).setY(0).normalize();
        const d = t - T.tap1; if (d < T.tap2 - T.tap1) pos.y += .024 * arc(d / (T.tap2 - T.tap1));
        const sl = seg(t, T.slam - .02, T.slam + .03); sy = 1 - .96 * sl; pos.y = CARDS.book.thick + KEEL * sy + (d < T.tap2 - T.tap1 ? .024 * arc(d / (T.tap2 - T.tap1)) : 0);
        const ls = t - T.tap2; if (ls > 0 && ls < .2) sy *= 1 - .18 * Math.sin(Math.PI * ls / .2);
      }
      plane.position.copy(pos); tmp.copy(pos).add(dir); plane.up.set(0, 1, 0); plane.lookAt(tmp); plane.rotateZ(bank + roll); plane.rotateX(pitch);
      planeBody.scale.set(1, sy, 1);
      plane.visible = t < T.stampBack[0] + .02;   // after the press it lives on as the stamp's print
      // trail: violet dots where the plane has been
      const u = t < T.launch ? 0 : flyU(Math.min(t, T.tap1)), fade = 1 - ss(seg(t, T.slam, T.slam + .6));
      for (let k = 0; k < 46; k++) { const uk = (k + .5) / 46; const on = u > uk ? Math.min(1, (u - uk) * 30) * fade : 0; const p = FLY.getPointAt(uk); m4.compose(p.setY(p.y - .012), q.identity(), V(1, 1, 1).multiplyScalar(Math.max(1e-4, on))); trail.setMatrixAt(k, m4); }
      trail.instanceMatrix.needsUpdate = true;
    }

    // the bulb
    {
      const P0 = pop(t, T.bulbPop, .42, .05), H = hops(t, bulbHops(), NOTE_SPOT);
      let pos = H.pos.clone(), yaw = .15, e = P0.e, hinge = P0.hinge, sq = P0.sq * squash(t, H.lands, H.takeoffs, H.air), scale = 1, parent = scene;
      pos.y += P0.y;
      if (t > T.bulbPop + .45 && t < T.hop1[0]) { const bb = beatBounce(t, T.qFlash, T.hop1[0] - .08, .012); pos.y += bb.y; sq *= bb.sq; yaw = .15 + .45 * Math.sin(Math.PI * 2 * seg(t, T.qFlash, T.hop1[0] - .1)) ; }
      if (H.air !== null && H.dir) yaw = Math.atan2(H.dir.x, H.dir.z) * .5;
      if (t >= T.hop3[1] && t < T.hop4[0]) { hinge = 1 - .3 * ss(seg(t, T.hop3[1] + .15, T.hop3[1] + .45)) * (1 - ss(seg(t, T.hop4[0] - .22, T.hop4[0]))); pos = CITY_SPOT(); const bb = beatBounce(t, T.hop3[1] + .1, T.hop4[0] - .06, .01); pos.y += bb.y; sq *= bb.sq * squash(t, [T.hop3[1]], [], null); yaw = -.35 + .7 * ss(seg(t, T.hop3[1] + .3, T.bulbLight)) - .2 * ss(seg(t, T.bulbLight + .5, T.hop4[0])); }
      if (t >= T.hop4[0] && t < T.hop4[1]) { const p = seg(t, ...T.hop4); const to = plane.localToWorld(ON_PLANE.clone()); pos = CITY_SPOT().lerp(to, lerp(p, ss(p), .5)); pos.y += .06 * arc(p); sq = squash(t, [], [T.hop4[0]], p); yaw = .9; }
      if (t >= T.hop4[1] && t < T.hop5[0]) {   // aboard: parented to the plane
        parent = plane; pos = ON_PLANE.clone();
        // the held breath: it turns to look down the runway (beat 21), then snaps round to us on the creak (beat 22) and crouches
        const look = eio(seg(t, T.silence[0], T.silence[0] + BEAT * .75)), back_ = back(seg(t, T.creak, T.creak + .16), 1.6);
        yaw = -Math.PI + (Math.PI - .15) * look * (1 - back_) + (Math.PI - 2.72) * back_ * (t >= T.creak ? 1 : 0);
        if (t >= T.launch) yaw = -2.72 + .45 * ss(seg(t, T.launch + .1, T.roll[0]));   // riding: turned towards the side camera
        const crouch = ss(seg(t, T.creak, T.creak + .35)) * (1 - ei(seg(t, T.launch - .1, T.launch)));
        sq = squash(t, [T.hop4[1], T.launch], [], null) * (1 - .18 * crouch) * (1 + .06 * look * (1 - back_));
        const ride = ss(seg(t, T.launch, T.launch + .25)) * (1 - ss(seg(t, T.tap1 - .3, T.tap1)));
        scale = 1 - .2 * ride; sq *= 1 - .08 * ride;   // tucked low against the fold while it flies
        if (t > T.planePop) { const pp = pop(t, T.planePop, .4, .03); pos.y += pp.y * .2; }
        if (t > T.tap1) yaw = -2.27 + .3 * ss(seg(t, T.tap1, T.hop5[0]));
      }
      if (t >= T.hop5[0]) { const p = seg(t, ...T.hop5); const from = plane.localToWorld(ON_PLANE.clone()); pos = from.lerp(ASIDE, lerp(p, ss(p), .5)); pos.y += .07 * arc(p); sq = squash(t, [T.hop5[1]], [T.hop5[0]], p < 1 ? p : null); yaw = .25;
        if (t > T.hop5[1] + .1) { const bb = beatBounce(t, T.hop5[1] + .15, b(HIT.cc[4]) - .05, .01); pos.y += bb.y; sq *= bb.sq; }
        const ccp = pop(t, b(HIT.cc[4]), .4, .05); if (t >= b(HIT.cc[4])) { scale = 1 + .3 * ss(seg(t, b(HIT.cc[4]), b(HIT.cc[4]) + .3)); pos.y += ccp.y; sq *= t < b(HIT.cc[4]) + .4 ? 1 + .2 * Math.sin(Math.PI * seg(t, b(HIT.cc[4]), b(HIT.cc[4]) + .4)) : 1; } }
      if (bulb.root.parent !== parent) parent.add(bulb.root);
      bulb.set({ pos, yaw, e, hinge, sq, scale });
      bulb.blink(blinks.some(tb => t > tb && t < tb + .12) || (t > T.slam - .03 && t < T.slam + .12) || (t > T.creak + .1 && t < T.creak + .24));
      // the glow: flickers into life at beat 16, stays lit
      const gl = t < T.bulbLight ? 0 : t < T.bulbLight + S16 ? 1 : t < T.bulbLight + 2 * S16 ? .25 : 1;
      const cc = t >= b(HIT.cc[4]) ? .4 * Math.max(0, 1 - (t - b(HIT.cc[4])) / .5) : 0;
      bulb.mesh.material.emissiveIntensity = (gl * .55 + cc) * (t > T.silence[0] && t < T.launch ? .75 : 1);
      const bp = new THREE.Vector3(); bulb.root.getWorldPosition(bp); bp.y += .05 * scale;
      glowL.position.copy(bp); glowL.intensity = .012 * gl + cc * .03;   // a faint warm kiss on what is right beside it, not a wash
      // the halo is a highlight, not a wash: faint, and set just behind the bulb so it never veils the glass
      halo.visible = gl > 0; halo.position.copy(bp).addScaledVector(tmp.copy(bp).sub(ctx.camera.position).normalize(), .035); halo.quaternion.copy(ctx.camera.quaternion); halo.material.opacity = .13 * gl + .5 * cc; halo.scale.setScalar(scale);
    }

    // the stamp: rests on its pad → leaps over the notebook → slams on the plane (beat 32) → holds → hops home
    {
      let p = STAMP_REST.clone(), sq = 1, tilt = 0;
      const hover = STAMP_HIT.clone().setY(.2);
      if (t >= T.stampUp[0] && t < T.stampUp[1]) { const u = seg(t, ...T.stampUp); p = STAMP_REST.clone().lerp(hover, eio(u)); p.y += .1 * arc(u); tilt = .3 * Math.sin(Math.PI * u); }
      else if (t >= T.stampUp[1] && t < T.slam) { const u = seg(t, b(31.5), T.slam); p = hover.clone(); p.y = lerp(.2, STAMP_HIT.y, ei(u)); if (t < b(31.5)) p.y = .2 + .006 * Math.sin((t - T.stampUp[1]) * 30); }
      else if (t >= T.slam && t < T.stampBack[0]) { p = STAMP_HIT.clone(); const d = t - T.slam; sq = 1 - .16 * Math.sin(Math.PI * Math.min(1, d / .16)) * (d < .16 ? 1 : 0); }
      else if (t >= T.stampBack[0] && t < T.stampBack[1]) { const u = seg(t, ...T.stampBack); p = STAMP_HIT.clone().lerp(STAMP_REST, eio(u)); p.y += .14 * arc(u); tilt = -.25 * Math.sin(Math.PI * u); }
      const dl = t - T.stampBack[1]; if (dl > 0 && dl < .2) sq = 1 - .12 * Math.sin(Math.PI * dl / .2);
      stamp.position.copy(p); stamp.rotation.set(tilt, -.12, 0); stamp.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    }
    // debris from the stamp
    DEB.forEach((d, k) => { const dt = t - T.slam; if (dt < 0 || dt > 2.0) { m4.compose(V(0, -1, 0), q, V(1e-4, 1e-4, 1e-4)); debris.setMatrixAt(k, m4); return; }
      const fl = Math.min(dt, .5), p = STAMP_HIT.clone().addScaledVector(d.dir, .07 + d.sp * fl + .04 * Math.max(0, dt - .5) * d.sp); p.y += .01 + d.up * fl - 1.5 * fl * fl; p.y = Math.max(CARDS.book.thick + .0035, p.y);
      q.setFromEuler(new THREE.Euler(dt * 6 * hash(k), dt * 4, 0)); const sc = 1 - ss(seg(dt, 1.4, 2.0)); m4.compose(p, q, V(sc, sc, sc).addScalar(1e-4)); debris.setMatrixAt(k, m4); });
    debris.instanceMatrix.needsUpdate = true;

    // curtain call: note, tower, (lamp blinks), notebook hop once, one 8th apart; the jolt on the slam
    { const hopY = tc => { const d = t - tc; return d > 0 && d < .27 ? .022 * arc(d / .27) : 0; };
      cd.note.position.y = hopY(b(HIT.cc[0])); tower.position.y = hopY(b(HIT.cc[1]));
      let j = 0; { const d = t - T.slam; if (d > 0 && d < .3) j = .003 * Math.sin(d * 60) * (1 - d / .3); }
      cd.book.position.set(CARDS.book.c.x + j, hopY(b(HIT.cc[3])), CARDS.book.c.z); }
    // steam over the mug
    for (let k = 0; k < 9; k++) { const u = ((t * .32 + k / 9) % 1); const p = MUG.clone().add(V(Math.sin(k * 2.3 + t * 1.1) * .012 * u, .095 + u * .12, Math.cos(k * 1.7) * .01)); const s = Math.sin(Math.PI * u) * (.6 + .4 * hash(k)); m4.compose(p, q.setFromEuler(new THREE.Euler(u * 2, k, 0)), V(s, s, s).addScalar(1e-4)); steam.setMatrixAt(k, m4); }
    steam.instanceMatrix.needsUpdate = true;
    // rings
    rings.forEach(({ m, r }) => { const d = t - r.t, on = d > 0 && d < 1.0; m.visible = on; if (on) { const s = .03 + d * r.s; m.scale.setScalar(s); m.material.opacity = .6 * (1 - d / 1.0); m.position.copy(r.p); if (r.drawer) m.position.copy(REST().setY(FLOOR_Y + .001)); } });
    tent.visible = true;
    // the end title falls (ease-in, a slight twist that settles) and then lies dead still
    { const u = seg(t, ...T.titleDrop), f = ei(u); title.visible = t >= T.titleDrop[0];
      title.position.set(TITLE.c.x, .34 * (1 - f), TITLE.c.z); title.rotation.set(.2 * (1 - f), .25 * (1 - f), -.1 * (1 - f)); }
  };
}
