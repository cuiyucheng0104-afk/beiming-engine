// evidence-b.js — 第 6–10 关的证据画面（画在 F.boardAnchor(i) 的证据板上）。
// 接口见 s4-gates.js 顶部：F.EVIDENCE[i] = { build(scene, anchor), seek(u, t), overlay(g, u, cam, t) }，u = 该关本地时间。
// 节奏（每关一致）：u=1.0 板上零件沿法线推出 → 1.5 / 2.0 / 2.5 逐拍加一层意思 → 3.0 结论锁定 → 3.5 完整可读；
//   u=4.0 起证据块飞走，板上内容保持；u≥4.9 叠层文字随板子离开画面淡出；3D 零件 u>7.2 隐藏。
// 数据全部取自 window.FILM_DATA（BIBLE 第 6 节），不改数。
// 共享小工具挂在 F.EB 下（只给本文件用）。
'use strict';
(function () {
const F = window.F;
F.EVIDENCE = F.EVIDENCE || [];
const D = window.FILM_DATA;
const C = F.C;
const EB = F.EB = {};
const G0 = i => F.GATE_T0 + i * F.GATE_LEN;
const FZ = .08;                                   // 板面前表面

// ─── 小工具 ────────────────────────────────────────────────────────────────
EB.emis = (hex, ei = 1, base = '#10151D') => new THREE.MeshStandardMaterial({ color: new THREE.Color(base), emissive: new THREE.Color(hex), emissiveIntensity: ei, roughness: .6 });
EB.lit = (hex, ei = .3) => new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), emissive: new THREE.Color(hex), emissiveIntensity: ei, roughness: .9, metalness: 0 });
EB.flat = hex => new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: .92, metalness: 0 });
EB.box = (w, h, d, m) => { const me = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); me.castShadow = true; me.receiveShadow = true; return me; };
// 矩形细框（四根条），中心在原点
EB.frame = (w, h, t, d, m) => {
  const g = new THREE.Group();
  for (const [bw, bh, x, y] of [[w, t, 0, h / 2 - t / 2], [w, t, 0, -h / 2 + t / 2], [t, h, w / 2 - t / 2, 0], [t, h, -w / 2 + t / 2, 0]]) {
    const b = EB.box(bw, bh, d, m); b.position.set(x, y, 0); g.add(b);
  }
  return g;
};
// 沿板面法线推出：u<t0 藏在板里（不可见），t0→t0+dur 推到原位
EB.home = (obj, x, y, z) => { obj.position.set(x, y, z); obj.userData.hz = z; return obj; };
EB.rise = (obj, u, t0, dur = .35, depth = .22) => {
  const k = F.easeOut((u - t0) / dur);
  obj.visible = u >= t0;
  obj.position.z = obj.userData.hz - depth * (1 - k);
  return k;
};
const _v = new THREE.Vector3();
EB.P = (anchor, cam, x, y, z = FZ + .06) => { _v.set(x, y, z).applyMatrix4(anchor.group.matrixWorld); return F.project(cam, _v); };
// 叠层文字：跟着板子走；靠近字幕区（y>775）或画面边缘时自动淡掉
EB.text = (g, anchor, cam, str, x, y, o = {}, alpha = 1, prog = 1) => {
  if (alpha * prog <= .004) return;
  const p = EB.P(anchor, cam, x, y, o.z ?? FZ + .06); if (!p) return;
  const fy = 1 - F.smooth((p.y - 772) / 26), fx = F.smooth((p.x + 40) / 80) * (1 - F.smooth((p.x - 1880) / 80));
  const a = alpha * fy * fx; if (a <= .004) return;
  F.label(g, str, p.x, p.y, Object.assign({ size: 24, weight: 500, color: C.ivory }, o, { alpha: a, prog }));
};
// 叠层总开关：u≥1 起可见，4.9→5.35 随板子移出画面淡出
EB.fadeOut = u => 1 - F.smooth((u - 4.9) / .45);
EB.inp = (u, t0, d = .35) => F.easeOut((u - t0) / d);
EB.flash = (u, t0, w = .3) => Math.max(0, 1 - Math.abs(u - t0) / w);
EB.root = anchor => { const r = new THREE.Group(); anchor.group.add(r); return r; };
EB.vis = (root, u) => { root.visible = u > .95 && u < 7.2; return root.visible; };

// ═══ 第六关 · 估价：收据 + 账本量规 ═════════════════════════════════════════
(function () {
  const i = 6, g0 = G0(i);
  const L = D.ledger, P = D.market.price;
  const reqs = [5, 4, 5, 6];                           // r1–r4 秒数（BIBLE 第 6 节 / 原理 4）
  const total = reqs.reduce((a, b) => a + b, 0);      // 20
  const peak = total * P.peak_yuan_per_s, off = total * P.offpeak_yuan_per_s;   // 1.40 / 1.00
  const RX0 = -2.05, RX1 = .85, RY0 = .45, RY1 = 2.62; // 收据范围
  const TX = -1.85;                                    // 文字左缘
  const ROW_PEAK = 1.42, ROW_OFF = .98;
  const GX = 1.12, GY0 = .64, GH = 1.72;                 // 量规
  let A, root, paper, paperPivot, bars = [], selFrame, selMat, peakStrike, gauge, fill, fillMat, ticks = [];
  F.EVIDENCE[i] = {
    build(scene, anchor) {
      A = anchor; root = EB.root(anchor);
      // 收据纸：从顶边向下展开
      paperPivot = new THREE.Group(); paperPivot.position.set((RX0 + RX1) / 2, RY1, FZ + .02); root.add(paperPivot);
      paper = F.block(RX1 - RX0, RY1 - RY0, .035, EB.flat('#F4EFE6'), .012); paper.position.y = -(RY1 - RY0) / 2; paperPivot.add(paper);
      // 顶部压条（收据夹）
      const clip = F.block(RX1 - RX0 + .12, .09, .08, F.mat.plasterShade, .02); clip.position.set(0, 0, .03); paperPivot.add(clip);
      // 4 个请求：按秒数成比例的青蓝条
      let x = TX;
      const barMat = EB.emis(C.teal, 1.1);
      for (const s of reqs) {
        const w = s * .1, b = EB.box(w - .04, .15, .05, barMat);
        EB.home(b, x + w / 2, 1.9, FZ + .08); root.add(b); bars.push({ b, x0: x, w }); x += w + .02;
      }
      // 高峰行的删除线（冷灰）
      peakStrike = EB.box(2.52, .018, .02, EB.flat(C.cold)); EB.home(peakStrike, TX + 1.26, ROW_PEAK - .025, FZ + .075); root.add(peakStrike);
      // 选中框：金色细框
      selMat = EB.emis(C.gold, 0, '#3A2E18');
      selFrame = EB.frame(2.86, .4, .03, .04, selMat); EB.home(selFrame, TX + 1.3, ROW_OFF - .01, FZ + .08); root.add(selFrame);
      // 量规：石膏外框 + 深色槽 + 刻度 + 青蓝液柱
      gauge = new THREE.Group(); EB.home(gauge, GX, GY0 + GH / 2, FZ + .05); root.add(gauge);
      const outer = F.block(.36, GH + .16, .07, F.mat.plaster, .03); gauge.add(outer);
      const groove = EB.box(.16, GH, .02, F.mat.ink); groove.position.z = .04; gauge.add(groove);
      for (let k = 0; k <= 6; k++) {                  // 每 ¥5 一格
        const tk = EB.box(k % 6 === 0 ? .14 : .09, .016, .02, F.mat.plasterDark); tk.position.set(-.18 - (k % 6 === 0 ? .07 : .045), -GH / 2 + GH * k / 6, .04); gauge.add(tk); ticks.push(tk);
      }
      fillMat = EB.emis(C.teal, 1.6);
      fill = EB.box(.14, GH * off / L.cap_yuan, .03, fillMat); gauge.add(fill);
      // 声音
      F.ev(g0 + 1.0, 'paper'); F.ev(g0 + 1.5, 'tick'); F.ev(g0 + 2.0, 'tick'); F.ev(g0 + 2.5, 'tick');
      F.ev(g0 + 3.0, 'lock'); F.ev(g0 + 3.5, 'tick');
    },
    seek(u) {
      if (!EB.vis(root, u)) return;
      paperPivot.scale.y = Math.max(.001, F.easeOut((u - 1.0) / .45));
      paperPivot.visible = u >= 1.0;
      bars.forEach((o, k) => { const kk = EB.rise(o.b, u, 1.5 + k * .06, .3); o.b.scale.x = Math.max(.001, kk); o.b.position.x = o.x0 + o.w * kk / 2; });
      const sel = EB.rise(selFrame, u, 3.0, .25, .15);
      selMat.emissiveIntensity = 1.3 * sel + 2.2 * EB.flash(u, 3.05, .3);
      const st = F.easeOut((u - 3.0) / .3); peakStrike.visible = st > 0; peakStrike.scale.x = Math.max(.001, st); peakStrike.position.x = TX + 1.26 * st;
      EB.rise(gauge, u, 1.0, .4);
      const fk = F.easeOut((u - 3.0) / .5);
      fill.visible = fk > 0; fill.scale.y = Math.max(.001, fk);
      fill.position.set(0, -GH / 2 + GH * off / L.cap_yuan * fk / 2, .05);
      fillMat.emissiveIntensity = 1.6 + 2 * EB.flash(u, 3.5, .3);
    },
    overlay(g, u, cam) {
      if (u < .9 || u > 5.5) return;
      const o = EB.fadeOut(u), T = (s, x, y, opt, t0) => EB.text(g, A, cam, s, x, y, opt, o, EB.inp(u, t0));
      T('plan', TX, 2.33, { mono: true, size: 26, weight: 600, color: C.teal, align: 'left' }, 1.25);
      T('4 个外部请求 · 全部支持', TX + .62, 2.33, { size: 24, align: 'left' }, 1.25);
      T(`共 ${total} 秒`, TX + 2.2, 1.9, { size: 22, color: '#D8E6E4', align: 'left' }, 1.75);
      const dim = 1 - .5 * F.smooth((u - 3.0) / .3);
      EB.text(g, A, cam, `${total} 秒 × 高峰 ¥${P.peak_yuan_per_s.toFixed(2)} = ¥${peak.toFixed(2)}`, TX, ROW_PEAK, { size: 26, color: '#C9CFD9', align: 'left' }, o * dim, EB.inp(u, 2.0));
      const selK = F.smooth((u - 3.0) / .2);
      EB.text(g, A, cam, `${total} 秒 × 闲时 ¥${P.offpeak_yuan_per_s.toFixed(2)} = ¥${off.toFixed(2)}`, TX, ROW_OFF, { size: 26, weight: selK > .5 ? 600 : 500, color: selK > .5 ? C.gold : C.ivory, align: 'left' }, o, EB.inp(u, 2.5));
      T(`账本上限 ¥${L.cap_yuan}`, GX, GY0 + GH + .2, { size: 22, color: '#E8DFCF' }, 1.25);
      T(`¥${off.toFixed(2)}`, GX + .27, GY0 + .06, { size: 26, weight: 600, mono: true, color: C.gold, align: 'left' }, 3.5);
    },
  };
})();

// ═══ 第七关 · 生成：甘特图 ═════════════════════════════════════════════════
(function () {
  const i = 7, g0 = G0(i);
  const M = D.market, tasks = M.tasks, WALL = M.wall_min;          // 15.7
  const names = ['611b', '934', 'ce76', 'e42e'];
  const AX0 = -1.45, AX1 = 1.5, MMAX = 16, sx = (AX1 - AX0) / MMAX;
  const X = m => AX0 + m * sx;
  const ROWS = [2.12, 1.75, 1.38, 1.01], BH = .22, AY = .78;
  const SW0 = 1.5, SW1 = 3.0;                                        // 扫描线：u 1.5→3.0 走完 0→15.7 分钟
  const now = u => WALL * F.clamp((u - SW0) / (SW1 - SW0));
  let A, root, axis, tickMs = [], qBars = [], rBars = [], runMat, runMats = [], sweep, wallLine, wallMat, legend = [];
  F.EVIDENCE[i] = {
    build(scene, anchor) {
      A = anchor; root = EB.root(anchor);
      axis = F.block(AX1 - AX0 + .08, .035, .04, F.mat.plaster, .01); EB.home(axis, (AX0 + AX1) / 2, AY, FZ + .03); root.add(axis);
      for (let m = 0; m <= MMAX; m += 4) { const tk = EB.box(.02, .1, .03, F.mat.plasterDark); EB.home(tk, X(m), AY + .02, FZ + .04); root.add(tk); tickMs.push(tk); }
      // 行底槽：每行一条浅浅的凹轨
      const qMat = EB.lit(C.cold, .45);
      tasks.forEach((tk, r) => {
        const q = EB.box(Math.max(.001, tk.queue_min * sx), BH, .06, qMat); root.add(q);
        const m = EB.emis(C.teal, 1.0); runMats.push(m);
        const b = EB.box(tk.run_min * sx, BH, .07, m); root.add(b);
        qBars.push({ mesh: q, s: 0, e: tk.queue_min, r }); rBars.push({ mesh: b, s: tk.queue_min, e: tk.queue_min + tk.run_min, r });
      });
      sweep = EB.box(.018, ROWS[0] - AY + .25, .02, EB.emis('#DDE7F0', .9)); root.add(sweep);
      wallMat = EB.emis(C.gold, 0, '#3A2E18');
      wallLine = EB.box(.03, ROWS[0] - AY + .36, .05, wallMat); EB.home(wallLine, X(WALL), (ROWS[0] + BH / 2 + .2 + AY) / 2, FZ + .09); root.add(wallLine);
      // 图例小方块
      const lq = EB.box(.16, .16, .05, qMat), lr = EB.box(.16, .16, .05, EB.emis(C.teal, 1.0));
      EB.home(lq, -2.02, 2.5, FZ + .05); EB.home(lr, -1.22, 2.5, FZ + .05); root.add(lq, lr); legend.push(lq, lr);
      // 声音：轴出现、扫描开始、每个任务跑完一声、全部拿齐锁定
      F.ev(g0 + 1.0, 'tick'); F.ev(g0 + 1.5, 'tick');
      for (const b of rBars) { const at = SW0 + (b.e / WALL) * (SW1 - SW0); if (b.e < WALL - 1e-6) F.ev(g0 + at, 'tick', { soft: true }); }
      F.ev(g0 + SW1, 'lock');
    },
    seek(u) {
      if (!EB.vis(root, u)) return;
      EB.rise(axis, u, 1.0); tickMs.forEach((t, k) => EB.rise(t, u, 1.0 + k * .03)); legend.forEach(l => EB.rise(l, u, 1.0));
      const m = now(u);
      for (const b of [...qBars, ...rBars]) {
        const len = F.clamp(m - b.s, 0, b.e - b.s);
        b.mesh.visible = len > .02 && u >= SW0;
        const full = (b.e - b.s) * sx;
        b.mesh.scale.x = Math.max(.001, len / (b.e - b.s || 1));
        b.mesh.position.set(X(b.s) + len * sx / 2, ROWS[b.r], FZ + .04);
        if (full <= 0) b.mesh.visible = false;
      }
      rBars.forEach((b, k) => { const doneAt = SW0 + b.e / WALL * (SW1 - SW0); runMats[k].emissiveIntensity = 1.0 + 1.6 * EB.flash(u, doneAt, .25); });
      sweep.visible = u >= SW0 && u < SW1 + .05;
      sweep.position.set(X(m), (ROWS[0] + BH / 2 + .1 + AY) / 2, FZ + .09);
      const wk = EB.rise(wallLine, u, SW1, .2, .1);
      wallLine.scale.y = Math.max(.001, F.easeOut((u - SW1) / .3));
      wallMat.emissiveIntensity = 1.4 * wk + 2.5 * EB.flash(u, SW1 + .05, .3);
    },
    overlay(g, u, cam) {
      if (u < .9 || u > 5.5) return;
      const o = EB.fadeOut(u), T = (s, x, y, opt, t0, a = 1) => EB.text(g, A, cam, s, x, y, opt, o * a, EB.inp(u, t0));
      T('排队', -1.88, 2.5, { size: 20, color: '#D6DBE3', align: 'left' }, 1.0);
      T('运行', -1.08, 2.5, { size: 20, color: '#CFEDEA', align: 'left' }, 1.0);
      names.forEach((n, r) => T(n, -2.12, ROWS[r], { mono: true, size: 20, color: '#E8DFCF', align: 'left' }, 1.0 + r * .06));
      for (let mm = 0; mm <= MMAX; mm += 4) T(String(mm), X(mm), AY - .17, { mono: true, size: 18, color: '#D6DBE3' }, 1.0);
      T('分钟', -2.12, AY - .17, { size: 18, color: '#D6DBE3', align: 'left' }, 1.0);
      const m = now(u);
      // 排队 8.2（934 的冷灰段）与每条运行时长：扫描线经过该段结尾时出现
      tasks.forEach((tk, r) => {
        const qEnd = SW0 + tk.queue_min / WALL * (SW1 - SW0), rEnd = SW0 + (tk.queue_min + tk.run_min) / WALL * (SW1 - SW0);
        if (tk.queue_min >= 1) T(`排队 ${tk.queue_min.toFixed(1)}`, X(tk.queue_min / 2), ROWS[r], { size: 18, color: '#1C2436', halo: false, weight: 600 }, qEnd);
        T(tk.run_min.toFixed(1), X(tk.queue_min + tk.run_min / 2), ROWS[r], { mono: true, size: 19, weight: 600, color: C.ivory }, rEnd);
      });
      T(`${WALL} 分钟 拿齐`, X(WALL) + .06, ROWS[0] + BH / 2 + .34, { size: 28, weight: 600, color: C.gold, align: 'right' }, SW1);
      if (m <= 0) return;
    },
  };
})();

// ═══ 第八关 · 选段与固定：内部切点、选段框避让、金钉 ═══════════════════════
// 板面右侧（x>1.55）留空：u≈3.4 证据块从 emitLocal(1.9,1.4) 处长出，不能压住证据。
(function () {
  const i = 8, g0 = G0(i);
  const CLIP_S = 5, CX0 = -2.05, CX1 = 1.45, sx = (CX1 - CX0) / CLIP_S;
  const X = s => CX0 + s * sx;
  const CUT = 4.54, CY = 1.8, CH = .7;
  const SEL_LEN = 1.0, SEL_A = 3.9, SEL_B = 3.3;           // 选段框：先压在切点上（3.9–4.9 s），再滑到 3.3–4.3 s
  const RY = CY - CH / 2 - .23;                             // 时间尺
  const red = new THREE.Color(C.red), gold = new THREE.Color(C.gold);
  let A, root, clip, clipMat, cutLine, cutMat, ruler, rTicks = [], selG, selMat, pin, pinMat;
  const selS = u => F.lerp(SEL_A, SEL_B, F.easeIO((u - 2.5) / .5));
  const selX = u => X(selS(u) + SEL_LEN / 2);
  F.EVIDENCE[i] = {
    build(scene, anchor) {
      A = anchor; root = EB.root(anchor);
      // 生成片 r3：用复刻截帧做片面，内部切点前后是两个不同的画面
      const CW = 2048, CHP = Math.round(2048 * CH / (CX1 - CX0));
      const [c, x] = F.canvas(CW, CHP);
      x.fillStyle = '#0B0F16'; x.fillRect(0, 0, CW, CHP);
      const cutPx = Math.round(CUT / CLIP_S * CW), tw = CHP * 2;           // 截帧 2:1
      const imA = F.images[10], imB = F.images[12];
      for (let k = 0; k * tw < cutPx; k++) { const w = Math.min(tw, cutPx - k * tw); if (imA) x.drawImage(imA, 0, 0, imA.width * w / tw, imA.height, k * tw + 3, 3, w - 6, CHP - 6); }
      if (imB) x.drawImage(imB, 0, 0, imB.width * (CW - cutPx) / tw, imB.height, cutPx + 3, 3, CW - cutPx - 6, CHP - 6);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      clipMat = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#FFFFFF', emissiveMap: tex, emissiveIntensity: .8, roughness: 1 });
      clip = new THREE.Group(); EB.home(clip, (CX0 + CX1) / 2, CY, FZ + .05); root.add(clip);
      const back = F.block(CX1 - CX0 + .1, CH + .1, .05, EB.lit(C.plasterShade, .15), .015); clip.add(back);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(CX1 - CX0, CH), clipMat); face.position.z = .027; clip.add(face);
      // 内部切点：红色细线
      cutMat = EB.emis(C.red, 0, '#3A1614');
      cutLine = EB.box(.028, CH + .3, .03, cutMat); EB.home(cutLine, X(CUT), CY, FZ + .1); root.add(cutLine);
      // 时间尺
      ruler = F.block(CX1 - CX0 + .06, .03, .03, EB.lit(C.plaster, .25), .01); EB.home(ruler, (CX0 + CX1) / 2, RY, FZ + .03); root.add(ruler);
      for (let s = 0; s <= CLIP_S; s++) { const tk = EB.box(.018, .09, .03, EB.lit(C.plasterShade, .2)); EB.home(tk, X(s), RY + .03, FZ + .04); root.add(tk); rTicks.push(tk); }
      // 选段框
      selMat = EB.emis(C.red, 1.4, '#301818');
      selG = EB.frame(SEL_LEN * sx, CH + .22, .035, .05, selMat); EB.home(selG, X(SEL_A + SEL_LEN / 2), CY, FZ + .12); root.add(selG);
      // 金色图钉：针 + 钉头
      pin = new THREE.Group(); root.add(pin);
      pinMat = F.goldMat();
      const needle = new THREE.Mesh(new THREE.ConeGeometry(.022, .26, 12), pinMat); needle.rotation.x = -Math.PI / 2; needle.position.z = -.13; pin.add(needle);
      const head = new THREE.Mesh(new THREE.CylinderGeometry(.1, .1, .05, 32), pinMat); head.rotation.x = Math.PI / 2; head.castShadow = true; pin.add(head);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(.07, 20, 12), pinMat); cap.position.z = .05; cap.castShadow = true; pin.add(cap);
      // 声音
      F.ev(g0 + 1.0, 'tick'); F.ev(g0 + 1.5, 'tick', { mark: 'cut' }); F.ev(g0 + 2.0, 'thud', { soft: true });
      F.ev(g0 + 3.0, 'lock'); F.ev(g0 + 3.5, 'pin');
    },
    seek(u) {
      if (!EB.vis(root, u)) return;
      EB.rise(clip, u, 1.0, .4); EB.rise(ruler, u, 1.0); rTicks.forEach((t, k) => EB.rise(t, u, 1.0 + k * .03));
      clipMat.emissiveIntensity = .8 * F.easeOut((u - 1.0) / .4);
      const ck = EB.rise(cutLine, u, 1.5, .2, .12);
      cutLine.scale.y = Math.max(.001, F.easeOut((u - 1.5) / .25));
      cutMat.emissiveIntensity = 1.5 * ck + 3 * EB.flash(u, 1.55, .3);
      // 选段框：1.75 从前方落下，2.0 压在切点上（红）；2.5→3.0 滑开；3.0 变金
      const drop = F.easeOut((u - 1.75) / .25);
      selG.visible = u >= 1.75;
      selG.position.set(selX(u), CY, selG.userData.hz + .5 * (1 - drop));
      const gk = F.smooth((u - 2.75) / .25);
      selMat.emissive.copy(red).lerp(gold, gk);
      selMat.color.set(gk > .5 ? '#3A2E18' : '#301818');
      selMat.emissiveIntensity = 1.4 + 2.0 * EB.flash(u, 2.0, .25) + 1.6 * EB.flash(u, 3.0, .3);
      // 图钉：3.0 从前上方落下，3.5 钉入选段中心
      const pk = F.easeIn((u - 3.0) / .5);
      pin.visible = u >= 3.0;
      pin.position.set(X(SEL_B + SEL_LEN / 2), CY + .9 * (1 - pk), FZ + .2 + 1.1 * (1 - pk));
      pin.rotation.set(-.5 * (1 - pk), 0, .3 * (1 - pk));
      pinMat.emissiveIntensity = .35 + 3 * EB.flash(u, 3.5, .35);
    },
    overlay(g, u, cam) {
      if (u < .9 || u > 5.5) return;
      const o = EB.fadeOut(u), T = (s, x, y, opt, t0) => EB.text(g, A, cam, s, x, y, opt, o, EB.inp(u, t0));
      T('生成片 r3', CX0, CY + CH / 2 + .24, { size: 22, color: '#E8DFCF', align: 'left' }, 1.0);
      T('内部切点', X(CUT), CY + CH / 2 + .3, { size: 22, weight: 600, color: C.red }, 1.5);
      for (let s = 0; s <= CLIP_S; s++) T(s === CLIP_S ? `${s} 秒` : String(s), X(s) + (s === CLIP_S ? .1 : 0), RY - .17, { mono: s !== CLIP_S, size: 18, color: '#D6DBE3' }, 1.0);
      // 选段框下方的状态字：压线时"跨切点"（红），避开后"选段"（金）
      const gk = F.smooth((u - 2.75) / .25), sxp = selX(u);
      EB.text(g, A, cam, '跨切点', sxp, RY - .42, { size: 22, weight: 600, color: C.red }, o * (1 - gk), EB.inp(u, 2.0));
      EB.text(g, A, cam, '选段', sxp, RY - .42, { size: 22, weight: 600, color: C.gold }, o * gk, 1);
      T('重建付费', -.95, RY - .42, { size: 26, color: '#E8DFCF', align: 'right' }, 3.5);
      T('0', -.8, RY - .4, { size: 48, weight: 700, mono: true, color: C.gold, align: 'left' }, 3.5);
      T('次', -.42, RY - .42, { size: 26, color: '#E8DFCF', align: 'left' }, 3.5);
    },
  };
})();

// ═══ 第九关 · 复审：13 镜运动量对照柱 + 色调色块 + 切点数 ═════════════════
(function () {
  const i = 9, g0 = G0(i);
  const S = D.shots.src, K = D.shots.clone, n = S.length;       // 13
  const X0 = -2.08, X1 = .45, pitch = (X1 - X0) / n, BW = .07;
  const BY = .78, VMAX = 30, HS = 1.55 / VMAX;
  const GROW0 = 1.5, GSTEP = .06;                                  // 柱子从左到右依次长出，复刻柱晚半拍
  const SWY = 2.2, SWX = [.95, 1.72];
  let A, root, axis, srcBars = [], clnBars = [], clnMat, sw = [], leg = [];
  const gx = k => X0 + pitch * (k + .5);
  F.EVIDENCE[i] = {
    build(scene, anchor) {
      A = anchor; root = EB.root(anchor);
      axis = F.block(X1 - X0 + .06, .03, .04, EB.lit(C.plaster, .25), .01); EB.home(axis, (X0 + X1) / 2, BY - .02, FZ + .03); root.add(axis);
      const srcMat = EB.lit(C.plaster, .42); clnMat = EB.emis(C.teal, 1.0);
      for (let k = 0; k < n; k++) {
        const hs = S[k].motion * HS, hc = K[k].motion * HS;
        const a = EB.box(BW, hs, .07, srcMat); a.userData.h = hs; EB.home(a, gx(k) - BW / 2 - .008, BY, FZ + .05); root.add(a); srcBars.push(a);
        const b = EB.box(BW, hc, .07, clnMat); b.userData.h = hc; EB.home(b, gx(k) + BW / 2 + .008, BY, FZ + .05); root.add(b); clnBars.push(b);
      }
      // 图例
      const la = EB.box(.14, .14, .05, srcMat), lb = EB.box(.14, .14, .05, clnMat);
      EB.home(la, -2.0, 2.55, FZ + .05); EB.home(lb, -1.18, 2.55, FZ + .05); root.add(la, lb); leg.push(la, lb);
      // 色块：A 镜真实平均色（不打光）
      for (const [rgb, x] of [[S[0].rgb, SWX[0]], [K[0].rgb, SWX[1]]]) {
        const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(`rgb(${rgb.join(',')})`) });
        const grp = new THREE.Group(); EB.home(grp, x, SWY, FZ + .05); root.add(grp);
        const rim = F.block(.48, .48, .05, EB.lit(C.plaster, .3), .02); grp.add(rim);
        const face = new THREE.Mesh(new THREE.PlaneGeometry(.4, .4), m); face.position.z = .027; grp.add(face);
        sw.push(grp);
      }
      F.ev(g0 + 1.0, 'tick'); F.ev(g0 + 1.5, 'tick'); F.ev(g0 + 2.0, 'tick');
      F.ev(g0 + 2.5, 'lock', { soft: true }); F.ev(g0 + 3.0, 'stamp');
    },
    seek(u) {
      if (!EB.vis(root, u)) return;
      EB.rise(axis, u, 1.0); leg.forEach(l => EB.rise(l, u, 1.0));
      for (let k = 0; k < n; k++) {
        for (const [b, off] of [[srcBars[k], 0], [clnBars[k], .5]]) {
          const kk = F.easeOut((u - GROW0 - k * GSTEP - off) / .45);
          b.visible = kk > 0; b.scale.y = Math.max(.001, kk); b.position.y = BY + b.userData.h * kk / 2;
        }
      }
      clnMat.emissiveIntensity = 1.0 + 1.2 * EB.flash(u, 2.0 + n * GSTEP, .3);
      sw.forEach((s, k) => EB.rise(s, u, 2.5 + k * .12, .35));
    },
    overlay(g, u, cam) {
      if (u < .9 || u > 5.5) return;
      const o = EB.fadeOut(u), T = (s, x, y, opt, t0) => EB.text(g, A, cam, s, x, y, opt, o, EB.inp(u, t0));
      T('原片', -1.86, 2.55, { size: 20, color: '#E8DFCF', align: 'left' }, 1.0);
      T('复刻', -1.04, 2.55, { size: 20, color: '#CFEDEA', align: 'left' }, 1.0);
      T('运动量', X1, 2.55, { size: 20, color: '#D6DBE3', align: 'right' }, 1.0);
      for (let k = 0; k < n; k++) T(S[k].shot, gx(k), BY - .16, { mono: true, size: 18, color: '#D6DBE3' }, 1.0 + k * .03);
      T('A 镜色调', (SWX[0] + SWX[1]) / 2, SWY + .42, { size: 20, color: '#D6DBE3' }, 2.5);
      T('原片', SWX[0], SWY - .4, { size: 19, color: '#E8DFCF' }, 2.5);
      T('复刻', SWX[1], SWY - .4, { size: 19, color: '#E8DFCF' }, 2.62);
      T(S[0].rgb.join('/'), SWX[0], SWY - .57, { mono: true, size: 16, color: '#CFEDEA' }, 2.5);
      T(K[0].rgb.join('/'), SWX[1], SWY - .57, { mono: true, size: 16, color: '#C9CFD9' }, 2.62);
      T(`切点数 = ${D.shots.cut_frames.length - 1} ✓`, 1.36, .86, { size: 28, weight: 600, color: C.gold }, 3.0);
    },
  };
})();

// ═══ 第十关 · 交付：三格结论托盘 + 令牌落入 + 看过听过 ═════════════════════
(function () {
  const i = 10, g0 = G0(i);
  const TRAYS = [{ x: -1.62 }, { x: -.3 }, { x: 1.02 }];
  const TW = 1.2, TY0 = .5, TY1 = 1.9;
  const TOK = [                                   // [托盘, 文字, 落入时刻 u]
    [0, '13 刀', 1.5], [0, '字幕', 1.75], [0, '原声', 2.0],
    [1, '倒握', 2.5], [1, '动作强度', 2.75],
  ];
  const SLOT = [.74, 1.08, 1.42];
  let A, root, trays = [], toks = [], goldM, grayM, stripGold;
  F.EVIDENCE[i] = {
    build(scene, anchor) {
      A = anchor; root = EB.root(anchor);
      goldM = F.goldMat(); goldM.emissiveIntensity = .55;
      grayM = EB.lit('#B8BEC8', .35);
      stripGold = EB.emis(C.gold, 1.3, '#3A2E18');
      const wallM = EB.lit(C.plaster, .22), stripCold = EB.lit(C.cold, .3), stripInk = EB.flat('#3A4256');
      TRAYS.forEach((t, k) => {
        const grp = new THREE.Group(); EB.home(grp, t.x, (TY0 + TY1) / 2, FZ + .03); root.add(grp);
        const walls = [[TW, .08, 0, -(TY1 - TY0) / 2 + .04], [.08, TY1 - TY0, -TW / 2 + .04, 0], [.08, TY1 - TY0, TW / 2 - .04, 0]];
        for (const [w, h, x, y] of walls) { const wl = F.block(w, h, .16, wallM, .02); wl.position.set(x, y, .06); grp.add(wl); }
        const strip = EB.box(TW - .1, .05, .05, [stripGold, stripCold, stripInk][k]); strip.position.set(0, (TY1 - TY0) / 2 - .03, .04); grp.add(strip);
        trays.push(grp);
      });
      const cnt = [0, 0];
      for (const [tr, s, t0] of TOK) {
        const b = F.block(1.0, .27, .1, tr === 0 ? goldM : grayM, .04);
        root.add(b); toks.push({ b, tr, s, t0, y: SLOT[cnt[tr]++] });
      }
      F.ev(g0 + 1.0, 'tick');
      for (const [, , t0] of TOK) F.ev(g0 + t0, 'lock', { soft: true });
      F.ev(g0 + 3.0, 'tick'); F.ev(g0 + 3.5, 'stamp');
    },
    seek(u) {
      if (!EB.vis(root, u)) return;
      trays.forEach((t, k) => EB.rise(t, u, 1.0 + k * .08, .4));
      for (const o of toks) {
        const k = F.clamp((u - (o.t0 - .3)) / .3);
        o.b.visible = u >= o.t0 - .3;
        o.b.position.set(TRAYS[o.tr].x, o.y + 1.0 * (1 - k * k), FZ + .13 + .35 * (1 - k));
        o.b.rotation.z = .25 * (1 - k) * (o.tr ? -1 : 1);
      }
      let fl = 0; for (const o of toks) if (o.tr === 0) fl = Math.max(fl, EB.flash(u, o.t0 + .03, .25));
      goldM.emissiveIntensity = .55 + 1.0 * fl;
      stripGold.emissiveIntensity = 1.3 + 2.5 * EB.flash(u, 3.5, .35);
    },
    overlay(g, u, cam) {
      if (u < .9 || u > 5.5) return;
      const o = EB.fadeOut(u), T = (s, x, y, opt, t0) => EB.text(g, A, cam, s, x, y, opt, o, EB.inp(u, t0));
      T('已达成', TRAYS[0].x, TY1 + .2, { size: 24, weight: 600, color: C.gold }, 1.0);
      T('需要配置', TRAYS[1].x, TY1 + .32, { size: 22, weight: 600, color: '#D6DBE3' }, 1.08);
      T('或再付费', TRAYS[1].x, TY1 + .12, { size: 22, weight: 600, color: '#D6DBE3' }, 1.08);
      T('受阻', TRAYS[2].x, TY1 + .2, { size: 24, weight: 600, color: '#D6DBE3' }, 1.16);
      for (const t of toks) {
        const k = F.clamp((u - (t.t0 - .3)) / .3);
        if (k < .95) continue;
        EB.text(g, A, cam, t.s, TRAYS[t.tr].x, t.y, { size: 22, weight: 600, color: t.tr === 0 ? '#2A1E08' : C.ink, halo: false, z: FZ + .19 }, o, 1);
      }
      T('无', TRAYS[2].x, 1.08, { size: 28, color: '#AEB6C3' }, 3.0);
      T('看过 ✓   听过 ✓', TRAYS[1].x, 2.6, { size: 30, weight: 600, color: C.gold }, 3.5);
    },
  };
})();
})();
