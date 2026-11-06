import * as T from 'three';
import {createLook} from '../src/look.js';
import {setToonGlobals} from '../src/toon.js';
import {wireOutlines} from '../engine/stage/outline.js';
import {compact,cloudsReady} from './world.js';
import {makeScene} from './scenes.js';
const q=new URLSearchParams(location.search),sid=q.get('scene')||'04',W=innerWidth,H=innerHeight;
const r=new T.WebGLRenderer({antialias:false,preserveDrawingBuffer:true,powerPreference:'high-performance'});
r.debug.onShaderError=(gl,p,v,f)=>{throw Error('GLSL compilation: '+gl.getShaderInfoLog(v)+' '+gl.getShaderInfoLog(f));};
r.setPixelRatio(1);r.setSize(W,H);r.outputColorSpace=T.SRGBColorSpace;r.toneMapping=T.NoToneMapping;r.shadowMap.enabled=true;r.shadowMap.type=T.PCFSoftShadowMap;document.body.appendChild(r.domElement);
const scene=new T.Scene(),c=await makeScene(sid,scene);compact(scene);
await cloudsReady;
if(!c.interior&&!c.night){const tex=await new T.TextureLoader().loadAsync('../assets/sky_dawn.png');tex.colorSpace=T.SRGBColorSpace;scene.background=tex;}
const camera=new T.PerspectiveCamera(c.fov,W/H,.12,c.far||5000);camera.position.set(...c.cam);camera.lookAt(...c.at);
const sun=new T.DirectionalLight('#ffffff',1);sun.position.set(...c.light);sun.target.position.set(...c.at);sun.castShadow=true;const span=c.shadowSpan;
Object.assign(sun.shadow.camera,{left:-span,right:span,top:span,bottom:-span,near:1,far:600});sun.shadow.mapSize.set(4096,4096);sun.shadow.bias=-.0002;sun.shadow.normalBias=.07;scene.add(sun,sun.target);
setToonGlobals({keyDir:c.light,inkTime:0,exposure:c.night?.82:1,skyGain:c.night?.65:.7,fillGain:c.night?.35:1});
wireOutlines(scene);const look=createLook(r,W,H,{ss:H>1200?1.5:2,msaa:4,paperUrl:'../assets/paper.png'});await look.ready;
const post={t:0,kuwahara:{radius:1.2,farRadius:1.4,strength:.14},outline:{width:1.4,wobble:.3,pressure:.18,inner:.32,opacity:.68,far:140,farScale:.35},bloom:{strength:.18,threshold:1.05,radius:.38},grade:{exposure:1,warmth:.08,lift:[0,0,.005],shoulder:1.1,gamma:.87,saturation:1.12},paper:{strength:.025},vignette:.12,grain:0,
 fog:c.fog===false?false:{color:c.night?'#8E95B9':'#AA99CA',colorHigh:'#EAB3AE',density:c.fogDensity||.004,start:28,max:.82,baseHeight:0,falloff:0,sky:false}};
let mode='hero';const clay=new T.MeshStandardMaterial({color:'#C3C6CD',roughness:1});const ambient=new T.HemisphereLight('#DCE9FF','#5F596B',2.2);let saved=[];
window.setView=(v='hero')=>{mode=v;camera.position.set(...c.cam);camera.lookAt(...c.at);if(v==='angle'){camera.position.x+=Math.max(3,Math.abs(c.cam[2]-c.at[2])*.25);camera.position.y+=1;camera.lookAt(...c.at);}
 if(v==='clay'||v==='angle'){if(!saved.length){scene.traverse(o=>{if(o.isMesh&&!o.isReflector){saved.push([o,o.material]);o.material=clay;}});scene.add(ambient);}}
 else if(saved.length){for(const [o,m]of saved)o.material=m;saved=[];ambient.removeFromParent();}
};
window.render=t=>{if(mode==='hero')look.render(scene,camera,{...post,t});else{r.setRenderTarget(null);r.render(scene,camera);}};
window.info=()=>{let faces=0,meshes=0,instances=0;scene.traverse(o=>{if(o.isMesh){meshes++;let n=o.geometry.index?o.geometry.index.count:o.geometry.attributes.position.count;faces+=n/3*(o.isInstancedMesh?o.count:1);if(o.isInstancedMesh)instances+=o.count;}});return {sid,title:c.title,faces:Math.round(faces),meshes,instances,camera:c,post,render:r.info.render};};
window.DUR=1;window.render(0);window.READY=true;
