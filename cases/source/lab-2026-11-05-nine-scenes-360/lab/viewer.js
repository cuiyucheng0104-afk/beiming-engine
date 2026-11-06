import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createLook} from '../engine/look/index.js';
import {wireOutlines} from '../engine/stage/outline.js';
import {assetMaterial,bind,applyPreset} from './material.js';
import {presets} from './presets.js';
const W=innerWidth,H=innerHeight,Q=new URLSearchParams(location.search),sid=Q.get('scene')||'04',tag=Q.get('tag')||'r1';
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true,powerPreference:'high-performance'});
renderer.debug.onShaderError=(gl,p,v,f)=>{throw new Error(gl.getShaderInfoLog(v)+'\n'+gl.getShaderInfoLog(f));};
renderer.setSize(W,H);renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(32,W/H,.01,100);
const sun=new THREE.DirectionalLight('#ffffff',2);sun.position.set(-2.4,3.4,4.6);sun.castShadow=true;sun.shadow.mapSize.set(4096,4096);Object.assign(sun.shadow.camera,{left:-1.5,right:1.5,top:1.5,bottom:-1.5,near:.1,far:12});sun.shadow.bias=-.00005;sun.shadow.normalBias=.001;scene.add(sun,sun.target);
scene.add(new THREE.HemisphereLight('#dee8ef','#524230',1));
const look=createLook(renderer,W,H,{ss:1,msaa:4,refHeight:1080});await look.ready;
const gltf=await new GLTFLoader().loadAsync(`../models/${sid}/${tag}/model_tex.glb`),root=gltf.scene;
scene.add(root);const box=new THREE.Box3().setFromObject(root),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());root.position.sub(center);
let faces=0,vertices=0;const meshes=[];
root.traverse(o=>{if(!o.isMesh)return;faces+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;vertices+=o.geometry.attributes.position.count;
 const old=o.material,original=old.clone();original.metalness=.05;original.roughness=.85;if(original.map)original.map.anisotropy=8;
 const stylized=assetMaterial(old);const clay=new THREE.MeshStandardMaterial({color:'#bcb4a3',roughness:1,metalness:0,side:THREE.DoubleSide});
 bind(o,stylized,{outline:true});o.userData.outlineGroup='main';meshes.push({o,original,stylized,clay});
});wireOutlines(root);
let current=presets[1],view='front',mode='style';
function cameraFor(v){
 const radius=Math.max(size.x/(2*Math.tan(THREE.MathUtils.degToRad(16))*W/H),size.y/(2*Math.tan(THREE.MathUtils.degToRad(16))))*1.12+size.z*.55;
 const pos=v==='side'?[.85,.20,.60]:v==='back'?[-.3,.18,-1]:v==='angle'?[.32,.12,1]:[0,.035,1];
 camera.position.set(...pos).normalize().multiplyScalar(radius);camera.lookAt(0,0,0);camera.updateMatrixWorld();camera.updateProjectionMatrix();
}
window.setVariant=(id='A2',v='front',m='style')=>{current=presets.find(x=>x.id===id)||presets[1];view=v;mode=m;
 applyPreset(current,{textureKeep:sid==='01'||sid==='03'?.60:.42});
 for(const x of meshes)x.o.material=m==='clay'?x.clay:m==='original'?x.original:x.stylized;
 scene.background=new THREE.Color(m==='style'?current.palette.fog:'#263239');cameraFor(v);window.render(0);
};
window.render=()=>{
 if(mode!=='style'){renderer.render(scene,camera);return;}
 const p=current.palette;
 look.render(scene,camera,{t:0,outline:{width:p.inkWidth*.7,color:p.ink,opacity:.55,wobble:.12,pressure:.12,inner:.25,silhouette:.12,near:0,far:10,farScale:.8},kuwahara:{radius:.65,farRadius:.65,strength:.10,protect:[1.1,1.6]},bloom:{strength:.06,threshold:1.1,radius:.4},grade:{exposure:1.10,saturation:1,shoulder:1},fog:false,paper:{strength:p.paperAmt*.15},vignette:.1,grain:.02});
};
window.info=()=>({scene:sid,tag,preset:current.id,view,mode,faces,vertices,bounds:size.toArray(),meshes:meshes.length,draw:renderer.info.render,three:THREE.REVISION});
window.DUR=1;window.setVariant(Q.get('preset')||'A2',Q.get('view')||'front',Q.get('mode')||'original');window.READY=true;
