import {chromium} from 'playwright-core';import {fileURLToPath,pathToFileURL} from 'node:url';import path from 'node:path';import fs from 'node:fs/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=await chromium.launch({executablePath:process.env.BEIMING_CHROME||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.join(root,'delivery/index.html')).href);await page.waitForFunction(()=>document.querySelectorAll('.card').length===40);
 const initial=await page.locator('.card').count();
 await page.locator('.heart').first().click();await page.check('#onlyFav');if(await page.locator('.card').count()!==1)throw Error('favorite filter');
 const downloadWait=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadWait;if(!download.suggestedFilename().endsWith('.txt'))throw Error('favorite export');
 await page.locator('.heart').first().click();await page.uncheck('#onlyFav');
 await page.selectOption('#palette','D');if(await page.locator('.card').count()!==5)throw Error('palette filter');
 await page.selectOption('#profile','3');if(await page.locator('.card').count()!==1)throw Error('profile filter');
 await page.locator('.card img').click();if(!await page.locator('#modal').isVisible())throw Error('modal');await page.locator('#toCompare').click();
 if(await page.locator('#selA').inputValue()!=='D3')throw Error('compare selection');
 await page.check('#detail');await page.waitForFunction(()=>document.querySelector('#front').complete&&document.querySelector('#front').naturalWidth===2400);
 await page.locator('#slider').fill('37');await page.locator('#slider').dispatchEvent('input');
 if(!(await page.locator('#front').getAttribute('style')).includes('63%'))throw Error('slider');
 await page.selectOption('#palette','');await page.selectOption('#profile','');await page.evaluate(()=>scrollTo(0,0));
 await page.waitForFunction(()=>[...document.querySelectorAll('.card img')].slice(0,3).every(i=>i.complete&&i.naturalWidth>0));
 const broken=await page.evaluate(()=>[...document.images].filter(i=>i.complete&&i.naturalWidth===0).map(i=>i.src));if(broken.length||errors.length)throw Error(JSON.stringify({errors,broken}));
 await page.screenshot({path:path.join(root,'out/qa/gallery.png')});
 await fs.writeFile(path.join(root,'delivery/gallery-check.json'),JSON.stringify({cards:initial,filters:true,favorites:true,export:true,modal:true,compare:true,slider:true,errors,broken},null,2));
 console.log('40 cards; filters/favorites/export/modal/compare/slider passed; no broken loaded images or JS errors');
}finally{await browser.close();}
