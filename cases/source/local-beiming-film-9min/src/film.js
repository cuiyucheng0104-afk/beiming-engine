import { createFilm } from '../engine/stage/film.js';
import { createLook } from './look.js';
import { loadPlates } from '../engine/stage/plates.js';
import { buildShotC } from './shotC.js';
import { buildWorld } from './world.js';
import { SHOTS } from './storyboard.js';
import { prepareFonts,drawFilmUI } from './film-ui.js';

const q=new URLSearchParams(location.search);
const film=createFilm({designHeight:1040});
const {W,H,K,DW,DH}=film;
const look=createLook(film.renderer,W,H,{ss:2,msaa:4,paperUrl:'./assets/plates/paper.png'});
const names=['sky_dawn','sky_tall','shotB_sky','clouds_back','clouds_front_a','clouds_front_b','skyline_pudong','skyline_pudong_reflect','skyline_bund','river','mist_low'];
const [{tex},dialogue,lips]=await Promise.all([loadPlates(names),fetch('./audio/dialogue.json').then(r=>r.json()),fetch('./audio/lips.json').then(r=>r.json()),prepareFonts()]);
const world=buildWorld({W:DW,H:DH,K,tex,dialogue,lips});
const eye=buildShotC({W:DW,H:DH,tex,q:new URLSearchParams()});
let active=SHOTS[0],eyeState=null;
function wrapper(s){
 const isEye=s.kind==='eye';
 return {
  scene:isEye?eye.scene:world.scene,camera:isEye?eye.camera:world.camera,
  update(t,f){
   active=s;eyeState=null;
   if(isEye){
    const u=(t-s.start)/(s.end-s.start);
    const virtual=5.1+u*(s.scene===3?1.35:s.scene===12?2.4:1.0);
    eye.update(virtual,Math.round(virtual*24));
    // 角色摆动仍按真实播放时间一拍三；摄影机的缓动不被拉成定格。
    eye.kun.setPose(Math.floor(t*8)/8,{look:eye.camera.position});
    eyeState=eye.hudState.eye;
   }else world.update(s.id==='S074'?486:t,s.id==='S074'?486*24:f,s);
  },
  look(t){return isEye?{...eye.look(5.8),t}:world.look(t,s);}
 };
}
const shots=SHOTS.map(s=>({at:s.start,shot:wrapper(s)}));
await film.run({dur:540,post:look,shots,warm:[2,56,74,201,391,470,535],
 draw:(ctx,t)=>{
  const pe=eyeState&&{x:eyeState.x*K,y:eyeState.y*K,r:eyeState.r*K};
  drawFilmUI(ctx,t,W,H,active,dialogue,pe);
 },texts:t=>dialogue.filter(d=>t>=d.start&&t<d.end).map(d=>({text:d.text,start:d.start,end:d.end}))
});
window.SHOTS=SHOTS;window.activeShot=()=>active;window.STYLE_LOCK='original-beiming-10s';
