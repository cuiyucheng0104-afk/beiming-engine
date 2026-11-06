// 《豹变》D 雾山 · 3D 卡通材质（在 _lib/toon.js 上加 D 版钩子）
//   2 阶（亮 / 影）+ 硬亮边；二档关掉（shade2 = shade1，step2 = -0.1）
//   钩子：竖向皴（顺坡长干笔条，只作用于陡面）、点苔（朝上的面和脊沿的深墨点）——DESIGN 3.3a/b
import * as THREE from 'three';
import { makeToonMaterial, setToonGlobals, TOON_SHARED } from '../../_lib/toon.js';
export { setToonGlobals, TOON_SHARED };

const HOOK_VP = 'varying vec3 vNW; varying vec3 vWP;';
const HOOK_VB = 'vNW = normalize( mat3( modelMatrix ) * objectNormal ); vWP = ( modelMatrix * vec4( position, 1.0 ) ).xyz;';
const HOOK_FP = `varying vec3 vNW; varying vec3 vWP; uniform float uStreak, uMoss, uMossClust; uniform vec2 uStreakF; uniform vec3 uMossInk; uniform float uRimBoost; uniform vec4 uSeaFade; uniform vec3 uSeaCol;`;
const HOOK_FA = `
{
  vec3 Q = vToonObj;
  float steep = 1.0 - smoothstep( 0.45, 0.65, abs( vNW.y ) );
  if ( uStreak > 0.0 ) {
    float s1 = toonNoise( vec3( Q.x * uStreakF.x, Q.y * uStreakF.y, Q.z * uStreakF.x ) );
    float s2 = toonNoise( vec3( Q.x * uStreakF.x * 2.1 + 7.0, Q.y * uStreakF.y * 2.0, Q.z * uStreakF.x * 2.1 ) );
    float a1 = max( fwidth( s1 ), 1e-4 ), a2 = max( fwidth( s2 ), 1e-4 );
    float st = 0.65 * smoothstep( 0.16 - a1, 0.24 + a1, s1 ) + 0.35 * smoothstep( 0.30 - a2, 0.36 + a2, s2 );
    diffuseColor.rgb *= 1.0 - uStreak * st * steep;
  }
  if ( uMoss > 0.0 ) {
    float up = smoothstep( 0.45, 0.70, vNW.y );
    float d = toonNoise( Q * 7.5 + 31.0 );
    float ad = max( fwidth( d ), 1e-4 );
    // 点苔成簇（脊上一簇簇小树墨点，不是满坡散点）：uMossClust > 0 时再乘一层低频的簇遮罩
    float clm = uMossClust > 0.0 ? smoothstep( 0.18, 0.3, toonNoise( Q * uMossClust + 7.0 ) ) : 1.0;
    toonInk = max( toonInk, smoothstep( 0.42 - ad, 0.47 + ad, d ) * up * uMoss * clm );
  }
  // 雾吃山脚：按世界高度把山脚混成云海色（uSeaFade.x = 云海顶面高度，.y 往上渐变的高度，.z 往下全没的深度，.w 开）
  if ( uSeaFade.w > 0.5 ) {
    float k = smoothstep( uSeaFade.x + uSeaFade.y, uSeaFade.x - uSeaFade.z, vWP.y );
    toonOverlay = vec4( uSeaCol, max( toonOverlay.a, k ) );
  }
}`;

// 预设（DESIGN 3.2）
export const PRESETS = {
  rock_mist: { color: '#5E7F7B', shade1: '#2B4047', step1: .50, edgeNoise: .07, edgeNoiseScale: 1.2, rimColor: '#AFC3B6', rimAmt: .7, rimPower: .25, rimInside: .46, rimDirK: .35,
    skyAmt: .5, skyTint: [.90, 1.00, 1.06], algaeColor: '#6E7F5E', algaeAmt: .35, algaeThr: .3, patchScale: .35, streak: .14, moss: .85, outline: 1.0 },
  rock_sun: { color: '#3F8A86', shade1: '#1E3540', step1: .52, edgeNoise: .07, edgeNoiseScale: 1.2, rimColor: '#E8C45C', rimAmt: 1.0, rimPower: .25, rimInside: .46, rimDirK: .35,
    rimLitColor: '#F4DA8A', rimLitAmt: .5, rimLitInside: .25, skyAmt: .55, skyTint: [.86, .98, 1.10], algaeColor: '#8FA35A', algaeAmt: .35, algaeThr: .3, patchScale: .35, streak: .14, moss: .85, outline: 1.0 },
  rock_deep: { color: '#1E2A30', shade1: '#151B27', step1: .50, edgeNoise: .05, edgeNoiseScale: 1.6, rimColor: '#5E7F7B', rimAmt: .35, rimPower: .25, rimInside: .46, rimDirK: .35,
    streak: .08, moss: 0, outline: .6 },
  pine: { color: '#2F5B48', shade1: '#16302B', step1: .48, edgeNoise: .05, edgeNoiseScale: 2.5, rimColor: '#A9BBAE', rimAmt: .8, rimPower: .3, rimInside: .42, rimDirK: .35, dabAmt: .18, dabScale: 2.2, outline: 1.1 },
  bark: { color: '#4A463A', shade1: '#1D1E1C', step1: .50, edgeNoise: .04, edgeNoiseScale: 4, rimColor: '#C9B07A', rimAmt: .7, rimPower: .25, rimInside: .46, rimDirK: .35, streak: .12, outline: 1.0 },
  ridge_mid: { color: '#4E8582', shade1: '#2A4D55', step1: .50, edgeNoise: .05, edgeNoiseScale: .08, rimColor: '#CFE0D2', rimAmt: .5, rimPower: .25, rimInside: .46, rimDirK: .35,
    streak: .16, streakF: [.9, .05], moss: .6, skyAmt: .4, skyTint: [.9, 1, 1.06], outline: .8 },
  meadow: { color: '#6E7F5E', shade1: '#3A4A3E', step1: .50, edgeNoise: .05, edgeNoiseScale: .2, rimAmt: 0, dabAmt: .2, dabScale: .6, outline: 0 },
  book_cover: { color: '#2E3A4A', shade1: '#1A2029', step1: .50, edgeNoise: .03, edgeNoiseScale: 40, rimColor: '#F3D08A', rimAmt: .8, rimPower: .3, rimInside: .42, rimDirK: .35, outline: 1.0 },
  metal: { color: '#C9B48A', shade1: '#3A3430', step1: .55, edgeNoise: 0, rimColor: '#FFF1C8', rimAmt: 1.0, rimPower: .4, rimInside: .4, rimDirK: .3, outline: .7 },
  wood: { color: '#834311', shade1: '#3A1E0C', step1: .50, edgeNoise: .03, edgeNoiseScale: 30, rimColor: '#F3D08A', rimAmt: .5, rimPower: .3, rimInside: .42, rimDirK: .35, outline: .8 },
};

export function toon(name, over = {}) {
  const p = { ...PRESETS[name], ...over };
  const mat = makeToonMaterial({
    color: p.color, shade1: p.shade1, shade2: p.shade1, step1: p.step1, step2: -0.1, feather1: .015, feather2: .015,
    edgeNoise: p.edgeNoise ?? .05, edgeNoiseScale: p.edgeNoiseScale ?? 1,
    rimColor: p.rimColor || '#ffffff', rimAmt: p.rimAmt ?? 0, rimPower: p.rimPower ?? .25, rimInside: p.rimInside ?? .46, rimDirK: p.rimDirK ?? .35,
    rimLitColor: p.rimLitColor || '#ffffff', rimLitAmt: p.rimLitAmt ?? 0, rimLitInside: p.rimLitInside ?? .2, rimLitPower: .4, rimLitDirK: .3,
    skyAmt: p.skyAmt ?? 0, skyTint: p.skyTint || [1, 1, 1],
    algaeColor: p.algaeColor || '#5f7f74', algaeAmt: p.algaeAmt ?? 0, algaeThr: p.algaeThr ?? .3, patchScale: p.patchScale ?? .05,
    dabAmt: p.dabAmt ?? 0, dabScale: p.dabScale ?? 1,
    inkColor: p.ink || '#1C2622', cityAmt: 0, fog: false, side: p.side ?? THREE.FrontSide, outlineW: p.outline ?? 1, map: p.map || null,
    uniforms: { uStreak: { value: p.streak ?? 0 }, uMoss: { value: p.moss ?? 0 }, uMossClust: { value: p.mossClust ?? 0 }, uStreakF: { value: new THREE.Vector2(...(p.streakF || [9, .55])) }, uMossInk: { value: new THREE.Color(p.ink || '#1C2622') }, uRimBoost: { value: 0 },
      uSeaFade: { value: new THREE.Vector4(0, 0, 0, 0) }, uSeaCol: { value: new THREE.Color('#F6E6BC') } },
    vertexPars: HOOK_VP, vertexBegin: HOOK_VB, fragmentPars: HOOK_FP, fragmentAlbedo: HOOK_FA,
  });
  mat.userData.preset = name;
  return mat;
}
// 换色（同一个网格在不同镜头里换预设颜色：灰雨崖 → 晴崖）
export function retint(mat, color, shade1, rimColor) {
  const u = mat.userData.toon;
  const b = new THREE.Color(color), s = new THREE.Color(shade1);
  mat.color.copy(b);
  u.uShade1Tint.value.set(s.r / Math.max(b.r, 1e-4), s.g / Math.max(b.g, 1e-4), s.b / Math.max(b.b, 1e-4));
  u.uShade2Tint.value.copy(u.uShade1Tint.value);
  if (rimColor) u.uRimColor.value.set(rimColor);
}
// 挂到网格上（不投影，按 look 的约定标记描边）
export function bind(mesh, mat, { outline = true, group = null } = {}) {
  mesh.material = mat;
  mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.userData.outline = outline && (mat.userData.toon.uOutlineW.value > 0);
  mesh.userData.outlineWidth = mat.userData.toon.uOutlineW.value;
  if (group) mesh.userData.outlineGroup = group;
  return mesh;
}
