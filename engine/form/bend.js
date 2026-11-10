// 北冥引擎 · 游动弯曲：沿主轴 x 往后传的行波把长条形体弯起来——GLSL 顶点钩子 + 同一公式的 JS 镜像（CPU 摆位的挂件、眼睛用）。
// 包络：s = (半长 - x) / 全长，头部为 0，往尾巴按 smoothstep(e0, 1, s) 加大；相位 2π·s·波数 - 角频率·t。
// 名字前缀 p（如 'fish'）：uniform 叫 uFishT / uFishAmp …，GLSL 函数叫 fishBendPos / fishBendNormal / fishBendMatrix …，
// 同一个材质里能放两套弯曲（钩子按顺序拼起来就是逐层复合：先 p1 再 p2；实例化网格的 instanceMatrix 也逐层复合）。四种形式：
//   pitchWave(p, { e0, sMax })        只有竖向波（XY 平面内转）。uniform：T Amp Wave Omega HalfL
//   pitchYawWave(p, { e0, sMax })     竖向 + 横向两个分量，先俯仰后偏航的精确转动。uniform：T Amp AmpZ Wave Omega HalfL PhZ
//   pitchYawLinearWave(p, { e0, sMax }) 同上两个分量，但位移按一阶近似叠加（两个分量各自独立好调）
//   frameWave(p, { e0, sMax, pow })   横摆为主、竖向为辅，转动由斜率直接构造（不走三角函数）。
//                                     uniform：T AmpY AmpZ Wave Omega HalfL PhY
// 四种形式都有整块刚体弯 BendRigid( p, ax )：按轴位置 ax 处的位移和转动（与 BendMatrix 同一套转动）整块搬动顶点；
//   frameWave 的写在 funcs 里，其余三种只在 modeHooks 的 'rigid' 模式里才拼进着色器（rigidGlsl），不改别的模式的着色器。
// 每种形式返回 { unif, funcs, glsl, inst, rigidGlsl, js(U), hooks(o), outline(U, o), modeHooks(U, o) }：
//   glsl = uniform 声明 + 函数；inst = 实例化网格的钩子（把 instanceMatrix 换成弯过的矩阵，three 自带 chunk 无须改）
//   js(U) → 绑在 uniform 对象上的 CPU 镜像（各形式见下；都带 rigid(p, ax, t, out)，与 GLSL 的 BendRigid 一致）
//   hooks({ bend, extraPars, extraBegin, extraNormal, preBend, normalX })：材质钩子（vertexPars / MainStart / Begin / Normal）；
//     preBend（弯曲前改 transformed）、extraNormal（改 objectNormal）末尾不带换行也行；bend = false 时它们照样生效，只是不弯
//   outline(U, { bend, pars, begin, uniforms })：给 ID 图描边的同款顶点形变 { head, body, uniforms }
//   modeHooks(U, { mode, dispPars, disp, varPars, varBegin, extraUniforms })：mode = 'vertex' 逐顶点 / 'rigid' 按 aAnchor 整块 /
//     'inst' 按实例原点 / 'none'；disp 是弯曲前的顶点位移（也交给 ID 图）；带 outlineVertex
import { clamp, ss, seg, TAU } from '../core/math.js';

const sstep = (a, b, x) => ss(seg(x, a, b));
const lit = v => Number.isInteger(v) ? v.toFixed(1) : String(v);
const uName = p => 'u' + p[0].toUpperCase() + p.slice(1);

// 拼接 GLSL 片段时保证预处理指令落在行首
const nl = s => s && !s.endsWith('\n') ? s + '\n' : s;

function finish(p, unif, funcs, js, rigidGlsl = '') {
  const glsl = '\n' + unif + funcs;
  // 同一个材质里第二套弯曲：GetIM 展开时取到的是上一套的 IM（宏），先 #undef 再重定义 → 逐层复合，不会宏重定义
  const inst = `
#ifdef USE_INSTANCING
mat4 ${p}GetIM() { return instanceMatrix; }
mat4 ${p}IM;
#ifdef instanceMatrix
#undef instanceMatrix
#endif
#define instanceMatrix ${p}IM
#endif
`;
  const mainStart = `#ifdef USE_INSTANCING\n${p}IM = ${p}BendMatrix( ${p}GetIM() );\n#endif`;
  function hooks({ bend = true, extraPars = '', extraBegin = '', extraNormal = '', preBend = '', normalX = 'position.x' } = {}) {
    if (!bend) {
      if (!extraPars && !extraBegin && !preBend && !extraNormal) return {};
      const h = { vertexPars: extraPars, vertexBegin: preBend ? nl(extraBegin) + preBend : extraBegin };
      if (extraNormal) h.vertexNormal = extraNormal;
      return h;
    }
    return {
      vertexPars: glsl + inst + extraPars,
      vertexMainStart: mainStart,
      vertexBegin: extraBegin + '\n' + nl(preBend) + `#ifndef USE_INSTANCING\ntransformed = ${p}BendPos( transformed );\n#endif`,
      vertexNormal: nl(extraNormal) + `#ifndef USE_INSTANCING\nobjectNormal = ${p}BendNormal( objectNormal, ${normalX} );\n#endif`,
    };
  }
  function outline(U, { bend = true, pars = '', begin = '', uniforms = {} } = {}) {
    if (!bend && !pars && !begin) return undefined;
    const head = (bend ? glsl + inst : '') + pars;
    const body = begin + (bend ? `\n#ifdef USE_INSTANCING\n${p}IM = ${p}BendMatrix( ${p}GetIM() );\n#else\ntransformed = ${p}BendPos( transformed );\n#endif\n` : '');
    return { head, body, uniforms: { ...U, ...uniforms } };
  }
  function modeHooks(U, { mode = 'none', dispPars = '', disp = '', varPars = '', varBegin = '', extraUniforms = {} } = {}) {
    const bend = mode !== 'none';
    const pars = unif + (bend ? '\n' + funcs + (mode === 'rigid' ? rigidGlsl : '') + inst : '') + (mode === 'rigid' ? 'attribute float aAnchor;\n' : '') + dispPars;
    const bendPos = mode === 'vertex' ? `transformed = ${p}BendPos( transformed );` : mode === 'rigid' ? `transformed = ${p}BendRigid( transformed, aAnchor );` : '';
    const bendNrm = mode === 'vertex' ? `objectNormal = ${p}BendNormal( objectNormal, position.x );` : mode === 'rigid' ? `objectNormal = ${p}BendNormal( objectNormal, aAnchor );` : '';
    const ms = bend ? mainStart : '';
    const out = { vertexPars: pars + varPars, vertexMainStart: ms, vertexBegin: varBegin + '\n' + disp + '\n' + bendPos, vertexNormal: bendNrm };
    if (bend || disp) out.outlineVertex = { head: pars, body: ms + '\n' + disp + '\n' + bendPos, uniforms: { ...U, ...extraUniforms } };
    return out;
  }
  return { unif, funcs, glsl, inst, rigidGlsl, js, hooks, outline, modeHooks };
}

// js(U) → { dy(x, t), bend(x, t) → [dy, 俯仰角], rigid(p, ax, t, out) }
export function pitchWave(p, { e0 = 0.22, sMax = 1.15 } = {}) {
  const u = uName(p);
  const unif = `uniform float ${u}T, ${u}Amp, ${u}Wave, ${u}Omega, ${u}HalfL;\n`;
  const funcs = `float ${p}Dy( float x ) {
  float s = clamp( ( ${u}HalfL - x ) / ( 2.0 * ${u}HalfL ), 0.0, ${lit(sMax)} );
  float e = smoothstep( ${lit(e0)}, 1.0, s );
  return ${u}Amp * e * e * sin( 6.2831853 * s * ${u}Wave - ${u}Omega * ${u}T );
}
vec2 ${p}Bend( float x ) {
  float d0 = ${p}Dy( x );
  return vec2( d0, atan( ( ${p}Dy( x + 1.0 ) - ${p}Dy( x - 1.0 ) ) * 0.5 ) );
}
vec3 ${p}BendPos( vec3 p ) {
  vec2 b = ${p}Bend( p.x ); float c = cos( b.y ), s = sin( b.y );
  return vec3( p.x - p.y * s, b.x + p.y * c, p.z );
}
vec3 ${p}BendNormal( vec3 n, float x ) {
  vec2 b = ${p}Bend( x ); float c = cos( b.y ), s = sin( b.y );
  return vec3( n.x * c - n.y * s, n.x * s + n.y * c, n.z );
}
mat4 ${p}BendMatrix( mat4 im ) {
  float x0 = im[ 3 ].x;
  vec2 b = ${p}Bend( x0 ); float c = cos( b.y ), s = sin( b.y );
  mat4 R = mat4( c, s, 0.0, 0.0,  -s, c, 0.0, 0.0,  0.0, 0.0, 1.0, 0.0,  0.0, 0.0, 0.0, 1.0 );
  mat4 T1 = mat4( 1.0 ); T1[ 3 ] = vec4( x0, b.x, 0.0, 1.0 );
  mat4 T0 = mat4( 1.0 ); T0[ 3 ] = vec4( - x0, 0.0, 0.0, 1.0 );
  return T1 * R * T0 * im;
}
`;
  const rigid = `vec3 ${p}BendRigid( vec3 p, float ax ) {
  vec2 b = ${p}Bend( ax ); float c = cos( b.y ), s = sin( b.y );
  vec3 v = p - vec3( ax, 0.0, 0.0 );
  return vec3( ax + v.x * c - v.y * s, b.x + v.x * s + v.y * c, v.z );
}
`;
  const js = U => {
    const A = U[u + 'Amp'], Wv = U[u + 'Wave'], Om = U[u + 'Omega'], H = U[u + 'HalfL'];
    const dy = (x, T) => { const s = clamp((H.value - x) / (2 * H.value), 0, sMax), e = sstep(e0, 1, s); return A.value * e * e * Math.sin(TAU * s * Wv.value - Om.value * T); };
    const bend = (x, T) => [dy(x, T), Math.atan((dy(x + 1, T) - dy(x - 1, T)) / 2)];
    function rigid(q, ax, T, out) {
      const [b0, th] = bend(ax, T), c = Math.cos(th), s = Math.sin(th), vx = q.x - ax;
      return out.set(ax + vx * c - q.y * s, b0 + vx * s + q.y * c, q.z);
    }
    return { dy, bend, rigid };
  };
  return finish(p, unif, funcs, js, rigid);
}

// js(U) → { d(x, t) → [dy, dz], point(p, t, out), rigid(p, ax, t, out) }
export function pitchYawWave(p, { e0 = 0.2, sMax = 1.15 } = {}) {
  const u = uName(p);
  const unif = `uniform float ${u}T, ${u}Amp, ${u}AmpZ, ${u}Wave, ${u}Omega, ${u}HalfL, ${u}PhZ;\n`;
  const funcs = `vec2 ${p}D( float x ) {
  float s = clamp( ( ${u}HalfL - x ) / ( 2.0 * ${u}HalfL ), 0.0, ${lit(sMax)} );
  float e = smoothstep( ${lit(e0)}, 1.0, s ); e *= e;
  float ph = 6.2831853 * s * ${u}Wave - ${u}Omega * ${u}T;
  return e * vec2( ${u}Amp * sin( ph ), ${u}AmpZ * sin( ph + ${u}PhZ ) );
}
vec4 ${p}Bend( float x ) {           // (dy, dz, 俯仰角, 偏航角)
  vec2 d0 = ${p}D( x ), sl = ( ${p}D( x + 1.0 ) - ${p}D( x - 1.0 ) ) * 0.5;
  return vec4( d0, atan( sl.x ), atan( sl.y ) );
}
vec3 ${p}Rot( vec3 v, vec4 b ) {     // 先俯仰（XY 平面）再偏航（XZ 平面）
  float c = cos( b.z ), s = sin( b.z );
  vec3 r = vec3( v.x * c - v.y * s, v.x * s + v.y * c, v.z );
  float cy = cos( b.w ), sy = sin( b.w );
  return vec3( r.x * cy - r.z * sy, r.y, r.x * sy + r.z * cy );
}
vec3 ${p}BendPos( vec3 p ) { vec4 b = ${p}Bend( p.x ); return vec3( p.x, b.x, b.y ) + ${p}Rot( vec3( 0.0, p.y, p.z ), b ); }
vec3 ${p}BendNormal( vec3 n, float x ) { return ${p}Rot( n, ${p}Bend( x ) ); }
mat4 ${p}BendMatrix( mat4 im ) {
  float x0 = im[ 3 ].x;
  vec4 b = ${p}Bend( x0 );
  float c = cos( b.z ), s = sin( b.z ), cy = cos( b.w ), sy = sin( b.w );
  mat4 Rp = mat4( c, s, 0.0, 0.0,  -s, c, 0.0, 0.0,  0.0, 0.0, 1.0, 0.0,  0.0, 0.0, 0.0, 1.0 );
  mat4 Ry = mat4( cy, 0.0, sy, 0.0,  0.0, 1.0, 0.0, 0.0,  -sy, 0.0, cy, 0.0,  0.0, 0.0, 0.0, 1.0 );
  mat4 T1 = mat4( 1.0 ); T1[ 3 ] = vec4( x0, b.x, b.y, 1.0 );
  mat4 T0 = mat4( 1.0 ); T0[ 3 ] = vec4( - x0, 0.0, 0.0, 1.0 );
  return T1 * Ry * Rp * T0 * im;
}
`;
  const rigid = `vec3 ${p}BendRigid( vec3 p, float ax ) { vec4 b = ${p}Bend( ax ); return vec3( ax, b.x, b.y ) + ${p}Rot( p - vec3( ax, 0.0, 0.0 ), b ); }
`;
  const js = U => {
    const A = U[u + 'Amp'], AZ = U[u + 'AmpZ'], Wv = U[u + 'Wave'], Om = U[u + 'Omega'], H = U[u + 'HalfL'], PZ = U[u + 'PhZ'];
    const d = (x, T) => {
      const s = clamp((H.value - x) / (2 * H.value), 0, sMax), e0v = sstep(e0, 1, s), e = e0v * e0v;
      const ph = TAU * s * Wv.value - Om.value * T;
      return [A.value * e * Math.sin(ph), AZ.value * e * Math.sin(ph + PZ.value)];
    };
    // 先俯仰再偏航，转 (vx, vy, vz)，再平移到轴位置 x0 的弯曲点
    function place(x0, vx, vy, vz, T, out) {
      const d0 = d(x0, T), d1 = d(x0 + 1, T), dm = d(x0 - 1, T);
      const th = Math.atan((d1[0] - dm[0]) / 2), ps = Math.atan((d1[1] - dm[1]) / 2);
      const c = Math.cos(th), s = Math.sin(th), cy = Math.cos(ps), sy = Math.sin(ps);
      const rx = vx * c - vy * s, ry = vx * s + vy * c, rz = vz;
      return out.set(x0 + rx * cy - rz * sy, d0[0] + ry, d0[1] + rx * sy + rz * cy);
    }
    const point = (q, T, out) => place(q.x, 0, q.y, q.z, T, out);
    const rigid = (q, ax, T, out) => place(ax, q.x - ax, q.y, q.z, T, out);
    return { d, point, rigid };
  };
  return finish(p, unif, funcs, js, rigid);
}

// js(U) → { dy, dz, bend(x, t) → [dy, 俯仰角, dz, 偏航角], point(p, t, out), dir(n, x, t, out), rigid(p, ax, t, out) }
// 逐顶点（BendPos / point）按一阶近似叠加两个分量；整块（BendMatrix / BendRigid / rigid）用先俯仰后偏航的真转动。
export function pitchYawLinearWave(p, { e0 = 0.18, sMax = 1.25 } = {}) {
  const u = uName(p);
  const unif = `uniform float ${u}T, ${u}Amp, ${u}AmpZ, ${u}Wave, ${u}Omega, ${u}HalfL, ${u}PhZ;\n`;
  const funcs = `float ${p}S( float x ) { return clamp( ( ${u}HalfL - x ) / ( 2.0 * ${u}HalfL ), 0.0, ${lit(sMax)} ); }
float ${p}E( float x ) { float e = smoothstep( ${lit(e0)}, 1.0, ${p}S( x ) ); return e * e; }
float ${p}Dy( float x ) { return ${u}Amp * ${p}E( x ) * sin( 6.2831853 * ${p}S( x ) * ${u}Wave - ${u}Omega * ${u}T ); }
float ${p}Dz( float x ) { return ${u}AmpZ * ${p}E( x ) * sin( 6.2831853 * ${p}S( x ) * ${u}Wave - ${u}Omega * ${u}T + ${u}PhZ ); }
vec4 ${p}Bend( float x ) {
  return vec4( ${p}Dy( x ), atan( ( ${p}Dy( x + 1.0 ) - ${p}Dy( x - 1.0 ) ) * 0.5 ), ${p}Dz( x ), atan( ( ${p}Dz( x + 1.0 ) - ${p}Dz( x - 1.0 ) ) * 0.5 ) );
}
vec3 ${p}BendPos( vec3 p ) {
  vec4 b = ${p}Bend( p.x ); float cy = cos( b.y ), sy = sin( b.y ), cz = cos( b.w ), sz = sin( b.w );
  return vec3( p.x - p.y * sy - p.z * sz, b.x + p.y * cy, b.z + p.z * cz );
}
vec3 ${p}BendNormal( vec3 n, float x ) {
  vec4 b = ${p}Bend( x ); float cy = cos( b.y ), sy = sin( b.y ), cz = cos( b.w ), sz = sin( b.w );
  vec3 m = vec3( n.x * cy - n.y * sy, n.x * sy + n.y * cy, n.z );
  return vec3( m.x * cz - m.z * sz, m.y, m.x * sz + m.z * cz );
}
mat4 ${p}BendMatrix( mat4 im ) {
  float x0 = im[ 3 ].x;
  vec4 b = ${p}Bend( x0 ); float cy = cos( b.y ), sy = sin( b.y ), cz = cos( b.w ), sz = sin( b.w );
  mat4 Rv = mat4( cy, sy, 0.0, 0.0,  -sy, cy, 0.0, 0.0,  0.0, 0.0, 1.0, 0.0,  0.0, 0.0, 0.0, 1.0 );
  mat4 Rh = mat4( cz, 0.0, sz, 0.0,  0.0, 1.0, 0.0, 0.0,  -sz, 0.0, cz, 0.0,  0.0, 0.0, 0.0, 1.0 );
  mat4 T1 = mat4( 1.0 ); T1[ 3 ] = vec4( x0, b.x, b.z, 1.0 );
  mat4 T0 = mat4( 1.0 ); T0[ 3 ] = vec4( - x0, 0.0, 0.0, 1.0 );
  return T1 * Rh * Rv * T0 * im;
}
`;
  const rigid = `vec3 ${p}BendRigid( vec3 p, float ax ) {
  vec4 b = ${p}Bend( ax ); float cy = cos( b.y ), sy = sin( b.y ), cz = cos( b.w ), sz = sin( b.w );
  vec3 v = p - vec3( ax, 0.0, 0.0 );
  vec3 m = vec3( v.x * cy - v.y * sy, v.x * sy + v.y * cy, v.z );
  return vec3( ax + m.x * cz - m.z * sz, b.x + m.y, b.z + m.x * sz + m.z * cz );
}
`;
  const js = U => {
    const A = U[u + 'Amp'], AZ = U[u + 'AmpZ'], Wv = U[u + 'Wave'], Om = U[u + 'Omega'], H = U[u + 'HalfL'], PZ = U[u + 'PhZ'];
    const kS = x => clamp((H.value - x) / (2 * H.value), 0, sMax);
    const kE = x => { const e = sstep(e0, 1, kS(x)); return e * e; };
    const dy = (x, T) => A.value * kE(x) * Math.sin(TAU * kS(x) * Wv.value - Om.value * T);
    const dz = (x, T) => AZ.value * kE(x) * Math.sin(TAU * kS(x) * Wv.value - Om.value * T + PZ.value);
    const bend = (x, T) => [dy(x, T), Math.atan((dy(x + 1, T) - dy(x - 1, T)) / 2), dz(x, T), Math.atan((dz(x + 1, T) - dz(x - 1, T)) / 2)];
    function point(q, T, out) {
      const [by, ty, bz, tz] = bend(q.x, T);
      return out.set(q.x - q.y * Math.sin(ty) - q.z * Math.sin(tz), by + q.y * Math.cos(ty), bz + q.z * Math.cos(tz));
    }
    function dir(n, x, T, out) {
      const [, ty, , tz] = bend(x, T), cy = Math.cos(ty), sy = Math.sin(ty), cz = Math.cos(tz), sz = Math.sin(tz);
      const mx = n.x * cy - n.y * sy, my = n.x * sy + n.y * cy, mz = n.z;
      return out.set(mx * cz - mz * sz, my, mx * sz + mz * cz);
    }
    function rigid(q, ax, T, out) {
      const [by, , bz] = bend(ax, T);
      dir({ x: q.x - ax, y: q.y, z: q.z }, ax, T, out);
      return out.set(ax + out.x, by + out.y, bz + out.z);
    }
    return { dy, dz, bend, point, dir, rigid };
  };
  return finish(p, unif, funcs, js, rigid);
}

// js(U) → { off(x, t) → [dy, dz], rigid(p, ax, t, out)（整块按轴位置 ax 弯，与 GLSL 的 BendRigid 一致） }
export function frameWave(p, { e0 = 0.33, sMax = 1.1, pow = 2.4 } = {}) {
  const u = uName(p);
  const unif = `uniform float ${u}T, ${u}AmpY, ${u}AmpZ, ${u}Wave, ${u}Omega, ${u}HalfL, ${u}PhY;\n`;
  const funcs = `vec2 ${p}Off( float x ) {
  float s = ( ${u}HalfL - x ) / ( 2.0 * ${u}HalfL );
  float e = pow( smoothstep( ${lit(e0)}, 1.0, clamp( s, 0.0, ${lit(sMax)} ) ), ${lit(pow)} );
  float ph = 6.2831853 * s * ${u}Wave - ${u}Omega * ${u}T;
  return e * vec2( ${u}AmpY * sin( ph + ${u}PhY ), ${u}AmpZ * sin( ph ) );
}
void ${p}Frame( float x, out vec2 o, out vec4 cs ) {
  o = ${p}Off( x );
  vec2 d = ( ${p}Off( x + 1.0 ) - ${p}Off( x - 1.0 ) ) * 0.5;
  float iy = inversesqrt( 1.0 + d.x * d.x ), iz = inversesqrt( 1.0 + d.y * d.y );
  cs = vec4( iy, d.x * iy, iz, d.y * iz );
}
vec3 ${p}Rot( vec3 v, vec4 cs ) {
  vec3 r = vec3( v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x, v.z );
  return vec3( r.x * cs.z - r.z * cs.w, r.y, r.x * cs.w + r.z * cs.z );
}
vec3 ${p}BendPos( vec3 p ) { vec2 o; vec4 cs; ${p}Frame( p.x, o, cs ); return vec3( p.x, o ) + ${p}Rot( vec3( 0.0, p.yz ), cs ); }
vec3 ${p}BendNormal( vec3 n, float x ) { vec2 o; vec4 cs; ${p}Frame( x, o, cs ); return ${p}Rot( n, cs ); }
vec3 ${p}BendRigid( vec3 p, float ax ) { vec2 o; vec4 cs; ${p}Frame( ax, o, cs ); return vec3( ax, o ) + ${p}Rot( p - vec3( ax, 0.0, 0.0 ), cs ); }
mat4 ${p}BendMatrix( mat4 im ) {
  float x0 = im[ 3 ].x;
  vec2 o; vec4 cs; ${p}Frame( x0, o, cs );
  mat4 R = mat4( vec4( ${p}Rot( vec3( 1.0, 0.0, 0.0 ), cs ), 0.0 ), vec4( ${p}Rot( vec3( 0.0, 1.0, 0.0 ), cs ), 0.0 ),
                 vec4( ${p}Rot( vec3( 0.0, 0.0, 1.0 ), cs ), 0.0 ), vec4( x0, o, 1.0 ) );
  mat4 T0 = mat4( 1.0 ); T0[ 3 ] = vec4( - x0, 0.0, 0.0, 1.0 );
  return R * T0 * im;
}
`;
  const js = U => {
    const AY = U[u + 'AmpY'], AZ = U[u + 'AmpZ'], Wv = U[u + 'Wave'], Om = U[u + 'Omega'], H = U[u + 'HalfL'], PY = U[u + 'PhY'];
    const off = (x, T) => {
      const s = (H.value - x) / (2 * H.value), e = Math.pow(sstep(e0, 1, clamp(s, 0, sMax)), pow), ph = TAU * s * Wv.value - Om.value * T;
      return [AY.value * e * Math.sin(ph + PY.value), AZ.value * e * Math.sin(ph)];
    };
    function rigid(q, ax, T, out) {
      const o0 = off(ax, T), a = off(ax + 1, T), b = off(ax - 1, T);
      const dy = (a[0] - b[0]) / 2, dz = (a[1] - b[1]) / 2, iy = 1 / Math.sqrt(1 + dy * dy), iz = 1 / Math.sqrt(1 + dz * dz);
      const cs = [iy, dy * iy, iz, dz * iz];
      const vx = q.x - ax, vy = q.y, vz = q.z;
      const rx = vx * cs[0] - vy * cs[1], ry = vx * cs[1] + vy * cs[0];
      return out.set(ax + rx * cs[2] - vz * cs[3], o0[0] + ry, o0[1] + rx * cs[3] + vz * cs[2]);
    }
    return { off, rigid };
  };
  return finish(p, unif, funcs, js);
}
