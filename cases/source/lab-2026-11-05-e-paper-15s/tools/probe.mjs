import fs from 'fs';
import path from 'path';
import {openFilm,closeServer} from '../engine/render/page.mjs';
const root=path.resolve('.');fs.mkdirSync('out/stills',{recursive:true});
const {browser,page,gpu}=await openFilm(root,{w:1920,h:1040});
if(!/5090/i.test(gpu)||!/Vulkan/i.test(gpu))throw new Error('需要 RTX 5090 / Vulkan，实际 '+gpu);
const ts=process.argv.slice(2).map(Number);const times=ts.length?ts:[0,1.5,2.8,3.8,4.1,4.55,5.3,6.3,6.8,7.4,8.1,9.3,10.4,12.2,14.7];
const states=[];for(const t of times){await page.evaluate(t=>window.render(t),t);await page.screenshot({path:`out/stills/f_${t.toFixed(2)}.jpg`,type:'jpeg',quality:95});states.push(await page.evaluate(()=>window.FRAME_STATE));}
await page.evaluate(()=>window.render(7.4));const first=await page.screenshot({type:'png'});
await page.evaluate(()=>window.render(1.2));await page.evaluate(()=>window.render(7.4));const second=await page.screenshot({type:'png'});
fs.writeFileSync('out/probe.json',JSON.stringify({gpu,repeatExact:first.equals(second),states},null,2));
console.log(JSON.stringify({gpu,repeatExact:first.equals(second),frames:times.length}));
await browser.close();await closeServer();
