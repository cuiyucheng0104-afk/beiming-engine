import fs from 'node:fs/promises';import path from 'node:path';
import {openFilm,closeServer,ROOT} from '../engine/render/page.mjs';import {presets} from '../lab/presets.js';
const args=process.argv.slice(2),arg=(key,def)=>{const i=args.indexOf(key);return i<0?def:args[i+1];};
const scenes=arg('--scenes','04').split(','),tag=arg('--tag','r1'),qa=args.includes('--qa'),pilot=args.includes('--pilot');
const frame=args.includes('--frame'),configs=JSON.parse(await fs.readFile(path.join(ROOT,'scenes.json'),'utf8'));
for(const sid of scenes){let browser;const cfg=configs.find(s=>s.id===sid),w=qa||pilot?1600:2400,h=frame?Math.round(w*cfg.height/cfg.width/2)*2:qa||pilot?1000:1500;
 const dir=path.join(ROOT,'out',(frame?'frame-':'')+(qa?'qa':pilot?'pilot':'renders'),sid,...(qa&&!frame?[tag]:[]));await fs.mkdir(dir,{recursive:true});
 try{const film=await openFilm(path.join(ROOT,frame?'lab/frame':'lab'),{w,h,query:`scene=${sid}&tag=${tag}`});browser=film.browser;
 if(!args.includes('--inspect')&&(!/RTX 5090/.test(film.gpu)||!/Vulkan/i.test(film.gpu)))throw new Error('RTX5090 Vulkan required: '+film.gpu);
 const errors=[];film.page.on('pageerror',e=>errors.push(e.message));film.page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const jobs=qa?(frame?[['A2','front','original'],['A2','front','clay'],['A2','side','clay'],['A2','front','style']]:[['A2','front','original'],['A2','angle','original'],['A2','side','clay'],['A2','back','clay'],['A2','front','style']]):
 (pilot?presets.filter(p=>['A1','A2','A5','D2','G3','H5'].includes(p.id)):presets).map(p=>[p.id,'front','style']);
 const logs=[];for(const [id,v,m] of jobs){const file=qa?`${v}_${m}.png`:`${id}.png`;const start=performance.now();
 await film.page.evaluate(({id,v,m})=>window.setVariant(id,v,m),{id,v,m});await film.page.evaluate(()=>window.render(0));
 await film.page.screenshot({path:path.join(dir,file),type:'png'});logs.push({file,ms:Math.round(performance.now()-start),...await film.page.evaluate(()=>window.info())});console.log(sid,file,logs.at(-1).ms+'ms');}
 if(errors.length)throw new Error(errors.join('\n'));await fs.writeFile(path.join(dir,`render-log-${tag}.json`),JSON.stringify({gpu:film.gpu,size:[w,h],created:new Date().toISOString(),errors,logs},null,2));
 }finally{await browser?.close();}
}
await closeServer();
