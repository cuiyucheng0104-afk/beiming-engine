import * as THREE from 'three';
import {toonKind,makeToonShared} from '../engine/shade/toon.js';
export const shared=makeToonShared();
const U={uBandN:{value:3},uBandThresholds:{value:[.34,.66,1,1,1]},uBandValues:{value:[.08,.48,1,1,1,1]},uBandFeather:{value:.015},uLabShadow:{value:new THREE.Color()},uLabLight:{value:new THREE.Color()},uLabRoof:{value:new THREE.Color()},uLabRock:{value:new THREE.Color()},uLabLeaf:{value:new THREE.Color()},uLabWood:{value:new THREE.Color()},uLabPaper:{value:new THREE.Color()},uLabRim:{value:new THREE.Color()},uLabClay:{value:0}};
// 新增多色阶着色家族；仍使用北冥的形变、投影与描边接口。
const family=toonKind({name:'tonal-lab-multiband-v1',shared,featherMin:.005,defaults:{rimAmt:0,rimLitAmt:0,edgeNoise:0,skyAmt:0,fillAmt:0},
 pars:`uniform int uBandN; uniform float uBandThresholds[5],uBandValues[6],uBandFeather,uLabClay;
 uniform vec3 uLabShadow,uLabLight,uLabRoof,uLabRock,uLabLeaf,uLabWood,uLabPaper,uLabRim;`,
 uniforms:()=>U,
 shade:{afterRim:`
 float illumination=clamp((dot(N,L)*.5+.5-.08)/.92,0.,1.);
 illumination*=mix(.32,1.,att);
 float bw=max(uBandFeather,fwidth(illumination)*1.2);
 float bq=uBandValues[0];
 for(int i=0;i<5;i++){if(i<uBandN-1) bq+=(uBandValues[i+1]-uBandValues[i])*smoothstep(uBandThresholds[i]-bw*.5,uBandThresholds[i]+bw*.5,illumination);}
 vec3 dark=mix(alb*.24,uLabShadow*.75,.24);
 vec3 bright=alb*mix(vec3(1.),uLabLight*1.35,.40);
 col=mix(dark,bright,bq);
 float edge=pow(1.-max(0.,dot(N,V)),5.)*smoothstep(.45,.9,hl)*att;
 col+=uLabRim*edge*.075;
 `}});
const materials=[];
export function makeMaterial(role,extra={}){
 const ai=role==='asset',rock=role==='rock';
 const m=family.make({color:'#ffffff',side:THREE.DoubleSide,vertexPars:rock?'varying vec3 vStoneNormal;':'',vertexMainStart:rock?'vStoneNormal=normal;':'',fragmentPars:rock?'varying vec3 vStoneNormal;':'',outlineW:role==='leaf'?.55:1,...extra,
 fragmentAlbedo:ai?`
 vec3 src=diffuseColor.rgb;
 float lum=dot(src,vec3(.2126,.7152,.0722));
 // 保留颜色分区与有限纹理，压缩源图烘焙光照。不是物理反照率恢复。
 float green=smoothstep(.005,.045,src.g-src.r*.90)*smoothstep(.015,.09,lum);
 float warm=smoothstep(.008,.06,src.r-src.b)*smoothstep(.015,.12,lum);
 vec3 flatAlbedo=mix(uLabRoof,uLabRock,smoothstep(.012,.13,lum));
 flatAlbedo=mix(flatAlbedo,uLabPaper,smoothstep(.25,.55,lum)*.6);
 flatAlbedo=mix(flatAlbedo,uLabWood,warm*.90);
 flatAlbedo=mix(flatAlbedo,uLabLeaf,green*.84);
 float micro=mix(.90,1.08,smoothstep(.0,.4,lum));
 diffuseColor.rgb=mix(flatAlbedo*micro,vec3(.46),uLabClay);
 `:rock?`
 float cliffNoise=toonNoise(vec3(vToonObj.x*.9,vToonObj.y*.13,vToonObj.z*.9));
 float strata=toonNoise(vToonObj*vec3(1.8,.1,1.8));
 float cover=smoothstep(.12,.72,vStoneNormal.y+cliffNoise*.7);
 diffuseColor.rgb=mix(diffuseColor.rgb*.72,uLabLeaf,clamp(cover+.22,0.,1.));
 diffuseColor.rgb*=.88+.20*smoothstep(-.3,.5,strata);
 diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.46),uLabClay);
 `:`
 float nn=toonNoise(vToonObj*1.7)*.5+toonNoise(vToonObj*5.1)*.18;
 diffuseColor.rgb*=1.+nn*.08;
 diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.46),uLabClay);
 `});
 materials.push({m,role}); return m;
}
export function bind(mesh,mat,opts={}){return family.bind(mesh,mat,opts);}
export function applyPreset(p,{clay=false}={}){
 const c=p.palette,s=p.profile;
 U.uBandN.value=s.bands;U.uBandFeather.value=s.feather;
 U.uBandThresholds.value=[...s.thresholds,...Array(5-s.thresholds.length).fill(1)];
 U.uBandValues.value=[...s.levels,...Array(6-s.levels.length).fill(1)];
 for(const [k,role] of [['uLabShadow','shadow'],['uLabLight','light'],['uLabRoof','roof'],['uLabRock','rock'],['uLabLeaf','leaf'],['uLabWood','wood'],['uLabPaper','paper'],['uLabRim','accent']])U[k].value.set(c[role]);
 U.uLabClay.value=clay?1:0;
 for(const {m,role} of materials){m.color.set(c[role]||'#ffffff');if(role==='asset')m.color.set('#ffffff');}
 shared.uInkTime.value=0;shared.uExposure.value=1;
}
