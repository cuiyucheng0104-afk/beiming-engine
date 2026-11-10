// 北冥引擎 · 原生层 · 资产桥（浏览器端主程序）：在无头 Chromium 里把 three.js 对象导出成 GLB，并回读核对。
// 由 export.mjs 起本地服务后加载；不要直接在影片页面里用。
//
//   run({ assets, preview }) → { [文件名]: 报告 }
//   asset 两种写法（字段见 export.mjs 头注释）：
//     通用：{ to, module, export, args, length|scale, prefix, names, meta, clip }
//           import(module)[export](args) → Object3D（或 { group | scene | root | object, length?, … }）
//           → 可选：按 clip.pose 逐帧采样所有子节点的位置 / 旋转 / 缩放与 morph 权重，生成一段关键帧动画
//           → 材质换成普通 PBR（MeshBasicMaterial 视为自发光；保留贴图、顶点色、双面、透明）→ 统一缩放 → GLB
//     配方：{ to, recipe, … }  配方模块自己 build(ctx, asset) → { scene, clips, report }，可选 verify(ctx, bytes, 全部字节)
import * as T from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { track } from './geometry.mjs';

const renderer = new T.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
renderer.outputColorSpace = T.SRGBColorSpace;
renderer.toneMapping = T.NoToneMapping;
const assert = (ok, message) => { if(!ok) throw new Error(message); };

async function upload(name, scene, clips=[], maxBytes=20_000_000) {
  const bytes=await new GLTFExporter().parseAsync(scene,{binary:true,animations:clips,onlyVisible:true,trs:true});
  const j=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,20,new DataView(bytes).getUint32(12,true))));
  console.log(JSON.stringify({asset:name,bytes:bytes.byteLength,embeddedImageBytes:j.images?.reduce((sum,i)=>sum+j.bufferViews[i.bufferView].byteLength,0)||0,meshes:j.meshes.length}));
  assert(bytes.byteLength<maxBytes,`${name} exceeds ${maxBytes} bytes: ${bytes.byteLength}`);
  const r=await fetch('/output/'+encodeURIComponent(name),{method:'POST',headers:{'Content-Type':'model/gltf-binary'},body:bytes});
  assert(r.ok,await r.text());console.log(`Saved ${name}: ${(bytes.byteLength/1e6).toFixed(2)} MB`);
  return bytes;
}

// 任意材质 → 普通 PBR。只在与默认值不同时才设置额外字段，所以朴素输入的导出结果保持稳定。
// 材质名：源材质的 name 非空时为 <前缀>-<name>，否则 <前缀>-PBR-<序号> / <前缀>-emissive-<序号>。
function standardOf(old, n, prefix) {
  const emissive=old.isMeshBasicMaterial;
  const intensity=emissive?Math.max(old.color.r,old.color.g,old.color.b,1):0;
  const color=emissive?old.color.clone().multiplyScalar(1/intensity):old.color;
  const m=new T.MeshStandardMaterial({color:emissive?0x111111:color,roughness:.8,metalness:0,emissive:emissive?color:0x000000,emissiveIntensity:intensity});
  // 源材质有名字就沿用（film.tsx 能按名字给某个部件单独的卡通 / 自发光覆盖）；没名字按序号
  m.name=old.name?`${prefix}-${old.name}`:emissive?`${prefix}-emissive-${n}`:`${prefix}-PBR-${n}`;
  if(old.map) m.map=old.map;
  if(old.vertexColors) m.vertexColors=true;
  if(old.side!==undefined&&old.side!==T.FrontSide) m.side=old.side;
  if(old.transparent){m.transparent=true;m.opacity=old.opacity;}
  return m;
}

function portable(g, scale, prefix) {
  let id=0;const cache=new Map(), lights=[];
  g.traverse(obj=>{
    if(obj===g)return;
    obj.position.multiplyScalar(scale);
    if(!obj.isMesh)return;
    obj.name ||= `${prefix}-part-`+String(id++).padStart(2,'0');
    obj.geometry=obj.geometry.clone().scale(scale,scale,scale);obj.userData={};delete obj.customDepthMaterial;
    const convert=old=>{if(!cache.has(old))cache.set(old,standardOf(old,cache.size,prefix));return cache.get(old);};
    obj.material=Array.isArray(obj.material)?obj.material.map(convert):convert(obj.material);
    const first=Array.isArray(obj.material)?obj.material[0]:obj.material;
    if(first.emissiveIntensity>0)lights.push({name:obj.name,emissiveIntensity:first.emissiveIntensity});
  });
  return lights;
}

// 逐帧调用 pose(t)，记录每个子节点的 TRS 与 morph 权重；没有变化的通道不写
function capture(g, pose, { name='Idle', duration, fps=30, loop=true }, scale) {
  const n=Math.round(duration*fps), times=Array.from({length:n+1},(_,i)=>i/fps);
  const nodes=[];g.traverse(o=>{if(o!==g)nodes.push(o);});
  const rec=nodes.map(()=>({p:[],q:[],s:[],w:[]}));
  for(const t of times){
    pose(loop&&t===times[n]?0:t);
    nodes.forEach((o,i)=>{const r=rec[i];r.p.push(o.position.x*scale,o.position.y*scale,o.position.z*scale);r.q.push(...o.quaternion);r.s.push(...o.scale);if(o.morphTargetInfluences?.length)r.w.push(...o.morphTargetInfluences);});
  }
  pose(0);
  const moving=(a,k)=>a.some((v,i)=>Math.abs(v-a[i%k])>1e-9), tracks=[];
  nodes.forEach((o,i)=>{const r=rec[i];
    if(moving(r.p,3))tracks.push(track(o.name,'position',times,r.p));
    if(moving(r.q,4))tracks.push(track(o.name,'quaternion',times,r.q));
    if(moving(r.s,3))tracks.push(track(o.name,'scale',times,r.s));
    if(r.w.length&&moving(r.w,o.morphTargetInfluences.length))tracks.push(track(o.name,'morphTargetInfluences',times,r.w));
  });
  assert(tracks.length,`clip ${name}: pose(t) 没有让任何节点动起来`);
  return new T.AnimationClip(name,times[n],tracks);
}

async function fromModule(a) {
  const mod=await import(a.module);
  const fn=mod[a.export];
  assert(typeof fn==='function',`${a.module} 没有导出函数 ${a.export}`);
  const made=await fn(a.args);
  const g=made?.isObject3D?made:(made?.group||made?.scene||made?.root||made?.object);
  assert(g?.isObject3D,`${a.export}() 要返回 Object3D 或 { group | scene | root | object }`);
  const prefix=a.prefix||g.name||a.to.replace(/\.(glb|gltf)$/,'');
  for(const [field,pre] of Object.entries(a.names||{})) for(const [key,obj] of Object.entries(made[field]||{})) obj.name=pre+key;
  let scale=a.scale??1;
  if(a.length){const L=made.length??Math.max(...new T.Box3().setFromObject(g).getSize(new T.Vector3()).toArray());scale=a.length/L;}
  const clips=[];
  if(a.clip){
    const key=a.clip.pose||'pose';
    const pose=typeof made[key]==='function'?t=>made[key](t):typeof mod[key]==='function'?t=>mod[key](made,t):null;
    assert(pose,`clip 需要 pose(t)：${a.export}() 的返回值或模块本身要有函数 ${key}`);
    let k=0;const seen=new Set();
    g.traverse(o=>{if(o===g)return;if(!o.name||seen.has(o.name))o.name=`${prefix}-node-`+String(k++).padStart(2,'0');seen.add(o.name);});
    clips.push(capture(g,pose,a.clip,scale));
  }
  const lights=portable(g,scale,prefix);
  g.userData={source:`beiming-engine/${a.moduleRel||a.module} ${a.export}`,sourceScale:scale,...(a.length?{nominalLength:a.length}:{}),...(a.meta||{})};
  g.updateMatrixWorld(true);
  const size=new T.Box3().setFromObject(g).getSize(new T.Vector3());
  const scene=new T.Scene();if(a.sceneName)scene.name=a.sceneName;scene.add(g);
  return {scene,clips,report:{scale,boundsXYZ:size.toArray(),...(a.length?{nominalLength:a.length}:{}),emissiveMeshes:lights.length,emissive:lights,clips:clips.map(c=>({name:c.name,duration:c.duration,tracks:c.tracks.length}))}};
}

// 通用回读：GLTFLoader 解析导出字节，核对材质、尺寸，并用 AnimationMixer 采样每个动画节点的世界位置
async function readback(bytes) {
  const parsed=await new GLTFLoader().parseAsync(bytes,''), scene=parsed.scene;
  let meshes=0;scene.traverse(o=>{if(o.isMesh){meshes++;for(const m of [].concat(o.material))assert(m.isMeshStandardMaterial,'Nonstandard material after reload');}});
  scene.updateMatrixWorld(true);
  const out={loadedWith:`three GLTFLoader r${T.REVISION} (exported bytes)`,meshes,boundsXYZ:new T.Box3().setFromObject(scene,true).getSize(new T.Vector3()).toArray(),clips:[]};
  for(const clip of parsed.animations){
    const mixer=new T.AnimationMixer(scene),action=mixer.clipAction(clip);action.setLoop(T.LoopOnce,1);action.clampWhenFinished=true;action.play();
    const at=t=>{action.reset().play();mixer.setTime(t);scene.updateMatrixWorld(true);};
    const names=[...new Set(clip.tracks.map(t=>t.name.slice(0,t.name.lastIndexOf('.'))))];
    const nodes=names.map(n=>scene.getObjectByName(n)).filter(Boolean);
    const paths=nodes.map(()=>[]), steps=40;
    for(let i=0;i<=steps;i++){at(clip.duration*i/steps);nodes.forEach((o,k)=>paths[k].push(o.getWorldPosition(new T.Vector3())));}
    const motion=nodes.map((o,k)=>({node:o.name,rangeXYZ:new T.Box3().setFromPoints(paths[k]).getSize(new T.Vector3()).toArray(),loopEndpointDistance:paths[k][0].distanceTo(paths[k][steps])}));
    out.clips.push({name:clip.name,duration:clip.duration,tracks:clip.tracks.length,animatedNodes:nodes.length,maxRange:Math.max(0,...motion.map(m=>Math.max(...m.rangeXYZ))),maxLoopEndpointDistance:Math.max(0,...motion.map(m=>m.loopEndpointDistance)),motion:motion.slice(0,24)});
  }
  return out;
}

export async function run({ assets, preview = false }) {
  const ctx={renderer,preview}, built=[], bytesByName={}, reports={};
  for(const a of assets){
    const recipe=a.recipe?await import(a.recipe):null;
    const r=recipe?await recipe.build(ctx,a):await fromModule(a);
    const bytes=await upload(a.to,r.scene,r.clips||[],a.maxBytes);
    bytesByName[a.to]=bytes;built.push({a,recipe,bytes,report:r.report});
  }
  for(const {a,recipe,bytes,report} of built){
    reports[a.to]={...report,bytes:bytes.byteLength,roundTrip:recipe?.verify?await recipe.verify(ctx,bytes,bytesByName):await readback(bytes)};
  }
  return reports;
}
