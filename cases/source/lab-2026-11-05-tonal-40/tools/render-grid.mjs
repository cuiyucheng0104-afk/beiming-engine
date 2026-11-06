import fs from 'node:fs/promises';
import path from 'node:path';
import {openFilm,closeServer,ROOT} from '../engine/render/page.mjs';
import {presets} from '../lab/presets.js';
const test=process.argv.includes('--pilot'),qa=process.argv.includes('--qa'),detail=process.argv.includes('--detail'),probe=process.argv.includes('--probe');
const width=test?1600:2400,height=test?900:1350;
const dir=path.join(ROOT,'out',probe?'probe':qa?'qa':test?'pilot':detail?'detail':'renders');await fs.mkdir(dir,{recursive:true});
let browser;
try{
 const film=await openFilm(path.join(ROOT,probe?'lab/probe':'lab'),{w:width,h:height});browser=film.browser;
 if(!/RTX 5090/.test(film.gpu)||! /Vulkan/i.test(film.gpu))throw new Error('Required RTX 5090 Vulkan renderer, got: '+film.gpu);
 const errors=[];film.page.on('pageerror',e=>errors.push(e.message));film.page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const chosen=probe?presets.slice(0,5):test?presets.filter(p=>['A1','A2','A5','D2','G2','H3'].includes(p.id)):presets;
 const logs=[];console.log('GPU',film.gpu);
 const jobs=qa?[['A2','wide',true],['A2','side',true],['A2','back',true],['A2','detail',false]]:chosen.map(p=>[p.id,detail?'detail':'wide',false]);
 for(const [id,view,clay] of jobs){const start=performance.now();await film.page.evaluate(({id,view,clay})=>window.setVariant(id,view,clay),{id,view,clay});
  // 第二遍确定反射/阴影全部更新，并使用无损截图。
  await film.page.evaluate(()=>window.render(0));
  const file=`${id}${qa?'_'+view+(clay?'_clay':''):''}.png`;await film.page.screenshot({path:path.join(dir,file),type:'png'});
  const info=await film.page.evaluate(()=>window.info());logs.push({id,view,clay,file,ms:Math.round(performance.now()-start),...info});console.log(file,logs.at(-1).ms+'ms');
 }
 if(errors.length)throw new Error(errors.join('\n'));
 await fs.writeFile(path.join(dir,'render-log.json'),JSON.stringify({gpu:film.gpu,createdAt:new Date().toISOString(),size:[width,height],logs,errors},null,2));
}finally{await browser?.close();await closeServer();}
