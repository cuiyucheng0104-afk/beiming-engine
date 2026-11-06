import * as THREE from 'three';
import {toonKind,makeToonShared,setToonShared,tintFrom} from '../engine/shade/toon.js';
import {wireOutlines} from '../engine/stage/outline.js';
import {mulberry} from '../engine/core/math.js';
import {E,clamp,ease,seg,mix,poseTime} from './style.js';

export const shared=makeToonShared({keyDir:[-.55,.65,.85]});
const kind=toonKind({name:'E-paper',shared,firstId:100,defaults:{
 color:E.paper,shade1:'#a9a697',shade2:'#606a65',step1:.66,step2:.34,feather1:.035,feather2:.045,
 edgeNoise:.012,edgeNoiseScale:4,rimAmt:.10,rimColor:E.light,rimLitAmt:.06,rimLitColor:E.light,
 skyAmt:0,fillAmt:0,inkColor:E.ink,side:THREE.DoubleSide,outlineW:1
}});

// Paper and markings are generated at a fixed seed. No per-frame random drawing.
function makePaperTexture(){
 const c=document.createElement('canvas');c.width=1536;c.height=1024;const x=c.getContext('2d'),rnd=mulberry(110506);
 x.fillStyle='#ffffff';x.fillRect(0,0,c.width,c.height);
 for(let i=0;i<17000;i++){x.fillStyle=`rgba(58,51,38,${.018+rnd()*.026})`;x.fillRect(rnd()*1536,rnd()*1024,rnd()*8+.6,.5+rnd());}
 x.strokeStyle='#4a514d';x.lineCap='round';x.lineJoin='round';
 // A small painted landscape. Ink washes and dry ridge marks echo the last shot.
 const ridges=[
  [[145,589],[260,534],[365,421],[445,487],[565,322],[655,448],[753,361],[870,469],[990,399],[1130,514],[1295,597]],
  [[155,648],[270,591],[400,621],[515,475],[600,432],[685,568],[800,495],[880,552],[1015,478],[1195,607],[1320,648]],
  [[180,734],[320,682],[455,649],[570,713],[690,652],[830,694],[1000,616],[1120,652],[1315,733]]
 ];
 ridges.forEach((ridge,n)=>{
  const pts=[];for(let k=0;k<ridge.length-1;k++)for(let j=0;j<10;j++){const q=j/10,sm=q*q*(3-2*q);pts.push([mix(ridge[k][0],ridge[k+1][0],q),mix(ridge[k][1],ridge[k+1][1],sm)+(rnd()-.5)*8]);}
  x.beginPath();x.moveTo(...pts[0]);pts.forEach(p=>x.lineTo(...p));x.lineTo(1315,775);x.lineTo(145,775);x.closePath();
  const wash=x.createLinearGradient(0,330,0,780);wash.addColorStop(0,`rgba(53,69,64,${.14+n*.09})`);wash.addColorStop(1,'rgba(53,69,64,0)');x.fillStyle=wash;x.globalAlpha=1;x.fill();
  x.strokeStyle=`rgba(49,60,53,${.18+n*.10})`;x.lineWidth=1.5;x.beginPath();pts.forEach((p,i)=>{if(i%8<5)x.lineTo(...p);else x.moveTo(...p)});x.stroke();
  for(let j=0;j<180;j++){const p=pts[Math.floor(rnd()*pts.length)],l=7+rnd()*48;x.globalAlpha=.04+rnd()*.12;x.lineWidth=.5+rnd();x.beginPath();x.moveTo(p[0],p[1]+rnd()*45);x.lineTo(p[0]+l*.12,p[1]+l);x.stroke();}
 });
 x.globalAlpha=.16;x.strokeStyle='#3f5551';x.lineWidth=1.4;
 for(let j=0;j<28;j++){const yy=728+j*2.9; x.beginPath();x.moveTo(450+Math.sin(j*.6)*40,yy);x.bezierCurveTo(650,yy-12,790,yy+10,1100-j*4,yy);x.stroke();}
 // Two pine silhouettes, drawn from branch strokes instead of a font glyph.
 for(const [px,py,h] of [[314,674,123],[355,686,84]]){x.globalAlpha=.63;x.strokeStyle='#34443c';x.lineWidth=3.1;x.beginPath();x.moveTo(px,py);x.quadraticCurveTo(px-4,py-h*.5,px+5,py-h);x.stroke();
  for(let j=2;j<9;j++){const yy=py-h+j*h/11,w=j*3.1;x.lineWidth=1.6;x.beginPath();x.moveTo(px-w,yy+6);x.lineTo(px+3,yy);x.lineTo(px+w,yy+5);x.stroke();}}
 x.globalAlpha=.75;x.fillStyle=E.wood;x.fillRect(1110,725,116,120);
 x.strokeStyle='#efe4cd';x.lineWidth=5;x.strokeRect(1122,737,92,96);
 x.beginPath();x.moveTo(1141,759);x.lineTo(1141,807);x.lineTo(1194,807);x.moveTo(1167,748);x.lineTo(1167,816);x.moveTo(1193,758);x.lineTo(1193,807);x.stroke();
 const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=8;return tex;
}

export function createHero(){
 const group=new THREE.Group(),tex=makePaperTexture();
 const mat=kind.make();mat.map=tex;mat.needsUpdate=true;
 const geo=new THREE.PlaneGeometry(1.5,1,60,40);const base=geo.attributes.position.array.slice();
 const sheet=new THREE.Mesh(geo,mat);kind.bind(sheet,mat);group.add(sheet);
 const crane=new THREE.Group();group.add(crane);let facetIndex=0;
 const tri=(points,color)=>{
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(points.flat(),3));
  const cell=Math.floor(facetIndex/2),col=cell%4,row=Math.floor(cell/4),flip=facetIndex%2;
  const u0=col/4,u1=(col+1)/4,v0=row/2,v1=(row+1)/2;
  const uv=flip?[u0,v0,u1,v1,u0,v1]:[u0,v0,u1,v0,u1,v1];
  const flat=[];for(let i=0;i<3;i++)flat.push((uv[i*2]-.5)*1.5,(uv[i*2+1]-.5),0);
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.computeVertexNormals();
  const m=kind.make(color?{color,shade1:'#8d9990',shade2:E.shadow}:{});m.map=tex;m.needsUpdate=true;
  const obj=new THREE.Mesh(g,m);obj.userData.finalColor=m.color.clone();obj.userData.finalShade1=new THREE.Color(color===E.wood?'#743b31':'#a9a697');obj.userData.finalShade2=new THREE.Color(color===E.wood?'#44302b':'#606a65');obj.userData.flat=flat;obj.userData.final=points.flat();obj.userData.facet=facetIndex++;kind.bind(obj,m);crane.add(obj);return obj;
 };
 // Faceted body, long folded neck and small downturned beak.
 const b0=[-.55,0,0],b1=[.4,0,0],ridge=[-.08,.20,0],belly=[-.12,-.18,0];
 tri([b0,ridge,[-.02,-.02,.22]]);tri([ridge,b1,[-.02,-.02,.22]]);
 tri([b0,[-.02,-.02,-.22],ridge]);tri([ridge,[-.02,-.02,-.22],b1]);
 tri([b0,belly,[-.02,-.02,.22]],'#c9c6ac');tri([b1,[-.02,-.02,.22],belly]);
 tri([[.18,.04,0],[.50,.60,.02],[.58,.35,.04]]);
 tri([[.18,.04,0],[.58,.35,.04],[.42,-.05,0]],'#c7baa0');
 tri([[.50,.60,.02],[.78,.70,0],[.58,.35,.04]]);
 tri([[.78,.70,0],[1.02,.48,0],[.74,.51,.025]],E.wood);
 tri([[-.38,.02,0],[-1.03,.43,0],[-.76,-.06,.08]]);
 tri([[-.38,.02,0],[-.76,-.06,-.08],[-1.03,.43,0]],'#c9c6ac');
 const wings=[];
 for(const side of [-1,1]){
  const a=tri([[-.37,.04,side*.10],[.28,.08,side*.08],[-.56,.39,side*1.35]]);
  const b=tri([[-.37,.04,side*.10],[-.56,.39,side*1.35],[-.93,.07,side*.80]],side===1?'#d8cfb5':'#b0b4a2');
  for(const m of [a,b]){m.userData.rest=m.geometry.attributes.position.array.slice();m.userData.side=side;wings.push(m);}
 }
 wireOutlines(group);
 function update(t){
  const ts=poseTime(t),fold=seg(ts,6.15,7.95),pos=geo.attributes.position;
  for(let i=0;i<pos.count;i++){
   const x=base[i*3],y=base[i*3+1],curl=seg(t,.55,2.1);
   pos.setXYZ(i,x*(1-.40*fold),y*(1-.68*fold),(.105*Math.sin(x*4.0-ts*3.8)+.05*Math.sin(y*6+ts*4.3))*(.10+.90*curl)+fold*.24*Math.abs(x));
  }pos.needsUpdate=true;geo.computeVertexNormals();
  sheet.visible=fold<.001;crane.visible=fold>=.001;
  const reveal=fold;crane.scale.setScalar(1);
  crane.rotation.x=(.85+.10*Math.sin(ts*2.2))*reveal;crane.rotation.y=-.18*reveal;
  // Sixteen facets start as one tiled sheet and move continuously to the crane.
  // This is a stylised vertex morph, not a physical origami constraint solver.
  crane.children.forEach(m=>{const p=m.geometry.attributes.position,a=m.userData.flat,b=m.userData.final;
   const f=ease(clamp((fold-.035*(m.userData.facet%3))/.93)),colorMix=seg(fold,.1,.7);
   m.material.color.set(E.paper).lerp(m.userData.finalColor,colorMix);
   // Absolute shadow colours require new tint ratios when the base changes.
   // Reusing the red beak's ratios with a cream base creates a cyan flash.
   const s1=new THREE.Color('#a9a697').lerp(m.userData.finalShade1,colorMix),s2=new THREE.Color('#606a65').lerp(m.userData.finalShade2,colorMix);
   m.material.userData.toon.uShade1Tint.value.copy(tintFrom(m.material.color,s1));
   m.material.userData.toon.uShade2Tint.value.copy(tintFrom(m.material.color,s2));
   for(let i=0;i<p.count;i++){
    const x=a[i*3],y=a[i*3+1],z=(.105*Math.sin(x*4-ts*3.8)+.05*Math.sin(y*6+ts*4.3))*(1-f);
    p.setXYZ(i,mix(x,b[i*3],f),mix(y,b[i*3+1],f),z+mix(0,b[i*3+2],f));
   }p.needsUpdate=true;m.geometry.computeVertexNormals();
  });
  for(const m of wings){const p=m.geometry.attributes.position,r=m.userData.rest,side=m.userData.side;
   const a=(.18+.46*Math.sin((ts-8.0)*5.2))*seg(t,7.7,8.5)+(.9*(1-reveal));
   const flap=seg(t,7.95,8.35);
   for(let i=0;i<p.count;i++){const x=r[i*3],y=r[i*3+1],z=r[i*3+2],w=clamp((Math.abs(z)-.1)/1.25);p.setXYZ(i,mix(p.getX(i),x,flap),mix(p.getY(i),y+Math.sin(a)*Math.abs(z)*w,flap),mix(p.getZ(i),z*Math.cos(a*w),flap));}
   p.needsUpdate=true;m.geometry.computeVertexNormals();
  }
  setToonShared(shared,{inkTime:Math.floor(t*12),keyDir:[-.55,.65,.85],fillGain:0,skyGain:0});
 }
 return {group,update,sheet,crane};
}

export function createLoosePaper(seed){
 const rnd=mulberry(seed),g=new THREE.PlaneGeometry(1,.70,8,5),m=kind.make({color:seed%3===0?'#bbbdad':E.paper,outlineW:.6});
 const obj=new THREE.Mesh(g,m);kind.bind(obj,m);wireOutlines(obj,{alpha:.6});
 const phase=rnd()*Math.PI*2,rad=.4+rnd()*.6;
 const rest=g.attributes.position.array.slice();
 return {obj,phase,rad,update(t){const p=g.attributes.position,ts=poseTime(t);for(let i=0;i<p.count;i++){const x=rest[i*3],y=rest[i*3+1];p.setXYZ(i,x,y,.12*Math.sin(x*4+ts*4+phase));}p.needsUpdate=true;g.computeVertexNormals();}};
}
