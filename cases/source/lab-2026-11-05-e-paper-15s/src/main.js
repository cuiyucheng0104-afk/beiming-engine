import * as THREE from 'three';
import {createFilm} from '../engine/stage/film.js';
import {createLook,LOOK_BASE} from '../engine/look/index.js';
import {createBackground} from './background.js';
import {createHero,createLoosePaper} from './hero.js';
import {createAtmosphere} from './atmosphere.js';
import {E,LOOK,seg,mix,poseTime,TIMELINE} from './style.js';

const film=createFilm({designHeight:1040,shadows:false});const {DW:W,DH:H}=film;
// Film overrides are partial; retain the engine's required edge/depth fields.
const defaults={...LOOK_BASE,...LOOK};
for(const k of ['outline','kuwahara','bloom','grade','paper'])defaults[k]={...LOOK_BASE[k],...LOOK[k]};
const post=createLook(film.renderer,film.W,film.H,{ss:1.5,msaa:4,defaults,paperUrl:'./assets/plates/paper.png'});
const scene=new THREE.Scene();scene.background=new THREE.Color(E.ink);
const camera=new THREE.OrthographicCamera(-W/2,W/2,H/2,-H/2,1,5000);camera.position.z=1800;camera.lookAt(0,0,0);
const bg=await createBackground(W,H);scene.add(bg.mesh);
const hero=createHero();scene.add(hero.group);
const atmosphere=createAtmosphere(W,H);scene.add(atmosphere.root);
const scraps=Array.from({length:28},(_,i)=>createLoosePaper(1900+i));scraps.forEach(s=>scene.add(s.obj));
const light=new THREE.DirectionalLight(E.light,1);light.position.set(-500,700,1200);scene.add(light);
const put=(g,x,y,z)=>g.position.set((x-.5)*W,(.5-y)*H,z);

function update(t){
 bg.update(t);hero.update(t);atmosphere.update(t);const ts=poseTime(t);
 let x,y,s,rx,ry,rz;
 if(t<3.6){
  const lift=seg(t,.6,2.1),run=seg(t,1.8,3.6);x=.50+.05*lift+.09*run;y=.68-.21*lift-.08*run;
  s=175+95*lift+70*run;rx=-1.0+1.3*lift+.2*Math.sin(ts*2);ry=.10+lift*.23*Math.sin(ts*2.2);rz=-.14+.16*Math.sin(ts*2.4)*lift;
 }else if(t<4.65){
  const a=seg(t,3.6,4.03),b=seg(t,4.25,4.65);x=mix(.64,.5,a)+.02*b;y=mix(.39,.5,a)-.06*b;
  s=mix(340,3400,a)*(1-b)+310*b;rx=mix(.12,0,a)+.12*b;ry=.04;rz=.12*(1-a)+.05*b;
 }else if(t<8.2){
  const q=seg(t,4.65,6.1),fold=seg(t,6.1,8.2);x=.52-.08*Math.sin(q*Math.PI)+.02*fold;y=.44+.055*Math.sin(q*Math.PI)-.01*fold;
  s=310+60*q-60*fold;rx=.12*(1-fold)+.12*Math.sin(ts*1.4)*(1-fold);ry=.26*Math.sin(ts*1.8)*(1-fold);rz=.12*Math.sin(ts*1.2)-.16*fold;
 }else if(t<10.2){
  const q=seg(t,8.2,10.2);x=.54+.12*q;y=.43-.06*q;s=310-32*q;rx=0;ry=0;rz=-.16+.12*Math.sin(ts*1.8);
 }else{
  const q=seg(t,10.2,15);x=.66+.10*q;y=.37-.12*q;s=278*(1-q)+35*q;rx=0;ry=-.15*q;rz=.08*Math.sin(ts*1.6);
 }
 put(hero.group,x,y,100);hero.group.scale.setScalar(s);hero.group.rotation.set(rx,ry,rz);
 scraps.forEach((p,i)=>{
  const birth=4.05+i*.027,pop=seg(t,birth,birth+.8),away=seg(t,8.2,10.7),alpha=pop*(1-away);
  p.obj.visible=alpha>.001;if(!p.obj.visible)return;p.update(t);
  const a=p.phase+(t-4.2)*(.42+.12*p.rad),rad=(.12+p.rad*.28)*(1+away*1.2);
  put(p.obj,.50+Math.cos(a)*rad,.46+Math.sin(a)*rad*.64,20+Math.sin(a)*250);
  p.obj.scale.setScalar((25+40*p.rad)*pop);p.obj.rotation.set(Math.sin(ts*2+p.phase)*.7,ts*.8+p.phase,a*.5);
 });
 window.FRAME_STATE={t,shot:t<4.1?'书案':t<9.4?'楼阁':'江山',hero:{x,y,size:s},palette:'E 朱砂玄墨',fold:seg(t,6.15,7.95)};
}
const debug=new URLSearchParams(location.search).get('debug');
const shot={scene,camera,update,look:t=>({...LOOK,t,...(debug?{debug}:{})})};
await film.run({dur:TIMELINE.duration,fps:24,shots:[{at:0,shot}],post,warm:[0,2.5,4.1,5,7.3,8.1,10.5,14.8]});
window.EV=[{t:1.2,type:'paper-lift'},{t:3.85,type:'page'},{t:6.25,type:'fold'},{t:6.85,type:'fold'},{t:7.5,type:'fold'},{t:8.2,type:'wing'},{t:9.2,type:'wind-reveal'}];
