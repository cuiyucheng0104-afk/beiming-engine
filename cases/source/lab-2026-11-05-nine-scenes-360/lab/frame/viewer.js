import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {toonKind,makeToonShared} from '../../engine/shade/toon.js';
import {createLook} from '../../engine/look/index.js';
import {wireOutlines} from '../../engine/stage/outline.js';
import {presets} from '../presets.js';
const W=innerWidth,H=innerHeight,Q=new URLSearchParams(location.search),sid=Q.get('scene')||'01';
const cfg=(await (await fetch('../../scenes.json')).json()).find(x=>x.id===sid);
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true,powerPreference:'high-performance'});
renderer.debug.onShaderError=(gl,p,v,f)=>{throw new Error(gl.getShaderInfoLog(v)+'\n'+gl.getShaderInfoLog(f));};
renderer.setSize(W,H);renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(45,W/H,.001,10000);
const sun=new THREE.DirectionalLight('#ffffff',1);sun.position.set(-2,3,4);scene.add(sun);
scene.add(new THREE.HemisphereLight('#d0dce0','#333e37',2));
const look=createLook(renderer,W,H,{ss:1,msaa:4,refHeight:1080});await look.ready;
const gltf=await new GLTFLoader().loadAsync(`../../models/${sid}/view/scene.glb`),root=gltf.scene;scene.add(root);
const normalMap=await new THREE.TextureLoader().loadAsync(`../../models/${sid}/view/normals.png`);normalMap.colorSpace=THREE.NoColorSpace;normalMap.flipY=false;
const U={uBandN:{value:3},uThreshold:{value:[.34,.66,1,1,1]},uLevel:{value:[.08,.48,1,1,1,1]},uFeather:{value:.015},uShadow:{value:new THREE.Color()},uLight:{value:new THREE.Color()},uAccent:{value:new THREE.Color()},uLeaf:{value:new THREE.Color()},uPaper:{value:new THREE.Color()},uPalette:{value:0},uNormals:{value:normalMap},uTexel:{value:new THREE.Vector2(1/cfg.width,1/cfg.height)},uWhite:{value:cfg.whitePoint},uGeomMix:{value:.19}};
const shared=makeToonShared();
const family=toonKind({name:'nine-view-tonal-v3',shared,featherMin:.004,defaults:{rimAmt:0,rimLitAmt:0,edgeNoise:0,skyAmt:0,fillAmt:0},
 pars:`uniform int uBandN;uniform float uThreshold[5],uLevel[6],uFeather,uWhite,uPalette,uGeomMix;
 uniform vec3 uShadow,uLight,uAccent,uLeaf,uPaper;uniform sampler2D uNormals;uniform vec2 uTexel;`,
 vars:'float sourceIllum=0.; float sourceLum=0.; vec3 sourceChroma=vec3(1.);',uniforms:()=>U,
 shade:{afterRim:`
 float surfaceLight=clamp(dot(N,L)*.5+.5,0.,1.);
 float illumination=clamp(mix(sourceIllum,surfaceLight,uGeomMix),0.,1.);
 float bw=max(uFeather,fwidth(illumination)*1.3),qv=uLevel[0];
 for(int i=0;i<5;i++){if(i<uBandN-1)qv+=(uLevel[i+1]-uLevel[i])*smoothstep(uThreshold[i]-bw*.5,uThreshold[i]+bw*.5,illumination);}
 float warmDetail=smoothstep(.08,.45,sourceChroma.r-sourceChroma.b);
 float outLum=mix(pow(max(qv,0.),1.85)*uWhite,sourceLum,mix(.28,.48,warmDetail));
 vec3 shadowHue=uShadow/max(dot(uShadow,vec3(.2126,.7152,.0722)),.001);
 vec3 lightHue=uLight/max(dot(uLight,vec3(.2126,.7152,.0722)),.001);
 vec3 hue=mix(sourceChroma,shadowHue,(1.-qv)*.30);
 hue=mix(hue,lightHue,qv*.20);
 if(uPalette>.5&&uPalette<1.5){hue=mix(hue,vec3(.93,1.04,1.04),.28);outLum=pow(outLum,.88)*1.06;}
 else if(uPalette>1.5&&uPalette<2.5)hue=mix(hue,vec3(1.20,1.,.72),.36);
 else if(uPalette>2.5&&uPalette<3.5)hue=mix(hue,vec3(.68,1.08,1.18),.30);
 else if(uPalette>3.5&&uPalette<4.5)hue=mix(hue,vec3(1.),.48);
 else if(uPalette>4.5&&uPalette<5.5)hue=mix(hue,mix(vec3(.99,.76,1.35),vec3(1.26,1.,.78),qv),.45);
 else if(uPalette>5.5&&uPalette<6.5){hue=mix(hue,vec3(1.06,1.04,.95),.88);outLum=pow(outLum,.78)*1.1;}
 else if(uPalette>6.5)hue=mix(hue,vec3(.60,.85,1.36),.45*(1.-qv*.6));
 col=hue*outLum;
 // Preserve small candle/window emission as a color texture cue, not a fabricated point light.
 float candle=smoothstep(.94,1.12,sourceIllum)*smoothstep(.1,.6,sourceChroma.r-sourceChroma.b);
 col+=uAccent*candle*.10;
 `}});
const meshes=[];let faces=0,verts=0,fxValues=[],depthSamples=[];
root.traverse(o=>{if(!o.isMesh)return;const g=o.geometry,pos=g.attributes.position,uv=g.attributes.uv;
 faces+=(g.index?.count||pos.count)/3;verts+=pos.count;
 for(let i=0;i<pos.count;i+=Math.max(1,Math.floor(pos.count/2000))){const x=pos.getX(i),z=pos.getZ(i),u=uv.getX(i);if(Number.isFinite(z)&&z<0)depthSamples.push(-z);if(Math.abs(x)>.001&&Math.abs(u-.5)>.15&&Number.isFinite(z)){const f=(u-.5)*(-z)/x;if(f>.05&&f<10)fxValues.push(f);}}
 const old=o.material,source=old.map;source.anisotropy=8;
 const basic=new THREE.MeshBasicMaterial({map:source,side:THREE.DoubleSide});
 const clay=new THREE.MeshStandardMaterial({color:'#b4b8ac',roughness:1,side:THREE.DoubleSide});
 const mat=family.make({color:'#ffffff',map:source,side:THREE.DoubleSide,fog:false,
 fragmentNormal:`normal=normalize(mat3(viewMatrix)*(texture2D(uNormals,vMapUv).xyz*2.-1.));`,
 fragmentAlbedo:`
 // Edge-preserving texture simplification before quantizing the illumination.
 vec3 center=diffuseColor.rgb,acc=center*2.;float weight=2.;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
   vec3 c=texture2D(map,vMapUv+vec2(float(x),float(y))*uTexel*1.35).rgb;
   float w=exp(-dot(c-center,c-center)*65.);acc+=c*w;weight+=w;
 }
 vec3 src=acc/weight;float lum=max(dot(src,vec3(.2126,.7152,.0722)),.001);
 sourceLum=lum;sourceIllum=pow(clamp(lum/max(uWhite,.08),0.,1.5),.56);
 sourceChroma=clamp(src/lum,vec3(.25),vec3(2.2));
 vec3 base=sourceChroma*mix(.28,.58,clamp(sourceIllum,0.,1.));
 float green=smoothstep(.02,.24,sourceChroma.g-(sourceChroma.r+sourceChroma.b)*.5);
 base=mix(base,uLeaf*1.35,green*.27);
 float pale=smoothstep(.65,1.,sourceIllum)*(1.-smoothstep(.2,.55,length(sourceChroma-1.)));
 base=mix(base,uPaper*.90,pale*.25);
 // Palette identity: source hues retained; shadow/highlight hues carry the major shifts.
 if(uPalette>5.5&&uPalette<6.5)base=mix(base,vec3(dot(base,vec3(.2126,.7152,.0722)))*uPaper*1.4,.78);
 else if(uPalette>4.5&&uPalette<5.5)base=mix(base,base*vec3(1.13,.88,1.18),.65);
 else if(uPalette>2.5&&uPalette<3.5)base=mix(base,base*vec3(.85,1.15,1.1),.65);
 diffuseColor.rgb=base;
 `});family.bind(o,mat,{outline:true});o.userData.outlineGroup='view-geometry';meshes.push({o,mat,basic,clay});
});wireOutlines(root);fxValues.sort((a,b)=>a-b);const fx=fxValues[Math.floor(fxValues.length/2)];if(!fx)throw new Error('Cannot recover camera focal length');
depthSamples.sort((a,b)=>a-b);const dNear=depthSamples[0],dFar=depthSamples[Math.floor(depthSamples.length*.97)]*1.1;
// Bound the frustum to avoid far-sky depth precision noise; projection stays unchanged.
for(const {o}of meshes){const p=o.geometry.attributes.position;for(let i=0;i<p.count;i++){const d=-p.getZ(i);if(d>dFar){const k=dFar/d;p.setXYZ(i,p.getX(i)*k,p.getY(i)*k,-dFar);}}p.needsUpdate=true;o.geometry.computeBoundingSphere();}
camera.near=Math.max(.001,dNear*.25);camera.far=dFar*1.15;
const fovY=THREE.MathUtils.radToDeg(2*Math.atan(.5/(fx*cfg.width/cfg.height)));
camera.fov=fovY;camera.aspect=cfg.width/cfg.height;camera.position.set(0,0,0);camera.lookAt(0,0,-1);camera.updateProjectionMatrix();
let preset=presets[1],mode='style',view='front';
window.setVariant=(id='A2',v='front',m='style')=>{preset=presets.find(p=>p.id===id)||presets[1];mode=m;view=v;const p=preset.palette,s=preset.profile;
 U.uBandN.value=s.bands;U.uThreshold.value=[...s.thresholds,...Array(5-s.thresholds.length).fill(1)];U.uLevel.value=[...s.levels,...Array(6-s.levels.length).fill(1)];U.uFeather.value=s.feather;U.uPalette.value='ABCDEFGH'.indexOf(p.id);
 for(const[k,r]of[['uShadow','shadow'],['uLight','light'],['uAccent','accent'],['uLeaf','leaf'],['uPaper','paper']])U[k].value.set(p[r]);
 for(const x of meshes)x.o.material=m==='original'?x.basic:m==='clay'?x.clay:x.mat;
 scene.background=new THREE.Color(m==='style'?p.shadow:'#263239');
 camera.position.set(v==='side'?.20:0,0,0);camera.rotation.set(0,0,0);camera.updateMatrixWorld();
 window.render(0);
};
window.render=()=>{if(mode!=='style'){renderer.render(scene,camera);return;}
 const p=preset.palette;look.render(scene,camera,{t:0,outline:{width:p.inkWidth*.6,color:p.ink,opacity:.35,wobble:.10,pressure:.10,inner:.2,silhouette:.05,near:dNear,far:dFar,farScale:.20,depthThreshold:.045},kuwahara:{radius:2.1,farRadius:2.1,strength:.65,protect:[1.0,1.5]},bloom:{strength:.09,threshold:.82,radius:.4},grade:{exposure:p.id==='H'?.85:1.0,saturation:p.id==='D'?1.1:.96,shoulder:1.0},fog:false,paper:{strength:p.paperAmt*.20},vignette:.12,grain:.018});};
window.info=()=>({scene:sid,preset:preset.id,faces,vertices:verts,mode,view,three:THREE.REVISION,fovY,fx,geometry:'MoGe-2 single-view textured geometry; not complete 360-degree scene',config:cfg});
window.DUR=1;window.setVariant(Q.get('preset')||'A2',Q.get('view')||'front',Q.get('mode')||'style');window.READY=true;
