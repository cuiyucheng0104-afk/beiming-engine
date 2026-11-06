// 空间：手工路线（走廊一 + 走廊二）+ 程序化填充的无尽隔断；自定义光照（千余盏灯管存在一张数据纹理里，无遮挡、无阴影）
// 着色器与光照算法沿用本风格的引擎写法；布局、道具、灯的状态是本片自己的
import * as THREE from 'three';
import { mulberry, hash } from '/core/lib.js';
import * as TX from './tex.js';
import { C1, C2, DOORS_Z, ENDDOOR, LAMP, SWITCH, NOTICE } from './timeline.js';
export { LAMP };

export const H = 2.7;                 // 吊顶高度
export const PLATE_YOU = .38;        // 尽头门牌边长（米）
export const LX = 2.4, LZ = 2.4;      // 灯格间距
export const LOX = 0.05, LOZ = 0.3;   // 灯格原点（两条走廊的中线各有一排灯）
const WT = 0.16;
const LN = 128, LOFF = 64;

// ———————————————————— 布局 ————————————————————
export const WALLS = [];
const wx = (z, x0, x1) => WALLS.push({ a: 'x', c: z, s0: Math.min(x0, x1), s1: Math.max(x0, x1) });
const wz = (x, z0, z1) => WALLS.push({ a: 'z', c: x, s0: Math.min(z0, z1), s1: Math.max(z0, z1) });
// 走廊一：西墙连续到 z=-12，再往北是有缺口的隔断；东墙 z∈[-12.5, 2] 连续（一排门），往北开缺口
[[2.2, -12.4], [-15.0, -21.8], [-24.6, -33], [-36.2, -47], [-50, -62], [-65.5, -80], [-83, -140]].forEach(([a, b]) => wz(C1.xw, a, b));
[[2.2, -12.8], [-14.6, -19.5], [-22.4, -29.6], [-32.2, -44], [-47.4, -58], [-61, -75], [-78, -140]].forEach(([a, b]) => wz(C1.xe, a, b));
wx(2.2, C1.xw, C1.xe);
// 走廊二：x∈[27.6, 30.1]，尽头墙 z=-22.5（门在正中）。两侧墙各开一个缺口（错开），缺口外的灯是死的 → 纵深退进暗雾
wz(C2.xw, -6, -19.9); wz(C2.xw, -21.2, -22.5);
wz(C2.xe, -6, -17.5); wz(C2.xe, -18.8, -22.5);
wz(C2.xw, -1, 4); wz(C2.xe, 0.5, 6);
wx(C2.zEnd, C2.xw - 2.4, C2.xe + 2.4);
const KEEP = [
  [C1.xw - 0.3, -145, C1.xe + 0.3, 2.6],
  [C2.xw - 0.3, -22.4, C2.xe + 0.3, 6],
  [C2.xw - 2.6, -26, C2.xe + 2.6, -22.6],
];
const inKeep = (x0, z0, x1, z1, m = 0.25) => KEEP.some(([a, b, c, d]) => x1 > a - m && x0 < c + m && z1 > b - m && z0 < d + m);
{
  const R = mulberry(3610);
  const GX = x => 2.4 * x + 1.25, GZ = z => 2.4 * z + 1.5;
  for (let i = -18; i <= 30; i++) for (let j = -62; j <= 3; j++) {
    const x = GX(i), z = GZ(j);
    if (R() < 0.22 && !inKeep(x, z - WT, x + 2.4, z + WT)) wx(z, x, x + 2.4);
    if (R() < 0.22 && !inKeep(x - WT, z, x + WT, z + 2.4)) wz(x, z, z + 2.4);
  }
}
export const PILLARS = [];
{
  const R = mulberry(361);
  for (let i = -18; i <= 30; i++) for (let j = -40; j <= 3; j++) {
    const x = 2.4 * i + 1.25, z = 2.4 * j + 1.5;
    if (R() < 0.07 && !inKeep(x - .3, z - .3, x + .3, z + .3, .5)) PILLARS.push([x, z]);
  }
  PILLARS.push([-0.75, -27.9]);
}

// ———————————————————— 灯格数据 ————————————————————
export const lightData = new Float32Array(LN * LN * 4);
export const lightTex = new THREE.DataTexture(lightData, LN, LN, THREE.RGBAFormat, THREE.FloatType);
lightTex.magFilter = lightTex.minFilter = THREE.NearestFilter;
export const LIGHTS = [];
const wallHitsRect = (x0, z0, x1, z1) => WALLS.some(w => w.a === 'x'
  ? (w.c + WT / 2 > z0 && w.c - WT / 2 < z1 && w.s1 > x0 && w.s0 < x1)
  : (w.c + WT / 2 > x0 && w.c - WT / 2 < x1 && w.s1 > z0 && w.s0 < z1));
{
  const R = mulberry(3699);
  for (let i = -LOFF; i < LOFF; i++) for (let j = -LOFF; j < LOFF; j++) {
    const x = LX * i + LOX, z = LZ * j + LOZ;
    if (x < -50 || x > 75 || z > 12 || z < -150) continue;
    if (wallHitsRect(x - .32, z - .62, x + .32, z + .62)) continue;
    const r = R();
    const warm = (R() - .5) * 0.16, green = R() * 0.07;
    let kind = r < 0.04 ? 'dead' : r < 0.065 ? 'flicker' : 'ok';
    const inC1 = Math.abs(x - C1.cx) < .5, inC2 = Math.abs(x - C2.cx) < .5;
    if (inC1 && z > -16 && z < 3) kind = 'ok';
    if (Math.abs(x - C1.cx) < 6 && z < -38) kind = R() < .6 ? 'dead' : 'dim';   // 走廊一远处渐暗：纵深化进黑暗
    if (inC1 && z < -20 && z > -38 && kind === 'ok' && R() < .3) kind = 'dead';
    if (inC2 && z > -23 && z < -10) kind = 'ok';
    if (Math.abs(x - C2.cx) < 6 && z > -2) kind = 'dead';                       // 走廊二身后是暗的
    // 走廊二的纵深分区：近处亮 → 中段一盏没打着、只剩暗绿的残光 → 门口又亮；缺口外第一圈半亮，再往外全死
    if (inC2 && Math.abs(z + 18.9) < .3) kind = 'dim';
    const outC2 = (x < C2.xw || x > C2.xe) && Math.abs(x - C2.cx) < 9 && z < -15.5 && z > -32;
    if (outC2) kind = (Math.abs(x - C2.cx) < 4 && z > -22.5) ? 'dim' : 'dead';
    let base = kind === 'dead' ? 0 : kind === 'dim' ? 0.1 + R() * 0.08 : 0.85 + R() * 0.3;
    let col = [1 + warm, 1 + green, 0.84 - warm * 0.6];
    if (inC2 && Math.abs(z + 18.9) < .3) { base = 0.3; col = [0.86, 1.04, 0.7]; }      // 中段那盏：偏绿、只有三成亮
    LIGHTS.push({ i, j, x, z, base, col, kind, ph: R() * 100 });
  }
}
export function updateLights(t, g = 1, extra = null) {
  lightData.fill(0);
  for (const L of LIGHTS) {
    let k = L.base;
    if (L.kind === 'flicker') {
      const s = Math.floor(t * 24 + L.ph), h1 = hash(s * 1.7 + L.ph), h2 = hash(Math.floor(t * 1.3 + L.ph));
      k *= h2 < 0.35 ? (h1 < 0.5 ? 0.15 : 0.9) : 1.0;
    }
    if (extra) k *= extra(L, t);
    const o = ((L.j + LOFF) * LN + (L.i + LOFF)) * 4;
    lightData[o] = L.col[0] * k * g; lightData[o + 1] = L.col[1] * k * g; lightData[o + 2] = L.col[2] * k * g; lightData[o + 3] = 1;
  }
  lightTex.needsUpdate = true;
}

// ———————————————————— Shaders ————————————————————
export const U = {
  uLights: { value: lightTex }, uAmb: { value: 0.16 }, uI: { value: 2.2 },
  uExitPos: { value: new THREE.Vector3(LAMP.x, LAMP.y, LAMP.z + 0.12) }, uExitI: { value: 0.0 },
  uFogCol: { value: new THREE.Color(0.19, 0.16, 0.075) }, uFogD: { value: 0.032 }, uFogG: { value: 1 },
  uTime: { value: 0 },
};
const VS = `
varying vec3 vW; varying vec3 vN; varying vec2 vUv;
void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * w; }`;
const COMMON = `
uniform sampler2D uLights; uniform float uAmb, uI, uExitI, uFogD, uFogG, uTime; uniform vec3 uExitPos, uFogCol;
varying vec3 vW; varying vec3 vN; varying vec2 vUv;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float a = .5, s = 0.; for (int k = 0; k < 5; k++){ s += a * vn(p); p = p * 2.03 + 17.1; a *= .5; } return s; }
// Light-grid lighting: the 5×5 surrounding lights (each approximated as a downward-facing area light), plus a "bounce light" that follows the local brightness
void lightAt(vec3 P, vec3 N, vec3 V, float shin, out vec3 dif, out vec3 spc, out vec3 amb){
  dif = vec3(0); spc = vec3(0); amb = vec3(0);
  float gi = floor((P.x - ${LOX.toFixed(2)}) / ${LX.toFixed(2)} + .5), gj = floor((P.z - ${LOZ.toFixed(2)}) / ${LZ.toFixed(2)} + .5);
  for (int di = -2; di <= 2; di++) for (int dj = -2; dj <= 2; dj++) {
    float i = gi + float(di), j = gj + float(dj);
    vec4 L = texture2D(uLights, (vec2(i, j) + ${LOFF}.5) / ${LN}.);
    if (L.a < .5) continue;
    vec3 lp = vec3(i * ${LX.toFixed(2)} + ${LOX.toFixed(2)}, ${(H - 0.02).toFixed(2)}, j * ${LZ.toFixed(2)} + ${LOZ.toFixed(2)});
    vec3 d = lp - P; float d2 = dot(d, d); vec3 l = d * inversesqrt(d2);
    float emit = .3 + .7 * max(l.y, 0.);
    float ndl = max(dot(N, l), 0.);
    dif += L.rgb * ndl * emit / (d2 + .3);
    if (shin > 0.) { vec3 hv = normalize(l + V); spc += L.rgb * pow(max(dot(N, hv), 0.), shin) * emit / (d2 + .3); }
    vec2 dh = d.xz; amb += L.rgb / (dot(dh, dh) + 3.);
  }
  dif *= uI; spc *= uI; amb *= uAmb;
  // Red light from the exit sign
  if (uExitI > 0.) { vec3 d = uExitPos - P; float d2 = dot(d, d); vec3 l = d * inversesqrt(d2);
    dif += vec3(1., .08, .04) * uExitI * (max(dot(N, l), 0.) * .9 + .04) / (d2 + .15); }
}
vec3 fog(vec3 c, vec3 P){ float d = length(P - cameraPosition); float f = 1. - exp(-d * uFogD); return mix(c, uFogCol * uFogG, f); }
// Fog colour follows the local brightness: where the lights are dead the fog is dark too (only then is the silhouette "a hole in the light")
vec3 fogA(vec3 c, vec3 P, vec3 a){ float d = length(P - cameraPosition); float f = 1. - exp(-d * uFogD);
  float k = clamp(dot(a, vec3(.333)) / (.2 * uAmb / .16), .15, 1.25); return mix(c, uFogCol * uFogG * k, f); }
`;
function mat(frag, extraU = {}, defs = {}) {
  return new THREE.ShaderMaterial({ uniforms: { ...U, ...extraU }, vertexShader: VS, fragmentShader: COMMON + frag, defines: defs });
}

// Walls: wallpaper (world-space UVs chosen by normal) + fading differences between widths + water stains + skirting board
const WALL_FS = `
uniform sampler2D map;
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
  float u = abs(N.x) > .5 ? vW.z * sign(N.x) : -vW.x * sign(N.z);
  float roll = floor(u / .53);
  vec3 alb = texture2D(map, vec2(u / .53, vW.y / .53)).rgb;
  alb *= .92 + .12 * h21(vec2(roll, 3.1));                       // each wallpaper width fades by a different amount
  float st = fbm(vec2(u * .9, vW.y * 1.4) + 5.);               // large stains
  alb *= mix(vec3(1.), vec3(.82, .74, .55), smoothstep(.55, .78, st) * .8);
  float wmask = smoothstep(.45, .65, fbm(vec2(u * .23, 7.)));   // only some wall sections have water stains
  float wet = (fbm(vec2(u * .8, 3.)) * .5 + .05) * wmask;       // water stains at the foot of the wall (tide marks at varying heights)
  // 走廊二：一圈很淡、高度起伏的水渍线沿墙脚走（不是每段墙都有，但这里整条都有）
  float c2 = step(${(C2.xw - 0.3).toFixed(2)}, vW.x) * step(vW.x, ${(C2.xe + 0.3).toFixed(2)}) * step(vW.z, -8.);
  wmask = max(wmask, c2 * .75); wet = mix(wet, .11 + .16 * fbm(vec2(u * .55, 3.7)), c2);
  float tide = smoothstep(wet + .05, wet - .06, vW.y) * wmask;
  alb *= mix(vec3(1.), vec3(.74, .63, .42), tide * .55);
  alb *= 1. - .2 * smoothstep(.04, 0., abs(vW.y - wet)) * step(.15, wet);   // dark edge of the tide mark
  alb *= mix(vec3(1.), vec3(.86, .8, .62), smoothstep(${(H - 0.35).toFixed(2)}, ${H.toFixed(2)}, vW.y) * .6); // nicotine yellow below the ceiling
  // 走廊二尽头墙：门右侧一道从吊顶渗下来的水痕（窄、断续、越往下越淡）
  if (N.z > .5 && vW.z > ${(C2.zEnd - 0.2).toFixed(2)} && vW.z < ${(C2.zEnd + 0.2).toFixed(2)}) {
    float sx0 = vW.x - ${(C2.cx + 0.93).toFixed(2)} - .03 * sin(vW.y * 3.1);
    float streak = smoothstep(.07, .0, abs(sx0)) * smoothstep(.9, ${H.toFixed(2)}, vW.y) * (.55 + .45 * vn(vec2(vW.x * 20., vW.y * 2.2)));
    alb *= mix(vec3(1.), vec3(.78, .66, .44), streak * .55);
  }
  // Lifting seams: a thin dark line at the width edge + a little light beside it
  float sx = fract(u / .53) * .53;
  alb *= 1. - .4 * smoothstep(.008, 0., sx) * step(.3, h21(vec2(roll, 7.)));
  alb *= 1. + .12 * smoothstep(.012, .004, abs(sx - .012)) * step(.3, h21(vec2(roll, 7.)));
  // On a few widths the seam lifts in the upper half: showing the whitish paper back (a triangle) + a shadow under it
  if (h21(vec2(roll, 11.)) > .93) {
    float y0 = ${(H - 0.3).toFixed(2)} - 1.1 * h21(vec2(roll, 13.)), k = clamp((vW.y - y0) / (${H.toFixed(2)} - y0), 0., 1.);
    float wpe = .075 * k * (vW.y > y0 ? 1. : 0.);
    float tri = step(sx, wpe);
    alb = mix(alb, vec3(.8, .75, .58), tri * .9);
    alb *= 1. - .4 * smoothstep(.025, 0., sx - wpe) * step(wpe, sx) * step(.001, wpe);
  }
  // Occasional small stains (very few)
  float sp = vn(vec2(u * 3.1, vW.y * 3.1) + 40.);
  alb *= 1. - .22 * smoothstep(.86, .93, sp) * step(.6, h21(vec2(floor(u / 2.), 9.)));
  // Skirting board
  if (vW.y < .1) alb = vec3(.30, .24, .15) * (.9 + .1 * vn(vec2(u * 30., 1.)));
  vec3 d, s, a; lightAt(vW + N * .02, N, V, 0., d, s, a);
  vec3 c = alb * (d + a);
  gl_FragColor = vec4(fogA(c, vW, a), 1.);
}`;
// Carpet: pile + damp, darkened patches (darker and shinier) + dirtier near the walls
const FLOOR_FS = `
uniform sampler2D map;
void main(){
  vec3 N = vec3(0, 1, 0); vec3 V = normalize(cameraPosition - vW);
  vec3 alb = texture2D(map, vW.xz / .9).rgb;
  alb *= .9 + .2 * vn(vW.xz * 1.3);
  float damp = smoothstep(.5, .68, fbm(vW.xz * .45 + 3.));
  alb *= mix(1., .6, damp);
  alb = mix(alb, alb * vec3(.95, .9, .8), smoothstep(.6, .8, fbm(vW.xz * 1.1)) * .5);
  alb *= .88 + .24 * fbm(vW.xz * 7.);                                          // close-up pile mottling
  alb *= 1. - .16 * smoothstep(.64, .72, fbm(vW.xz * 2.3 + 11.));                 // small damp prints
  vec3 d, s, a; lightAt(vW, N, V, 22., d, s, a);
  vec3 c = alb * (d + a * .7) + s * (.012 + .09 * damp) * vec3(1., .95, .8);
  gl_FragColor = vec4(fogA(c, vW, a), 1.);
}`;
// Ceiling: mineral-fibre tiles + T-bar grid + yellow-brown water stains on a few tiles
const CEIL_FS = `
uniform sampler2D map;
void main(){
  vec3 N = vec3(0, -1, 0); vec3 V = normalize(cameraPosition - vW);
  vec2 q = vec2((vW.x + .2) / 1.2, (vW.z - 1.2) / 1.2);
  vec3 alb = texture2D(map, q).rgb;
  vec2 tile = floor(vec2((vW.x + .2) / .6, (vW.z - 1.2) / 1.2));
  float hs = h21(tile);
  alb *= .95 + .08 * hs;
  vec2 f0 = fract(vec2((vW.x + .2) / .6, (vW.z - 1.2) / 1.2));
  bool inner = f0.x > .03 && f0.x < .97 && f0.y > .015 && f0.y < .985;
  float kind = h21(tile + 71.);
  bool missing = kind > .992 && inner, vent = kind > .972 && kind <= .992, yell = kind > .93 && kind <= .972;
  if (tile.x > 48.5 && tile.x < 49.5 && tile.y > -17.5 && tile.y < -16.5) { yell = true; missing = false; vent = false; hs = .95; }   // 走廊二：中段那盏残灯旁一块发黄带水圈的板
  if (yell) alb *= mix(vec3(.93, .86, .7), vec3(.8, .68, .45), smoothstep(.2, .5, length(f0 - .5)));   // whole tile yellowed
  if (vent) { vec2 g = (f0 - .5) * vec2(1., 2.); float sq = step(max(abs(g.x), abs(g.y)), .38);          // return-air vent: square grille
    float slot = step(.5, fract(g.y * 11.)); alb = mix(alb, mix(vec3(.2, .19, .16), vec3(.78, .76, .7), slot), sq);
    alb *= 1. - .3 * sq * step(.34, max(abs(g.x), abs(g.y))); }
  if (hs > .93 && !vent && !missing) { vec2 f = fract(vec2((vW.x + .2) / .6, (vW.z - 1.2) / 1.2)) - .5; f.x *= .5;
    float r = length(f + (vec2(h21(tile + 3.), h21(tile + 5.)) - .5) * .3); float ring = smoothstep(.22, .19, r) * (.5 + .5 * smoothstep(.12, .2, r));
    alb *= mix(vec3(1.), vec3(.72, .58, .34), ring * .8); }
  vec3 d, s, a; lightAt(vW - vec3(0, .05, 0), N, V, 0., d, s, a);
  vec3 c = alb * (d * .55 + a * 1.05);
  if (missing) c = vec3(.012, .01, .008) * (1. + 2. * smoothstep(.3, .0, min(min(f0.x, 1. - f0.x), min(f0.y, 1. - f0.y) * 2.)));   // a tile missing: a black hole, with a tiny bit of light at the edge
  gl_FragColor = vec4(fogA(c, vW, a), 1.);
}`;
// Fluorescent panels: emissive area = texture brightness × each light's own colour and brightness
const TROF_FS = `
uniform sampler2D map; uniform float uEmit;
void main(){
  vec2 cell = vec2(floor((vW.x - ${LOX.toFixed(2)}) / ${LX.toFixed(2)} + .5), floor((vW.z - ${LOZ.toFixed(2)}) / ${LZ.toFixed(2)} + .5));
  vec4 L = texture2D(uLights, (cell + ${LOFF}.5) / ${LN}.);
  vec3 tx = texture2D(map, vUv).rgb;
  float glow = smoothstep(.75, .95, dot(tx, vec3(.33)));
  vec3 c = mix(tx * .25 * (L.rgb * .3 + .05), tx * L.rgb * uEmit, glow);
  gl_FragColor = vec4(fog(c, vW), 1.);
}`;
// Generic: diffuse objects with a texture or flat colour (notices, corkboard, door, sockets, shoes and trousers…)
const PAINT_FS = `
uniform sampler2D map; uniform vec3 color; uniform float useMap, shin, spec, emit;
void main(){
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N; vec3 V = normalize(cameraPosition - vW);
  vec3 alb = color; if (useMap > .5) alb *= texture2D(map, vUv).rgb;
  vec3 d, s, a; lightAt(vW + N * .02, N, V, shin, d, s, a);
  vec3 c = alb * (d + a) + s * spec + alb * emit;
  gl_FragColor = vec4(fogA(c, vW, a), 1.);
}`;
// Silhouette: alpha test, takes almost no light (only a tiny bit), takes fog
const SIL_FS = `
uniform sampler2D map;
void main(){
  vec4 tx = texture2D(map, vUv); if (tx.a < .5) discard;
  vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
  vec3 d, s, a; lightAt(vW + N * .05, N, V, 0., d, s, a);
  vec3 c = vec3(.012, .011, .009) * (d + a);
  gl_FragColor = vec4(fogA(c, vW, a), 1.);
}`;
export function silhouetteMat(map) { const m = mat(SIL_FS, { map: { value: map } }); m.side = THREE.DoubleSide; return m; }
export function paint(o = {}) {
  return mat(PAINT_FS, {
    map: { value: o.map || null }, color: { value: new THREE.Color(o.color ?? '#ffffff') }, useMap: { value: o.map ? 1 : 0 },
    shin: { value: o.shin ?? 0 }, spec: { value: o.spec ?? 0 }, emit: { value: o.emit ?? 0 },
  });
}

// ———————————————————— Geometry ————————————————————
function boxInto(pos, nor, uv, x0, y0, z0, x1, y1, z1) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0); g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const ni = g.toNonIndexed();
  pos.push(...ni.attributes.position.array); nor.push(...ni.attributes.normal.array); uv.push(...ni.attributes.uv.array);
}
function merged(pos, nor, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

export function buildWorld(scene) {
  const T = { wall: TX.wallpaper(), carpet: TX.carpet(), ceil: TX.ceiling(), trof: TX.troffer() };
  // Walls + pillars + door lintels
  const P = [], N = [], UV = [];
  for (const w of WALLS) {
    if (w.a === 'x') boxInto(P, N, UV, w.s0, 0, w.c - WT / 2, w.s1, H, w.c + WT / 2);
    else boxInto(P, N, UV, w.c - WT / 2, 0, w.s0, w.c + WT / 2, H, w.s1);
  }
  for (const [x, z] of PILLARS) boxInto(P, N, UV, x - .24, 0, z - .24, x + .24, H, z + .24);
  const walls = new THREE.Mesh(merged(P, N, UV), mat(WALL_FS, { map: { value: T.wall } }));
  scene.add(walls);
  // Carpet / ceiling
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), mat(FLOOR_FS, { map: { value: T.carpet } }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0, -40); scene.add(floor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), mat(CEIL_FS, { map: { value: T.ceil } }));
  ceil.rotation.x = Math.PI / 2; ceil.position.set(0, H, -40); scene.add(ceil);
  // Light panels: merged into one mesh
  const tp = [], tn = [], tu = [];
  for (const L of LIGHTS) {
    const x0 = L.x - .3, x1 = L.x + .3, z0 = L.z - .6, z1 = L.z + .6, y = H - .004;
    tp.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1);
    for (let k = 0; k < 6; k++) tn.push(0, -1, 0);
    tu.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  }
  const trofMat = mat(TROF_FS, { map: { value: T.trof }, uEmit: { value: 5.0 } });
  const trof = new THREE.Mesh(merged(tp, tn, tu), trofMat); scene.add(trof);
  return { walls, floor, ceil, trof, trofMat, T };
}


// 道具：开关（贴着胶带）、告示、东墙一排门、走廊二尽头的「你」门 + 红色占用灯
export function buildProps(scene) {
  const out = {};
  // 1) 开机特写：西墙上的灯开关，被一条遮蔽胶带封住
  {
    const g = new THREE.Group(); g.position.set(SWITCH.x + WT / 2 + .002, 0, SWITCH.z); g.rotation.y = Math.PI / 2;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(.086, .124, .008), paint({ map: TX.switchPlate(), shin: 30, spec: .04 })); plate.position.set(0, SWITCH.y, .004);
    const tape = new THREE.Mesh(new THREE.PlaneGeometry(.05, .17), paint({ map: TX.tapeStrip(), spec: .02 })); tape.position.set(.002, SWITCH.y + .004, .0095); tape.rotation.z = .06;
    g.add(plate, tape); scene.add(g);
  }
  // 2) 告示：直接用胶带贴在西墙壁纸上
  {
    const NW = .36, NHh = .48;
    const g = new THREE.Group(); g.position.set(NOTICE.x + WT / 2 + .002, 0, NOTICE.z); g.rotation.y = Math.PI / 2;
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(NW, NHh), paint({ map: TX.notice({ age: .85, seed: 36 }) })); sheet.position.set(0, NOTICE.y, .002); sheet.rotation.z = -.008;
    g.add(sheet);
    for (const [px, py, r] of [[-.165, NOTICE.y + .235, .5], [.165, NOTICE.y + .24, -.45], [-.17, NOTICE.y - .235, -.5], [.168, NOTICE.y - .24, .55]]) {
      const tape = new THREE.Mesh(new THREE.PlaneGeometry(.065, .022), paint({ color: '#d8c98a', spec: .02 })); tape.position.set(px, py, .004); tape.rotation.z = r; g.add(tape);
    }
    scene.add(g); out.notice = g;
  }
  // 门：门扇 + 门框 + 门牌 + 压把手。facing = 门面朝向（绕 y 旋转），(x,z) = 墙面上的门中心
  const doorMat = paint({ color: '#a39a84', shin: 26, spec: .05 }), frameMat = paint({ color: '#7a7060', shin: 20, spec: .05 }), metal = paint({ color: '#8d8a80', shin: 70, spec: .35 });
  const blankPlate = TX.doorPlate(''), youPlate = TX.doorPlate('你');
  function door(x, z, rotY, plateTex, PS = .26) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY;
    const DW = .9, DH = 2.1;
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(DW, DH, .03), doorMat); leaf.position.set(0, DH / 2, .015); g.add(leaf);
    for (const dx of [-DW / 2 - .035, DW / 2 + .035]) { const j = new THREE.Mesh(new THREE.BoxGeometry(.07, DH + .07, .045), frameMat); j.position.set(dx, (DH + .07) / 2, .022); g.add(j); }
    const hd = new THREE.Mesh(new THREE.BoxGeometry(DW + .14, .07, .045), frameMat); hd.position.set(0, DH + .035, .022); g.add(hd);
    const kick = new THREE.Mesh(new THREE.BoxGeometry(DW - .04, .2, .034), paint({ color: '#7c7462', shin: 30, spec: .1 })); kick.position.set(0, .12, .017); g.add(kick);
    const rose = new THREE.Mesh(new THREE.CylinderGeometry(.028, .028, .012, 16), metal); rose.rotation.x = Math.PI / 2; rose.position.set(DW / 2 - .1, 1.0, .036); g.add(rose);
    const lever = new THREE.Mesh(new THREE.BoxGeometry(.13, .022, .022), metal); lever.position.set(DW / 2 - .155, 1.0, .055); g.add(lever);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(PS, PS, .006), paint({ map: plateTex, shin: 50, spec: .06 })); plate.position.set(0, 1.56, .033); g.add(plate);
    scene.add(g); return g;
  }
  out.doors = DOORS_Z.map(z => door(C1.xe - WT / 2 - .002, z, -Math.PI / 2, blankPlate));
  out.endDoor = door(ENDDOOR.x, ENDDOOR.z + WT / 2 + .002, 0, youPlate, PLATE_YOU);   // 门牌放大到门宽的 42%
  // 红色占用灯（全片唯一的饱和色）：门上方
  {
    const g = new THREE.Group(); g.position.set(LAMP.x, LAMP.y, LAMP.z + WT / 2 + .002);
    const box = new THREE.Mesh(new THREE.BoxGeometry(.26, .12, .05), paint({ color: '#cfc9b8', shin: 20, spec: .05 })); box.position.z = .025;
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(.21, .08), paint({ color: '#ff1608', emit: 0 })); lens.position.z = .0505;
    // 光晕：贴墙的加色发光面（红灯点亮时在门框上方晕开），强度由 main.js 按灯的状态驱动
    const hc = document.createElement('canvas'); hc.width = 256; hc.height = 128; const hx = hc.getContext('2d');
    const gr = hx.createRadialGradient(64, 64, 2, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.25, 'rgba(255,255,255,.45)'); gr.addColorStop(.6, 'rgba(255,255,255,.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    hx.setTransform(2, 0, 0, 1, 0, 0); hx.fillStyle = gr; hx.fillRect(0, 0, 128, 128);
    const htex = new THREE.CanvasTexture(hc); htex.colorSpace = THREE.SRGBColorSpace;
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(1.15, .62), new THREE.MeshBasicMaterial({ map: htex, color: new THREE.Color(0, 0, 0), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    halo.position.z = .07; halo.renderOrder = 5;
    g.add(box, lens, halo); scene.add(g); out.lamp = lens; out.halo = halo;
  }
  // 插座
  {
    const m = paint({ map: TX.outlet() });
    for (const [x, z, s] of [[C1.xw, -6.5, 1], [C1.xw, 1.4, 1], [C1.xe, 0.6, -1], [C2.xw, -18.5, 1], [C2.xe, -12.2, -1]]) {
      const o = new THREE.Mesh(new THREE.PlaneGeometry(.07, .12), m); o.position.set(x + s * (WT / 2 + .003), .32, z); o.rotation.y = s * Math.PI / 2; scene.add(o);
    }
  }
  return out;
}
