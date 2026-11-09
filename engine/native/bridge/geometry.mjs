// 北冥引擎 · 原生层 · 资产桥（浏览器端）：把 engine/form 搭出来的几何整理成可移植的 GLB 网格。
// 由 examples/raea/tools/export-kun-browser.mjs 抽出，算式不变；与具体生物无关的部分都在这里。
//
//   triangles(g)                    三角面数
//   cleanGeometry(g)                只留 position / normal / uv / color / skinIndex / skinWeight，清掉分组
//   loftUV(source, ringSize)        engine/form/loft.js 的放样拓扑重新展 UV（只在接缝与封口复制顶点）
//   stationWeights(g, stations, { spacing, scale, anchorX })
//                                   沿 x 轴等距站点（stations[i] = 第 i 个骨骼的源坐标 x）的双骨骼线性权重：
//                                   x = anchorX ? anchorX[i] : position.x / scale；关节号 = 站点号 + 1（0 号留给共同根骨）
//   mergeInstances(renderer, mesh, { scale, ratio, deform })
//                                   InstancedMesh → 一个合并网格：保留所有实例位置，小件按 ratio 降面，原着色器的固有色按顶点烘进 COLOR_0；
//                                   deform = { names, instance(i) → state, vertex(state, vec, im, write(k, delta)) } 时额外生成 morph targets
//                                   → { geometry, material, anchors（每顶点所属实例的源坐标 x）, detail }
//   track(name, prop, times, values, discrete)   位置 / 四元数 / morph 权重关键帧轨道
import * as T from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { renderBake } from './bake.mjs';

const assert = (ok, message) => { if(!ok) throw new Error(message); };
export const triangles = g => (g.index?.count || g.attributes.position.count)/3;

export function cleanGeometry(g) {
  for(const name of Object.keys(g.attributes)) if(!['position','normal','uv','color','skinIndex','skinWeight'].includes(name)) g.deleteAttribute(name);
  g.clearGroups();return g;
}

export function loftUV(source, ringSize) {
  const g=source.toNonIndexed(), rows=(source.attributes.position.count-2)/ringSize;
  assert(Number.isInteger(rows),'Unexpected source loft topology');
  const uv=new Float32Array(g.attributes.position.count*2);
  for(let i=0;i<source.index.count;i+=3) {
    const ids=[0,1,2].map(k=>source.index.getX(i+k));
    const vs=ids.map(id=>id<rows*ringSize?(id%ringSize)/ringSize:null);
    const valid=vs.filter(x=>x!==null);
    if(Math.max(...valid)-Math.min(...valid)>.5) for(let k=0;k<3;k++) if(vs[k]!==null&&vs[k]<.5) vs[k]+=1;
    for(let k=0;k<3;k++) {
      const id=ids[k];const u=id<rows*ringSize?Math.floor(id/ringSize)/(rows-1):(id===rows*ringSize?0:1);
      const v=vs[k]??vs.filter(x=>x!==null).reduce((a,b)=>a+b,0)/2;
      uv[(i+k)*2]=.001+.998*u;uv[(i+k)*2+1]=v;
    }
  }
  g.setAttribute('uv',new T.BufferAttribute(uv,2));return mergeVertices(g,1e-6);
}

export function stationWeights(g, anchors, { spacing, scale, anchorX = null }) {
  const n=g.attributes.position.count, joints=new Uint8Array(n*4), weights=new Uint8Array(n*4);
  for(let i=0;i<n;i++) {
    const x=anchorX?anchorX[i]:g.attributes.position.getX(i)/scale;
    const value=T.MathUtils.clamp((x-anchors[0])/spacing,0,anchors.length-1);
    const lo=Math.min(Math.floor(value),anchors.length-2), hi=lo+1;
    const b=Math.round((value-lo)*255);
    joints[i*4]=lo+1;joints[i*4+1]=hi+1;weights[i*4]=255-b;weights[i*4+1]=b;
  }
  g.setAttribute('skinIndex',new T.Uint8BufferAttribute(joints,4));
  g.setAttribute('skinWeight',new T.Uint8BufferAttribute(weights,4,true));
}

function decimate(mesh, ratio) {
  let g=mesh.geometry.clone();
  // 保留全部实例摆放，只简化可复用的小件本身
  for(const attr of Object.keys(g.attributes)) if(attr!=='position') g.deleteAttribute(attr);
  g=mergeVertices(g,1e-5);
  if(ratio<1) g=new SimplifyModifier().modify(g,Math.floor(g.attributes.position.count*(1-ratio)));
  g.computeVertexNormals();
  return {g,detail:{name:mesh.name,instances:mesh.count,sourceTrianglesPerInstance:triangles(mesh.geometry),exportTrianglesPerInstance:triangles(g)}};
}

// 不用 EXT_mesh_gpu_instancing、自定义着色器或外部贴图：原生端拿到的是普通网格 + 顶点色
export function mergeInstances(renderer, mesh, { scale, ratio = 1, deform = null }) {
  const {g:proto,detail}=decimate(mesh,ratio), pn=proto.attributes.position.count, count=pn*mesh.count;
  const vec=new T.Vector3(), norm=new T.Vector3();
  const pos=new Float32Array(count*3), normals=new Float32Array(count*3), local=new Float32Array(count*3), objects=new Float32Array(count*3), colors=new Float32Array(count*3);
  const anchors=new Float32Array(count), indices=count<65536?new Uint16Array(proto.index.count*mesh.count):new Uint32Array(proto.index.count*mesh.count);
  const morph=deform?deform.names.map(()=>new Float32Array(count*3)):[];
  const tint=new T.Color(), nm=new T.Matrix3(), im=new T.Matrix4();
  for(let i=0;i<mesh.count;i++) {
    mesh.getMatrixAt(i,im);nm.getNormalMatrix(im);
    if(mesh.instanceColor) mesh.getColorAt(i,tint); else tint.setRGB(1,1,1);
    const state=deform?deform.instance(i):null;
    for(let j=0;j<pn;j++) {
      const id=i*pn+j, at=id*3;
      vec.fromBufferAttribute(proto.attributes.position,j);
      local.set(vec.toArray(),at);objects.set([vec.x+i*1.618,vec.y+i*2.718,vec.z+i*3.1416],at);
      colors.set(tint.toArray(),at);
      if(deform) deform.vertex(state,vec,im,(k,d)=>morph[k].set(d.toArray(),at));
      vec.applyMatrix4(im).multiplyScalar(scale);pos.set(vec.toArray(),at);
      norm.fromBufferAttribute(proto.attributes.normal,j).applyMatrix3(nm).normalize();normals.set(norm.toArray(),at);
      anchors[id]=im.elements[12];
    }
    for(let j=0;j<proto.index.count;j++) indices[i*proto.index.count+j]=i*pn+proto.index.getX(j);
  }
  const g=new T.BufferGeometry();g.setAttribute('position',new T.BufferAttribute(pos,3));g.setAttribute('normal',new T.BufferAttribute(normals,3));g.setIndex(new T.BufferAttribute(indices,1));
  g.setAttribute('aBakeObj',new T.BufferAttribute(objects,3));g.setAttribute('aBakeLocal',new T.BufferAttribute(local,3));g.setAttribute('aBakeColor',new T.BufferAttribute(colors,3));
  // 颜色烘焙每个顶点一个 GL 点，不用三角形索引
  const index=g.index;g.setIndex(null);
  const width=512,height=Math.ceil(count/width), rgba=renderBake(renderer,g,mesh.material,width,height,true);
  g.setIndex(index);
  const rgb=new Uint8Array(count*3);for(let j=0;j<count;j++) rgb.set(rgba.subarray(j*4,j*4+3),j*3);
  g.setAttribute('color',new T.Uint8BufferAttribute(rgb,3,true));
  cleanGeometry(g);
  if(deform) {
    g.computeVertexNormals();
    g.morphTargetsRelative=true;
    g.morphAttributes.position=morph.map((a,i)=>{const b=new T.BufferAttribute(a,3);b.name=deform.names[i];return b;});
    g.morphAttributes.normal=morph.map(a=>{
      const copy=g.clone();copy.morphAttributes={};
      const p=copy.attributes.position.array;for(let i=0;i<p.length;i++)p[i]+=a[i];copy.computeVertexNormals();
      const n=copy.attributes.normal.array, base=g.attributes.normal.array;for(let i=0;i<n.length;i++)n[i]-=base[i];
      return new T.BufferAttribute(n,3);
    });
  }
  const mat=new T.MeshStandardMaterial({color:0xffffff,vertexColors:true,roughness:.9,metalness:0,side:mesh.material.side});mat.name=mesh.name+'-PBR';
  return {geometry:g,material:mat,anchors,detail};
}

export function track(name, prop, times, values, discrete=false) {
  const C=prop==='quaternion'?T.QuaternionKeyframeTrack:prop==='position'||prop==='scale'?T.VectorKeyframeTrack:T.NumberKeyframeTrack;
  return new C(`${name}.${prop}`,times,values,discrete?T.InterpolateDiscrete:T.InterpolateLinear);
}
