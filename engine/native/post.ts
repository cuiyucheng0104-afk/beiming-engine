// 北冥引擎 · 原生层 · 后期：生成原生 FramePass 用的 WESL 源码（全屏一遍，按书写顺序依次执行）。
// 用法：<FramePass wesl={gradePass({...})} /> <FramePass wesl={paperPass({...})} />（放在 Canvas3D 里）
//
//   wf(x)                      JS 数 → WGSL 浮点字面量（1 → '1.0'）
//   paperPass({ size, grain, vignette, reach = 1.4, power = 2 })
//                              纸面颗粒 + 暗角：颗粒按 size=[宽, 高] 的像素格取着色器式正弦哈希（与 math.ts 的 sinHash 同族），
//                              幅度 grain；暗角 1 − vignette·(|uv − 0.5|·reach)^power
//   gradePass({ exposure, warmth, saturation, lift, gamma, gain, shoulder })
//                              调色，公式逐行对应 engine/look/grade.js（曝光 → 白平衡 → 饱和度 → 2.2 伽马空间里的
//                              lift/gamma/gain → 高光肩），不含 bloom 与 Kuwahara 保护通道；lift/gamma/gain 可为数或 [r,g,b]。
//                              原生 FramePass 默认在色调映射之后取帧（at="after-tonemap"），与 A 路在线性 HDR 上调色的位置不同，
//                              同参数下的逐像素等价**未验证**；要更接近 A 路，给 FramePass 加 at="before-tonemap" 并关色调映射。

export const wf = (x: number) => Number.isInteger(x) ? x.toFixed(1) : String(x);
const v3 = (v: number | number[]) => Array.isArray(v) ? `vec3<f32>(${v.map(wf).join(',')})` : `vec3<f32>(${wf(v)})`;

export function paperPass({ size, grain, vignette, reach = 1.4, power = 2 }: { size: [number, number], grain: number, vignette: number, reach?: number, power?: number }) {
  return `
fn hash(p:vec2<f32>)->f32{return fract(sin(dot(p,vec2<f32>(127.1,311.7)))*43758.5453);}
fn shade(in: FullscreenVertexOutput)->vec4<f32>{
 var c=frame(in.uv); let n=hash(floor(in.uv*vec2<f32>(${wf(size[0])},${wf(size[1])})));
 let vign=1.0-${wf(vignette)}*pow(length(in.uv-.5)*${wf(reach)},${wf(power)});
 c=vec4<f32>(c.rgb*vign+(n-.5)*${wf(grain)},c.a);return c;
}`;
}

export function gradePass({ exposure = 1, warmth = 0, saturation = 1, lift = 0, gamma = 1, gain = 1, shoulder = 1 }: { exposure?: number, warmth?: number, saturation?: number, lift?: number | number[], gamma?: number | number[], gain?: number | number[], shoulder?: number } = {}) {
  // 白平衡：暖 = 红多蓝少，再按亮度归一，不改整体明暗（与 engine/look/grade.js 相同）
  const wb = [1 + .10 * warmth, 1 + .012 * warmth, 1 - .15 * warmth];
  const y = wb[0] * .2126 + wb[1] * .7152 + wb[2] * .0722;
  const knee = shoulder < .999 ? `
 let k=${wf(shoulder)};
 let pc=min(c,vec3<f32>(k))+(1.0-k)*(1.0-exp(-max(c-vec3<f32>(k),vec3<f32>(0.0))/(1.0-k)));
 let m=max(c.r,max(c.g,c.b));
 var mm=k;
 if(m<k){mm=m;}else{mm=k+(1.0-k)*(1.0-exp(-(m-k)/(1.0-k)));}
 c=mix(c*(mm/max(m,1e-5)),pc,0.3);` : '';
  return `
fn shade(in: FullscreenVertexOutput)->vec4<f32>{
 let src=frame(in.uv);
 var c=src.rgb*${wf(exposure)};
 c=c*${v3(wb.map(x => x / y))};
 let l=dot(c,vec3<f32>(.2126,.7152,.0722));
 c=max(mix(vec3<f32>(l),c,${wf(saturation)}),vec3<f32>(0.0));
 var g=pow(c,vec3<f32>(1.0/2.2));
 g=${v3(gain)}*(g+${v3(lift)}*max(vec3<f32>(1.0)-g,vec3<f32>(0.0)));
 g=pow(max(g,vec3<f32>(0.0)),vec3<f32>(1.0)/${v3(gamma)});
 c=pow(g,vec3<f32>(2.2));${knee}
 return vec4<f32>(c,src.a);
}`;
}
