// 把 WonderX 的网页入口及运行资源打进同一个 HTML。预算按磁盘字节（十进制 MB）核算。
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

import { CliError, defineCommand, isMain, runCli } from '../lib/cli.mjs';

export const isFilmEntry = (id, entry) => id.replaceAll('\\', '/') === entry.replaceAll('\\', '/');

export function checkEmbedded(html, embedded) {
  if (!html.includes('window.__WX_ASSETS=') || !embedded.manifest.fonts.length ||
      !Object.values(embedded).filter(v => typeof v === 'string').every(uri => html.includes(uri))) {
    throw new CliError('contract.assets', '终包缺少内联资源或字体');
  }
}

export function verifyAssetIntegrity(data, expected, label) {
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (expected?.bytes != null && data.length !== expected.bytes) {
    throw new CliError('contract.assets', `${label} 字节数不符：期望 ${expected.bytes}，实测 ${data.length}`);
  }
  if (expected?.sha256 && sha256 !== expected.sha256) {
    throw new CliError('contract.assets', `${label} SHA-256 不符：期望 ${expected.sha256}，实测 ${sha256}`);
  }
  return sha256;
}

async function pack(root) {
  const outDir=path.join(root,'out/standalone');
  const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
  const manifest=await json(path.join(root,'fonts/fonts.json'));
  const styles=path.resolve('engine/style');
  const film=await json(path.join(root,'film.json'));
  const cfg=film.standalone??{};
  const embedded={film,manifest,styles:{},licenses:[]};
  const registry=await json(path.join(styles,'registry.json'));
  embedded.styles['registry.json']=registry;
  const entry=registry.styles.find(s=>s.id===embedded.film.style.id && s.version===embedded.film.style.version);
  embedded.styles[entry.file]=await json(path.join(styles,entry.file));
  const bill=[];
  async function add(file,mime,kind='asset',key=file,expected=null) {
    const abs=path.isAbsolute(file)?file:path.join(root,file);
    const data=await fs.readFile(abs);
    if (!data.length || (mime === 'font/woff2' && data.toString('ascii',0,4) !== 'wOF2')) throw new CliError('contract.assets', `无效的 ${file}`);
    const sha256=verifyAssetIntegrity(data,expected,key);
    embedded[key]=`data:${mime};base64,${data.toString('base64')}`;
    bill.push({file:key,kind,raw:data.length,inline:Buffer.byteLength(embedded[key]),sha256});
  }
  for (const spec of embedded.film.fonts) {
    if (!manifest.fonts.some(f => f.family === spec.family && String(f.weight) === String(spec.weight))) {
      throw new CliError('contract.font', `清单缺少必需字族 ${spec.family}（${spec.weight}）`);
    }
  }
  for(const f of manifest.fonts) await add(`fonts/${f.file}`,'font/woff2','font');
  const plates=Array.isArray(cfg.plates)?cfg.plates:['plates/clouds_far.webp','plates/proscenium.webp','plates/paper.webp'];
  for(const file of plates) await add(file,'image/webp','plate');
  if (cfg.audioManifest) {
    const audioManifest=await json(path.join(root,cfg.audioManifest));
    embedded.audioManifest=audioManifest;
    const baseDir=path.dirname(path.join(root,cfg.audioManifest));
    for(const item of audioManifest.assets??[]) {
      await add(path.join(baseDir,item.file),item.mime||'audio/ogg',item.kind||'audio',item.key,{bytes:item.bytes,sha256:item.sha256});
    }
  }
  if (cfg.provenance) {
    embedded.provenance=await json(path.join(root,cfg.provenance));
  }
  for(const name of (await fs.readdir(path.join(root,'fonts'))).filter(n=>n.endsWith('.txt'))) embedded.licenses.push({name,text:await fs.readFile(path.join(root,'fonts',name),'utf8')});
  embedded.licenses.push({name:'three-0.170.0-LICENSE',text:await fs.readFile('node_modules/three/LICENSE','utf8')});
  for(const lic of cfg.extraLicenses??[]) {
    const spec=typeof lic==='string'?{path:lic}:lic;
    const abs=spec.path.startsWith('repo:')?path.resolve(spec.path.slice(5)):path.join(root,spec.path);
    const data=await fs.readFile(abs);
    const name=spec.name||path.basename(abs);
    verifyAssetIntegrity(data,spec.sha256?{sha256:spec.sha256}:null,name);
    embedded.licenses.push({name,text:data.toString('utf8')});
  }
  const three=await json('node_modules/three/package.json');
  if(three.version!=='0.170.0') throw Error(`需要 three 0.170.0，当前为 ${three.version}`);
  await build({root,logLevel:'silent',configFile:false,base:'./',publicDir:false,plugins:[{
    name:'offline-assets',transformIndexHtml:{order:'pre',handler:html=>html.replace(/<script type="importmap">[\s\S]*?<\/script>/,'')},
    transform(code,id){if(isFilmEntry(id,path.join(root,'main.js'))) return `window.__WX_ASSETS=${JSON.stringify(embedded).replaceAll('<','\\u003c')};\n${code}`;},
  },viteSingleFile()],build:{target:'es2022',outDir,emptyOutDir:false,modulePreload:false,assetsInlineLimit:Infinity,license:false}});
  const html=await fs.readFile(path.join(outDir,'index.html'),'utf8');
  checkEmbedded(html, embedded);
  if (!/<meta charset="utf-8">/i.test(html.slice(0, 1024))) throw new CliError('contract.encoding', '离线 HTML 的前 1024 字节缺 UTF-8 声明');
  if(/<(?:script|link|img|video|iframe)\b[^>]*\s(?:src|href)=["'](?!data:)/i.test(html)||/<video\b|data:video\/mp4/i.test(html)) throw new CliError('contract.offline','单文件依赖检查失败');
  const bytes=Buffer.byteLength(html); if(bytes>5500000) throw new CliError('contract.size',`超过 5.5 MB 硬顶，文件 ${bytes} B`);
  const sha256=createHash('sha256').update(html,'utf8').digest('hex');
  const byKind={};
  for(const item of bill) {
    byKind[item.kind]??={count:0,raw:0,inline:0};
    byKind[item.kind].count++; byKind[item.kind].raw+=item.raw; byKind[item.kind].inline+=item.inline;
  }
  const inlineAssetsBytes=bill.reduce((a,b)=>a+b.inline,0);
  const licensesBytes=Buffer.byteLength(JSON.stringify(embedded.licenses));
  const summary={bytes,sha256,hardCapBytes:5500000,targetRangeBytes:[3100000,3600000],codeAndRuntimeBytes:bytes-inlineAssetsBytes-licensesBytes,licensesBytes,inlineAssetsBytes,byKind,bill};
  await fs.writeFile(path.join(root,'out/standalone-size.json'),JSON.stringify(summary,null,2)+'\n');
  return summary;
}

export const command=defineCommand({
  name:'standalone:build',summary:'把 WonderX 网页、字体、底板与许可打成可离线打开的单文件 HTML',
  usage:['npm run standalone:build -- films/wonderx-m0'],
  positionals:[{name:'film',label:'<作品目录>',describe:'WonderX 作品目录'}],
  async run(ctx) {
    const data=await pack(path.resolve(ctx.args.film));
    ctx.out(`单文件 ${data.bytes} B，资源明细在 ${ctx.args.film}/out/standalone-size.json`);
    return {data};
  },
});
if(isMain(import.meta.url)) await runCli(command);
