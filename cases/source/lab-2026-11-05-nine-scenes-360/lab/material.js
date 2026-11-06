import * as THREE from 'three';
import {toonKind,makeToonShared} from '../engine/shade/toon.js';
export const shared=makeToonShared();
const U={uBandN:{value:3},uBandThresholds:{value:[.34,.66,1,1,1]},uBandValues:{value:[.08,.48,1,1,1,1]},uBandFeather:{value:.015},uShadow:{value:new THREE.Color()},uLight:{value:new THREE.Color()},uRoof:{value:new THREE.Color()},uRock:{value:new THREE.Color()},uLeaf:{value:new THREE.Color()},uWood:{value:new THREE.Color()},uPaper:{value:new THREE.Color()},uAccent:{value:new THREE.Color()},uTextureKeep:{value:.5}};
const family=toonKind({name:'nine-scenes-multiband-v2',shared,featherMin:.004,
 defaults:{rimAmt:0,rimLitAmt:0,edgeNoise:0,skyAmt:0,fillAmt:0},
 pars:`uniform int uBandN;uniform float uBandThresholds[5],uBandValues[6],uBandFeather,uTextureKeep;
 uniform vec3 uShadow,uLight,uRoof,uRock,uLeaf,uWood,uPaper,uAccent;`,uniforms:()=>U,
 shade:{afterRim:`
 float illumination=clamp(dot(N,L)*.58+.40,0.,1.);
 illumination*=mix(.26,1.,att);
 float bw=max(uBandFeather,fwidth(illumination)*1.15);
 float bq=uBandValues[0];
 for(int i=0;i<5;i++){if(i<uBandN-1)bq+=(uBandValues[i+1]-uBandValues[i])*smoothstep(uBandThresholds[i]-bw*.5,uBandThresholds[i]+bw*.5,illumination);}
 vec3 dark=mix(alb*.28,uShadow*.52,.33);
 vec3 bright=alb*mix(vec3(1.18),uLight*1.65,.28);
 col=mix(dark,bright,bq);
 float edge=pow(1.-max(0.,dot(N,V)),5.)*smoothstep(.38,.92,hl)*att;
 col+=uAccent*edge*.055;
 `}});
const materials=[];
export function assetMaterial(source){
 const m=family.make({color:'#ffffff',map:source.map||null,vertexColors:!source.map&&source.vertexColors,side:THREE.DoubleSide,
 fragmentAlbedo:`
 vec3 src=diffuseColor.rgb;
 float lum=max(dot(src,vec3(.2126,.7152,.0722)),.001);
 vec3 chroma=clamp(src/lum,vec3(.25),vec3(2.4));
 // Source lighting is compressed, not claimed to be recovered physical albedo.
 float value=pow(lum,.46);
 float cool=smoothstep(-.02,.10,src.b-src.r);
 float green=smoothstep(-.01,.06,src.g-(src.r+src.b)*.51);
 float warm=smoothstep(.005,.11,src.r-src.b);
 vec3 role=mix(uRoof,uRock,smoothstep(.015,.22,lum));
 role=mix(role,uRoof,cool*.9);
 role=mix(role,uWood,warm*.8);role=mix(role,uLeaf,green*.85);
 role=mix(role,uPaper,smoothstep(.30,.65,lum)*.75);
 vec3 ownColor=chroma*mix(.15,.68,value);
 diffuseColor.rgb=mix(role*mix(.52,1.05,value),ownColor,uTextureKeep);
 `});materials.push(m);return m;
}
export function roleMaterial(role){const m=family.make({color:'#ffffff',side:THREE.DoubleSide});m.userData.role=role;materials.push(m);return m;}
export function bind(mesh,mat,opts={}){return family.bind(mesh,mat,opts);}
export function applyPreset(p,{textureKeep=.48}={}){
 const c=p.palette,s=p.profile;U.uBandN.value=s.bands;U.uBandFeather.value=s.feather;
 U.uBandThresholds.value=[...s.thresholds,...Array(5-s.thresholds.length).fill(1)];
 U.uBandValues.value=[...s.levels,...Array(6-s.levels.length).fill(1)];U.uTextureKeep.value=textureKeep;
 for(const [key,role] of [['uShadow','shadow'],['uLight','light'],['uRoof','roof'],['uRock','rock'],['uLeaf','leaf'],['uWood','wood'],['uPaper','paper'],['uAccent','accent']])U[key].value.set(c[role]);
 for(const m of materials)if(m.userData.role)m.color.set(c[m.userData.role]);
 shared.uInkTime.value=0;shared.uExposure.value=1;
}
