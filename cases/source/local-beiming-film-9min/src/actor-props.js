import { C, MATERIAL as S, stage, shape, ink, line, ellipse, screw, grip, cord, ease, clamp01 } from './actor-paint.js';

/** Only the working/cabin illumination switches off. Navigation lamps stay on. */
export function actorLightState(progress = 0, lights = 1) {
  return { cabin: clamp01(lights) * (1 - ease(progress, 0.42, 0.58)), red: 1, green: 1 };
}

export function paintSwitch(g, t, W, H, opts) {
  stage(g, W, H, 0.5, 0.55, () => {
    const p = opts.progress, state = actorLightState(p, opts.lights);
    shape(g, 'M -354 -206 L 338 -195 L 359 178 L -348 200 Z', C.frame, t);
    shape(g, 'M -338 -190 L 322 -179 L 340 159 L -333 179 Z', C.cloth, t);
    shape(g, 'M -320 -173 L 305 -162 L 313 -125 L -319 -136 Z', C.hairLift, t, { outline: false });
    for (const x of [-318, 315]) for (const y of [-169, 153]) screw(g, x, y, t, 8);
    // Two permanent navigation indicators use the exact ferry lamp colors.
    for (const [x, color] of [[-218, S.red], [-73, S.green]]) {
      ellipse(g, x, -49, 43, 43, C.frame);
      ellipse(g, x, -49, 34, 34, C.hairLift);
      ellipse(g, x, -49, 28, 28, color);
      ellipse(g, x - 8, -59, 8, 5, C.rimHot, 0.75);
      for (let j = -1; j <= 1; j++) line(g, `M ${x - 21} ${-49 + j * 11} L ${x + 21} ${-49 + j * 11}`, C.frame, 1, 0.2);
      ink(g, `M ${x - 25} 24 L ${x + 24} 24 M ${x - 14} 34 L ${x + 15} 34`, t, { color: C.skyRim, size: 2, alpha: 0.65 });
    }
    // Cabin lamp pictogram and telltale. No text is burned into the scene.
    ellipse(g, 173, -82, 26, 26, C.frame);
    ellipse(g, 173, -82, 17, 17, C.skinDeep);
    ellipse(g, 173, -82, 17, 17, S.window, state.cabin);
    line(g, 'M 131 -127 L 144 -145 L 199 -145 L 212 -127 Z M 171 -145 L 171 -156', C.skyRim, 2.5, 0.7);
    for (let i = -1; i <= 1; i++) line(g, `M ${173 + i * 19} -120 L ${173 + i * 24} -111`, C.skyRim, 2, 0.7);
    ellipse(g, 174, 39, 47, 38, C.frame); ellipse(g, 174, 39, 36, 29, C.hairLift);
    const travel = ease(p, 0.36, 0.58), tipY = -5 + travel * 83;
    shape(g, `M 159 40 L 160 ${tipY} C 160 ${tipY - 16} 188 ${tipY - 16} 190 ${tipY} L 187 43 Z`, S.shellShade, t);
    ellipse(g, 175, tipY, 15, 10, S.shell);
    ink(g, 'M 221 32 L 238 32 M 222 46 L 235 46', t, { color: C.skyRim, size: 2 });
    // Index approaches, depresses the toggle, then withdraws; wrist follows.
    const approach = ease(p, 0.05, 0.3) * (1 - ease(p, 0.72, 0.98));
    if (approach > 0) {
      g.save(); g.translate(174 + 200 * (1 - approach), tipY + 7 + 290 * (1 - approach));
      shape(g, 'M 14 166 C 58 155 119 184 138 214 L 225 500 L 10 500 Z', C.cloth, t);
      shape(g, `M 0 0 C -11 -5 -20 2 -21 14 C -20 48 -9 77 2 102
        C -14 80 -26 68 -37 77 C -48 83 -45 102 -36 121
        C -49 108 -63 109 -66 122 C -69 135 -59 154 -49 166
        C -61 158 -73 165 -72 179 C -69 199 -41 222 -12 234
        C 24 251 58 232 81 221 C 108 207 118 180 102 154
        C 87 130 65 109 52 85 C 41 65 30 44 20 20 C 16 9 10 2 0 0 Z`, C.hand, t, { seed: 231 });
      for (const q of ['M 2 102 C 13 122 19 142 30 149', 'M -36 121 C -22 143 -15 153 -4 159',
        'M -49 166 C -37 179 -24 187 -12 190', 'M -7 22 C 1 26 9 24 13 19', 'M 51 85 C 52 111 64 136 76 154']) ink(g, q, t, { size: 1.6, alpha: 0.7, seed: 252 });
      ink(g, 'M 18 18 C 28 42 40 63 52 85', t, { color: C.rim, size: 2.7 });
      g.restore();
    }
  });
}

export function paintRope(g, t, W, H, opts) {
  stage(g, W, H, 0.51, 0.61, () => {
    const p = opts.progress;
    const tied = ease(p, 0.08, 0.5) * (1 - ease(p, 0.68, 0.95));
    // A small mounting plate, never a full-frame opaque deck.
    ellipse(g, 5, 131, 307, 59, C.ink, 0.22);
    shape(g, 'M -273 86 L 205 64 L 294 142 L -203 180 Z', C.skinDeep, t);
    shape(g, 'M -273 86 L 205 64 L 278 125 L -211 163 Z', C.hairLift, t);
    for (const [x, y] of [[-224, 100], [186, 81], [227, 123], [-184, 142]]) screw(g, x, y, t, 9);
    cord(g, `M -820 216 C -530 ${230 - 65 * tied} -310 202 -187 97 C -140 50 -124 22 -87 5`, t, 19);
    // Rear bight wraps behind the cleat's neck before crossing its front.
    cord(g, 'M -91 77 C -183 48 -174 -30 -110 -35 C -44 -44 90 -44 140 -18 C 193 8 175 66 94 85', t, 18, tied);
    shape(g, 'M -85 102 L -75 -13 L 69 -17 L 86 94 C 47 120 -43 129 -85 102 Z', C.cloth, t);
    shape(g, 'M -221 -17 C -210 -38 -180 -46 -147 -38 L -66 -21 L 78 -27 L 156 -52 C 185 -59 215 -53 221 -32 L 213 -13 L 87 17 C 35 28 -35 29 -84 20 L -215 2 Z', C.hairLift, t);
    shape(g, 'M -217 -7 L -86 12 C -19 23 34 19 89 10 L 216 -22 L 213 -6 L 89 30 C 37 43 -36 45 -88 31 L -217 12 Z', C.cloth, t);
    ink(g, 'M -205 -27 C -165 -35 -117 -14 -76 -10 L 78 -15 L 185 -43', t, { color: C.rim, size: 3, seed: 500 });
    const end = cord(g, `M -92 88 C -8 119 110 63 163 6 C 193 -26 173 -38 151 -24
      C 84 8 -105 112 -159 37 C -191 -8 -152 -27 -123 -9 C -45 36 34 65 110 83
      C 168 99 215 ${146 - tied * 48} ${349 - tied * 182} ${150 - tied * 76}`, t, 18, tied);
    // Locking half hitch on the last turn, with its crossing drawn above.
    const lock = ease(p, 0.43, 0.55) * (1 - ease(p, 0.63, 0.73));
    if (lock > 0) {
      g.save(); g.globalAlpha *= lock;
      cord(g, 'M 73 37 C 121 37 141 82 118 103 C 94 124 41 98 48 75 C 56 49 103 49 139 77', t, 17);
      g.restore();
    }
    // Continuous free end meets the palm. It travels away as the hitch slips.
    const hx = end[0] + 106 + 75 * (1 - tied), hy = end[1] - 140 - 34 * Math.sin(t * 0.27);
    cord(g, `M ${end[0]} ${end[1]} C ${end[0] + 87} ${end[1] + 25} ${hx - 65} ${hy + 19} ${hx} ${hy}`, t, 18);
    grip(g, t, hx, hy, 0.79, -0.57, false, 1800);
    // Other hand holds the standing part well away from the moving loop.
    grip(g, t, -340, 182 - tied * 22, 0.71, 1.22, true, 1800);
  });
}

const SHELL = `M -30 149 C -66 143 -103 120 -138 92 C -171 83 -195 62 -206 34
  C -236 22 -252 -3 -253 -29 C -277 -48 -282 -76 -269 -99
  C -286 -125 -277 -154 -253 -166 C -260 -196 -241 -219 -211 -220
  C -208 -251 -181 -269 -155 -257 C -142 -287 -108 -290 -84 -271
  C -61 -299 -26 -294 -9 -272 C 20 -292 51 -283 62 -255
  C 96 -268 121 -247 123 -218 C 154 -218 176 -193 170 -169
  C 198 -155 207 -127 195 -104 C 219 -82 215 -51 197 -32
  C 214 -9 199 22 175 32 C 178 62 158 85 130 88
  C 111 115 69 136 24 148 C 13 168 -18 168 -30 149 Z`;
const RIBS = [[-254,-29],[-270,-97],[-252,-166],[-211,-220],[-155,-257],[-84,-271],[-9,-272],[62,-255],[123,-218],[170,-169],[195,-104],[197,-32],[175,32],[130,88]];

export function paintShell(g, t, W, H) {
  stage(g, W, H, 0.51, 0.59, () => {
    g.rotate(-0.19); g.scale(1.5, 1.1);
    // Contact shadow follows the shell, with no background rectangle or fake halo.
    ellipse(g, -17, 129, 202, 36, C.ink, 0.19);
    ellipse(g, -4, 142, 83, 16, C.ink, 0.27);
    shape(g, SHELL, S.shellShade, t, { size: 3, seed: 530 });
    g.save(); g.translate(-3, -9);
    shape(g, SHELL, S.shell, t, { size: 2.5, seed: 531 });
    // Actual radial folds taper to the hinge; alternating facets remain planar.
    RIBS.forEach(([x, y], i) => {
      const dx = x + 9, dy = y - 133;
      shape(g, `M -9 133 C ${-9 + dx * 0.22 - 10} ${133 + dy * 0.22} ${x - 18} ${y + 55} ${x} ${y}
        C ${x + 8} ${y + 32} ${-9 + dx * 0.46 + 11} ${133 + dy * 0.46} -9 133 Z`, i % 3 === 0 ? S.lavender : S.shellShade, t, { outline: false });
      ink(g, `M -9 133 C ${-9 + dx * 0.33} ${133 + dy * 0.33} ${x - 8} ${y + 42} ${x} ${y}`, t,
        { size: 2.1 + (i % 3) * 0.35, color: C.rimHot, alpha: 0.78, seed: 550 + i, t0: 12, t1: 3 });
      ink(g, `M -13 124 C ${-9 + dx * 0.38 - 5} ${133 + dy * 0.38} ${x - 11} ${y + 42} ${x - 5} ${y + 7}`, t,
        { size: 1.1, color: S.shellShade, alpha: 0.9, seed: 570 + i, t0: 8, t1: 2 });
    });
    // Concentric interrupted growth rings, not uniform spokes/icon decoration.
    for (const [i, r] of [0.31, 0.48, 0.63, 0.74, 0.83, 0.91].entries()) {
      g.save(); g.translate(-9 * (1 - r), 133 * (1 - r)); g.scale(r, r);
      ink(g, 'M -250 -35 C -274 -124 -215 -242 -95 -271 C 17 -303 139 -231 187 -125 C 207 -64 206 -5 175 32', t,
        { color: S.shellShade, size: 1.3 / r, alpha: 0.52, seed: 590 + i, t0: 8, t1: 12 });
      g.restore();
    }
    shape(g, 'M -36 130 C -54 127 -70 139 -63 155 L -23 163 C -9 178 17 174 28 156 L 66 143 C 68 129 51 120 32 129 C 12 146 -14 149 -36 130 Z', S.shellShade, t, { size: 1.7 });
    ink(g, 'M -44 144 C -21 155 13 161 43 139', t, { color: C.rim, size: 3.2 });
    // A chipped lip and a few mineral inclusions, all fixed in shell space.
    shape(g, 'M -253 -166 L -244 -156 L -248 -178 Z', S.shellShade, t, { outline: false });
    for (const [x, y, rx, ry] of [[-178,-144,5,3],[-126,-204,3,6],[101,-103,4,2],[-87,-71,3,2],[50,30,2,4]]) {
      ellipse(g, x, y, rx, ry, S.shellShade, 0.68);
    }
    g.restore();
    // Two droplets sitting on the deck establish scale and contact.
    ellipse(g, 224, 105, 13, 6, C.skyRim, 0.25);
    line(g, 'M 216 104 C 222 100 229 100 234 103', C.rim, 1.4, 0.75);
  });
}

export function paintWake(g, t, W, H, opts) {
  stage(g, W, H, 0.5, 0.48, () => {
    // Fixed centreline at x=0. Perspective widens the straight wake downstream.
    const reach = 0.78 + 0.22 * ease(opts.progress);
    for (const side of [-1, 1]) {
      shape(g, `M ${side * 10} -241 C ${side * 42} -120 ${side * 169} 204 ${side * 341} 524
        L ${side * 369} 524 C ${side * 185} 193 ${side * 61} -123 ${side * 15} -241 Z`, C.skyRim, t, { outline: false });
      g.save(); g.globalAlpha *= 0.45 * reach;
      ink(g, `M ${side * 13} -237 C ${side * 56} -86 ${side * 174} 219 ${side * 350} 522`, t,
        { color: C.rim, size: 5.2, seed: 630 + side, t0: 18, t1: 26 });
      g.restore();
    }
    // Advect foam down the same axis; position depends only on the held clock.
    for (let i = 0; i < 30; i++) {
      const u = ((i / 30 + t * 0.063) % 1 + 1) % 1;
      const y = -240 + 800 * u * u, width = 12 + 358 * u * u;
      const fade = ease(u, 0, 0.11) * (1 - ease(u, 0.79, 1)) * reach;
      const ph = Math.sin(i * 12.73), half = width * (0.12 + 0.1 * Math.abs(ph));
      const center = ph * width * 0.42;
      ink(g, `M ${center - half} ${y} C ${center - half * 0.4} ${y + 6 * u} ${center + half * 0.5} ${y - 4 * u} ${center + half} ${y + 2 * u}`, t,
        { color: i % 3 === 0 ? C.rim : C.glow, size: 1.5 + u * 3.5, alpha: fade * 0.35, seed: 650 + i, t0: 5, t1: 7 });
      for (const side of [-1, 1]) ink(g, `M ${side * width} ${y} C ${side * (width + 5)} ${y + 9} ${side * (width + 12)} ${y + 20} ${side * (width + 18)} ${y + 30}`, t,
        { color: C.rimHot, size: 2 + u * 3, alpha: fade * 0.5, seed: 700 + i + side, t0: 4, t1: 5 });
    }
  });
}
