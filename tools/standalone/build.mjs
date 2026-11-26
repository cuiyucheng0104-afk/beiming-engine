// 把 WonderX 的网页入口及运行资源打进同一个 HTML。预算按磁盘字节（十进制 MB）核算。
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

async function pack(root) {
  const outDir=path.join(root,'out/standalone');
  const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
  const manifest=await json(path.join(root,'fonts/fonts.json'));
  const styles=path.resolve('engine/style');
  const embedded={film:await json(path.join(root,'film.json')),manifest,styles:{},licenses:[]};
  const registry=await json(path.join(styles,'registry.json'));
  embedded.styles['registry.json']=registry;
  const entry=registry.styles.find(s=>s.id===embedded.film.style.id && s.version===embedded.film.style.version);
  embedded.styles[entry.file]=await json(path.join(styles,entry.file));
  const bill=[];
  async function add(file,mime) {
    const data=await fs.readFile(path.join(root,file));
    if (!data.length || (mime === 'font/woff2' && data.toString('ascii',0,4) !== 'wOF2')) throw new CliError('contract.assets', `无效的 ${file}`);
    embedded[file]=`data:${mime};base64,${data.toString('base64')}`;
    bill.push({file,raw:data.length,inline:Buffer.byteLength(embedded[file])});
  }
  for (const spec of embedded.film.fonts) {
    if (!manifest.fonts.some(f => f.family === spec.family && String(f.weight) === String(spec.weight))) {
      throw new CliError('contract.font', `清单缺少必需字族 ${spec.family}（${spec.weight}）`);
    }
  }
  for(const f of manifest.fonts) await add(`fonts/${f.file}`,'font/woff2');
  for(const file of ['clouds_far','proscenium','paper']) await add(`plates/${file}.webp`,'image/webp');
  for(const name of (await fs.readdir(path.join(root,'fonts'))).filter(n=>n.endsWith('.txt'))) embedded.licenses.push(await fs.readFile(path.join(root,'fonts',name),'utf8'));
  embedded.licenses.push(await fs.readFile('node_modules/three/LICENSE','utf8'));
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
  await fs.writeFile(path.join(root,'out/standalone-size.json'),JSON.stringify({bytes,bill},null,2)+'\n');
  return {bytes,bill};
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
