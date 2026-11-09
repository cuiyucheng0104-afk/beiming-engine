// 鲲的资产桥配方（浏览器端，由 engine/native/bridge/export.mjs 在无头 Chromium 里加载）。
// 通用部分（反照率烘焙、放样 UV、站点权重、实例合并、脊柱骨骼、GLB 上传与结构检查）在 engine/native/bridge/；
// 这里只写鲲特有的：用哪些部件、各部件分辨率与降面比例、胸鳍 / 眼睑 / 海草的动作、10 秒循环的重定时与回读断言。
//   build(ctx, spec)   → { name, scene, clips, report }        ctx = { renderer, scale? }，spec 来自 film.json 的 models 条目
//   verify(ctx, bytes, assets) → 回读报告（GLTFLoader + AnimationMixer 采样导出后的真实顶点）；ctx.preview 时附预览图
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createKun } from '../../../src/kun.js';
import { pitchWave } from '../../../engine/form/bend.js';
import { autoBlink } from '../../../engine/form/eye.js';
import { texturePBR } from '../../../engine/native/bridge/bake.mjs';
import { triangles, cleanGeometry, loftUV, stationWeights, mergeInstances, track } from '../../../engine/native/bridge/geometry.mjs';
import { spineRig, poseSpine } from '../../../engine/native/bridge/rig.mjs';

const SCALE = 1/20, TAU = Math.PI*2, DURATION = 10, FPS = 30, SPACING = 15;
const vec = new T.Vector3(), matrix = new T.Matrix4();
const assert = (ok, message) => { if(!ok) throw new Error(message); };
// 小装饰的降面比例（海葵最碎，海带不降）
const RATIO = name => name.includes('anemones')?.35:name.includes('weed')?.65:name.includes('kelp')?1:.55;

// 海草：原 aSway 公式换成四个解析 morph 基（前后 / 侧向 × 正弦 / 余弦）
function kelpDeform(mesh) {
  const sway=new T.Vector3(), sd=new T.Vector3(), dv=new T.Vector3(), dv2=new T.Vector3(), a=mesh.geometry.attributes.aSway;
  return {
    names:['back-sin','back-cos','side-sin','side-cos'],
    instance(i) {
      const phase=a.getW(i);
      sway.set(a.getX(i),a.getY(i),a.getZ(i));
      sd.crossVectors(sway,new T.Vector3(0,1,0)).addScalar(.0001).normalize().multiplyScalar(sway.length());
      return phase;
    },
    vertex(phase, vec, im, write) {
      const hg=T.MathUtils.clamp(vec.y,0,1), h2=hg*hg;
      vec.addScaledVector(sway,.3*.9*h2);vec.y-=.12*h2;
      for(let k=0;k<4;k++) {
        const v=k<2?sway:sd, ph=k<2?phase:phase*1.3-hg*2.4;
        dv.copy(v).multiplyScalar((k<2?.14*.9:.2)*h2*(k%2===0?Math.cos(ph):Math.sin(ph)));
        dv2.copy(dv).applyMatrix3(new T.Matrix3().setFromMatrix4(im)).multiplyScalar(SCALE);
        write(k,dv2);
      }
    },
  };
}

export async function build({ renderer }, { lod = 0.5 }) {
  const tex = (g, m, name, w, h) => texturePBR(renderer, g, m, name, w, h, name.includes('eye-ball')?.28:.87);
  const sourceMeshes = [], details = [];
  const kun=createKun({lod,seed:20261103,wisps:false,blinkPeriod:5,blinkOffset:1.5});
  kun.group.traverse(o=>{if(o.isMesh)sourceMeshes.push(o);});
  const wave=pitchWave('kun',{e0:.22,sMax:1.15}).js(kun.uniforms);
  const root=new T.Group();root.name='kun';
  root.userData={source:'beiming-engine/src/kun.js createKun',lod,sourceScale:SCALE,lengthNominal:30,forward:'+X',up:'+Y',clip:'Swim',duration:10,loop:true,materialPolicy:'Keep embedded baseColorTexture and COLOR_0 when replacing with RAEA ToonMaterial'};
  const anchors=Array.from({length:41},(_,i)=>-300+i*SPACING);
  const {bones,skeleton}=spineRig(root,anchors,{prefix:'kun',scale:SCALE});
  const skinned=[];
  const addSkin=(g,mat,name,ax)=>{
    stationWeights(g,anchors,{spacing:SPACING,scale:SCALE,anchorX:ax});
    const mesh=new T.SkinnedMesh(g,mat);mesh.name=name;mesh.frustumCulled=false;root.add(mesh);mesh.bind(skeleton,new T.Matrix4());skinned.push(mesh);return mesh;
  };
  const merge=mesh=>{const d=mergeInstances(renderer,mesh,{scale:SCALE,ratio:RATIO(mesh.name),deform:mesh.name==='kun-kelp'?kelpDeform(mesh):null});details.push(d.detail);return d;};
  const body=kun.group.getObjectByName('kun-body');
  const nv=Math.round(56+(128-56)*lod)&~1;
  const bodyGeo=loftUV(body.geometry,nv), bodyMat=tex(bodyGeo,body.material,'kun-body-PBR',2048,1024);
  cleanGeometry(bodyGeo).scale(SCALE,SCALE,SCALE);addSkin(bodyGeo,bodyMat,'kun-body');
  const fluke=kun.group.getObjectByName('kun-flukes'), fg=loftUV(fluke.geometry,28), fm=tex(fg,fluke.material,'kun-flukes-PBR');
  cleanGeometry(fg).scale(SCALE,SCALE,SCALE);addSkin(fg,fm,'kun-flukes');
  const finNodes=[];
  for(const f of kun.fins) {
    const pivot=new T.Group();pivot.name=f.pivot.name;root.add(pivot);finNodes.push({f,pivot});
    const g=loftUV(f.mesh.geometry,26),m=tex(g,f.mesh.material,pivot.name+'-PBR');
    cleanGeometry(g).scale(SCALE,SCALE,SCALE);
    const mesh=new T.Mesh(g,m);mesh.name=pivot.name+'-surface';pivot.add(mesh);
    for(const child of f.pivot.children.filter(o=>o.isInstancedMesh)) {
      const data=merge(child),props=new T.Mesh(data.geometry,data.material);props.name=pivot.name+'-barnacles';pivot.add(props);
    }
  }
  const lidNodes=[];
  let eyeMat,lidMat;
  for(const eye of kun.eyes) {
    const side=eye.side>0?'R':'L';const socket=new T.Group();socket.name='kun-eye-'+side;
    socket.position.copy(eye.group.position).multiplyScalar(SCALE);socket.quaternion.copy(eye.group.quaternion);root.add(socket);
    if(!eyeMat)eyeMat=tex(eye.ball.geometry,eye.ball.material,'kun-eye-ball-PBR',1024,512);
    const ball=new T.Mesh(eye.ball.geometry.clone().scale(SCALE,SCALE,SCALE),eyeMat);ball.name='kun-eye-ball-'+side;socket.add(ball);
    if(!lidMat)lidMat=tex(new T.SphereGeometry(12*1.07,80,48),eye.lidU.children[0].material,'kun-eyelids-PBR',512,256);
    for(const [part,source]of [['upper',eye.lidU],['lower',eye.lidL]]){
      const pivot=new T.Group();pivot.name=`kun-eyelid-${part}-${side}`;socket.add(pivot);
      const shell=new T.Mesh(source.children[0].geometry.clone().scale(SCALE,SCALE,SCALE),lidMat);shell.name=pivot.name+'-shell';pivot.add(shell);
      lidNodes.push({pivot,source});
    }
  }
  for(const mesh of kun.group.children.filter(o=>o.isInstancedMesh)) {
    const d=merge(mesh);addSkin(d.geometry,d.material,mesh.name,d.anchors);
  }
  console.log('Built portable skin and PBR geometry');
  const times=Array.from({length:DURATION*FPS+1},(_,i)=>i/FPS),tracks=[];
  const Z=new T.Vector3(0,0,1), bq=new T.Quaternion(), sq=new T.Quaternion(), euler=new T.Euler();
  const pose=t=>{
    poseSpine(bones,anchors,wave,t,SCALE);
    for(const {f,pivot}of finNodes) {
      const [dy,th]=wave.bend(f.x0,t), r=f.root, ph=TAU*t/5+(f.side>0?0:.35);
      pivot.position.set((r.x-r.y*Math.sin(th))*SCALE,(dy+r.y*Math.cos(th))*SCALE,r.z*SCALE);
      sq.setFromEuler(euler.set(f.side*.11*Math.sin(ph),.05*Math.sin(ph+1.1),0,'XYZ'));
      pivot.quaternion.copy(bq.setFromAxisAngle(Z,th)).multiply(f.baseQ).multiply(sq);
    }
    kun.setPose(t,{blink:autoBlink(t,5,1.5)});
    for(const {pivot,source}of lidNodes)pivot.quaternion.copy(source.quaternion);
  };
  const animated=[...bones,...finNodes.map(x=>x.pivot)];
  for(const node of animated) {
    const p=[],q=[];
    for(const t of times){pose(t===DURATION?0:t);p.push(...node.position);q.push(...node.quaternion);}
    // 头部不动的站点不需要通道
    if(p.some((v,i)=>Math.abs(v-p[i%3])>1e-9))tracks.push(track(node.name,'position',times,p));
    if(q.some((v,i)=>Math.abs(v-q[i%4])>1e-9))tracks.push(track(node.name,'quaternion',times,q));
  }
  const blinkTimes=[0,1.5,1.625,1.75,1.875,2,6.5,6.625,6.75,6.875,7,10];
  for(const {pivot}of lidNodes){const q=[];for(const t of blinkTimes){pose(t===10?0:t);q.push(...pivot.quaternion);}tracks.push(track(pivot.name,'quaternion',blinkTimes,q,true));}
  const kelp=skinned.find(x=>x.name==='kun-kelp'), weights=[];
  for(const t of times){const phase=t===10?0:t;weights.push(Math.sin(TAU*3*phase/10),Math.cos(TAU*3*phase/10),Math.sin(TAU*4*phase/10),Math.cos(TAU*4*phase/10));}
  tracks.push(track(kelp.name,'morphTargetInfluences',times,weights));
  pose(0);kelp.morphTargetInfluences=[0,1,0,1];root.updateMatrixWorld(true);skeleton.update();
  const clip=new T.AnimationClip('Swim',DURATION,tracks);
  // 用原 GPU 波形公式量化骨骼近似误差
  let maxError=0,sumSq=0,samples=0;
  const sample=bodyGeo.attributes.position, si=bodyGeo.attributes.skinIndex, sw=bodyGeo.attributes.skinWeight;
  const expect=new T.Vector3(), actual=new T.Vector3(), tmp=new T.Vector3();
  for(let frame=0;frame<20;frame++){
    const t=frame/4;pose(t);root.updateMatrixWorld(true);skeleton.update();
    for(let i=0;i<sample.count;i+=7){
      vec.fromBufferAttribute(sample,i);const x=vec.x/SCALE,y=vec.y/SCALE,[dy,th]=wave.bend(x,t);
      expect.set((x-y*Math.sin(th))*SCALE,(dy+y*Math.cos(th))*SCALE,vec.z);
      actual.set(0,0,0);
      for(let k=0;k<2;k++){const ix=si.array[i*4+k];matrix.fromArray(skeleton.boneMatrices,ix*16);tmp.copy(vec).applyMatrix4(matrix);actual.addScaledVector(tmp,sw.getComponent(i,k));}
      const error=expect.distanceTo(actual);maxError=Math.max(maxError,error);sumSq+=error*error;samples++;
    }
  }
  assert(maxError<.025,'Spine approximation error exceeds 2.5 cm');
  pose(0);root.updateMatrixWorld(true);skeleton.update();
  const scene=new T.Scene();scene.name='Beiming-Kun';scene.add(root);
  return {scene,clips:[clip],report:{lod,sourceTriangles:sourceMeshes.reduce((n,m)=>n+triangles(m.geometry)*(m.isInstancedMesh?m.count:1),0),sourceInstances:details.reduce((n,d)=>n+d.instances,0),decimation:details,skinWaveError:{maxWorldUnits:maxError,rmsWorldUnits:Math.sqrt(sumSq/samples),samples},mechanism:'41 independent spine stations + root bone; two joint weights per body vertex and per decoration anchor; original fin pivot motion; STEP eyelid rotations; four analytic kelp morph targets',retiming:{spineSeconds:5,pectoralSeconds:5,originalPectoralSeconds:6,blinkPeriodSeconds:5,originalBlinkPeriodSeconds:4,kelpCyclesPer10Seconds:[3,4]},limits:['Fin-tip cloud wisps omitted (scene VFX).','View-dependent toon lighting/outline and ink jitter are not baked; RAEA supplies lighting and toon treatment.','Eye gaze and catchlights baked at the original neutral gaze; eyelid shell motion remains animated.','Preserve baseColorTexture and COLOR_0 when overriding PBR materials with ToonMaterial.','glTF has no loop flag: runtime must repeat the 10-second Swim clip.','Small decorations decimated; all source LOD 0.5 instances retained.']}};
}

// 回读：GLTFLoader 解析导出的字节，AnimationMixer 采样尾端、胸鳍尖、吻端、海草的真实顶点
export async function verify({ renderer, preview }, bytes, assets = {}) {
  const parsed=await new GLTFLoader().parseAsync(bytes,''), scene=parsed.scene;
  assert(parsed.animations[0]?.name==='Swim','GLTFLoader lost Swim clip');
  const mixer=new T.AnimationMixer(scene),action=mixer.clipAction(parsed.animations[0]);action.setLoop(T.LoopOnce,1);action.clampWhenFinished=true;action.play();
  const at=t=>{action.reset().play();mixer.setTime(t);scene.updateMatrixWorld(true);scene.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});};
  const fluke=scene.getObjectByName('kun-flukes'),fin=scene.getObjectByName('kun-fin-R-surface'),body=scene.getObjectByName('kun-body'),kelp=scene.getObjectByName('kun-kelp');
  const point=(mesh,index)=>mesh.localToWorld(mesh.getVertexPosition(index,new T.Vector3()));
  const extreme=(mesh,axis,sign=1)=>{const a=mesh.geometry.attributes.position;let best=0;for(let i=1;i<a.count;i++)if(a.getComponent(i,axis)*sign>a.getComponent(best,axis)*sign)best=i;return best;};
  const tailIndex=extreme(fluke,0,-1),finIndex=extreme(fin,2,1),headIndex=extreme(body,0,1),kelpIndex=extreme(kelp,1,1);
  const paths={tail:[],fin:[],head:[],kelp:[]};
  for(let i=0;i<=40;i++){at(i*.25);for(const [name,m,ix]of [['tail',fluke,tailIndex],['fin',fin,finIndex],['head',body,headIndex],['kelp',kelp,kelpIndex]])paths[name].push(point(m,ix).toArray());}
  const movement={};for(const [name,points]of Object.entries(paths)){const box=new T.Box3().setFromPoints(points.map(p=>new T.Vector3(...p)));movement[name]={rangeXYZ:box.getSize(new T.Vector3()).toArray(),loopEndpointDistance:new T.Vector3(...points[0]).distanceTo(new T.Vector3(...points.at(-1)))};}
  assert(movement.tail.rangeXYZ[1]>.8,'Tail failed to deform');assert(Math.max(...movement.fin.rangeXYZ)>.8,'Pectoral fin failed to move');assert(Math.max(...movement.head.rangeXYZ)<.001,'Unexpected global drift');
  for(const value of Object.values(movement))assert(value.loopEndpointDistance<1e-5,'Reloaded clip has a loop seam');
  const lid=scene.getObjectByName('kun-eyelid-upper-R');at(0);const open=lid.quaternion.clone();at(1.7);const angle=open.angleTo(lid.quaternion);assert(angle>.5,'Eyelid did not close');
  at(0);const size=new T.Box3().setFromObject(scene,true).getSize(new T.Vector3());assert(size.x>28&&size.x<32,'Unexpected kun scale');
  const result={loadedWith:'three GLTFLoader r170 + AnimationMixer (exported bytes)',boundsXYZ:size.toArray(),movement,upperLidBlinkAngleRadians:angle,materialsAllStandard:true};
  scene.traverse(o=>{if(o.isMesh)assert(o.material.isMeshStandardMaterial,'Nonstandard material after reload');});
  if(preview) {
    const ferry=assets['ferry.glb']?(await new GLTFLoader().parseAsync(assets['ferry.glb'],'')).scene:null;
    document.body.append(makePreview(renderer,scene,at,ferry));
  }
  return result;
}

function makePreview(renderer,model,at,ferry) {
  // 只是几张 GLB 回读静帧，不渲时间线、不占外部端口
  const sheet=document.createElement('canvas');sheet.width=1600;sheet.height=1120;
  const ctx=sheet.getContext('2d');ctx.fillStyle='#121c2d';ctx.fillRect(0,0,1600,1120);
  ctx.fillStyle='#f2efdc';ctx.font='bold 27px sans-serif';ctx.fillText('BEIMING KUN  /  PORTABLE GLB',36,42);
  ctx.fillStyle='#96abc2';ctx.font='17px sans-serif';ctx.fillText('PBR albedo • GLTFLoader round trip • Swim / 10 s loop • LOD 0.5',36,71);
  const stage=new T.Scene();stage.background=new T.Color('#203249');stage.add(model);
  stage.add(new T.HemisphereLight(0xf8faff,0x525c74,2.5));
  const key=new T.DirectionalLight(0xffefd9,3.0);key.position.set(5,16,14);stage.add(key);
  const rim=new T.DirectionalLight(0xadc9ff,1.4);rim.position.set(-12,7,-14);stage.add(rim);
  const renderPanel=(x,y,w,h,eye,target,label,time)=>{
    at(time);renderer.setSize(w,h,false);
    const cam=new T.PerspectiveCamera(36,w/h,.05,200);cam.position.set(...eye);cam.lookAt(...target);
    renderer.render(stage,cam);ctx.drawImage(renderer.domElement,x,y,w,h);
    ctx.fillStyle='rgba(12,22,38,.84)';ctx.fillRect(x,y+h-35,w,35);ctx.fillStyle='#e1e9f2';ctx.font='16px sans-serif';ctx.fillText(label,x+14,y+h-12);
  };
  renderPanel(24,92,1016,544,[22,14,39],[0,-.6,0],'01 / full form • t = 0.00 s',0);
  renderPanel(1060,92,516,264,[11,2.3,9.4],[10.7,-.4,2.5],'02 / original eye • open',0);
  renderPanel(1060,372,516,264,[11,2.3,9.4],[10.7,-.4,2.5],'03 / eyelid shells • closed at 1.70 s',1.7);
  renderPanel(24,656,500,368,[1,8,40],[0,-.4,0],'04 / tail and fins • t = 1.25 s',1.25);
  renderPanel(540,656,500,368,[1,8,40],[0,-.4,0],'05 / tail and fins • t = 3.75 s',3.75);
  if(ferry){stage.remove(model);stage.add(ferry);renderPanel(1060,656,516,368,[2.6,1.7,3.3],[0,.25,0],'06 / ferry • 2 m • emissive lamps',0);}
  ctx.fillStyle='#96abc2';ctx.font='16px sans-serif';ctx.fillText('Skinned spine + tail • animated pectoral pivots • blinking lids • 4 kelp morph targets',36,1063);
  ctx.fillText('All colours embedded. Apply RAEA ToonMaterial while retaining baseColorTexture and COLOR_0.',36,1091);
  return sheet;
}
