import * as THREE from 'three';
import {mulberry} from '../engine/core/math.js';
import {E,seg} from './style.js';

export function createAtmosphere(W,H){
 const root=new THREE.Group(),rnd=mulberry(7158),N=180,points=new Float32Array(N*3),states=[];
 for(let i=0;i<N;i++)states.push({x:rnd()*W-W/2,y:rnd()*H-H/2,z:rnd()*300-180,p:rnd()*6.28,s:.3+rnd()});
 const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(points,3));
 const mat=new THREE.PointsMaterial({color:E.light,size:2.2,transparent:true,opacity:.42,depthWrite:false,sizeAttenuation:false});
 const dust=new THREE.Points(geo,mat);dust.userData.outline=false;root.add(dust);
 const uniforms={time:{value:0},opacity:{value:.05}};
 const haze=new THREE.Mesh(new THREE.PlaneGeometry(W,H),new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:false,uniforms,
 vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
 fragmentShader:`varying vec2 vUv;uniform float time,opacity;void main(){vec2 uv=vUv;float n=.5+.22*sin(uv.x*11.+time*.25)+.14*sin(uv.x*29.-time*.18);float band=exp(-pow((uv.y-.31-.04*n)*12.,2.));float ray=pow(max(0.,1.-abs((uv.x+uv.y*.42)-.87)*12.),3.)*.26;gl_FragColor=vec4(.66,.70,.62,opacity*(band+ray));}`}));
 haze.position.z=-500;haze.renderOrder=-80;haze.userData.outline=false;haze.userData.outlineOccluder=false;root.add(haze);
 const birds=[];
 for(let i=0;i<7;i++){
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(18),3));g.setIndex([0,1,2,3,4,5]);
  const m=new THREE.MeshBasicMaterial({color:i%2?E.paper:E.ink,side:THREE.DoubleSide,transparent:true,opacity:.8});const b=new THREE.Mesh(g,m);b.userData.outline=false;b.position.z=-100;root.add(b);birds.push(b);
 }
 return {root,update(t){
  uniforms.time.value=t;uniforms.opacity.value=.035+.035*seg(t,4.1,5)+.025*seg(t,9.2,10);
  for(let i=0;i<N;i++){const s=states[i];points[i*3]=((s.x+W/2+t*(6+s.s*7))%W)-W/2;points[i*3+1]=s.y+Math.sin(t*.5+s.p)*12;points[i*3+2]=s.z;}geo.attributes.position.needsUpdate=true;
  mat.opacity=.26+.10*seg(t,4,5)-.14*seg(t,10,12);
  birds.forEach((b,i)=>{b.visible=t>10.8;if(!b.visible)return;const q=t-10.8,flap=Math.sin(Math.floor(t*12)/12*7+i)*9,w=10+i*.8;
   b.position.set(-310+q*55+i*39,145+i*14+Math.sin(q*.7+i)*14,-100);const a=b.geometry.attributes.position;
   a.array.set([0,0,0,-w,flap,0,-4,2,0,0,0,0,w,flap+1,0,4,2,0]);a.needsUpdate=true;
  });
 }};
}
