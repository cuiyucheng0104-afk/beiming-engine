import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Reflector} from 'three/addons/objects/Reflector.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {makeToonMaterial,bindToon,PALETTE} from '../src/toon.js';
import {clump,boatHull} from '../engine/form/props.js';
import {mulberry} from '../engine/core/math.js';

export {T,mulberry};
export const V=(a)=>new T.Vector3(...a);
const roles={
 rock:['#8893BD','#626992','#41466D'],moss:['#8FAE70','#53785D','#354D53'],leaf:['#91B76B','#578365','#394E61'],
 wood:['#B98067','#735675','#41415D'],bark:['#8F7B94','#626182','#373E61'],roof:['#6E89AA','#4F5C85','#343D69'],
 cream:['#F1DBC3','#B5A4C7','#77769F'],paper:['#FFE9CF','#CABAD8','#8E89B2'],skin:['#E7AF91','#AD819B','#78667E'],
 red:['#E68F86','#A5688C','#674B76'],gold:['#EAB872','#A78683','#676084'],bronze:['#91A58B','#647C83','#414C70'],
 blue:['#839DC3','#5D729B','#414C77'],flower:['#FFF1D9','#D2B5D5','#8F84B1'],dark:['#40415E','#32344F','#242A45']
};
export function palette(role,extra={}){
 const [c,a,b]=roles[role]||roles.rock;
 return makeToonMaterial({color:c,shade1:new T.Color(a).multiplyScalar(.72),shade2:new T.Color(b).multiplyScalar(.56),step1:.62,step2:.31,feather1:.02,feather2:.025,
  rimColor:PALETTE.pink,rimAmt:.24,rimInside:.57,rimLitColor:PALETTE.kunRim,rimLitAmt:.4,rimLitInside:.5,
  fillColor:PALETTE.kunBelly,fillAmt:.28,skyAmt:.25,skyTint:[.88,.94,1.18],
  edgeNoise:.025,edgeNoiseScale:1.3,patchScale:1.4,rustAmt:0,algaeAmt:0,spotAmt:0,dabAmt:.055,dabScale:2.4,...extra});
}
export const M=Object.fromEntries(Object.keys(roles).map(k=>[k,palette(k)]));
M.cloud=palette('paper',{color:'#F7BFA9',shade1:'#AE91C9',shade2:'#7D75AD',rimAmt:.04,rimLitAmt:.15,dabAmt:.03,step1:.52});
M.rock=palette('rock',{rustAmt:.15,algaeAmt:.16,spotAmt:.15,patchScale:.55,dabAmt:.09,dabScale:1.4});
M.moss=palette('moss',{dabAmt:.18,dabScale:3.2,rimLitAmt:.3});
M.leaf=palette('leaf',{dabAmt:.16,dabScale:3.5,rimLitAmt:.38});
M.gold=palette('gold',{rimLitAmt:.55,dabAmt:.07});
M.glow=new T.MeshBasicMaterial({color:new T.Color('#FFBD75').multiplyScalar(1.5)});
const GEO={box:new T.BoxGeometry(1,1,1),sphere:new T.SphereGeometry(1,20,14),clump:clump({flat:.82,a1:.1,a2:.04})};
export function mesh(geo,mat,parent,opts={}){
 let m=new T.Mesh(geo,typeof mat==='string'?M[mat]:mat);if(m.material.userData.toon)bindToon(m,m.material,{outline:opts.outline!==false,castShadow:opts.cast!==false,receiveShadow:opts.receive!==false});
 if(!m.material.userData.toon){m.userData.outline=false;}
 parent?.add(m);return m;
}
export function box(parent,pos,size,role='wood',round=0){let o=mesh(round?new RoundedBoxGeometry(...size,2,round):GEO.box,role,parent);if(!round)o.scale.set(...size);o.position.set(...pos);return o;}
export function ball(parent,pos,size,role='leaf',irregular=false){let o=mesh(irregular?GEO.clump:GEO.sphere,role,parent);o.position.set(...pos);o.scale.set(...size);return o;}
export function group(parent,pos=[0,0,0],s=1,ry=0){const g=new T.Group();g.position.set(...pos);g.scale.setScalar(s);g.rotation.y=ry;parent?.add(g);return g;}
export function tube(parent,pts,r=.1,role='wood',r2=null){
 if(pts.length===2){const a=V(pts[0]),b=V(pts[1]);let o=mesh(new T.CylinderGeometry(r2??r,r,a.distanceTo(b),10),role,parent);o.position.copy(a).add(b).multiplyScalar(.5);o.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),b.sub(a).normalize());return o;}
 const c=new T.CatmullRomCurve3(pts.map(V));return mesh(new T.TubeGeometry(c,Math.max(16,pts.length*5),r,8,false),role,parent);
}
export function batch(parent,geo,mat,poses,{outline=false}={}){
 const o=new T.InstancedMesh(geo,typeof mat==='string'?M[mat]:mat,poses.length),d=new T.Object3D();
 poses.forEach((p,i)=>{d.position.set(...p.p);d.scale.set(...(p.s||[1,1,1]));d.rotation.set(...(p.r||[0,0,0]));d.updateMatrix();o.setMatrixAt(i,d.matrix);});
 bindToon(o,o.material,{outline,perInstance:false});parent.add(o);return o;
}
// 合并同材质小部件，保留真实几何与投影；高模和可反射水面不合并。
export function compact(root){root.updateMatrixWorld(true);let buckets=new Map();const inv=new T.Matrix4().copy(root.matrixWorld).invert();
 root.traverse(o=>{if(!o.isMesh||o.isInstancedMesh||o.userData.keep||o.geometry.attributes.position.count>100000||Array.isArray(o.material))return;
  if(!o.material.userData.toon)return;let key=o.material.uuid+'-'+o.castShadow+'-'+o.userData.outline;
  if(!buckets.has(key))buckets.set(key,{mat:o.material,shadow:o.castShadow,outline:o.userData.outline,items:[]});buckets.get(key).items.push(o);});
 for(const b of buckets.values()){if(b.items.length<3)continue;let parts=[];for(const o of b.items){let g=o.geometry.clone();g.applyMatrix4(new T.Matrix4().multiplyMatrices(inv,o.matrixWorld));if(g.index)g=g.toNonIndexed();
  for(const k of Object.keys(g.attributes))if(!['position','normal','uv'].includes(k))g.deleteAttribute(k);if(!g.attributes.uv)g.setAttribute('uv',new T.Float32BufferAttribute(new Float32Array(g.attributes.position.count*2),2));parts.push(g);o.removeFromParent();}
  let g=mergeGeometries(parts),m=mesh(g,b.mat,root,{cast:b.shadow,outline:b.outline});m.userData.outlineGroup=b.mat.name||b.mat.uuid;parts.forEach(g=>g.dispose());}
}
export function tree(parent,pos,s=1,seed=1,{pine=false,bare=false}={}){
 const g=group(parent,pos,s),R=mulberry(seed),fol=[];
 const trunk=[[0,0,0],[.3,2,0],[-.2,4,.2],[.4,6,.05],[.15,7.8,-.3]];
 for(let i=0;i<4;i++)tube(g,[trunk[i],trunk[i+1]],.44*(1-i*.2),'bark',.33*(1-i*.2));
 for(let i=0;i<7;i++){let a=i*2.4+R(),y=2.5+i*.65,l=2.4+(7-i)*.18;
  const end=[Math.cos(a)*l,y+1.2+R()*.6,Math.sin(a)*l];
  tube(g,[[.1,y,0],[end[0]*.55,y+.25,end[2]*.55],end],.11+(7-i)*.012,'bark');
  for(let j=0;j<3;j++){let b=a+(j-1)*.75,p=[end[0]+Math.cos(b)*(.6+R()),end[1]+R()*.55,end[2]+Math.sin(b)*(.6+R())];
   tube(g,[end,p],.055,'bark',.025);if(!bare)for(let k=0;k<8;k++){let rad=.5+R()*.6;fol.push({p:[p[0]+(R()-.5)*2.4,p[1]+R()*1.2,p[2]+(R()-.5)*2.4],s:[rad,pine?rad*.62:rad*.95,rad*.85],r:[R()*.4,R()*6,.1]});}}
 }
 for(let i=0;i<5;i++){const a=i*1.25; tube(g,[[0,.4,0],[Math.cos(a),.08,Math.sin(a)],[Math.cos(a)*2,-.1,Math.sin(a)*2]],.15,'bark');}
 if(fol.length)batch(g,GEO.clump,M.leaf,fol);return g;
}
export function rock(parent,pos,size,seed=2){const R=mulberry(seed),geo=new T.SphereGeometry(1,28,22),p=geo.attributes.position;
 for(let i=0;i<p.count;i++){let x=p.getX(i),y=p.getY(i),z=p.getZ(i);let n=1+.12*Math.sin(x*7.3+y*5+seed)*Math.sin(z*6.4+y*2)+.04*Math.sin(x*22+z*17);p.setXYZ(i,x*n,y*n,z*n);}geo.computeVertexNormals();let o=mesh(geo,M.rock,parent);o.position.set(...pos);o.scale.set(...size);o.rotation.y=R()*6;return o;
}
export function moss(parent,center,rx,rz,n=35,seed=1){let R=mulberry(seed),poses=[],flowers=[];for(let i=0;i<n;i++){let a=R()*Math.PI*2,r=Math.sqrt(R()),x=center[0]+Math.cos(a)*r*rx,z=center[2]+Math.sin(a)*r*rz,s=.15+R()*.45;poses.push({p:[x,center[1]+R()*.1,z],s:[s,s*.6,s]});if(i%6===0)flowers.push({p:[x,center[1]+s*.8,z],s:[.055,.08,.055]});}batch(parent,GEO.clump,M.moss,poses);if(flowers.length)batch(parent,GEO.sphere,M.flower,flowers);}
export function mountain(parent,pos,h,r,seed=1,{green=true}={}){
 const R=mulberry(seed),N=80,A=80,p=[],ix=[],tops=[];
 for(let j=0;j<=N;j++){let t=j/N,y=h*t,rad=r*Math.pow(Math.max(.002,1-t),.52)*(1+.16*Math.sin(t*7+seed));
  if(j===N)rad*=.07;
  for(let i=0;i<=A;i++){let a=i/A*Math.PI*2,n=1+.15*Math.sin(a*5+seed)+.1*Math.sin(a*9-t*2)+.07*Math.cos(a*13+t*12)+.035*Math.sin(a*27+t*29);
   let x=Math.cos(a)*rad*n+Math.sin(t*4+seed)*r*.18,z=Math.sin(a)*rad*n+Math.sin(t*5+seed*2)*r*.12;
   p.push(x,y+.025*h*Math.sin(a*6+seed)*Math.sin(Math.PI*t),z);
   if(j<N&&i<A){let k=j*(A+1)+i;ix.push(k,k+A+1,k+1,k+1,k+A+1,k+A+2);}
   if(green&&j>9&&R()<.09&&(t>.7||Math.sin(a*3+t*8+seed)>.2)){let s=r*(.07+R()*.14);tops.push({p:[x,y,z],s:[s,s*.95,s],r:[0,R()*6,0]});}
  }}
 const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(p,3));geo.setIndex(ix);geo.computeVertexNormals();const g=group(parent,pos);mesh(geo,M.rock,g);if(tops.length)batch(g,GEO.clump,M.moss,tops);return g;
}
let cloudMap;export let cloudsReady=Promise.resolve();
export function cloud(parent,pos,s=1,seed=1){if(!cloudMap){cloudsReady=new Promise((resolve,reject)=>{cloudMap=new T.TextureLoader().load('../assets/clouds_back.png',resolve,undefined,reject);});cloudMap.colorSpace=T.SRGBColorSpace;}let g=group(parent,pos,s);let m=new T.MeshBasicMaterial({map:cloudMap,transparent:true,depthWrite:false,side:T.DoubleSide});let o=new T.Mesh(new T.PlaneGeometry(17,6.5),m);g.add(o);o.userData.outline=false;o.userData.outlineOccluder=false;o.renderOrder=2;return g;}
export function distant(parent,{seed=1,rows=3,span=200,start=-85,h=35,step=75}={}){let R=mulberry(seed);for(let row=0;row<rows;row++)for(let i=0;i<7;i++)mountain(parent,[(i-3)*span/5+(R()-.5)*span*.12,-4,start-row*step-R()*20],h*(.6+R()*.8),h*(.25+R()*.12),seed+row*31+i,{green:row===0});}

// 歇山式曲面屋面：屋脊有长度、檐口上翘，瓦垄是真实薄管几何。
export function roof(parent,w,d,h,role='roof'){
 const g=group(parent),nu=48,nv=32,p=[],ix=[];
 const height=(x,z)=>{let u=Math.abs(x)/(w/2),v=Math.abs(z)/(d/2),q=Math.max(v,Math.max(0,(u-.56)/.44));return h*Math.pow(1-q,.8)+h*.22*Math.pow(q,8)+h*.16*Math.pow(u*v,6);};
 for(let j=0;j<=nv;j++)for(let i=0;i<=nu;i++){let x=(i/nu-.5)*w,z=(j/nv-.5)*d;p.push(x,height(x,z),z);if(i<nu&&j<nv){let a=j*(nu+1)+i;ix.push(a,a+nu+1,a+1,a+1,a+nu+1,a+nu+2);}}
 const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(p,3));geo.setIndex(ix);geo.computeVertexNormals();let mat=M[role];let o=mesh(geo,mat,g);o.material.side=T.DoubleSide;
 tube(g,[[-w*.29,h+.07,0],[0,h+.1,0],[w*.29,h+.07,0]],.10,'gold');
 for(const side of [-1,1]){const pts=[];for(let i=0;i<=24;i++){let x=(i/24-.5)*w,z=side*d/2;pts.push([x,height(x,z),z]);}tube(g,pts,.09,'wood');}
 let count=Math.floor(w/.23);for(let i=0;i<count;i++){let x=(i/(count-1)-.5)*w;for(const side of [-1,1]){let pts=[];for(let j=0;j<=8;j++){let z=side*d/2*j/8;pts.push([x,height(x,z)+.025,z]);}tube(g,pts,.025,'blue');}}
 for(const a of [-1,1])for(const b of [-1,1]){let x=a*w/2,z=b*d/2;tube(g,[[x*.62,height(x*.62,z*.62),z*.62],[x,height(x,z)+.05,z],[x*1.04,height(x,z)+.22,z*1.04]],.07,'gold');}
 return g;
}
export function house(parent,pos,s=1,ry=0,{stories=1,open=false,lit=false}={}){
 const g=group(parent,pos,s,ry);box(g,[0,.15,0],[8.8,.3,6.3],'rock',.1);
 for(let level=0;level<stories;level++){let yy=level*4.05;
  if(!open)box(g,[0,yy+1.85,0],[7.1,3.4,4.8],'cream',.07);
  for(const x of [-3.65,0,3.65])for(const z of [-2.55,2.55]){box(g,[x,yy+1.85,z],[.27,3.7,.27],'red',.035);ball(g,[x,yy+.27,z],[.23,.3,.23],'rock');}
  for(const z of [-2.55,2.55]){box(g,[0,yy+3.3,z],[7.6,.25,.3],'wood');box(g,[0,yy+.6,z],[7.6,.15,.22],'wood');
   for(const x of [-2.4,2.4]){box(g,[x,yy+1.9,z+.03],[1.7,2,.055],lit?M.glow:M.roof);for(let k=0;k<6;k++)box(g,[x-.8+k*.32,yy+1.9,z+.08],[.055,2,.055],'wood');for(let k=0;k<4;k++)box(g,[x,yy+1.05+k*.55,z+.1],[1.7,.055,.055],'wood');}
  }
  let rr=roof(g,9.8-level*.25,7,1.8);rr.position.y=yy+3.45;
  if(level>0){box(g,[0,yy+.15,0],[9,.2,6.7],'wood');for(const z of [-3.1,3.1]){tube(g,[[-4.3,yy+1,z],[4.3,yy+1,z]],.07);for(let x=-4.2;x<4.3;x+=.6)box(g,[x,yy+.6,z],[.07,.85,.07]);}}
 }
 for(let i=0;i<4;i++)box(g,[0,-.13-i*.14,3.1+i*.28],[3.4,.2,.4],'rock',.05);return g;
}
const inkCache=new Map();
export function inkTexture(seed=1,paper=true){let key=seed+'-'+paper;if(inkCache.has(key))return inkCache.get(key);const c=document.createElement('canvas');c.width=1024;c.height=1024;const x=c.getContext('2d');x.fillStyle=paper?'#fae8c8':'#bec4be';x.fillRect(0,0,1024,1024);x.fillStyle=paper?'#41425a':'#525568';x.font='54px "Noto Serif SC", "Songti SC", serif';const chars='北冥有魚其名為鯤山川雲海清風明月天地玄黃日月盈昃歲在甲子歸去來兮';for(let col=0;col<10;col++)for(let row=0;row<13;row++)x.fillText(chars[(col*13+row+seed)%chars.length],930-col*90,70+row*70);const t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;t.anisotropy=8;inkCache.set(key,t);return t;}
export function paper(parent,pos,size=[2,3],seed=1,rot=[-Math.PI/2,0,0],bend=.08){const geo=new T.PlaneGeometry(size[0],size[1],12,14),p=geo.attributes.position;for(let i=0;i<p.count;i++)p.setZ(i,bend*Math.sin(p.getX(i)*3+seed)+bend*.6*Math.cos(p.getY(i)*4));geo.computeVertexNormals();const mat=palette('paper',{map:inkTexture(seed),side:T.DoubleSide,dabAmt:0,color:'#ffffff',shade1:null,shade2:null,shade1Tint:[.65,.59,.79],shade2Tint:[.38,.4,.6]});let o=mesh(geo,mat,parent);o.position.set(...pos);o.rotation.set(...rot);return o;}
export function scroll(parent,pos,s=1,seed=1,ry=0){let g=group(parent,pos,s,ry);paper(g,[0,.04,0],[2.1,3.3],seed);for(const z of [-1.65,1.65])tube(g,[[-1.3,.13,z],[1.3,.13,z]],.13,'cream');return g;}
export function candle(parent,pos,s=1){const g=group(parent,pos,s);let base=mesh(new T.LatheGeometry([[0,0],[.35,0],[.35,.12],[.13,.2],[.1,.55],[.38,.6],[.38,.68],[0,.68]].map(V2),32),M.bronze,g);tube(g,[[0,.68,0],[0,1.4,0]],.18,'red');ball(g,[0,1.65,0],[.09,.3,.09],M.glow);return g;}
const V2=p=>new T.Vector2(...p);
export function bowl(parent,pos,s=1,role='bronze'){let g=group(parent,pos,s);mesh(new T.LatheGeometry([[.02,0],[.48,.02],[.7,.26],[.78,.55],[.71,.55],[.62,.28],[.4,.12],[0,.12]].map(V2),48),M[role],g);return g;}
export function book(parent,pos,size=[1,.2,1.8],role='blue',ry=0){let g=group(parent,pos,1,ry);box(g,[0,0,0],size,'cream');box(g,[0,size[1]/2+.015,0],[size[0]+.08,.04,size[2]+.04],role);box(g,[0,-size[1]/2,0],[size[0]+.08,.04,size[2]+.04],role);for(let i=0;i<4;i++)tube(g,[[-size[0]/2-.03,0,-size[2]*.35+i*size[2]*.23],[-size[0]/2+.12,size[1]/2+.05,-size[2]*.35+i*size[2]*.23]],.015,'gold');return g;}
export function boat(parent,pos,s=1,ry=0,{cover=true}={}){let g=group(parent,pos,s,ry);mesh(boatHull(10,2.4,.8,.25),M.wood,g);for(let i=0;i<24;i++)box(g,[-4.5+i*.36,.65,0],[.32,.09,2.05],'wood');for(let side of [-1,1])tube(g,[[-4.5,.88,side*.85],[-1,.85,side*1.12],[3,.85,side*.9],[5,.95,0]],.07,'gold');
 if(cover){const p=[],ix=[],N=32;for(let j=0;j<=1;j++)for(let i=0;i<=N;i++){let a=i/N*Math.PI;p.push(-3+j*4,.95+1.25*Math.sin(a),1.22*Math.cos(a));if(j===0&&i<N)ix.push(i,i+N+1,i+1,i+1,i+N+1,i+N+2);}let geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(p,3));geo.setIndex(ix);geo.computeVertexNormals();mesh(geo,palette('roof',{side:T.DoubleSide}),g);for(let x=-3;x<=1;x+=.4){let pts=[];for(let i=0;i<=16;i++){let a=i/16*Math.PI;pts.push([x,.97+1.25*Math.sin(a),1.24*Math.cos(a)]);}tube(g,pts,.025,'wood');}}
 return g;
}
export function person(parent,pos,s=1,ry=0,role='cream',hat=true){let g=group(parent,pos,s,ry);mesh(new T.LatheGeometry([[.5,0],[.55,.12],[.43,1.1],[.5,1.7],[.32,2],[.2,2.08]].map(V2),16),M[role],g);ball(g,[0,2.3,0],[.23,.31,.23],'skin');ball(g,[0,2.52,0],[.21,.16,.22],'dark');for(const side of [-1,1]){tube(g,[[side*.37,1.8,0],[side*.56,1.1,.22]],.18,role,.11);ball(g,[side*.56,1.05,.22],[.11,.15,.11],'skin');}if(hat){let h=mesh(new T.ConeGeometry(.7,.3,32),M.gold,g);h.position.y=2.65;}tube(g,[[-.43,1,0],[.43,1,0]],.035,'red');return g;}
// TRELLIS 保留几何；纹理只用于识别衣/肤/发等固有色，不把照片的明暗叠到三维光照上。
export async function asset(parent,name,pos,size,ry=0){let gltf=await new GLTFLoader().loadAsync('../models/'+name+'.glb'),a=gltf.scene;
 const b=new T.Box3().setFromObject(a),c=b.getCenter(new T.Vector3()),sz=b.getSize(new T.Vector3());a.position.sub(c);a.position.y+=sz.y/2;
 const g=group(parent,pos,size/(name==='pavilion'?Math.max(sz.x,sz.z):sz.y),ry);g.add(a);
 a.traverse(o=>{if(!o.isMesh)return;const old=o.material;if(name==='scholar'){const p=o.geometry.attributes.position;for(let i=0;i<p.count;i++){let y=p.getY(i);if(y>.21)p.setY(i,.21+(y-.21)*.38);}p.needsUpdate=true;o.geometry.computeBoundingSphere();}const pal=name==='pavilion'?`vec3 tex=diffuseColor.rgb; float y=dot(tex,vec3(.21,.72,.07)); float warm=smoothstep(.002,.045,tex.r-tex.b); vec3 tile=vec3(.12,.2,.34); vec3 timber=vec3(.48,.22,.19); vec3 wall=vec3(.72,.62,.61); diffuseColor.rgb=mix(mix(tile,timber,warm),wall,smoothstep(.15,.4,y)*.45);`:
 `vec3 tex=diffuseColor.rgb; float y=dot(tex,vec3(.21,.72,.07)); float warm=smoothstep(.045,.14,tex.r-tex.b); vec3 cloth=vec3(.52,.53,.66); vec3 skin=vec3(.76,.45,.31); vec3 base=mix(cloth,skin,warm); diffuseColor.rgb=mix(vec3(.065,.07,.12),base,smoothstep(.012,.075,y));`;
 const m=palette('cream',{color:'#ffffff',map:old.map||null,vertexColors:!!o.geometry.attributes.color,shade1:null,shade2:null,shade1Tint:[.54,.49,.7],shade2Tint:[.27,.29,.49],fragmentAlbedo:pal,dabAmt:0,rimAmt:.08,rimLitAmt:.15,rimInside:.7,rimLitInside:.65,side:T.DoubleSide});bindToon(o,m,{outline:true});o.userData.keep=true;o.userData.outlineGroup=name;});
 g.userData.source=name;return g;
}
export function sky(scene,{night=false,interior=false}={}){const c=document.createElement('canvas');c.width=16;c.height=1024;const x=c.getContext('2d'),gr=x.createLinearGradient(0,0,0,1024);gr.addColorStop(0,night?'#354D82':'#6379BC');gr.addColorStop(.45,night?'#7A8EB6':'#A897CF');gr.addColorStop(1,night?'#AC9DAF':'#F2B498');x.fillStyle=gr;x.fillRect(0,0,16,1024);let tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;scene.background=interior?new T.Color('#4C507B'):tex;}
export function water(scene,y=0,size=5000){const shader={uniforms:{color:{value:new T.Color('#4D6D91')},tDiffuse:{value:null},textureMatrix:{value:null}},vertexShader:`uniform mat4 textureMatrix;varying vec4 vRef;varying vec3 vP;void main(){vP=position;vRef=textureMatrix*vec4(position,1.);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,fragmentShader:`uniform sampler2D tDiffuse;uniform vec3 color;varying vec4 vRef;varying vec3 vP;void main(){vec2 uv=vRef.xy/vRef.w;uv.x+=sin(vP.y*1.8+sin(vP.x*.31))*.0009;uv.y+=sin(vP.x*.8+vP.y*.6)*.0003;vec3 ref=texture2D(tDiffuse,uv).rgb;float stripe=pow(max(0.,sin(vP.y*4.2+sin(vP.x*.6)*1.5)),45.);vec3 c=mix(color,ref,.32)+vec3(.18,.15,.13)*stripe*.07;gl_FragColor=vec4(c,1.);\n#include <colorspace_fragment>\n}`};
 const w=new Reflector(new T.PlaneGeometry(size,size),{textureWidth:1536,textureHeight:1536,clipBias:.003,shader});w.rotation.x=-Math.PI/2;w.position.y=y;w.userData.keep=true;w.userData.outline=false;w.userData.outlineOccluder='own';scene.add(w);return w;
}
export function bird(parent,pos,s=1,seed=1){const g=group(parent,pos,s,seed*.7);ball(g,[0,0,0],[.16,.18,.5],'paper');for(const side of [-1,1]){const geo=new T.Shape();geo.moveTo(0,0);geo.quadraticCurveTo(side*.7,.1,side*1.5,.6);geo.quadraticCurveTo(side*.8,-.2,0,-.2);let o=mesh(new T.ExtrudeGeometry(geo,{depth:.035,bevelEnabled:false}),M.paper,g);o.rotation.x=Math.PI/2;}tube(g,[[0,0,-.35],[0,.15,-.8]],.055,'paper',.04);tube(g,[[0,.15,-.8],[0,.14,-1]],.035,'gold',.005);return g;}
export function ground(parent,size=100,y=-.3){return box(parent,[0,y-.4,0],[size,.8,size],'rock');}
export function paving(parent,{x=0,z=0,w=20,d=25,y=.03,seed=1}={}){let R=mulberry(seed),poses=[];for(let zz=-d/2;zz<d/2;zz+=.82)for(let xx=-w/2;xx<w/2;xx+=1.6)poses.push({p:[x+xx+(Math.round(zz/.82)%2)*.8,y+R()*.035,z+zz],s:[1.5,.14,.75],r:[0,(R()-.5)*.04,0]});return batch(parent,new RoundedBoxGeometry(1,1,1,1,.08),M.rock,poses,{outline:false});}
