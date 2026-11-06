import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Reflector} from 'three/addons/objects/Reflector.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {createLook} from '../engine/look/index.js';
import {wireOutlines} from '../engine/stage/outline.js';
import {spire,mesa} from '../engine/form/rock.js';
import {pineTree} from '../engine/form/plants.js';
import {boatHull} from '../engine/form/props.js';
import {mulberry} from '../engine/core/math.js';
import {makeMaterial,bind,applyPreset} from './material.js';
import {presets} from './presets.js';

const W=innerWidth,H=innerHeight,R=mulberry(1105),Q=new URLSearchParams(location.search);
const renderer=new THREE.WebGLRenderer({antialias:false,preserveDrawingBuffer:true,powerPreference:'high-performance'});
renderer.debug.onShaderError=(gl,p,v,f)=>{throw new Error('GLSL: '+gl.getShaderInfoLog(v)+' '+gl.getShaderInfoLog(f));};
renderer.setSize(W,H);renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(39,W/H,.3,1600);
const look=createLook(renderer,W,H,{ss:2,msaa:4,refHeight:1080});await look.ready;
const sun=new THREE.DirectionalLight('#ffffff',1);sun.position.set(85,115,100);sun.target.position.set(0,0,-15);sun.castShadow=true;
Object.assign(sun.shadow.camera,{left:-140,right:140,top:140,bottom:-140,near:1,far:370});sun.shadow.mapSize.set(4096,4096);sun.shadow.bias=-.00025;sun.shadow.normalBias=.12;scene.add(sun,sun.target);

const mats=Object.fromEntries(['rock','leaf','roof','wood','paper','accent'].map(k=>[k,makeMaterial(k)]));
const add=(g,m,parent=scene,outline=true)=>{const x=bind(new THREE.Mesh(g,m),m,{outline});parent.add(x);return x;};
function box(x,y,z,w,h,d,role,parent=scene){const o=add(new THREE.BoxGeometry(w,h,d),mats[role],parent);o.position.set(x,y,z);return o;}
function tube(a,b,r,role,parent=scene){a=new THREE.Vector3(...a);b=new THREE.Vector3(...b);let o=add(new THREE.CylinderGeometry(r*.85,r,a.distanceTo(b),7),mats[role],parent);o.position.copy(a).add(b).multiplyScalar(.5);o.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),b.sub(a).normalize());return o;}

// 天空是程序化三维球面，不使用参考图作背景贴片。
const skyU={top:{value:new THREE.Color()},bottom:{value:new THREE.Color()},glow:{value:new THREE.Color()}};
const sky=new THREE.Mesh(new THREE.SphereGeometry(1300,32,24),new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,uniforms:skyU,vertexShader:`varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,fragmentShader:`uniform vec3 top,bottom,glow;varying vec3 vDir;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
void main(){vec3 d=normalize(vDir);float h=smoothstep(-.18,.4,d.y);vec3 c=mix(bottom,top,h);float n=noise(d.xz*9.+d.y*4.)*.6+noise(d.xz*21.)*.25;float cloud=smoothstep(.47,.72,n)*smoothstep(.02,.17,d.y)*(1.-smoothstep(.35,.75,d.y));c=mix(c,glow,cloud*.32);gl_FragColor=vec4(c,1.);#include <colorspace_fragment>
}`.replace(';#include',';\n#include')}));sky.userData.outlineOccluder=false;// Gradient background avoids geometry seams at an oblique reflection clip plane.
const skyCanvas=document.createElement('canvas');skyCanvas.width=512;skyCanvas.height=512;
const skyCtx=skyCanvas.getContext('2d'),skyTex=new THREE.CanvasTexture(skyCanvas);skyTex.colorSpace=THREE.SRGBColorSpace;scene.background=skyTex;


// 三层山体，形体与随机种子在全部40版间固定。
for(let row=0;row<3;row++)for(let i=0;i<9;i++){
 const x=(i-4)*43+(R()-.5)*28,z=-120-row*100-R()*28,h=25+R()*43+row*14,r=14+R()*20;
 const geo=spire(R,h,r,{steps:3,NH:48,NA:48,lean:[(R()-.5)*.2,(R()-.5)*.12],seed:i+row*20});
 const o=add(geo,mats.rock,scene,row===0);o.position.set(x,-3,z);o.scale.z=.8+R()*.4;
}
function island(x,z,rx,rz,high){let g=mesa(R,{cx:0,cz:0,rx,rz,yTop:()=>high,yBot:()=>-4,NA:72,dome:1.5});let o=add(g,mats.rock);o.position.set(x,0,z);return o;}
island(-42,-13,20,13,1.5);island(56,-23,28,24,2);island(10,-5,27,22,1.8);

// 松树：复用北冥的实例化几何；树干和叶团共用三维光照。
for(let kind=0;kind<3;kind++){
 const geo=pineTree(150+kind);const color=[];const part=geo.attributes.aPart;
 for(let i=0;i<part.count;i++){let v=part.getX(i)>.5?1:.42;color.push(v,v,v);}
 geo.setAttribute('color',new THREE.Float32BufferAttribute(color,3));
 const mat=makeMaterial('leaf',{vertexColors:true});const inst=bind(new THREE.InstancedMesh(geo,mat,55),mat,{outline:true,perInstance:false});
 const d=new THREE.Object3D();
 for(let j=0;j<55;j++){
  let cluster=j%3,x,z,y,s;
  if(cluster===0){x=-43+(R()-.5)*31;z=-13+(R()-.5)*19;y=3.3;s=5+R()*6;}
  else if(cluster===1){x=57+(R()-.5)*42;z=-24+(R()-.5)*32;y=4;s=6+R()*8;}
  else{x=-90+R()*180;z=-58-R()*45;y=1;s=5+R()*9;}
  d.position.set(x,y,z);d.rotation.y=R()*Math.PI*2;d.scale.setScalar(s);d.updateMatrix();inst.setMatrixAt(j,d.matrix);
 }
 scene.add(inst);
}

// 小村落为独立几何，屋顶具有曲面和瓦垄，供深度/轮廓对照。
function roof(w,d,h){const pos=[],uv=[],idx=[],nu=28,nv=18;for(let j=0;j<=nv;j++)for(let i=0;i<=nu;i++){
 const u=i/nu*2-1,v=j/nv*2-1,outer=Math.max(Math.abs(u),Math.abs(v)),yy=h*(1-Math.pow(outer,.65))+.38*Math.pow(outer,8)+.035*Math.cos(u*60);
 pos.push(u*w/2,yy,v*d/2);uv.push(i/nu,j/nv);}
 for(let j=0;j<nv;j++)for(let i=0;i<nu;i++){const a=j*(nu+1)+i,b=a+nu+1;idx.push(a,b,a+1,b,b+1,a+1);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();return g;}
function house(x,z,s=1){const g=new THREE.Group();g.position.set(x,4,z);g.scale.setScalar(s);scene.add(g);
 box(0,2.2,0,8,4.4,5,'paper',g);const r=add(roof(11,8,2.2),mats.roof,g);r.position.y=4.5;
 for(const xx of [-3.7,0,3.7])box(xx,2.3,2.6,.22,4.5,.24,'wood',g);
 for(let i=0;i<9;i++)box(-3.5+i*.85,2.8,2.66,.10,1.8,.10,'wood',g);
 box(0,3.8,2.68,7.6,.16,.15,'wood',g);box(0,1.8,2.68,7.6,.16,.15,'wood',g);
 for(const xx of [-2.2,2.2])box(xx,2.7,2.62,1.5,1.6,.06,'accent',g);
 return g;}
house(-42,-6,1.3);house(-53,-19,.9);house(56,-20,1.1);

// TRELLIS.2 楼阁主体。完整GLB保留，几何与颜色处理分别可检查。
const gltf=await new GLTFLoader().loadAsync('../models/pavilion_vc.glb');
const asset=gltf.scene,originalBox=new THREE.Box3().setFromObject(asset),size=originalBox.getSize(new THREE.Vector3()),center=originalBox.getCenter(new THREE.Vector3());
const assetRoot=new THREE.Group();scene.add(assetRoot);assetRoot.add(asset);
asset.position.sub(center);asset.position.y+=size.y/2;
const scale=48/Math.max(size.x,size.z);assetRoot.scale.setScalar(scale);assetRoot.position.set(10,4,-5);
const originalMaterials=new Map();let faces=0;
asset.traverse(o=>{if(!o.isMesh)return;originalMaterials.set(o,o.material);faces+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;
 const old=Array.isArray(o.material)?o.material[0]:o.material;
 const mat=makeMaterial('asset',{vertexColors:!!o.geometry.attributes.color,map:old.map||null});
 bind(o,mat,{outline:true});o.userData.outlineGroup='trellis-pavilion';o.userData.stylizedMaterial=mat;
});

// 前景乌篷舟、人形与撑篙——真正几何，帮助判断尺度与色块。
const boat=new THREE.Group();boat.position.set(-17,.6,30);boat.rotation.y=-.25;scene.add(boat);
add(boatHull(13,3.1,1.1,.25),mats.wood,boat);box(-1,.8,0,7,.13,2.65,'wood',boat);
for(let i=0;i<11;i++)box(-4+i*.8,.9,0,.08,.08,2.6,'roof',boat);
const cover=new THREE.Mesh(new THREE.CylinderGeometry(1.45,1.45,4.3,18,1,true,0,Math.PI),mats.roof);cover.rotation.z=Math.PI/2;cover.rotation.x=Math.PI/2;cover.position.set(-1,1,0);bind(cover,mats.roof);boat.add(cover);
function traveler(parent){const robe=add(new THREE.ConeGeometry(.65,2.4,10),mats.paper,parent);robe.position.set(3,1.9,0);
 const head=add(new THREE.SphereGeometry(.27,12,8),mats.wood,parent);head.position.set(3,3.36,0);
 const hat=add(new THREE.ConeGeometry(.85,.32,24),mats.rock,parent);hat.position.set(3,3.72,0);
 tube([2.8,2.8,0],[3.7,2.3,.65],.12,'paper',parent);tube([3.3,2.8,0],[3.9,2.5,.5],.12,'paper',parent);tube([4.7,-.25,1.3],[3.3,4,.3],.055,'wood',parent);}
traveler(boat);
// 白鹭：两片有厚度的三维翼，固定姿态。
for(let i=0;i<16;i++){const g=new THREE.Group();g.position.set(-24+R()*47,26+R()*11,-33-R()*28);g.rotation.y=R()*2;scene.add(g);
 const body=add(new THREE.SphereGeometry(.27,6,4),mats.paper,g);body.scale.set(.7,.6,2.3);
 for(const side of [-1,1]){let wing=add(new THREE.ConeGeometry(.45,2.1,3),mats.paper,g);wing.rotation.z=side*1.15;wing.position.set(side*.9,.32,0);wing.scale.z=.16;}
}

// 真实平面反射加程序波纹。参考图片不进入此渲染通道。
const waterShader={uniforms:{color:{value:new THREE.Color()},tDiffuse:{value:null},textureMatrix:{value:null},uWater:{value:new THREE.Color()},uGlint:{value:new THREE.Color()},uFog:{value:new THREE.Color()}},vertexShader:`uniform mat4 textureMatrix;varying vec4 vRef;varying vec2 vPlane;void main(){vPlane=position.xy;vRef=textureMatrix*vec4(position,1.);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,fragmentShader:`uniform sampler2D tDiffuse;uniform vec3 uWater,uGlint,uFog;varying vec4 vRef;varying vec2 vPlane;
 void main(){vec2 uv=vRef.xy/vRef.w;float w=sin(vPlane.y*2.8+sin(vPlane.x*.24))*sin(vPlane.x*.48+vPlane.y*.18);uv.x+=w*.0018;vec3 reflected=texture2D(tDiffuse,uv).rgb;vec3 c=mix(uWater,reflected,.58);float streak=pow(max(0.,sin(vPlane.y*3.+sin(vPlane.x*.6))),38.)*pow(max(0.,sin(vPlane.x*.11+vPlane.y*.05)),14.);c=mix(c,uGlint,streak*.18);c=mix(c,uFog,smoothstep(90.,620.,length(vPlane))*.85);gl_FragColor=vec4(c,1.);
 #include <colorspace_fragment>
 }`};
const water=new Reflector(new THREE.PlaneGeometry(1600,1600),{textureWidth:Math.min(W,1920),textureHeight:Math.min(H,1080),clipBias:.001,shader:waterShader,multisample:2});water.rotation.x=-Math.PI/2;water.position.y=.05;water.userData.outline=false;water.userData.outlineOccluder=false;scene.add(water);

wireOutlines(scene);
let current=presets[0],mode='wide';
function setCamera(view){mode=view;
 if(view==='detail'){camera.position.set(70,38,81);camera.lookAt(10,15,-5);camera.fov=35;}
 else if(view==='back'){camera.position.set(-43,35,-65);camera.lookAt(10,15,-5);camera.fov=38;}
 else if(view==='side'){camera.position.set(-62,31,15);camera.lookAt(10,15,-5);camera.fov=38;}
 else{camera.position.set(73,36,118);camera.lookAt(0,14,-28);camera.fov=40;}
 camera.updateProjectionMatrix();camera.updateMatrixWorld();
}
window.setVariant=(id,view='wide',clay=false)=>{
 current=presets.find(p=>p.id===id)||presets[0];applyPreset(current,{clay});setCamera(view);const p=current.palette;
 skyU.top.value.set(p.sky);skyU.bottom.value.set(p.horizon);skyU.glow.value.set(p.paper);
 const gradient=skyCtx.createLinearGradient(0,0,0,512);gradient.addColorStop(0,p.sky);gradient.addColorStop(.64,p.horizon);gradient.addColorStop(1,p.fog);skyCtx.fillStyle=gradient;skyCtx.fillRect(0,0,512,512);skyTex.needsUpdate=true;
 scene.fog=new THREE.Fog(p.fog,90,420);renderer.setClearColor(p.sky);
 water.material.uniforms.uWater.value.set(p.water);water.material.uniforms.uGlint.value.set(p.paper);water.material.uniforms.uFog.value.set(p.fog);
 window.render(0);
};
window.render=t=>{
 const p=current.palette;sun.shadow.needsUpdate=true;
 look.render(scene,camera,{t:0,outline:{width:p.inkWidth*.8,color:p.ink,opacity:.65,wobble:.25,pressure:.17,inner:.35,silhouette:.12,near:20,far:220,farScale:.25,fogFade:1},kuwahara:{radius:1.2,farRadius:2.1,farStart:70,farEnd:200,strength:.22,protect:[1.1,1.6]},bloom:{strength:.10,threshold:1.05,radius:.5},grade:{exposure:1.12,saturation:1,warmth:0,shoulder:1},fog:false,paper:{strength:p.paperAmt*.24,scale:1},vignette:.12,grain:.06});
};
window.info=()=>({preset:current,view:mode,faces,assetOriginalBounds:{size:size.toArray(),center:center.toArray()},assetScale:scale,draw:renderer.info.render,three:THREE.REVISION});
window.DUR=2;window.TEXTS=()=>[];window.presets=presets;
window.setVariant(Q.get('preset')||'A2',Q.get('view')||'wide',Q.has('clay'));window.render(0);window.READY=true;
