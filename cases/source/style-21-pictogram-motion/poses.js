// Poses for 一天 · ONE DAY. Unit = body height, origin = hip, figure faces +x.
// Angle convention (engine.js): limbs 0 = straight down, 90 = forward, 180 = overhead; arms in torso frame, legs in body frame;
// forearm / shin angles are absolute in that frame. rot = whole body pitch (−90 = lying on the back, head to −x).
// u = beats since the card started. Key actions land on the same u as the card's sfx in timeline.js.
(function () {
  const G = window.G, E = G.E, clamp = G.clamp, lerp = G.lerp, inv = G.inv;
  const P = (window.POSES = {});
  const D = G.D2R;
  const K = (keys, u, loop) => G.keyPose(keys, u, loop);
  const rr = (ctx, x, y, w, h, r, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); };
  const deg = (dx, dy) => Math.atan2(dx, dy) / D;   // direction → angle (0 = down, 90 = +x)
  // two-bone IK for a leg in the body frame (rot = 0): knee bends forward
  function legIK(hip, foot, L1 = G.LEN.th, L2 = G.LEN.sh, bend = 1) {
    const dx = foot[0] - hip[0], dy = foot[1] - hip[1];
    let d = Math.hypot(dx, dy); d = Math.min(d, L1 + L2 - 1e-4);
    const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    const base = Math.atan2(dx, dy);
    const k = [hip[0] + Math.sin(base + bend * a) * L1, hip[1] + Math.cos(base + bend * a) * L1];
    return [deg(k[0] - hip[0], k[1] - hip[1]), deg(foot[0] - k[0], foot[1] - k[1])];
  }
  G.legIK = legIK;
  // speed lines trailing back from (x, y)
  G.P = {
    speed: (ctx, x, y, len, n, C, a = 1) => {
      ctx.save(); ctx.globalAlpha *= a;
      for (let i = 0; i < n; i++) { ctx.fillStyle = C.line; ctx.fillRect(x - len * (0.6 + 0.4 * ((i * 37) % 10) / 10), y + (i - (n - 1) / 2) * 0.07, len * (0.5 + 0.5 * ((i * 53) % 10) / 10), 0.014); }
      ctx.restore();
    },
  };

  // ── shared props ──
  function bed(ctx, C, x0 = -0.66, x1 = 0.56, top = 0.2) {
    rr(ctx, x0, top, x1 - x0, 0.085, 0.04, C.line);                 // mattress
    rr(ctx, x0 - 0.02, top - 0.12, 0.05, 0.37, 0.025, C.line);     // headboard
    G.seg(ctx, [x0 + 0.04, top + 0.08], [x0 + 0.04, 0.45], 0.035, C.line);
    G.seg(ctx, [x1 - 0.04, top + 0.08], [x1 - 0.04, 0.45], 0.035, C.line);
    rr(ctx, x0 + 0.06, top - 0.07, 0.17, 0.07, 0.035, C.far);     // pillow
  }
  const floor = (ctx, C, y = 0.45, x0 = -0.75, x1 = 0.8) => { ctx.fillStyle = C.line; ctx.fillRect(x0, y, x1 - x0, 0.014); };
  function stool(ctx, C, x = 0, top = 0.07) {
    rr(ctx, x - 0.12, top, 0.24, 0.04, 0.02, C.line);
    G.seg(ctx, [x, top + 0.04], [x, 0.45], 0.03, C.line);
    G.seg(ctx, [x - 0.1, 0.45], [x + 0.1, 0.45], 0.03, C.line);
  }

  // 01 起床 — lying, alarm rings (u0), sits up on u1, stretches on u2
  const LIE = { x: -0.06, y: 0.13, rot: -90, torso: 0, head: -4, aR1: 6, aR2: 8, aL1: 2, aL2: 4, lR1: 0, lR2: 0, lL1: 2, lL2: 2 };
  const SIT = { x: -0.06, y: 0.13, rot: 0, torso: 6, head: 6, aR1: 30, aR2: 60, aL1: 20, aL2: 50, lR1: 90, lR2: 90, lL1: 88, lL2: 88 };
  P.wake = {
    keys: [
      { b: 0, ...LIE },
      { b: 0.55, ...LIE, rot: -84, torso: -4 },                                   // anticipation: sinks back a little
      { b: 1, ...SIT, torso: 14, e: 'oExp' },                                      // sit up — contact on the beat
      { b: 1.45, ...SIT, torso: 2, aR1: 40, aR2: 70 },
      { b: 2, ...SIT, torso: -6, head: -10, aR1: 146, aR2: 150, aL1: 206, aL2: 212, e: 'oExp' },   // stretch on u2: a wide V
      { b: 3.2, ...SIT, torso: -10, head: -14, aR1: 150, aR2: 156, aL1: 210, aL2: 218 },
      { b: 4, ...SIT, torso: 4, head: 4, aR1: 120, aR2: 150, aL1: 112, aL2: 140 },
    ],
    back: (ctx, J, u, C) => {
      bed(ctx, C);
      // alarm clock on a little stand; shakes while it rings (u 0..1)
      const sh = u < 1 ? Math.sin(u * 2 * Math.PI * 8) * 0.012 : 0;
      G.seg(ctx, [0.72, 0.13], [0.72, 0.45], 0.03, C.line); rr(ctx, 0.62, 0.11, 0.2, 0.03, 0.015, C.line);
      ctx.save(); ctx.translate(0.72 + sh, 0.02); ctx.rotate(sh * 6);
      G.disc(ctx, -0.045, -0.06, 0.03, C.acc); G.disc(ctx, 0.045, -0.06, 0.03, C.acc);
      G.disc(ctx, 0, 0, 0.065, C.acc); G.disc(ctx, 0, 0, 0.045, C.bg);
      G.seg(ctx, [0, 0], [0, -0.03], 0.012, C.acc); G.seg(ctx, [0, 0], [0.022, 0.01], 0.012, C.acc);
      ctx.restore();
      if (u < 1) for (let i = 0; i < 3; i++) {   // ring lines
        const a = (-60 + i * 30) * D, k = 0.5 + 0.5 * Math.sin(u * Math.PI * 8);
        G.seg(ctx, [0.72 + Math.sin(a) * 0.1, 0.02 - Math.cos(a) * 0.1], [0.72 + Math.sin(a) * (0.13 + 0.03 * k), 0.02 - Math.cos(a) * (0.13 + 0.03 * k)], 0.014, C.acc);
      }
      floor(ctx, C);
    },
    iconU: 2.5,
  };

  // 02 刷牙 — brush strokes on every 8th
  P.brush = {
    pose: (u) => {
      const s = u > 0.3 && u < 3.4 ? Math.sin((u - 0.5) * 2 * Math.PI * 2) : 0;    // 2 cycles per beat → stroke reversal on 8ths
      return { torso: 3, head: 4 + s * 1.5, aR1: 38 + s * 4, aR2: 172 + s * 9, aL1: 18, aL2: 96, lR1: 5, lR2: 5, lL1: -6, lL2: -6, y: Math.abs(s) * 0.004 };
    },
    back: (ctx, J, u, C) => {
      floor(ctx, C);
      G.ring(ctx, 0.42, -0.45, 0.17, 0.022, C.line);                 // mirror
      rr(ctx, 0.26, 0.02, 0.34, 0.05, 0.025, C.line);                 // basin
      G.seg(ctx, [0.43, 0.07], [0.43, 0.45], 0.03, C.line);
    },
    front: (ctx, J, u, C) => {
      const h = J.aR[2];
      G.seg(ctx, h, [h[0] - 0.03, h[1] - 0.1], 0.02, C.acc);           // brush handle
      rr(ctx, h[0] - 0.075, h[1] - 0.125, 0.07, 0.03, 0.012, C.acc);   // brush head
      const c = J.aL[2]; rr(ctx, c[0] - 0.02, c[1] - 0.07, 0.07, 0.09, 0.012, C.acc);   // cup
      if (u > 0.3 && u < 3.4) for (let i = 0; i < 3; i++) {   // foam dots
        const k = (u * 4 + i * 0.33) % 1; G.disc(ctx, h[0] - 0.08 + i * 0.03, h[1] - 0.16 - k * 0.06, 0.008 * (1 - k), C.fg);
      }
    },
    iconU: 1.5,
  };

  // 03 跑步 — contacts on 8ths
  P.run = {
    pose: (u) => ({ ...G.runCycle(u + 0.25, 1, { lean: 14 }), y: -Math.abs(Math.cos((u + 0.25) * Math.PI * 2)) * 0.03 + 0.012 }),
    back: (ctx, J, u, C) => {
      ctx.fillStyle = C.line; ctx.fillRect(-0.8, 0.455, 1.6, 0.014);
      for (let i = 0; i < 7; i++) {   // ground dashes rushing back
        const x = 0.8 - ((u * 0.9 + i * 0.26) % 1.8); ctx.fillRect(x, 0.5, 0.11, 0.012);
      }
      G.P.speed(ctx, -0.22, -0.1, 0.4, 4, C, 0.9);
    },
    iconU: 0.5,
  };

  // 04 地铁 — strap overhead, the carriage sways on the beats, windows rush past
  P.subway = {
    pose: (u) => {
      const sw = Math.sin(u * Math.PI) * 4;   // sways out and back over each beat pair
      return { rot: sw * 0.5, torso: -2 + sw, head: 2, aR1: 168 - sw, aR2: 176 - sw, aL1: -6, aL2: -2, lR1: 9, lR2: 9, lL1: -9, lL2: -9 };
    },
    back: (ctx, J, u, C) => {
      // carriage: window band rushing to the left
      for (let i = 0; i < 6; i++) {
        const x = 0.9 - ((u * 0.75 + i * 0.36) % 2.16);
        rr(ctx, x, -0.62, 0.28, 0.34, 0.05, C.far2);
      }
      ctx.fillStyle = C.line; ctx.fillRect(-1.0, -0.86, 2.0, 0.02);      // overhead bar
      ctx.fillRect(-1.0, 0.45, 2.0, 0.016);                               // floor
      const h = J.aR[2]; G.seg(ctx, [h[0], -0.86], [h[0], h[1] - 0.03], 0.014, C.line);
    },
    front: (ctx, J, u, C) => {
      const h = J.aR[2]; G.ring(ctx, h[0], h[1] - 0.01, 0.035, 0.016, C.acc);
      const b = J.aL[2]; rr(ctx, b[0] - 0.06, b[1] - 0.02, 0.13, 0.11, 0.025, C.acc);
    },
    fig: { x: 0, y: 0 },
    iconU: 0.5,
  };

  // seated base (stool), used by 05 打字 / 07 吃饭
  const SEAT = { x: 0, y: 0.03, rot: 0, torso: 8, head: 6, lR1: 90, lR2: 4, lL1: 84, lL2: -2 };
  // 05 打字 — 16th-note key taps, alternating hands
  P.type = {
    pose: (u) => {
      const a = Math.sin(u * 2 * Math.PI * 2), b = -a;
      return { ...SEAT, torso: 14, head: 10, aR1: 52, aR2: 96 + Math.max(0, a) * 12, aL1: 46, aL2: 90 + Math.max(0, b) * 12 };
    },
    back: (ctx, J, u, C) => {
      floor(ctx, C); stool(ctx, C, -0.02);
      ctx.fillStyle = C.line; ctx.fillRect(0.12, -0.04, 0.72, 0.03);                 // desk
      G.seg(ctx, [0.76, -0.01], [0.76, 0.45], 0.03, C.line);
      ctx.save(); ctx.translate(0.6, -0.04); ctx.rotate(-12 * D);
      rr(ctx, -0.02, -0.32, 0.035, 0.32, 0.015, C.acc); ctx.restore();          // screen
      rr(ctx, 0.3, -0.06, 0.32, 0.025, 0.01, C.acc);                             // keyboard
    },
    iconU: 0.6,
  };

  // 06 开会 — taps the board (a bar grows each tap), a colleague raises a hand on u1.5
  P.meet = {
    keys: [
      { b: 0, torso: 2, aR1: 70, aR2: 80, aL1: -4, aL2: 10, lR1: 6, lR2: 6, lL1: -8, lL2: -8 },
      { b: 0.5, torso: 4, aR1: 102, aR2: 108, aL1: -4, aL2: 10, e: 'oExp' },
      { b: 0.75, torso: 3, aR1: 94, aR2: 100, aL1: -4, aL2: 10 },
      { b: 1, torso: 5, aR1: 112, aR2: 122, aL1: -4, aL2: 10, e: 'oExp' },
      { b: 2, torso: 4, aR1: 108, aR2: 116, aL1: -4, aL2: 10 },
    ],
    second: (u) => {
      const k = E.oExp(inv(1.25, 1.5, u));
      return { ...SEAT, torso: 4, aR1: lerp(40, 168, k), aR2: lerp(90, 176, k), aL1: 40, aL2: 90 };
    },
    secondX: [-0.5, 0.0], fig: { x: -0.04, y: 0 },
    back: (ctx, J, u, C) => {
      floor(ctx, C, 0.45, -0.95, 0.9);
      rr(ctx, 0.3, -0.78, 0.44, 0.5, 0.03, C.far2);                   // board
      const hs = [0.12, 0.2, 0.3];
      for (let i = 0; i < 3; i++) {
        const k = i === 0 ? 1 : E.oExp(inv(i === 1 ? 0.5 : 1, (i === 1 ? 0.5 : 1) + 0.2, u));
        const h = hs[i] * k; ctx.fillStyle = i === 2 ? C.acc : C.line; ctx.fillRect(0.38 + i * 0.11, -0.34 - h, 0.07, h);
      }
      ctx.save(); ctx.translate(-0.5, 0); stool(ctx, C, -0.02); ctx.restore();
    },
    iconU: 1.2,
  };

  // 07 吃饭 — chopsticks to the mouth on u0.5 and u1.5, back to the bowl on u1
  P.eat = {
    keys: [
      { b: 0, ...SEAT, aR1: 44, aR2: 120, aL1: 30, aL2: 96 },
      { b: 0.5, ...SEAT, head: -2, aR1: 34, aR2: 168, aL1: 30, aL2: 96, e: 'oExp' },
      { b: 1, ...SEAT, aR1: 46, aR2: 118, aL1: 30, aL2: 96, e: 'oExp' },
      { b: 1.5, ...SEAT, head: -2, aR1: 34, aR2: 168, aL1: 30, aL2: 96, e: 'oExp' },
      { b: 2, ...SEAT, aR1: 44, aR2: 124, aL1: 30, aL2: 96 },
    ],
    back: (ctx, J, u, C) => {
      floor(ctx, C); stool(ctx, C, -0.02);
      ctx.fillStyle = C.line; ctx.fillRect(0.16, 0.0, 0.6, 0.03); G.seg(ctx, [0.68, 0.03], [0.68, 0.45], 0.03, C.line);
    },
    front: (ctx, J, u, C) => {
      const b = J.aL[2];
      ctx.fillStyle = C.acc; ctx.beginPath(); ctx.arc(b[0] + 0.04, b[1] - 0.02, 0.08, 0, Math.PI); ctx.fill();   // bowl
      G.disc(ctx, b[0] + 0.04, b[1] - 0.035, 0.05, C.fg);
      const h = J.aR[2], a = Math.atan2(J.aR[2][0] - J.aR[1][0], J.aR[2][1] - J.aR[1][1]);
      for (const o of [0, 0.02]) G.seg(ctx, [h[0] + o, h[1]], [h[0] + o + Math.sin(a) * 0.16, h[1] + Math.cos(a) * 0.16], 0.012, C.acc);
    },
    iconU: 0.5,
  };

  // 08 骑车 — pedalling (feet solved by IK on the crank)
  P.bike = {
    pose: (u) => {
      const th = u * 2 * Math.PI * 1.5, bb = [0.06, 0.3], r = 0.1;
      const fR = [bb[0] + Math.cos(th) * r, bb[1] + Math.sin(th) * r], fL = [bb[0] - Math.cos(th) * r, bb[1] - Math.sin(th) * r];
      const hip = [0, 0];
      const [lR1, lR2] = legIK(hip, fR), [lL1, lL2] = legIK(hip, fL);
      return { torso: 34, head: -14, aR1: 74, aR2: 84, aL1: 70, aL2: 80, lR1, lR2, lL1, lL2 };
    },
    back: (ctx, J, u, C) => {
      const wa = u * 2 * Math.PI * 1.5;
      for (const x of [-0.36, 0.44]) {
        G.ring(ctx, x, 0.3, 0.17, 0.028, C.line);
        for (let i = 0; i < 3; i++) { const a = wa + i * Math.PI / 3; G.seg(ctx, [x - Math.cos(a) * 0.15, 0.3 - Math.sin(a) * 0.15], [x + Math.cos(a) * 0.15, 0.3 + Math.sin(a) * 0.15], 0.008, C.line); }
      }
      const L = (a, b) => G.seg(ctx, a, b, 0.03, C.acc);
      L([-0.36, 0.3], [0.06, 0.3]); L([0.06, 0.3], [0.0, 0.02]); L([-0.36, 0.3], [0.0, 0.02]); L([0.0, 0.02], [0.34, -0.02]); L([0.06, 0.3], [0.34, -0.02]);
      L([0.34, -0.02], [0.44, 0.3]); L([0.34, -0.02], [0.3, -0.12]); L([0.26, -0.12], [0.36, -0.12]);
      rr(ctx, -0.07, 0.0, 0.14, 0.035, 0.017, C.acc);
      ctx.fillStyle = C.line; ctx.fillRect(-0.8, 0.47, 1.6, 0.014);
      G.P.speed(ctx, -0.5, -0.05, 0.35, 3, C, 0.8);
    },
    fig: { x: -0.04, y: -0.02 },
    iconU: 0.3,
  };

  // 09 买菜 — walking with a full bag
  P.shop = {
    pose: (u) => ({ ...G.walkCycle(u * 1.0, 1), aR1: 6, aR2: 8 }),
    back: (ctx, J, u, C) => floor(ctx, C),
    front: (ctx, J, u, C) => {
      const h = J.aR[2];
      G.seg(ctx, [h[0] + 0.01, h[1] + 0.02], [h[0] + 0.16, h[1] - 0.18], 0.022, C.fg);   // leek
      G.disc(ctx, h[0] + 0.17, h[1] - 0.2, 0.035, C.fg);
      rr(ctx, h[0] - 0.08, h[1] + 0.0, 0.17, 0.16, 0.03, C.acc);                     // bag
    },
    iconU: 0.25,
  };

  // 10 做饭 — pan toss on u0.5
  P.cook = {
    keys: [
      { b: 0, torso: 6, aR1: 58, aR2: 84, aL1: 10, aL2: 70, lR1: 6, lR2: 6, lL1: -6, lL2: -6 },
      { b: 0.4, torso: 7, aR1: 52, aR2: 76, aL1: 10, aL2: 70 },
      { b: 0.5, torso: 5, aR1: 68, aR2: 100, aL1: 10, aL2: 70, e: 'oExp' },
      { b: 1, torso: 6, aR1: 62, aR2: 90, aL1: 10, aL2: 70 },
    ],
    back: (ctx, J, u, C) => {
      floor(ctx, C);
      rr(ctx, 0.2, -0.04, 0.6, 0.07, 0.02, C.line); G.seg(ctx, [0.3, 0.03], [0.3, 0.45], 0.03, C.line); G.seg(ctx, [0.7, 0.03], [0.7, 0.45], 0.03, C.line);
      for (let i = 0; i < 3; i++) {   // flames
        const f = 0.05 + 0.02 * Math.sin(u * 30 + i * 2);
        G.poly(ctx, [[0.42 + i * 0.07, -0.04], [0.45 + i * 0.07, -0.04 - f], [0.48 + i * 0.07, -0.04]], C.acc);
      }
    },
    front: (ctx, J, u, C) => {
      const h = J.aR[2], a = (J.p.aR2 - 90) * D;
      const e = [h[0] + Math.cos(a) * 0.14, h[1] + Math.sin(a) * 0.14];
      G.seg(ctx, h, e, 0.026, C.fg);
      ctx.save(); ctx.translate(e[0] + Math.cos(a) * 0.12, e[1] + Math.sin(a) * 0.12); ctx.rotate(a);
      rr(ctx, -0.13, -0.02, 0.26, 0.045, 0.022, C.fg); ctx.restore();
      const k = inv(0.5, 1, u), fy = -0.42 * 4 * k * (1 - k * 0.7);   // food flies up after the toss
      G.disc(ctx, e[0] + 0.12 + k * 0.03, e[1] - 0.05 + fy, 0.035, C.acc); G.disc(ctx, e[0] + 0.06 - k * 0.02, e[1] - 0.05 + fy * 0.8, 0.025, C.acc);
    },
    iconU: 0.7,
  };

  // 11 洗碗 — plate in one hand, the other scrubs in circles, the tap runs
  P.dish = {
    pose: (u) => { const s = Math.sin(u * 2 * Math.PI * 2), c = Math.cos(u * 2 * Math.PI * 2); return { torso: 10, head: 12, aL1: 36, aL2: 92, aR1: 50 + s * 6, aR2: 104 + c * 10, lR1: 5, lR2: 5, lL1: -5, lL2: -5 }; },
    back: (ctx, J, u, C) => {
      floor(ctx, C);
      rr(ctx, 0.18, 0.02, 0.6, 0.06, 0.025, C.line); G.seg(ctx, [0.62, 0.08], [0.62, 0.45], 0.03, C.line);
      G.seg(ctx, [0.62, 0.02], [0.62, -0.32], 0.026, C.line); G.seg(ctx, [0.62, -0.32], [0.48, -0.32], 0.026, C.line);
      for (let i = 0; i < 4; i++) { const k = (u * 3 + i * 0.25) % 1; G.disc(ctx, 0.48, -0.28 + k * 0.28, 0.012, C.fg); }
    },
    front: (ctx, J, u, C) => {
      const p = J.aL[2]; G.disc(ctx, p[0] + 0.05, p[1] - 0.04, 0.1, C.acc); G.disc(ctx, p[0] + 0.05, p[1] - 0.04, 0.06, C.bg);
      const h = J.aR[2]; rr(ctx, h[0] - 0.035, h[1] - 0.03, 0.07, 0.05, 0.015, C.fg);
    },
    iconU: 0.3,
  };

  // ── ½-beat run: one clear pose each, a little motion inside the half beat ──
  P.shower = {
    pose: (u) => ({ torso: -2, head: -8, aR1: 150, aR2: 206, aL1: 158, aL2: 214, lR1: 4, lR2: 4, lL1: -4, lL2: -4 }),
    back: (ctx, J, u, C) => {
      floor(ctx, C);
      G.seg(ctx, [0.42, 0.45], [0.42, -0.86], 0.026, C.line); G.seg(ctx, [0.42, -0.86], [0.2, -0.86], 0.026, C.line);
      ctx.fillStyle = C.acc; ctx.beginPath(); ctx.arc(0.14, -0.84, 0.08, 0, Math.PI); ctx.fill();
      for (let i = 0; i < 14; i++) { const x = 0.0 + (i % 7) * 0.045, k = (u * 4 + i * 0.137) % 1; ctx.fillStyle = C.fg; ctx.fillRect(x + 0.03 - k * 0.06, -0.74 + k * 1.1, 0.01, 0.05); }
    },
    iconU: 0.2,
  };
  P.dryer = {
    pose: (u) => ({ torso: 4, head: 8, aR1: 116, aR2: 150, aL1: 150, aL2: 214, lR1: 4, lR2: 4, lL1: -4, lL2: -4 }),
    back: (ctx, J, u, C) => floor(ctx, C),
    front: (ctx, J, u, C) => {
      const h = J.aR[2];
      rr(ctx, h[0] - 0.02, h[1] - 0.03, 0.04, 0.12, 0.02, C.acc);            // grip
      rr(ctx, h[0] - 0.13, h[1] - 0.09, 0.2, 0.07, 0.035, C.acc);           // body
      for (let i = 0; i < 3; i++) { const k = (u * 6 + i / 3) % 1; ctx.fillStyle = C.fg; ctx.fillRect(h[0] - 0.2 - k * 0.1, h[1] - 0.085 + i * 0.025, 0.05, 0.01); }
    },
    iconU: 0.2,
  };
  P.hang = {
    pose: (u) => ({ torso: -4, head: -10, aR1: 146, aR2: 160, aL1: 140, aL2: 152, lR1: 4, lR2: 4, lL1: -4, lL2: -4 }),
    back: (ctx, J, u, C) => { floor(ctx, C); ctx.fillStyle = C.line; ctx.fillRect(-0.7, -0.56, 1.5, 0.014); },
    front: (ctx, J, u, C) => {
      const h = J.aR[2], x = h[0] + 0.02, y = -0.55;
      G.poly(ctx, [[x - 0.17, y], [x + 0.17, y], [x + 0.24, y + 0.08], [x + 0.13, y + 0.12], [x + 0.13, y + 0.36], [x - 0.13, y + 0.36], [x - 0.13, y + 0.12], [x - 0.24, y + 0.08]], C.acc);
      G.seg(ctx, [x, y - 0.06], [x, y], 0.012, C.fg);
    },
    iconU: 0.2,
  };
  P.plant = {
    pose: (u) => ({ torso: 8, head: 10, aR1: 66, aR2: 80, aL1: -2, aL2: 4, lR1: 6, lR2: 6, lL1: -6, lL2: -6 }),
    back: (ctx, J, u, C) => {
      floor(ctx, C);
      G.poly(ctx, [[0.48, 0.3], [0.68, 0.3], [0.65, 0.45], [0.51, 0.45]], C.line);
      G.seg(ctx, [0.58, 0.3], [0.58, 0.12], 0.016, C.fg); G.disc(ctx, 0.53, 0.17, 0.045, C.fg); G.disc(ctx, 0.63, 0.12, 0.05, C.fg);
    },
    front: (ctx, J, u, C) => {
      const h = J.aR[2];
      rr(ctx, h[0] - 0.06, h[1] - 0.02, 0.16, 0.12, 0.03, C.acc);
      G.seg(ctx, [h[0] + 0.09, h[1] + 0.05], [h[0] + 0.2, h[1] + 0.12], 0.02, C.acc);
      for (let i = 0; i < 4; i++) { const k = (u * 4 + i * 0.25) % 1; G.disc(ctx, h[0] + 0.21 + k * 0.03, h[1] + 0.15 + k * 0.2, 0.01, C.fg); }
    },
    iconU: 0.2,
  };
  P.drink = {
    pose: (u) => ({ torso: -6, head: -22, aR1: 44, aR2: 168, aL1: -4, aL2: 4, lR1: 4, lR2: 4, lL1: -4, lL2: -4 }),
    back: (ctx, J, u, C) => floor(ctx, C),
    front: (ctx, J, u, C) => { const h = J.aR[2]; ctx.save(); ctx.translate(h[0] + 0.02, h[1] - 0.06); ctx.rotate(-35 * D); rr(ctx, -0.035, -0.06, 0.07, 0.12, 0.012, C.acc); ctx.restore(); },
    iconU: 0.2,
  };
  P.stretch = {
    pose: (u) => ({ torso: -6, head: -6, aR1: 176, aR2: 182, aL1: 170, aL2: 176, lR1: 52, lR2: 2, lL1: -34, lL2: -30, y: 0.06 }),
    back: (ctx, J, u, C) => floor(ctx, C),
    iconU: 0.2,
  };
  P.phone = {
    pose: (u) => ({ torso: 6, head: 26, aR1: 28, aR2: 118, aL1: 22, aL2: 112, lR1: 4, lR2: 4, lL1: -4, lL2: -4 }),
    back: (ctx, J, u, C) => floor(ctx, C),
    front: (ctx, J, u, C) => {
      const h = J.aR[2]; ctx.save(); ctx.translate(h[0] + 0.02, h[1] - 0.04); ctx.rotate(-30 * D);
      rr(ctx, -0.04, -0.07, 0.08, 0.14, 0.015, C.acc); rr(ctx, -0.028, -0.055, 0.056, 0.11, 0.008, C.fg); ctx.restore();
    },
    iconU: 0.2,
  };
  const READ = { torso: 4, head: 18, aR1: 30, aR2: 122, aL1: 24, aL2: 114, lR1: 4, lR2: 4, lL1: -4, lL2: -4 };
  function book(ctx, J, C, open = 1) {
    const h = J.aR[2], x = h[0] + 0.02, y = h[1] - 0.06;
    const a = lerp(0.12, 0.0, 1 - open);
    G.poly(ctx, [[x, y + 0.02], [x - 0.13 * open - 0.01, y - a], [x - 0.13 * open - 0.01, y - a - 0.13], [x, y - 0.11]], C.acc);
    G.poly(ctx, [[x, y + 0.02], [x + 0.13 * open + 0.01, y - a], [x + 0.13 * open + 0.01, y - a - 0.13], [x, y - 0.11]], C.fg);
  }
  P.read = { pose: () => READ, back: (ctx, J, u, C) => floor(ctx, C), front: (ctx, J, u, C) => book(ctx, J, C, 1), iconU: 0.2 };

  // 20 睡觉 — frozen while reading (u0), closes the book (u1), sits on the bed (u2), lies down (u3 → u3.25)
  const BED = { x0: -0.7, x1: 0.52 };
  const STAND = { ...READ, x: 0.3, y: 0 };
  const SITB = { x: 0.48, y: 0.13, rot: 0, torso: 10, head: 8, aR1: 20, aR2: 70, aL1: 14, aL2: 60, lR1: 90, lR2: 8, lL1: 86, lL2: 2 };
  const LIEB = { x: -0.03, y: 0.13, rot: -90, torso: 0, head: -4, aR1: 8, aR2: 10, aL1: 4, aL2: 6, lR1: 0, lR2: 0, lL1: 2, lL2: 2 };
  P.sleep = {
    keys: [
      { b: 0, ...STAND },
      { b: 1, ...STAND, head: 10, aR1: 18, aR2: 96, aL1: 14, aL2: 90, e: 'oExp' },        // book closes on u1
      { b: 1.6, ...STAND, head: 6, aR1: 10, aR2: 40, aL1: 8, aL2: 30 },
      { b: 2, ...SITB, e: 'io3' },                                                          // sits on the bed edge on u2
      { b: 2.45, ...SITB, torso: 18, rot: -6 },                                             // anticipation: leans forward
      { b: 3, ...LIEB, x: 0.02, rot: -86, e: 'io3' },                                       // swings in — lands on u3
      { b: 3.25, ...LIEB, e: 'oExp' },
      { b: 9, ...LIEB },
    ],
    back: (ctx, J, u, C) => { bed(ctx, C, BED.x0, BED.x1); floor(ctx, C, 0.45, -0.85, 1.0); },
    front: (ctx, J, u, C) => {
      if (u < 1.6) book(ctx, J, C, 1 - E.oExp(inv(0.6, 1, u)));
      // blanket after lying down
      const k = E.o3(inv(3.1, 3.8, u));
      if (k > 0) rr(ctx, -0.22, 0.13 - 0.085 * k, 0.72, 0.1 * k + 0.02, 0.04, C.acc);
    },
    iconU: 5,
  };
})();
