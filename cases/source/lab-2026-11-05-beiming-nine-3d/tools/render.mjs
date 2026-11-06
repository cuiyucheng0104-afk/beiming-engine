import fs from 'node:fs/promises';import path from 'node:path';
import {openFilm,closeServer,ROOT} from '../engine/render/page.mjs';
const args=process.argv.slice(2),arg=(k,d)=>{let i=args.indexOf(k);return i<0?d:args[i+1];};
const scenes=arg('--scenes','01,02,03,04,05,06,07,08,09').split(','),pilot=args.includes('--pilot'),qa=args.includes('--qa'),tag=arg('--tag','r1');
const [w,h]=(arg('--size',pilot?'1600x900':qa?'1920x1080':'3840x2160')).split('x').map(Number);
try{for(const sid of scenes){let browser;try{
 const f=await openFilm(path.join(ROOT,'lab'),{w,h,query:'scene='+sid});browser=f.browser;
 if(!args.includes('--local')&&(!/RTX 5090/.test(f.gpu)||!/Vulkan/i.test(f.gpu)))throw Error('RTX 5090 Vulkan required: '+f.gpu);
 const dir=path.join(ROOT,'out',qa?'qa':pilot?'pilot':'final',tag);await fs.mkdir(dir,{recursive:true});const logs=[];
 for(const view of qa?['clay','angle']:['hero']){let start=performance.now();await f.page.evaluate(v=>window.setView(v),view);await f.page.evaluate(()=>window.render(0));const name=sid+'_'+view+'.png';await f.page.screenshot({path:path.join(dir,name),type:'png'});logs.push({name,ms:Math.round(performance.now()-start),...await f.page.evaluate(()=>window.info())});console.log(sid,view,logs.at(-1).faces+' faces',logs.at(-1).ms+'ms');}
 await fs.writeFile(path.join(dir,sid+'_log.json'),JSON.stringify({gpu:f.gpu,size:[w,h],created:new Date().toISOString(),logs},null,2));
 }finally{await browser?.close();}}}finally{await closeServer();}
