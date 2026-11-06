import fs from 'node:fs';import {openFilm,closeServer} from '../engine/render/page.mjs';
const {page,browser}=await openFilm('.',{w:3840,h:2080});
try{
 for(const t of [515.5,519.8,520.1,522.75]){
  const state=await page.evaluate(t=>{window.render(t);const c=document.querySelectorAll('canvas')[1],g=c.getContext('2d');const p=g.getImageData(1300*2,215*2,1,1);return{t,shot:window.activeShot().id,pixel:[...p.data],transform:[g.getTransform().a,g.getTransform().d]};},t);
  console.log(state);await page.screenshot({path:`out/overlay-${t}.jpg`,type:'jpeg',quality:94});
 }
}finally{await browser.close();await closeServer();}
