import { drawActorProfile } from './actor-profile.js';
import { C, MATERIAL as S, stage, shape, ink, line, ellipse, screw, grip, ease } from './actor-paint.js';

// Small back view, feet fixed to the bow. Movement travels through hips,
// shoulders and hair instead of translating the entire figure off the deck.
export function paintDeck(g, t, W, H, opts) {
  stage(g, W, H, 0.51, 0.86, () => {
    const sway = 2.3 * Math.sin(t * 0.49) + 1.2 * Math.sin(t * 0.17 + 0.8);
    ellipse(g, 0, 4, 77, 11, C.ink, 0.2);
    shape(g, 'M -39 -104 L -4 -102 L -9 -14 C -17 -2 -27 1 -46 -1 L -53 -10 Z', C.cloth, t);
    shape(g, 'M 7 -103 L 41 -102 L 53 -13 C 47 2 28 4 15 -2 L 13 -19 Z', C.cloth, t);
    shape(g, 'M -48 -17 C -29 -18 -18 -14 -12 -3 L -17 7 L -61 7 C -66 1 -59 -10 -48 -17 Z', C.frame, t);
    shape(g, 'M 17 -16 C 35 -18 45 -14 52 -5 L 68 1 L 68 8 L 18 8 Z', C.frame, t);
    ink(g, 'M -39 -92 C -35 -60 -37 -37 -41 -23 M 30 -91 C 35 -60 35 -38 39 -22', t, { color: C.clothLift, size: 2 });
    g.save(); g.translate(sway, -102); g.rotate(sway * 0.0025);
    shape(g, `M -37 -167 C -67 -161 -75 -137 -75 -100 L -65 -13
      C -59 1 -50 2 -43 -7 L -47 -95 L -28 -128 Z`, C.cloth, t);
    shape(g, `M 36 -167 C 66 -161 75 -141 78 -104 L 67 -17
      C 61 -2 50 -1 46 -10 L 48 -97 L 29 -133 Z`, C.cloth, t);
    shape(g, 'M -65 -16 C -67 -5 -66 8 -60 14 C -57 19 -53 18 -52 11 C -46 19 -41 12 -43 2 L -46 -13 Z', C.hand, t, { size: 1.4 });
    shape(g, 'M 49 -15 C 45 -2 46 10 51 14 C 55 19 59 15 60 9 C 63 16 69 11 67 2 L 65 -14 Z', C.hand, t, { size: 1.4 });
    shape(g, 'M -24 -193 L 23 -193 L 28 -159 C 13 -143 -13 -143 -29 -160 Z', C.skin, t);
    shape(g, `M -29 -173 C -46 -176 -58 -165 -60 -144 L -56 -11
      C -23 4 23 5 56 -12 L 60 -144 C 57 -165 43 -176 28 -172
      C 15 -149 -15 -148 -29 -173 Z`, C.vest, t, { seed: 57 });
    shape(g, 'M -53 -137 C -34 -126 -29 -61 -32 -5 L -54 -12 Z M 41 -150 C 53 -111 45 -44 31 -3 L 56 -12 L 59 -141 Z', C.vestDeep, t, { outline: false });
    ink(g, 'M 0 -144 C -3 -104 -2 -54 0 -6 M -49 -112 C -25 -103 26 -103 50 -113', t, { size: 1.5, seed: 58 });
    shape(g, 'M -58 -52 C -25 -44 24 -44 56 -54 L 55 -40 C 20 -31 -24 -32 -57 -40 Z', C.cloth, t);
    shape(g, 'M -44 -151 L -23 -146 L -22 -121 L -44 -127 Z M 24 -145 L 44 -151 L 45 -127 L 24 -121 Z', S.shellShade, t, { size: 1 });
    ink(g, 'M 39 -168 C 55 -161 59 -146 57 -122', t, { color: C.vestRim, size: 4, alpha: 0.9 });
    // Nape and short uneven windblown haircut, matching the sample silhouette.
    shape(g, `M -37 -205 C -47 -218 -44 -240 -34 -253 C -24 -271 6 -277 29 -265
      C 49 -254 48 -233 44 -221 L 52 -207 L 41 -205 L 45 -191 L 30 -194
      L 29 -181 L 13 -189 L 5 -178 L -6 -189 L -21 -181 L -25 -194 L -42 -188 L -38 -202 Z`, C.hair, t, { seed: 91 });
    for (const [i, p] of ['M -30 -249 C -12 -263 13 -263 33 -247', 'M -34 -231 C -18 -245 16 -242 35 -227',
      'M -23 -216 C -10 -228 12 -224 23 -210'].entries()) ink(g, p, t, { color: C.hairLift, size: 1.7, seed: 70 + i });
    const flutter = 2.4 * Math.sin(t * 1.9) + 1.6 * Math.sin(t * 0.73);
    ink(g, `M -34 -249 C -43 -241 -49 -224 ${-52 - flutter} -213 M 28 -265 C 42 -260 48 -249 ${51 + flutter} -241`, t, { color: C.skyRim, size: 1.3, seed: 301 });
    if (opts.glasses) ink(g, 'M 41 -227 L 46 -225 L 46 -218', t, { color: C.frame, size: 3.4 });
    g.restore();
    // A low fore rail, drawn in front of the hips; the world supplies the hull.
    line(g, 'M -178 -106 C -104 -117 109 -117 180 -106', C.ink, 9);
    line(g, 'M -178 -109 C -104 -120 109 -120 180 -109', C.hairLift, 5);
    ink(g, 'M -176 -108 L -178 32 M 177 -108 L 181 32', t, { size: 5, color: C.clothLift, t0: 0, t1: 0 });
  });
}

export function paintHelm(g, t, W, H, opts) {
  // Same original profile model, framed as a waist-up operator.
  g.save(); g.translate(W * 0.16, H * 0.08); g.scale(0.58, 0.58);
  drawActorProfile(g, t, W, H, { ...opts, cam: false, touch: false, extendBody: true }); g.restore();
  stage(g, W, H, 0.59, 0.72, () => {
    const turn = 0.12 * Math.sin(t * 0.17) + 0.035 * Math.sin(t * 0.43) + (ease(opts.progress) - 0.5) * 0.16;
    shape(g, 'M -242 129 C -114 90 138 86 248 126 L 294 345 L -292 345 Z', C.cloth, t);
    shape(g, 'M -233 129 C -78 102 103 98 237 129 L 243 163 C 91 134 -72 139 -240 166 Z', C.hairLift, t);
    // Arms are broad, bent cloth volumes connected to the profile shoulder.
    shape(g, `M -402 -130 C -375 -168 -326 -164 -305 -137 C -286 -107 -266 -67 -228 -53
      L -134 -84 L -112 -32 C -177 4 -242 20 -281 -6 C -325 -36 -374 -65 -402 -130 Z`, C.cloth, t);
    shape(g, `M -317 -145 C -297 -170 -265 -168 -246 -145 C -205 -112 -173 -79 -122 -81
      C -51 -85 -8 -131 57 -141 L 79 -99 C 21 -62 -51 -26 -120 -25 C -209 -26 -266 -68 -317 -145 Z`, C.cloth, t);
    ink(g, 'M -370 -123 C -346 -87 -315 -64 -285 -57 M -274 -137 C -231 -104 -184 -67 -138 -62', t, { color: C.clothLift, size: 4, seed: 61 });
    g.save(); g.rotate(turn);
    // Six-spoke wooden/painted marine wheel with raised hub and bolted rim.
    for (let i = 0; i < 6; i++) {
      g.save(); g.rotate(i * Math.PI / 3);
      shape(g, 'M -12 15 C -10 -40 -12 -96 -14 -143 L 14 -143 C 12 -94 10 -38 12 15 Z', C.hairLift, t);
      shape(g, 'M -10 -145 L -12 -184 C -11 -198 11 -198 12 -184 L 10 -145 Z', C.cloth, t);
      ink(g, 'M 6 -185 L 6 -158', t, { color: C.rim, size: 2, alpha: 0.7 }); g.restore();
    }
    const rim = 'M 154 0 C 154 85 85 154 0 154 C -85 154 -154 85 -154 0 C -154 -85 -85 -154 0 -154 C 85 -154 154 -85 154 0 Z';
    line(g, rim, C.ink, 27); line(g, rim, C.hairLift, 20); line(g, rim, C.skin, 10);
    ink(g, 'M 145 -38 C 126 -112 69 -147 -2 -147', t, { color: C.rim, size: 3.8, seed: 410 });
    ellipse(g, 0, 0, 36, 36, C.frame); ellipse(g, 0, 0, 27, 27, C.hairLift);
    for (const a of [0, 2.1, 4.2]) screw(g, Math.cos(a) * 18, Math.sin(a) * 18, t, 4);
    // Both contact points rotate with the wheel; cuffs cover the arm ends.
    grip(g, t, -137, -60, 0.43, -0.65, true);
    grip(g, t, 80, -132, 0.43, 0.8);
    g.restore();
  });
}

export function paintRadio(g, t, W, H, opts) {
  stage(g, W, H, 0.54, 0.53, () => {
    g.scale(1.25, 1.25);
    g.rotate(-0.1 + 0.012 * Math.sin(t * 0.63));
    const squeeze = opts.talking ? 0.5 + 0.5 * Math.sin(t * 3.1) : 0;
    // Palm behind the body, wrist and tailored sleeve.
    shape(g, 'M -95 122 C -159 124 -174 172 -140 231 L -110 359 L 78 360 C 64 288 71 236 109 175 L 116 46 C 113 20 91 10 78 30 L 24 123 Z', C.hand, t);
    shape(g, 'M -122 295 C -74 277 36 277 82 300 L 115 560 L -183 560 Z', C.cloth, t);
    ink(g, 'M -120 314 C -59 295 33 299 85 319', t, { color: C.clothLift, size: 4 });
    // Antenna with a rubber ferrule; controls and body bevels are separate shapes.
    shape(g, 'M -75 -191 L -78 -410 C -76 -423 -62 -423 -59 -411 L -51 -193 Z', C.frame, t);
    ink(g, 'M -64 -398 L -59 -211', t, { color: C.hairLift, size: 2.3 });
    shape(g, 'M 27 -204 L 26 -239 C 40 -246 61 -246 74 -238 L 76 -202 Z', C.frame, t);
    for (let i = 0; i < 5; i++) line(g, `M ${33 + i * 8} -236 L ${34 + i * 8} -211`, C.hairLift, 1.4);
    shape(g, 'M -97 -200 C -101 -218 -79 -227 -59 -220 L 85 -206 C 108 -202 118 -183 117 -160 L 98 182 C 98 201 85 212 65 213 L -75 198 C -95 194 -108 180 -108 159 Z', C.frame, t);
    shape(g, 'M -87 -195 L 75 -183 L 87 -155 L 69 176 L -82 162 Z', C.cloth, t);
    shape(g, 'M 89 -178 L 108 -165 L 92 180 L 73 198 Z', C.skinDeep, t, { outline: false });
    // Recessed screen: no invented logo or HUD text.
    shape(g, 'M -66 -165 L 66 -155 L 61 -76 L -68 -85 Z', C.hairLift, t);
    shape(g, 'M -55 -150 L 51 -142 L 49 -92 L -57 -99 Z', C.hair, t, { size: 1 });
    for (let i = 0; i < 5; i++) line(g, `M ${-41 + i * 14} -111 L ${-41 + i * 14} ${-119 - i * 3}`, C.glow, 4, 0.45);
    ellipse(g, 64, -188, 4, 4, opts.talking ? S.window : C.skyRim);
    for (let j = 0; j < 8; j++) {
      const y = -44 + j * 13;
      line(g, `M -58 ${y} C -24 ${y + 3} 24 ${y + 6} 55 ${y + 8}`, C.frame, 5);
      ink(g, `M -55 ${y - 2} L 53 ${y + 6}`, t, { color: C.clothLift, size: 0.9, alpha: 0.7, seed: 450 + j });
    }
    for (const x of [-47, -2, 43]) { ellipse(g, x, 108 + x * 0.07, 13, 17, C.hairLift); ellipse(g, x, 104 + x * 0.07, 10, 12, C.frame); }
    shape(g, `M -106 -104 L ${-126 + squeeze * 3} -98 L ${-125 + squeeze * 3} -20 L -107 -16 Z`, C.hairLift, t);
    // Thumb rests on PTT; three separately curled fingers overlap the right edge.
    shape(g, `M -134 116 C -155 83 -150 33 -138 -6 C -133 -28 -126 -66 -109 -74
      C -95 -81 -83 -71 -86 -57 C -91 -35 -100 -13 -100 8 C -99 30 -92 47 -95 63
      C -96 89 -111 108 -134 116 Z`, C.hand, t, { seed: 231 });
    shape(g, 'M -117 -58 C -108 -63 -98 -60 -96 -54 L -104 -33 C -115 -31 -122 -37 -117 -58 Z', C.skin, t, { size: 1.2 });
    for (let i = 0; i < 3; i++) {
      const y = 10 + i * 50;
      shape(g, `M 99 ${y - 18} C 131 ${y - 24} 147 ${y - 3} 138 ${y + 18}
        C 132 ${y + 31} 106 ${y + 28} 83 ${y + 23} L 50 ${y + 15}
        C 35 ${y + 11} 35 ${y - 5} 47 ${y - 9} C 62 ${y - 15} 84 ${y - 10} 99 ${y - 18} Z`, C.hand, t, { seed: 240 + i });
      ink(g, `M 100 ${y - 11} C 106 ${y} 105 ${y + 10} 99 ${y + 19}`, t, { size: 1.4, alpha: 0.6 });
      ink(g, `M 47 ${y - 5} C 56 ${y - 7} 65 ${y - 5} 68 ${y + 2}`, t, { size: 1.2, color: C.skyRim, alpha: 0.5 });
    }
    ink(g, 'M 85 -198 C 104 -191 113 -174 110 -146', t, { color: C.rim, size: 3.2, seed: 455 });
    // Lanyard returns toward the wrist instead of ending in midair.
    line(g, 'M 54 206 C 103 263 16 332 -32 260 C -52 229 -58 218 -66 199', C.frame, 8);
    ink(g, 'M 54 208 C 92 261 19 315 -22 261', t, { color: C.hairLift, size: 1.5 });
  });
}
