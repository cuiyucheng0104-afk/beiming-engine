import * as T from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { createKun } from '/source/src/kun.js';
import { createFerry } from '/source/src/ferry.js';
import { pitchWave } from '/source/engine/form/bend.js';
import { autoBlink } from '/source/engine/form/eye.js';
import { patchLayer } from '/source/engine/shade/surface.js';
import { NOISE_GLSL } from '/source/engine/shade/noise.glsl.js';
import { SS_GLSL } from '/source/engine/shade/util.glsl.js';

const SCALE = 1/20, TAU = Math.PI*2, DURATION = 10, FPS = 30;
const sourceMeshes = [], details = [];
const renderer = new T.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
renderer.outputColorSpace = T.SRGBColorSpace;
renderer.toneMapping = T.NoToneMapping;
const vec = new T.Vector3(), norm = new T.Vector3(), matrix = new T.Matrix4();
const triangles = g => (g.index?.count || g.attributes.position.count)/3;
const assert = (ok, message) => { if(!ok) throw new Error(message); };

// Bake the actual source albedo hooks (not its view-dependent toon lighting).
// Exported PBRs contain only PNGs / vertex colours; shader hooks stay in this tool.
function bakeMaterial(source, pointMode, width, height) {
  const opts = source.userData.toonOpts || {}, layer = patchLayer();
  return new T.ShaderMaterial({
    uniforms: {...source.userData.toon, diffuse: {value:source.color}, bakeSize:{value:new T.Vector2(width,height)}},
    side:T.DoubleSide, depthTest:false, depthWrite:false,
    vertexShader:`
      attribute vec3 aLoft; attribute float aChord;
      ${pointMode ? 'attribute vec3 aBakeObj, aBakeLocal, aBakeColor; uniform vec2 bakeSize;' : ''}
      varying vec3 vToonObj, vLoft, vLocal, vTint; varying float vNy, vChord;
      void main(){
        vToonObj=${pointMode?'aBakeObj':'position'}; vLocal=${pointMode?'aBakeLocal':'position'};
        vLoft=aLoft;vNy=normal.y;vChord=aChord;vTint=${pointMode?'aBakeColor':'vec3(1.0)'};
        ${pointMode ? 'float id=float(gl_VertexID);vec2 p=vec2(mod(id,bakeSize.x),floor(id/bakeSize.x));gl_Position=vec4((p+0.5)/bakeSize*2.0-1.0,0.0,1.0);gl_PointSize=1.0;' : 'gl_Position=vec4(uv*2.0-1.0,0.0,1.0);'}
      }`,
    fragmentShader:`
      uniform vec3 diffuse,uInkColor;uniform float uInkTime;
      varying vec3 vToonObj,vTint;
      ${opts.fragmentPars || ''}
      ${layer.pars}${NOISE_GLSL}${SS_GLSL}
      void main(){
        vec4 diffuseColor=vec4(diffuse*vTint,1.0);float toonInk=0.0;vec4 toonOverlay=vec4(0.0);
        ${layer.surface}${opts.fragmentAlbedo || ''}
        vec3 c=mix(diffuseColor.rgb,uInkColor,clamp(toonInk,0.0,1.0));
        c=mix(c,toonOverlay.rgb,clamp(toonOverlay.a,0.0,1.0));
        gl_FragColor=vec4(c,1.0);
        #include <colorspace_fragment>
      }`,
  });
}
function renderBake(g, source, w, h, points = false) {
  // Attributes are defaults when the source material does not use them.
  const target = new T.WebGLRenderTarget(w,h,{depthBuffer:false,stencilBuffer:false});
  target.texture.colorSpace = points ? T.LinearSRGBColorSpace : T.SRGBColorSpace;
  const mat = bakeMaterial(source, points, w, h);
  mat.defaultAttributeValues.aLoft=[0,0,0];mat.defaultAttributeValues.aChord=[0];
  const obj = points ? new T.Points(g,mat) : new T.Mesh(g,mat);
  obj.frustumCulled=false;
  const scene = new T.Scene();scene.add(obj);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);renderer.setClearColor(source.color,1);renderer.clear();
  renderer.render(scene,new T.Camera());
  const pixels = new Uint8Array(w*h*4);renderer.readRenderTargetPixels(target,0,0,w,h,pixels);
  renderer.setRenderTarget(prev);target.dispose();mat.dispose();
  return pixels;
}
function texturePBR(g, original, name, w=512, h=256) {
  const pixels=renderBake(g,original,w,h);
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d'), image=ctx.createImageData(w,h);
  for(let y=0;y<h;y++) image.data.set(pixels.subarray(y*w*4,(y+1)*w*4),(h-1-y)*w*4);
  ctx.putImageData(image,0,0);
  const map=new T.CanvasTexture(canvas);map.name=name+'-albedo';map.colorSpace=T.SRGBColorSpace;
  const mat=new T.MeshStandardMaterial({color:0xffffff,map,roughness:name.includes('eye-ball')?.28:.87,metalness:0,side:original.side});
  mat.name=name;return mat;
}
function cleanGeometry(g) {
  for(const name of Object.keys(g.attributes)) if(!['position','normal','uv','color','skinIndex','skinWeight'].includes(name)) g.deleteAttribute(name);
  g.clearGroups();return g;
}

// Re-UV original loft topology, duplicating only the wrap seam and cap UVs.
function loftUV(source, ringSize) {
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

function preparePropGeometry(mesh) {
  let g=mesh.geometry.clone();
  // Preserve all instance placements; simplify only the reusable small prop.
  for(const attr of Object.keys(g.attributes)) if(attr!=='position') g.deleteAttribute(attr);
  g=mergeVertices(g,1e-5);
  const ratio=mesh.name.includes('anemones')?.35:mesh.name.includes('weed')?.65:mesh.name.includes('kelp')?1:.55;
  if(ratio<1) g=new SimplifyModifier().modify(g,Math.floor(g.attributes.position.count*(1-ratio)));
  g.computeVertexNormals();
  details.push({name:mesh.name,instances:mesh.count,sourceTrianglesPerInstance:triangles(mesh.geometry),exportTrianglesPerInstance:triangles(g)});
  return g;
}

function skinWeights(g, anchors, anchorX) {
  const n=g.attributes.position.count, joints=new Uint8Array(n*4), weights=new Uint8Array(n*4);
  for(let i=0;i<n;i++) {
    const x=anchorX?anchorX[i]:g.attributes.position.getX(i)/SCALE;
    const value=T.MathUtils.clamp((x-anchors[0])/15,0,anchors.length-1);
    const lo=Math.min(Math.floor(value),anchors.length-2), hi=lo+1;
    const b=Math.round((value-lo)*255);
    joints[i*4]=lo+1;joints[i*4+1]=hi+1;weights[i*4]=255-b;weights[i*4+1]=b;
  }
  g.setAttribute('skinIndex',new T.Uint8BufferAttribute(joints,4));
  g.setAttribute('skinWeight',new T.Uint8BufferAttribute(weights,4,true));
}

// Merge original InstancedMesh objects into portable meshes with vertex colours.
// No EXT_mesh_gpu_instancing, custom shader, or external texture dependencies.
function expandProps(mesh) {
  const proto=preparePropGeometry(mesh), pn=proto.attributes.position.count, count=pn*mesh.count;
  const pos=new Float32Array(count*3), normals=new Float32Array(count*3), local=new Float32Array(count*3), objects=new Float32Array(count*3), colors=new Float32Array(count*3);
  const anchors=new Float32Array(count), indices=count<65536?new Uint16Array(proto.index.count*mesh.count):new Uint32Array(proto.index.count*mesh.count);
  const kelp=mesh.name==='kun-kelp', morph=kelp?Array.from({length:4},()=>new Float32Array(count*3)):[];
  const tint=new T.Color(), nm=new T.Matrix3(), sway=new T.Vector3(), sd=new T.Vector3();
  const dv=new T.Vector3(), dv2=new T.Vector3(), im=new T.Matrix4();
  for(let i=0;i<mesh.count;i++) {
    mesh.getMatrixAt(i,im);nm.getNormalMatrix(im);
    if(mesh.instanceColor) mesh.getColorAt(i,tint); else tint.setRGB(1,1,1);
    const phase=kelp?mesh.geometry.attributes.aSway.getW(i):0;
    if(kelp) {
      const a=mesh.geometry.attributes.aSway;sway.set(a.getX(i),a.getY(i),a.getZ(i));
      sd.crossVectors(sway,new T.Vector3(0,1,0)).addScalar(.0001).normalize().multiplyScalar(sway.length());
    }
    for(let j=0;j<pn;j++) {
      const id=i*pn+j, at=id*3;
      vec.fromBufferAttribute(proto.attributes.position,j);
      local.set(vec.toArray(),at);objects.set([vec.x+i*1.618,vec.y+i*2.718,vec.z+i*3.1416],at);
      colors.set(tint.toArray(),at);
      if(kelp) {
        const hg=T.MathUtils.clamp(vec.y,0,1), h2=hg*hg;
        vec.addScaledVector(sway,.3*.9*h2);vec.y-=.12*h2;
        // Four analytic basis shapes retain the exact original kelp sway form.
        for(let k=0;k<4;k++) {
          const v=k<2?sway:sd, a=k<2?phase:phase*1.3-hg*2.4;
          dv.copy(v).multiplyScalar((k<2?.14*.9:.2)*h2*(k%2===0?Math.cos(a):Math.sin(a)));
          dv2.copy(dv).applyMatrix3(new T.Matrix3().setFromMatrix4(im)).multiplyScalar(SCALE);
          morph[k].set(dv2.toArray(),at);
        }
      }
      vec.applyMatrix4(im).multiplyScalar(SCALE);pos.set(vec.toArray(),at);
      norm.fromBufferAttribute(proto.attributes.normal,j).applyMatrix3(nm).normalize();normals.set(norm.toArray(),at);
      anchors[id]=im.elements[12];
    }
    for(let j=0;j<proto.index.count;j++) indices[i*proto.index.count+j]=i*pn+proto.index.getX(j);
  }
  const g=new T.BufferGeometry();g.setAttribute('position',new T.BufferAttribute(pos,3));g.setAttribute('normal',new T.BufferAttribute(normals,3));g.setIndex(new T.BufferAttribute(indices,1));
  g.setAttribute('aBakeObj',new T.BufferAttribute(objects,3));g.setAttribute('aBakeLocal',new T.BufferAttribute(local,3));g.setAttribute('aBakeColor',new T.BufferAttribute(colors,3));
  // The colour bake uses one GL point per vertex; do not use the triangle index.
  const index=g.index;g.setIndex(null);
  const width=512,height=Math.ceil(count/width), rgba=renderBake(g,mesh.material,width,height,true);
  g.setIndex(index);
  const rgb=new Uint8Array(count*3);for(let j=0;j<count;j++) rgb.set(rgba.subarray(j*4,j*4+3),j*3);
  g.setAttribute('color',new T.Uint8BufferAttribute(rgb,3,true));
  cleanGeometry(g);
  if(kelp) {
    g.computeVertexNormals();
    g.morphTargetsRelative=true;
    g.morphAttributes.position=morph.map((a,i)=>{const b=new T.BufferAttribute(a,3);b.name=['back-sin','back-cos','side-sin','side-cos'][i];return b;});
    g.morphAttributes.normal=morph.map(a=>{
      const copy=g.clone();copy.morphAttributes={};
      const p=copy.attributes.position.array;for(let i=0;i<p.length;i++)p[i]+=a[i];copy.computeVertexNormals();
      const n=copy.attributes.normal.array, base=g.attributes.normal.array;for(let i=0;i<n.length;i++)n[i]-=base[i];
      return new T.BufferAttribute(n,3);
    });
  }
  const mat=new T.MeshStandardMaterial({color:0xffffff,vertexColors:true,roughness:.9,metalness:0,side:mesh.material.side});mat.name=mesh.name+'-PBR';
  return {geometry:g,material:mat,anchors};
}

function track(name, prop, times, values, discrete=false) {
  const C=prop==='quaternion'?T.QuaternionKeyframeTrack:prop==='position'?T.VectorKeyframeTrack:T.NumberKeyframeTrack;
  return new C(`${name}.${prop}`,times,values,discrete?T.InterpolateDiscrete:T.InterpolateLinear);
}
async function upload(name, scene, clips=[]) {
  const bytes=await new GLTFExporter().parseAsync(scene,{binary:true,animations:clips,onlyVisible:true,trs:true});
  const j=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,20,new DataView(bytes).getUint32(12,true))));
  console.log(JSON.stringify({asset:name,bytes:bytes.byteLength,embeddedImageBytes:j.images?.reduce((sum,i)=>sum+j.bufferViews[i.bufferView].byteLength,0)||0,meshes:j.meshes.length}));
  assert(bytes.byteLength<20_000_000,`${name} exceeds 20 MB: ${bytes.byteLength}`);
  const r=await fetch('/output/'+name,{method:'POST',headers:{'Content-Type':'model/gltf-binary'},body:bytes});
  assert(r.ok,await r.text());console.log(`Saved ${name}: ${(bytes.byteLength/1e6).toFixed(2)} MB`);
  return bytes;
}

async function buildKun(lod) {
  const kun=createKun({lod,seed:20261103,wisps:false,blinkPeriod:5,blinkOffset:1.5});
  kun.group.traverse(o=>{if(o.isMesh)sourceMeshes.push(o);});
  const wave=pitchWave('kun',{e0:.22,sMax:1.15}).js(kun.uniforms);
  const root=new T.Group();root.name='kun';
  root.userData={source:'beiming-engine/src/kun.js createKun',lod,sourceScale:SCALE,lengthNominal:30,forward:'+X',up:'+Y',clip:'Swim',duration:10,loop:true,materialPolicy:'Keep embedded baseColorTexture and COLOR_0 when replacing with RAEA ToonMaterial'};
  const rig=new T.Bone();rig.name='kun-rig';root.add(rig);
  const anchors=Array.from({length:41},(_,i)=>-300+i*15);
  const bones=anchors.map((x,i)=>{const b=new T.Bone();b.name=`kun-spine-${String(i).padStart(2,'0')}`;b.position.x=x*SCALE;rig.add(b);return b;});
  root.updateMatrixWorld(true);
  const skeleton=new T.Skeleton([rig,...bones]);skeleton.calculateInverses();
  const skinned=[];
  const addSkin=(g,mat,name,ax)=>{
    skinWeights(g,anchors,ax);
    const mesh=new T.SkinnedMesh(g,mat);mesh.name=name;mesh.frustumCulled=false;root.add(mesh);mesh.bind(skeleton,new T.Matrix4());skinned.push(mesh);return mesh;
  };
  const body=kun.group.getObjectByName('kun-body');
  const nv=Math.round(56+(128-56)*lod)&~1;
  const bodyGeo=loftUV(body.geometry,nv), bodyMat=texturePBR(bodyGeo,body.material,'kun-body-PBR',2048,1024);
  cleanGeometry(bodyGeo).scale(SCALE,SCALE,SCALE);addSkin(bodyGeo,bodyMat,'kun-body');
  const fluke=kun.group.getObjectByName('kun-flukes'), fg=loftUV(fluke.geometry,28), fm=texturePBR(fg,fluke.material,'kun-flukes-PBR');
  cleanGeometry(fg).scale(SCALE,SCALE,SCALE);addSkin(fg,fm,'kun-flukes');
  const finNodes=[];
  for(const f of kun.fins) {
    const pivot=new T.Group();pivot.name=f.pivot.name;root.add(pivot);finNodes.push({f,pivot});
    const g=loftUV(f.mesh.geometry,26),m=texturePBR(g,f.mesh.material,pivot.name+'-PBR');
    cleanGeometry(g).scale(SCALE,SCALE,SCALE);
    const mesh=new T.Mesh(g,m);mesh.name=pivot.name+'-surface';pivot.add(mesh);
    for(const child of f.pivot.children.filter(o=>o.isInstancedMesh)) {
      const data=expandProps(child),props=new T.Mesh(data.geometry,data.material);props.name=pivot.name+'-barnacles';pivot.add(props);
    }
  }
  const lidNodes=[];
  let eyeMat,lidMat;
  for(const eye of kun.eyes) {
    const side=eye.side>0?'R':'L';const socket=new T.Group();socket.name='kun-eye-'+side;
    socket.position.copy(eye.group.position).multiplyScalar(SCALE);socket.quaternion.copy(eye.group.quaternion);root.add(socket);
    if(!eyeMat)eyeMat=texturePBR(eye.ball.geometry,eye.ball.material,'kun-eye-ball-PBR',1024,512);
    const ball=new T.Mesh(eye.ball.geometry.clone().scale(SCALE,SCALE,SCALE),eyeMat);ball.name='kun-eye-ball-'+side;socket.add(ball);
    if(!lidMat)lidMat=texturePBR(new T.SphereGeometry(12*1.07,80,48),eye.lidU.children[0].material,'kun-eyelids-PBR',512,256);
    for(const [part,source]of [['upper',eye.lidU],['lower',eye.lidL]]){
      const pivot=new T.Group();pivot.name=`kun-eyelid-${part}-${side}`;socket.add(pivot);
      const shell=new T.Mesh(source.children[0].geometry.clone().scale(SCALE,SCALE,SCALE),lidMat);shell.name=pivot.name+'-shell';pivot.add(shell);
      lidNodes.push({pivot,source});
    }
  }
  for(const mesh of kun.group.children.filter(o=>o.isInstancedMesh)) {
    const d=expandProps(mesh);addSkin(d.geometry,d.material,mesh.name,d.anchors);
  }
  console.log('Built portable skin and PBR geometry');
  const times=Array.from({length:DURATION*FPS+1},(_,i)=>i/FPS),tracks=[];
  const Z=new T.Vector3(0,0,1), bq=new T.Quaternion(), sq=new T.Quaternion(), euler=new T.Euler();
  const pose=t=>{
    for(let i=0;i<bones.length;i++) {const [dy,th]=wave.bend(anchors[i],t);bones[i].position.set(anchors[i]*SCALE,dy*SCALE,0);bones[i].quaternion.setFromAxisAngle(Z,th);}
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
    // Static head stations do not need channels.
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
  // Quantify the skin approximation against the actual original GPU wave formula.
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
  const bytes=await upload('kun.glb',scene,[clip]);
  return {bytes,report:{lod,sourceTriangles:sourceMeshes.reduce((n,m)=>n+triangles(m.geometry)*(m.isInstancedMesh?m.count:1),0),sourceInstances:details.reduce((n,d)=>n+d.instances,0),decimation:details,skinWaveError:{maxWorldUnits:maxError,rmsWorldUnits:Math.sqrt(sumSq/samples),samples},mechanism:'41 independent spine stations + root bone; two joint weights per body vertex and per decoration anchor; original fin pivot motion; STEP eyelid rotations; four analytic kelp morph targets',retiming:{spineSeconds:5,pectoralSeconds:5,originalPectoralSeconds:6,blinkPeriodSeconds:5,originalBlinkPeriodSeconds:4,kelpCyclesPer10Seconds:[3,4]},limits:['Fin-tip cloud wisps omitted (scene VFX).','View-dependent toon lighting/outline and ink jitter are not baked; RAEA supplies lighting and toon treatment.','Eye gaze and catchlights baked at the original neutral gaze; eyelid shell motion remains animated.','Preserve baseColorTexture and COLOR_0 when overriding PBR materials with ToonMaterial.','glTF has no loop flag: runtime must repeat the 10-second Swim clip.','Small decorations decimated; all source LOD 0.5 instances retained.']}};
}

async function buildFerry() {
  const ferry=createFerry(), g=ferry.group, scale=2/ferry.length;
  let id=0;const cache=new Map();
  for(const [name,obj] of Object.entries(ferry.lights))obj.name='ferry-light-'+name;
  const lights=[];
  g.traverse(obj=>{
    if(obj===g)return;
    obj.position.multiplyScalar(scale);
    if(!obj.isMesh)return;
    obj.name ||= 'ferry-part-'+String(id++).padStart(2,'0');
    obj.geometry=obj.geometry.clone().scale(scale,scale,scale);obj.userData={};delete obj.customDepthMaterial;
    const old=obj.material;
    if(!cache.has(old)){
      const emissive=old.isMeshBasicMaterial;
      const intensity=emissive?Math.max(old.color.r,old.color.g,old.color.b,1):0;
      const color=emissive?old.color.clone().multiplyScalar(1/intensity):old.color;
      const m=new T.MeshStandardMaterial({color:emissive?0x111111:color,roughness:.8,metalness:0,emissive:emissive?color:0x000000,emissiveIntensity:intensity});
      m.name=emissive?'ferry-emissive-'+cache.size:'ferry-PBR-'+cache.size;cache.set(old,m);
    }
    obj.material=cache.get(old);
    if(obj.material.emissiveIntensity>0)lights.push({name:obj.name,emissiveIntensity:obj.material.emissiveIntensity});
  });
  g.userData={source:'beiming-engine/src/ferry.js createFerry',sourceScale:scale,nominalLength:2,forward:'+X',up:'+Y',lights:'Original emissive window and navigation-light meshes; no source punctual lights'};
  g.updateMatrixWorld(true);
  const size=new T.Box3().setFromObject(g).getSize(new T.Vector3());
  const scene=new T.Scene();scene.add(g);const bytes=await upload('ferry.glb',scene);
  return {bytes,report:{bytes:bytes.byteLength,scale,boundsXYZ:size.toArray(),nominalLength:2,emissiveMeshes:lights.length,lights,lightPolicy:'Preserved HDR emissive windows and all four navigation lamps as PBR emissive materials (KHR_materials_emissive_strength); original ferry has no PointLight objects.'}};
}

async function roundTrip(bytes, preview, ferryBytes) {
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
    const ferry=await new GLTFLoader().parseAsync(ferryBytes,'');
    const canvas=await makePreview(scene,at,ferry.scene);
    document.body.append(canvas);
  }
  return result;
}

async function makePreview(model,at,ferry) {
  // A few GLB round-trip stills only; no timeline/video render or external port.
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
  stage.remove(model);stage.add(ferry);
  renderPanel(1060,656,516,368,[2.6,1.7,3.3],[0,.25,0],'06 / ferry • 2 m • emissive lamps',0);
  ctx.fillStyle='#96abc2';ctx.font='16px sans-serif';ctx.fillText('Skinned spine + tail • animated pectoral pivots • blinking lids • 4 kelp morph targets',36,1063);
  ctx.fillText('All colours embedded. Apply RAEA ToonMaterial while retaining baseColorTexture and COLOR_0.',36,1091);
  return sheet;
}

export async function run({lod,preview}) {
  const kun=await buildKun(lod),ferry=await buildFerry();
  const round=await roundTrip(kun.bytes,preview,ferry.bytes);
  return {...kun.report,roundTrip:round,ferry:ferry.report};
}
