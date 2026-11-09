// 北冥引擎 · 原生层 · 表面着色器：给原生 ShaderMesh 生成 WESL（只读 globals.time，确定性）。
// 用法：<ShaderMesh shape={{primitive:'Plane3d',half_size:[…]}} wesl={waterWesl({...})} textures={{ water: 'media/river.png' }} alpha="blend" />
// 注意：ShaderMesh 的纹理路径写**项目相对路径**（media/x.png），不是 staticFile（原实验记录的兼容点）。
//
//   waterWesl({ texture, span, origin, gain, lift, flow?, glint?, fade? })
//     把一张绘画水面贴图铺在 XZ 平面：uv = (x/span[0] + origin[0], (origin[1] − z)/span[1])，叠两层正弦扰动（flow 倍率），
//     颜色 = 贴图·gain + lift；glint = { color, x, width } 时在 x 附近一条带里加流动高光；fade = [近, 远] 按到相机的水平距离淡出
//   ribbonWesl({ color, alpha, edge, width, tear })
//     沿 uv.x 拖开的两道 V 形浪线（尾迹、拖痕）：浪线到中线的距离 = (1 − x)·edge.taper + edge.base，
//     width 线宽，tear=[频率1, 速度, 频率2, 斜率] 撕边

import { wf } from './post.ts';

const vec = (v: number[]) => `vec${v.length}<f32>(${v.map(wf).join(',')})`;

export function waterWesl({ texture, span, origin, gain, lift, flow = 1, glint, fade }: {
  texture: string, span: [number, number], origin: [number, number], gain: number, lift: [number, number, number],
  flow?: number, glint?: { color: [number, number, number], x: number, width: number }, fade?: [number, number],
}) {
  const f = (k: number) => wf(k * flow);
  const glintCode = glint ? `
 let s=sin(p.y*2.7+sin(p.x*.27+t*.4)*1.3-t*.7);
 let r=sin(p.x*.54+p.y*.2+t*.3);
 let path=exp(-pow((p.x-(${wf(glint.x)}))/${wf(glint.width)},2.0));
 c+=${vec(glint.color)}*smoothstep(.91,1.0,s)*smoothstep(.45,.9,r)*path;` : '';
  const alpha = fade ? `1.0-smoothstep(${wf(fade[0])},${wf(fade[1])},length(p-view.world_position.xz))` : '1.0';
  return `
fn shade(in: VertexOutput) -> vec4<f32> {
 let p = in.world_position.xz; let t=globals.time;
 var uv=vec2<f32>(p.x/${wf(span[0])}+${wf(origin[0])},(-p.y+${wf(origin[1])})/${wf(span[1])});
 uv.x+=sin(p.y*1.2+t*.8)*${f(.002)}+sin(p.y*.3-t*.4)*${f(.003)};
 uv.y+=sin(p.x*.28+p.y*.6-t*.5)*${f(.0015)};
 uv=clamp(uv,vec2<f32>(.015),vec2<f32>(.985));
 var c=textureSample(tex_${texture},samp_${texture},uv).rgb;
 c=c*${wf(gain)}+${vec(lift)};${glintCode}
 return vec4<f32>(c,${alpha});
}`;
}

export function ribbonWesl({ color, alpha, edge, width, tear }: {
  color: [number, number, number], alpha: number, edge: { base: number, taper: number }, width: number, tear: [number, number, number, number],
}) {
  return `
fn shade(in:VertexOutput)->vec4<f32>{
 let uv=in.uv;let x=uv.x;
 let edge=(1.0-x)*${wf(edge.taper)}+${wf(edge.base)};
 let row=abs(uv.y-.5);
 let stripe=exp(-pow((row-edge)/${wf(width)},2.0));
 let torn=smoothstep(-.3,.6,sin(x*${wf(tear[0])}+globals.time*${wf(tear[1])})+sin(uv.y*${wf(tear[2])}-x*${wf(tear[3])}));
 let a=stripe*torn*smoothstep(0.0,.22,x)*(1.0-smoothstep(.78,1.0,x))*${wf(alpha)};
 return vec4<f32>(${color.map(wf).join(',')},a);
}`;
}
