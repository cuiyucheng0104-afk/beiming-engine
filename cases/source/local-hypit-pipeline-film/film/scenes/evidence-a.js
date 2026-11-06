// evidence-a.js — 第 0–5 关的证据画面（画在各关证据板上）。
// 接口见 s4-gates.js 顶部：F.EVIDENCE[i] = { build(scene, anchor), seek(u, t), overlay(g, u, cam, t) }，u = 该关本地时间。
// 板面局部坐标：原点在板面底边中点，x∈[-2.3,2.3]，y∈[0,2.8]，前表面 z=0.08。
// 做法：所有证据挂在板子本体下面（跟随板子的分解组装一起落位）；立体元素是石膏片 / 发光细线，
//       文字与精确数字在 overlay 里投影后用 F.label 画，并按投影 y 自动避开 y>800 的字幕区。
// 节奏：u≈1 开始出现，所有动作落在拍点（0.5 s），3.5 前全部可读；4.0 证据块起飞后板上内容保持；6.5 后淡出。
// 共享小工具挂在 F.EA 下（本文件前缀 EA）。
'use strict';
(function () {
const F = window.F;
F.EVIDENCE = F.EVIDENCE || [];
const C = F.C;
const EA = F.EA = {};
const G0 = i => F.GATE_T0 + i * F.GATE_LEN;           // 第 i 关的绝对起点

// ─── 共享材质与几何（第一次 build 时创建） ───────────────────────────────────
let M = null;
EA.mats = function () {
  if (M) return M;
  M = {
    slate: new THREE.MeshStandardMaterial({ color: '#2A3347', roughness: .96 }),              // 板面内嵌的深靛石板
    chip: new THREE.MeshStandardMaterial({ color: C.plaster, roughness: .92, emissive: new THREE.Color(C.plaster), emissiveIntensity: .13 }),
    chipCold: new THREE.MeshStandardMaterial({ color: '#7E8796', roughness: .95, emissive: new THREE.Color('#5C6574'), emissiveIntensity: .12 }),
    recess: new THREE.MeshStandardMaterial({ color: '#161C2A', roughness: .98 }),
    cold: new THREE.MeshStandardMaterial({ color: '#000', emissive: new THREE.Color(C.cold), emissiveIntensity: .55, roughness: 1 }),
    unit: new THREE.BoxGeometry(1, 1, 1),
    tickGeo: (() => { const g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, .5, 0); return g; })(),   // 底部为原点的竖条
  };
  return M;
};
// 每个石膏片自己的材质副本：锁定时单独闪一下
EA.chipMat = (base = 'chip') => EA.mats()[base].clone();
EA.flash = (u, tl, len = .32) => (u >= tl ? Math.max(0, 1 - (u - tl) / len) : 0);

// 在证据板本体下建根节点，局部坐标与 anchor 一致；铺一块内嵌深色石板
const _v = new THREE.Vector3();
EA.ctx = function (anchor) {
  const m = EA.mats();
  const board = anchor.group.children[0];               // s4-gates 先加入的是板子本体
  const root = new THREE.Group(); root.position.set(0, -1.4, 0); board.add(root);
  const slate = new THREE.Mesh(new THREE.PlaneGeometry(4.36, 2.56), m.slate); slate.position.set(0, 1.4, .0815); slate.receiveShadow = true; root.add(slate);
  const E = {
    root, fade: 1,
    P(cam, x, y, z = .13) { _v.set(x, y, z); root.localToWorld(_v); return F.project(cam, _v); },
    begin(u) { root.updateWorldMatrix(true, false); E.fade = 1 - F.smooth((u - 6.5) / .5); },
    show(u) { const on = u > .9 && u < 9; root.visible = on; return on; },
  };
  return E;
};
// 石膏片：贴在板面上，w×h，厚 d
EA.chip = function (E, w, h, d, mat, x, y) {
  const b = F.block(w, h, d, mat, Math.min(.04, d / 2 - .002));
  b.position.set(x, y, .082 + d / 2); E.root.add(b); return b;
};
// 细线（发光条）：setBar 按进度 k 从 (x0,y0) 长向 (x1,y1)
EA.bar = function (E, mat, thick = .032) {
  const m = new THREE.Mesh(EA.mats().unit, mat); m.scale.set(.001, thick, .025); m.visible = false; E.root.add(m); return m;
};
EA.setBar = function (m, x0, y0, x1, y1, k0, k1, z = .1) {
  k0 = F.clamp(k0); k1 = F.clamp(k1);
  const len = Math.hypot(x1 - x0, y1 - y0) * (k1 - k0);
  m.visible = len > .004;
  const km = (k0 + k1) / 2;
  m.position.set(x0 + (x1 - x0) * km, y0 + (y1 - y0) * km, z);
  m.rotation.set(0, 0, Math.atan2(y1 - y0, x1 - x0));
  m.scale.x = Math.max(len, .001);
};
// 零件落位：F.piece 的 u 时间版本；落位前不可见
EA.piece = (obj, o) => F.piece(obj, Object.assign({ mode: 'gather' }, o));
EA.pose = function (list, u) { for (const p of list) { F.pose(p, u); p.obj.visible = u > p.t0; } };
// 投影标签：自动避开 y>800（字幕区），并乘以整关淡出
EA.label = function (g, E, cam, str, x, y, o = {}) {
  const p = E.P(cam, x, y, o.z ?? .13); if (!p) return null;
  const size = o.size || 26;
  const guard = 1 - F.smooth((p.y + size * .55 - 786) / 12);
  const a = (o.alpha ?? 1) * guard * E.fade;
  if (a > .004 && p.x > -300 && p.x < F.W + 300) F.label(g, str, p.x + (o.dx || 0), p.y + (o.dy || 0), Object.assign({}, o, { size, alpha: a }));
  return p;
};
EA.appear = (u, t0, dur = .35) => F.easeOut((u - t0) / dur);

// ═══ 第〇关 · 立项：三种输入 → 两个服务，"参考视频 → 市场"断开，标"不支持" ═════════════
F.EVIDENCE[0] = (() => {
  const IN = ['参考图', '参考视频', '首尾帧'], IY = [2.12, 1.42, .72], IX = -1.42, IW = 1.3;
  const SV = ['市场 1088p', '自有服务器 768P'], SY = [1.98, .92], SX = 1.28, SW = 1.62;
  const PAIRS = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]], BROKEN = 2;
  const LS = k => 1.95 + k * .16, LD = .32;             // 第 k 条线开始生长的时间与时长
  const CRACK = 3.0;
  let E, ins = [], svs = [], inMats = [], svMats = [], links = [], brA, brB, teal;
  const ends = ([a, b]) => [IX + IW / 2 + .04, IY[a] + (b === 0 ? .06 : -.06), SX - SW / 2 - .04, SY[b] + (a - 1) * .09];
  return {
    build(scene, anchor) {
      E = EA.ctx(anchor);
      teal = F.glow(C.teal, 1.6);
      IN.forEach((s, k) => {
        const mt = EA.chipMat(); inMats.push(mt);
        const b = EA.chip(E, IW, .44, .1, mt, IX, IY[k]);
        ins.push(EA.piece(b, { d: [-.7, .25, 1.1], axis: [0, 1, 0], ang: .35, t0: 1.0 + k * .1, t1: 1.5 }));
      });
      SV.forEach((s, k) => {
        const mt = EA.chipMat(); svMats.push(mt);
        const b = EA.chip(E, SW, .56, .26, mt, SX, SY[k]);
        svs.push(EA.piece(b, { d: [.8, .3, 1.2], axis: [0, 1, 0], ang: -.35, t0: 1.5 + k * .1, t1: 2.0 }));
      });
      PAIRS.forEach((p, k) => { if (k !== BROKEN) links.push(EA.bar(E, teal)); else links.push(null); });
      brA = EA.bar(E, teal); brB = EA.bar(E, EA.mats().cold);
      const g0 = G0(0);
      F.ev(g0 + 1.5, 'lock', { n: 3 }); F.ev(g0 + 2.0, 'lock', { n: 2 });
      for (let k = 0; k < PAIRS.length; k++) F.ev(g0 + LS(k) + LD, 'tick', { soft: true });
      F.ev(g0 + CRACK, 'crack');
    },
    seek(u) {
      if (!E.show(u)) return;
      EA.pose(ins, u); EA.pose(svs, u);
      inMats.forEach(m => m.emissiveIntensity = .13 + .7 * EA.flash(u, 1.5));
      svMats.forEach(m => m.emissiveIntensity = .13 + .7 * EA.flash(u, 2.0));
      PAIRS.forEach((p, k) => {
        const [x0, y0, x1, y1] = ends(p), kk = F.easeIO((u - LS(k)) / LD);
        if (k !== BROKEN) { EA.setBar(links[k], x0, y0, x1, y1, 0, kk); return; }
        // 断线：先和别的线一样长到一半，裂开后变冷灰，前后两截之间留出缺口
        const br = F.smooth((u - CRACK) / .18);
        brA.material = u < CRACK ? teal : EA.mats().cold;
        EA.setBar(brA, x0, y0, x1, y1, 0, Math.min(kk, .5) - .1 * br);
        EA.setBar(brB, x0, y0, x1, y1, .6, .6 + .4 * br);
      });
      teal.emissiveIntensity = 1.6;
    },
    overlay(g, u, cam) {
      if (u < .9 || u > 7.2) return;
      E.begin(u);
      IN.forEach((s, k) => { const p = ins[k]; EA.label(g, E, cam, s, IX, IY[k], { z: .2, size: 28, weight: 500, color: C.ink, halo: false, prog: EA.appear(u, p.t1 - .2), dx: 0 }); });
      SV.forEach((s, k) => { const p = svs[k]; EA.label(g, E, cam, s, SX, SY[k], { z: .36, size: 26, weight: 600, color: C.ink, halo: false, prog: EA.appear(u, p.t1 - .2) }); });
      // "不支持"：一枚冷灰小牌压在断口上（深色底遮住交叉线，读得干净）
      const [x0, y0, x1, y1] = ends(PAIRS[BROKEN]);
      const pa = E.P(cam, x0 + (x1 - x0) * .52, y0 + (y1 - y0) * .52, .12);
      const pr = EA.appear(u, CRACK + .05, .3);
      if (pa && pr > .004) {
        const a = pr * E.fade * (1 - F.smooth((pa.y + 20 - 786) / 12)), w = 104, h = 38;
        g.save(); g.globalAlpha = a; g.fillStyle = '#1B2232'; g.strokeStyle = C.cold; g.lineWidth = 1.5;
        g.beginPath(); g.roundRect(pa.x - w / 2, pa.y - h / 2 + (1 - pr) * 8, w, h, 7); g.fill(); g.stroke(); g.restore();
        F.label(g, '不支持', pa.x, pa.y + (1 - pr) * 8, { size: 24, weight: 600, color: '#B4BCC8', halo: false, alpha: a });
      }
    },
  };
})();

// ═══ 第一关 · 读片：切点检测时间轴，16 个候选 → 12 个真切点（金）+ 4 个镜头内变化（冷灰，带标注） ══
F.EVIDENCE[1] = (() => {
  const CANDS = [0.067, 0.767, 0.9, 1.4, 2.2, 2.933, 3.467, 3.8, 4.267, 4.5, 4.833, 4.9, 5.367, 5.7, 6.367, 7.4];
  const NOTES = { 0.067: '字幕条', 0.767: '闪电', 4.833: '冲锋', 7.4: '甩镜' };
  const REAL = CANDS.filter(s => !NOTES[s]);           // 12 个
  const AX0 = -1.86, AX1 = 1.86, AY = 1.22, DUR = 8.3;
  const sx = s => AX0 + (AX1 - AX0) * s / DUR;
  const SCAN0 = 1.0, SCAN1 = 2.4, VER0 = 2.5, VER1 = 2.95;
  const uc = s => SCAN0 + (SCAN1 - SCAN0) * s / DUR;    // 扫描经过的时刻
  const ud = s => VER0 + (VER1 - VER0) * s / DUR;       // 核对经过的时刻
  const HC = .6, HG = .84, HD = -.24;                   // 候选 / 真切点 / 镜头内变化（向下折）的高度
  let E, axis, axisP, ticks = [], scan, sweep, gold, tealG;
  return {
    build(scene, anchor) {
      E = EA.ctx(anchor); const m = EA.mats();
      gold = F.glow(C.gold, 1.5); tealG = F.glow(C.teal, 2.2);
      axis = EA.chip(E, AX1 - AX0 + .12, .05, .05, EA.chipMat(), 0, AY);
      axisP = EA.piece(axis, { d: [0, 0, .9], axis: [0, 0, 1], ang: .1, t0: .9, t1: 1.3 });
      for (const s of CANDS) {
        const t = new THREE.Mesh(m.tickGeo, m.chip); t.castShadow = true;
        t.position.set(sx(s), AY + .02, .11); t.scale.set(.024, .001, .03); t.visible = false; E.root.add(t);
        ticks.push({ s, mesh: t, real: !NOTES[s] });
      }
      scan = new THREE.Mesh(m.tickGeo, tealG); scan.scale.set(.018, .9, .02); scan.visible = false; E.root.add(scan);
      sweep = new THREE.Mesh(m.tickGeo, gold); sweep.scale.set(.018, 1.1, .02); sweep.visible = false; E.root.add(sweep);
      const g0 = G0(1);
      for (const s of CANDS) F.ev(g0 + uc(s), 'tick', { soft: true });
      F.ev(g0 + VER0, 'whoosh', { dur: .5, soft: true });
      F.ev(g0 + 3.0, 'lock', { n: 12 });
    },
    seek(u) {
      if (!E.show(u)) return;
      EA.pose([axisP], u);
      for (const tk of ticks) {
        const a = u - uc(tk.s), b = u - ud(tk.s), mm = tk.mesh;
        mm.visible = a > 0;
        let h = HC * F.easeBack(a / .2);
        if (b > 0) {
          if (tk.real) { h = F.lerp(HC, HG, F.easeBack(b / .22)); mm.material = gold; }
          else { const k = F.easeIO(b / .3); h = F.lerp(HC, HD, k); mm.material = k > .5 ? EA.mats().cold : EA.mats().chip; }
        } else mm.material = EA.mats().chip;
        mm.scale.y = Math.abs(h) < .002 ? .002 : h;
      }
      const sc = (u - SCAN0) / (SCAN1 - SCAN0);
      scan.visible = sc > 0 && sc < 1.05; scan.position.set(AX0 + (AX1 - AX0) * Math.min(1, sc), AY - .1, .13);
      tealG.emissiveIntensity = 2.2 * (1 - F.smooth((sc - .95) / .1));
      const sw = (u - VER0) / (VER1 - VER0);
      sweep.visible = sw > 0 && sw < 1.08; sweep.position.set(AX0 + (AX1 - AX0) * Math.min(1, sw), AY - .2, .13);
      gold.emissiveIntensity = 1.4 + .8 * EA.flash(u, 3.0, .35);
    },
    overlay(g, u, cam) {
      if (u < .9 || u > 7.2) return;
      E.begin(u);
      // 轴两端刻度
      const ap = EA.appear(u, 1.0);
      EA.label(g, E, cam, '0', AX0 - .1, AY, { size: 22, mono: true, color: '#C9C2B6', align: 'right', prog: ap });
      EA.label(g, E, cam, '8.3 s', AX1, AY - .2, { size: 22, mono: true, color: '#C9C2B6', prog: ap });
      // 镜头内变化：向下折的冷灰刻度 + 标注（两层错开，避免挤在一起）
      for (const tk of ticks) {
        if (tk.real) continue;
        const b = u - ud(tk.s); if (b < .1) continue;
        const low = tk.s < .5, ly = low ? .5 : .8;
        const p0 = E.P(cam, sx(tk.s), AY + HD - .02, .12), p1 = E.P(cam, sx(tk.s), ly + .11, .12);
        const pr = EA.appear(u, ud(tk.s) + .12, .3);
        if (p0 && p1) {
          const a = pr * E.fade * (1 - F.smooth((p1.y - 780) / 12));
          g.save(); g.globalAlpha = a * .8; g.strokeStyle = C.cold; g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke(); g.restore();
        }
        EA.label(g, E, cam, NOTES[tk.s], sx(tk.s), ly, { size: 24, weight: 500, color: '#AEB6C3', prog: pr });
      }
      // 大数字：16 → 12
      const p = E.P(cam, 0, 2.5, .13);
      if (p) {
        const guard = E.fade;
        const nC = ticks.filter(tk => u >= uc(tk.s)).length;
        const nR = ticks.filter(tk => tk.real && u >= ud(tk.s)).length;
        const a16 = EA.appear(u, SCAN0, .3), a12 = EA.appear(u, VER0, .3);
        F.label(g, String(nC), p.x - 46, p.y, { size: 60, weight: 600, mono: true, color: C.ivory, align: 'right', alpha: guard, prog: a16 });
        F.label(g, '→', p.x, p.y, { size: 44, weight: 400, color: C.cold, alpha: guard, prog: a12 });
        F.label(g, String(nR), p.x + 46, p.y, { size: 60, weight: 600, mono: true, color: C.gold, align: 'left', alpha: guard, prog: a12 });
      }
    },
  };
})();

// ═══ 第二关 · Brief：一张签字卡，最后一笔金色签名 ═════════════════════════════
F.EVIDENCE[2] = (() => {
  const CW = 3.7, CH = 2.36, CY = 1.42, LX = -1.62;
  const ROWS = [
    { y: 2.26, t: 1.5, parts: [['用户原话', { color: '#5E6573', weight: 600, size: 26 }]] },
    { y: 1.8, t: 2.0, parts: [['替换：主角、敌人、场景', { color: C.ink, weight: 600, size: 28 }]] },
    { y: 1.36, t: 2.5, parts: [['没提到的按原片继承', { color: C.ink, weight: 600, size: 28 }]] },
    { y: .92, t: 3.0, parts: [['花费上限', { color: C.ink, weight: 600, size: 28 }]] },
  ];
  const SIG0 = 3.0, SIG1 = 3.5;
  // 签名笔画（板面局部坐标，一笔连写）
  const SIG = (() => { const pts = [], N = 140; for (let k = 0; k <= N; k++) { const s = k / N, th = s * Math.PI * 5;
    // 拉长的摆线：连笔的几个小圈，幅度逐渐收小，最后一笔向右上甩出
    const x = .36 + 1.02 * s - .1 * Math.sin(th) * (1 - .4 * s), y = .62 + .11 * Math.cos(th) * (1 - .4 * s) + .1 * Math.sin(s * Math.PI) - .06 + (s > .9 ? (s - .9) * 1.2 : 0);
    pts.push([x, y]); } return pts; })();
  let E, pivot, card, cardMat, frame = [], goldF, quote = [], cardPiece;
  return {
    build(scene, anchor) {
      E = EA.ctx(anchor);
      cardMat = EA.chipMat(); cardMat.emissiveIntensity = .2;
      // 卡片绕底边翻起（纸张展开）
      pivot = new THREE.Group(); pivot.position.set(0, CY - CH / 2, .09); E.root.add(pivot);
      card = F.block(CW, CH, .04, cardMat, .018); card.position.set(0, CH / 2, .02); pivot.add(card);
      // "用户原话"后面：两道刻进卡面的引文线（示意原话，不捏造内容）
      for (const [x0, x1, y] of [[-.2, 1.62, 2.31], [-.2, 1.1, 2.17]]) {
        const q = new THREE.Mesh(EA.mats().unit, EA.mats().chipCold); q.scale.set(x1 - x0, .035, .01);
        q.position.set((x0 + x1) / 2, y - (CY - CH / 2), .045); pivot.add(q); quote.push({ mesh: q, x0, x1 });
      }
      // 签名线
      const sl = new THREE.Mesh(EA.mats().unit, EA.mats().chipCold); sl.scale.set(1.5, .012, .01);
      sl.position.set(.95, .48 - (CY - CH / 2), .045); pivot.add(sl);
      // 签完后卡片四周亮起金色细框
      goldF = F.glow(C.gold, 0);
      for (const [w, h, x, y] of [[CW + .06, .03, 0, CH + .03], [CW + .06, .03, 0, -.03], [.03, CH + .06, CW / 2 + .03, CH / 2], [.03, CH + .06, -CW / 2 - .03, CH / 2]]) {
        const b = new THREE.Mesh(EA.mats().unit, goldF); b.scale.set(w, h, .03); b.position.set(x, y, .03); pivot.add(b); frame.push(b);
      }
      const g0 = G0(2);
      F.ev(g0 + 1.0, 'paper'); F.ev(g0 + 3.0, 'tick', { n: 30 }); F.ev(g0 + SIG0, 'paper', { soft: true, sign: true }); F.ev(g0 + SIG1, 'lock');
    },
    seek(u) {
      if (!E.show(u)) return;
      const k = F.easeOut((u - 1.0) / .5);
      pivot.rotation.x = 1.45 * (1 - k); pivot.position.z = .09 + .5 * (1 - k);
      pivot.visible = u > 1.0;
      quote.forEach((q, j) => { const a = F.easeOut((u - 1.5 - j * .08) / .35); q.mesh.visible = a > .01; q.mesh.scale.x = Math.max(.001, (q.x1 - q.x0) * a); q.mesh.position.x = q.x0 + (q.x1 - q.x0) * a / 2; });
      cardMat.emissiveIntensity = .2 + .5 * EA.flash(u, 1.5, .3);
      goldF.emissiveIntensity = 1.1 * F.smooth((u - SIG1) / .15) + 1.2 * EA.flash(u, SIG1, .4);
      for (const b of frame) b.visible = u > SIG1 - .02;
    },
    overlay(g, u, cam) {
      if (u < .9 || u > 7.2) return;
      E.begin(u);
      if (u < 1.35) return;                                // 卡片翻起之后才上字
      for (const r of ROWS) for (const [s, o] of r.parts) EA.label(g, E, cam, s, LX, r.y, Object.assign({ z: .13, align: 'left', halo: false, prog: EA.appear(u, r.t) }, o));
      // ¥30：金色等宽数字，接在"花费上限"后面
      const pl = E.P(cam, LX, .92, .13);
      if (pl) {
        const w = F.bake('花费上限', { size: 28, weight: 600, color: C.ink, halo: false, align: 'left' }).tw;
        const guard = 1 - F.smooth((pl.y + 26 - 786) / 12);
        F.label(g, '¥30', pl.x + w + 18, pl.y - 2, { size: 46, weight: 700, mono: true, color: '#C98A2E', halo: false, align: 'left', alpha: guard * E.fade, prog: EA.appear(u, 3.0, .3) });
      }
      // 金色签名：沿笔画逐段画出（投影到板面，跟着板子动）
      const s = F.clamp((u - SIG0) / (SIG1 - SIG0)); if (s <= 0) return;
      const n = Math.max(2, Math.round(SIG.length * F.easeIO(s)));
      const pts = []; for (let k = 0; k < n; k++) { const p = E.P(cam, SIG[k][0], SIG[k][1], .13); if (p) pts.push(p); }
      if (pts.length < 2) return;
      const maxY = Math.max(...pts.map(p => p.y));
      g.save(); g.globalAlpha = E.fade * (1 - F.smooth((maxY - 786) / 12));
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.shadowColor = 'rgba(242,180,90,.85)'; g.shadowBlur = 10; g.strokeStyle = C.gold; g.lineWidth = 3.2;
      g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (const p of pts) g.lineTo(p.x, p.y); g.stroke();
      g.shadowBlur = 0; g.strokeStyle = '#FFE2A8'; g.lineWidth = 1.2; g.stroke();
      g.restore();
    },
  };
})();

// ═══ 第三关 · Treatment：原片的 4 个"作用" → 新片里的去向，连线依次亮起 ═══════════════
F.EVIDENCE[3] = (() => {
  const L = ['主角是唯一亮色', '13 刀的节奏', '字幕条', '倒握'];
  const R = ['换形式', '继承', '继承', '换形式'];
  const RY = [2.2, 1.72, 1.24, .76], LXc = -1.17, LW = 1.84, RXc = 1.36, RW = 1.0;
  const LOCK = [2.0, 2.5, 3.0, 3.5], GROW = .34;
  let E, lp = [], rp = [], rMats = [], bars = [], gold, teal;
  const inherit = k => R[k] === '继承';
  return {
    build(scene, anchor) {
      E = EA.ctx(anchor);
      gold = F.glow(C.gold, 2.0); teal = F.glow(C.teal, 1.8);
      L.forEach((s, k) => { const b = EA.chip(E, LW, .38, .1, EA.mats().chip, LXc, RY[k]); lp.push(EA.piece(b, { d: [-.8, .15, 1.0], axis: [0, 1, 0], ang: .35, t0: 1.0 + k * .08, t1: 1.5 })); });
      R.forEach((s, k) => {
        const mt = EA.mats().recess.clone(); mt.emissive = new THREE.Color('#000'); rMats.push(mt);
        const b = EA.chip(E, RW, .38, .1, mt, RXc, RY[k]);
        rp.push(EA.piece(b, { d: [.7, .1, .9], axis: [0, 1, 0], ang: -.35, t0: 1.5, t1: 2.0 }));
        bars.push(EA.bar(E, inherit(k) ? gold : teal, .036));
      });
      const g0 = G0(3);
      F.ev(g0 + 1.5, 'lock', { n: 4 });
      LOCK.forEach(t => F.ev(g0 + t, 'lock'));
    },
    seek(u) {
      if (!E.show(u)) return;
      EA.pose(lp, u); EA.pose(rp, u);
      R.forEach((s, k) => {
        const kk = F.easeIO((u - (LOCK[k] - GROW)) / GROW);
        EA.setBar(bars[k], LXc + LW / 2 + .05, RY[k], RXc - RW / 2 - .05, RY[k], 0, kk);
        const on = u >= LOCK[k];
        rMats[k].emissive.set(inherit(k) ? C.gold : C.teal);
        rMats[k].emissiveIntensity = (on ? .08 : 0) + .35 * EA.flash(u, LOCK[k]);
      });
      gold.emissiveIntensity = 2.0; teal.emissiveIntensity = 1.8;
    },
    overlay(g, u, cam) {
      if (u < .9 || u > 7.2) return;
      E.begin(u);
      const hp = EA.appear(u, 1.2);
      EA.label(g, E, cam, '原片的作用', LXc, 2.6, { size: 22, weight: 500, color: '#AEB6C3', prog: hp });
      EA.label(g, E, cam, '新片的去向', RXc, 2.6, { size: 22, weight: 500, color: '#AEB6C3', prog: hp });
      L.forEach((s, k) => EA.label(g, E, cam, s, LXc, RY[k], { z: .2, size: 26, weight: 600, color: C.ink, halo: false, prog: EA.appear(u, lp[k].t1 - .2) }));
      R.forEach((s, k) => {
        const on = u >= LOCK[k];
        EA.label(g, E, cam, s, RXc, RY[k], { z: .2, size: 26, weight: 600, color: on ? (inherit(k) ? C.gold : '#6FDCD4') : C.cold, halo: false, alpha: on ? 1 : .6, prog: EA.appear(u, 1.8) });
      });
    },
  };
})();

// ═══ 第四关 · 素材设计：四枚石膏令牌滑进四个标签槽 ════════════════════════════
F.EVIDENCE[4] = (() => {
  const TOK = ['图', '片段', '首尾帧', '提示词'], ROLE = ['长相', '动作', '终点', '态度'];
  const XS = [-1.56, -.52, .52, 1.56], SY = 1.78, LY = 1.08, TW = .84, TH = .5;
  const LOCK = [1.5, 2.0, 2.5, 3.0], SLIDE = .5;
  let E, slots = [], slotP = [], toks = [], tMats = [], lines = [], gold;
  return {
    build(scene, anchor) {
      E = EA.ctx(anchor);
      gold = F.glow(C.gold, 0);
      XS.forEach((x, k) => {
        const s = EA.chip(E, TW + .1, TH + .1, .03, EA.mats().recess, x, SY); slots.push(s);
        slotP.push(EA.piece(s, { d: [0, 0, .5], axis: [1, 0, 0], ang: .2, t0: .95 + k * .05, t1: 1.35 }));
        const mt = EA.chipMat(); tMats.push(mt);
        const t = EA.chip(E, TW, TH, .16, mt, x, SY); t.position.z = .082 + .03 + .08;
        // 令牌从右前上方沿法线推入：先在槽前方悬停，最后一段压进去
        toks.push(EA.piece(t, { d: [.9 + k * .15, .7, 1.4], axis: [.3, 1, .2], ang: .35, t0: LOCK[k] - SLIDE, t1: LOCK[k] }));
        const ln = new THREE.Mesh(EA.mats().unit, gold); ln.scale.set(.001, .022, .012); ln.position.set(x, (SY - TH / 2 - .1 + LY + .16) / 2, .1); E.root.add(ln); lines.push(ln);
      });
      const g0 = G0(4);
      LOCK.forEach((t, k) => F.ev(g0 + t, 'lock', { i: k }));
    },
    seek(u) {
      if (!E.show(u)) return;
      EA.pose(slotP, u); EA.pose(toks, u);
      tMats.forEach((m, k) => m.emissiveIntensity = .13 + .8 * EA.flash(u, LOCK[k]));
      lines.forEach((ln, k) => { const a = F.easeOut((u - LOCK[k]) / .25); ln.visible = a > .01; ln.scale.set(.022, Math.max(.001, (SY - TH / 2 - .1 - LY - .16) * a), .012); });
      gold.emissiveIntensity = 2.0;
    },
    overlay(g, u, cam) {
      if (u < .9 || u > 7.2) return;
      E.begin(u);
      XS.forEach((x, k) => {
        const on = u >= LOCK[k];
        EA.label(g, E, cam, ROLE[k], x, LY, { size: 28, weight: 600, color: on ? C.gold : '#8C96A6', alpha: on ? 1 : .8, prog: EA.appear(u, 1.1 + k * .05) });
        // 令牌上的字：跟着令牌走
        const tk = toks[k].obj; if (!tk.visible) return;
        const p = tk.position;
        EA.label(g, E, cam, TOK[k], p.x, p.y, { z: p.z + .09, size: TOK[k].length > 2 ? 24 : 28, weight: 600, color: C.ink, halo: false, alpha: F.smooth((u - toks[k].t0) / .2) });
      });
    },
  };
})();

// ═══ 第五关 · 编写与预览：本机请求 0 → 46（每拍跳一段），付费请求始终金色 0 ═══════════════
F.EVIDENCE[5] = (() => {
  const STEPS = [[1.0, 0], [1.5, 12], [2.0, 23], [2.5, 35], [3.0, 46]], ROLL = .28;
  const LXc = -.98, RXc = 1.2, COLS = 8, ROWSN = 6, PITCH = .19, CELL = .15;
  const count = u => { let v = 0; for (let k = 1; k < STEPS.length; k++) { const [t, n] = STEPS[k], p = STEPS[k - 1][1];
    if (u >= t) v = n; else if (u > t - ROLL) { v = Math.round(F.lerp(p, n, F.easeOut((u - t + ROLL) / (ROLL - .05)))); break; } else break; } return v; };
  let E, cells = [], teal, tealHot, gold, tray, trayP, panelP = [];
  return {
    build(scene, anchor) {
      E = EA.ctx(anchor);
      teal = F.glow(C.teal, .9); tealHot = F.glow(C.teal, 1.8); gold = F.glow(C.gold, 1.8);
      // 左：本机请求的格子（46 格依次点亮）
      const gx0 = LXc - (COLS - 1) * PITCH / 2, gy0 = 1.46;
      for (let k = 0; k < 46; k++) {
        const c = new THREE.Mesh(EA.mats().unit, EA.mats().recess); c.scale.set(CELL, CELL, .03);
        c.position.set(gx0 + (k % COLS) * PITCH, gy0 - Math.floor(k / COLS) * PITCH, .1); E.root.add(c); cells.push(c);
      }
      // 中间一道石膏分隔肋
      const rib = EA.chip(E, .05, 2.2, .06, EA.mats().chip, .18, 1.4);
      panelP.push(EA.piece(rib, { d: [0, 0, .6], axis: [0, 0, 1], ang: .1, t0: .9, t1: 1.3 }));
      // 右：付费请求的空托盘，金色细边
      tray = EA.chip(E, 1.2, .92, .03, EA.mats().recess, RXc, 1.0);
      trayP = EA.piece(tray, { d: [.4, 0, .8], axis: [0, 1, 0], ang: -.3, t0: 1.0, t1: 1.5 });
      for (const [w, h, x, y] of [[1.24, .025, 0, .47], [1.24, .025, 0, -.47], [.025, .96, .61, 0], [.025, .96, -.61, 0]]) {
        const b = new THREE.Mesh(EA.mats().unit, gold); b.scale.set(w, h, .03); b.position.set(x, y, .02); tray.add(b);
      }
      const g0 = G0(5);
      STEPS.slice(1).forEach(([t]) => F.ev(g0 + t, 'tick'));
      F.ev(g0 + 1.5, 'lock', { soft: true });
    },
    seek(u) {
      if (!E.show(u)) return;
      EA.pose(panelP, u); EA.pose([trayP], u);
      const v = count(u);
      cells.forEach((c, k) => {
        c.visible = u > 1.0;
        const lit = k < v;
        // 每拍新点亮的一段先亮一下，再退到常亮
        let hot = false; for (let s = 1; s < STEPS.length; s++) if (k >= STEPS[s - 1][1] && k < STEPS[s][1] && u >= STEPS[s][0] - ROLL && u < STEPS[s][0] + .3) hot = true;
        c.material = lit ? (hot ? tealHot : teal) : EA.mats().recess;
        c.scale.z = lit ? .05 : .03;
      });
      gold.emissiveIntensity = 1.8 + 1.2 * .5 * (1 + Math.sin(u * Math.PI * 2));   // 每小节一次缓慢呼吸：始终是 0
    },
    overlay(g, u, cam) {
      if (u < .9 || u > 7.2) return;
      E.begin(u);
      const ap = EA.appear(u, 1.0, .35);
      EA.label(g, E, cam, '本机请求', LXc, 2.56, { size: 26, weight: 500, color: '#C9C2B6', prog: ap });
      EA.label(g, E, cam, '付费请求', RXc, 2.56, { size: 26, weight: 500, color: '#C9C2B6', prog: ap });
      const v = count(u);
      EA.label(g, E, cam, String(v), LXc, 2.02, { size: 68, weight: 700, mono: true, color: '#7FE0D8', prog: ap });
      EA.label(g, E, cam, '0', RXc, 2.02, { size: 68, weight: 700, mono: true, color: C.gold, prog: ap });
    },
  };
})();
})();
