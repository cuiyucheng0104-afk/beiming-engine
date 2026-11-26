import * as THREE from 'three';
import { pageTiming } from '../../engine/production/timeline.js';
import { createLook } from '../../engine/look/index.js';
import { DARK_STAGE } from '../../engine/look/stage.js';
import { loadFilmFonts } from '../../engine/style/fonts.js';
import { loadStyle, resolveLook, setStyleJsonLoader } from '../../engine/style/index.js';
import { createDeck, createDeckModel, TIER_CONFIGS } from '../../engine/stage/deck.js';
import { createDeckAudio } from '../../engine/stage/deck-audio.js';
import { renderDeckStems, renderVoChime } from '../../engine/stage/deck-synth.js';
import { createDeckUI } from '../../engine/stage/deck-ui.js';
import { extractGlyphStrokes } from '../../engine/overlay/skeleton.js';
import { buildBrushGlyph } from '../../engine/overlay/brush.js';
import { createWorld } from './world.js';

async function boot() {
  const embedded = window.__WX_ASSETS;
  const asset = p => embedded ? embedded[p] : new URL(p, document.baseURI).href;
  const film = embedded?.film ?? await (await fetch(asset('film.json'))).json();
  if (embedded) setStyleJsonLoader(name => embedded.styles[name]);
  const timing = pageTiming(film), style = await loadStyle(film.style);
  const fonts = await loadFilmFonts(new URL('fonts/',document.baseURI), embedded ? {manifest:embedded.manifest,resolve:name=>asset(`fonts/${name}`)} : {});
  for (const text of film.texts) fonts.assert(text.font,text.text,text.id);
  const textures = {};
  await Promise.all(['clouds_far','proscenium','paper'].map(async name => {
    const tex = await new THREE.TextureLoader().loadAsync(asset(`plates/${name}.webp`));
    tex.colorSpace = name==='paper' ? THREE.NoColorSpace : THREE.SRGBColorSpace; textures[name] = tex;
  }));
  const stage=document.querySelector('#stage'), overlay=document.querySelector('#label'), status=document.querySelector('#status');
  const renderer=new THREE.WebGLRenderer({canvas:stage,antialias:false,preserveDrawingBuffer:true});
  renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  const world=createWorld(textures), preset=resolveLook(style,'wide'), ctx=overlay.getContext('2d');
  const model=createDeckModel({shots:film.shots,events:film.events,fps:timing.fps,dur:timing.DUR});
  const spec=new Map(film.shots.map(s=>[s.id,s])), copy=new Map(film.texts.map(x=>[x.id,x]));
  let look, lastTier, lastW, lastH, rows=[], lost=false;
  function size(tier) {
    const root=stage.parentElement, cfg=TIER_CONFIGS[tier];
    const w=window.__RENDER?.width ?? Math.max(2,Math.min(1920,Math.round(root.clientWidth)));
    const h=window.__RENDER?.height ?? Math.round(w*9/16);
    if (tier===lastTier && w===lastW && h===lastH) return;
    renderer.shadowMap.enabled=tier!=='minimal';
    const rw=Math.max(2,Math.round(w*cfg.renderScale)), rh=Math.max(2,Math.round(h*cfg.renderScale));
    renderer.setSize(rw,rh,false);
    if (!look || TIER_CONFIGS[lastTier].ss!==cfg.ss || TIER_CONFIGS[lastTier].msaa!==cfg.msaa) {
      look?.dispose(); look=createLook(renderer,rw,rh,{ss:cfg.ss,msaa:cfg.msaa,defaults:preset.defaults,fps:timing.fps});
    } else look.setSize(rw,rh);
    overlay.width=w; overlay.height=h; lastTier=tier; lastW=w; lastH=h;
  }
  function write(text,x,y,px,font,color='#f4f0e6',weight=400,id='label') {
    ctx.font=`${weight} ${px}px "${font}"`; ctx.fillStyle=color; ctx.fillText(text,x,y);
    const scale=overlay.width/1920, box=[x*scale,(y-px)*scale,ctx.measureText(text).width*scale,px*1.23*scale];
    rows.push({id,text,font,box,x0:box[0],y0:box[1],x1:box[0]+box[2],y1:box[1]+box[3],alpha:1});
  }
  function render(t, input={}) {
    if(lost) return;
    const tier=input.tier ?? 'full',cfg=TIER_CONFIGS[tier]; size(tier);
    const {shot:id,localFrame}=timing.at(t), shot=spec.get(id), progress=localFrame/(shot.out-shot.in);
    const p=input.pointer ?? [.5,.5];
    const st=world.update(id,progress,p,cfg);
    const params={...preset.params,...DARK_STAGE,t,stage:st,fog:false,outline:cfg.outline?{width:cfg.outline,opacity:.8}:false,
      kuwahara:cfg.kuwaharaRadius?{radius:cfg.kuwaharaRadius,farRadius:cfg.kuwaharaRadius,strength:cfg.kuwaharaStrength}:false,
      bloom:cfg.bloom?DARK_STAGE.bloom:false,paper:{tex:textures.paper,mid:.56,strength:.14},grain:.015};
    look.render(world.scene,world.camera,params);
    ctx.setTransform(overlay.width/1920,0,0,overlay.height/1080,0,0);ctx.clearRect(0,0,1920,1080); rows=[];
    const split=Math.max(0,Math.min(1,input.split??.5))*1920;
    if(id==='A10') {
      ctx.save();ctx.beginPath();ctx.rect(0,0,split,1080);ctx.clip();ctx.fillStyle='#f4f0e6';ctx.fillRect(0,0,1920,1080);
      write('产品升级汇报',72,230,66,'WX Text','#232324');
      ['研发周期   18周','交付质量   96%','服务覆盖   32城'].forEach((v,i)=>write(v,83,395+i*104,46,'WX Text','#38383c'));
      ctx.restore();ctx.fillStyle='#d2452c';ctx.fillRect(split-3,0,6,1080);ctx.fillRect(split-18,509,36,62);
      write('18周   96%   32城',Math.max(split+30,1040),850,65,'WX Text');
    } else {
      const x=88; ctx.shadowColor='#08080a';ctx.shadowBlur=9;
      write('WONDERX / LIVE STAGE',x,766,23,'WX Sans','#f4f0e6',500,'studio');
      write(`ACT ${id.slice(1)}`,x,823,52,'WX Display','#ffc46b',900,'act-label');
      for(const [suffix,y,sz] of [['title',913,76],['quote',970,30]]){
        const v=copy.get(`${id}-${suffix}`);write(v.text,x,y,sz,v.font,'#f4f0e6',suffix==='title'?700:400,v.id);
      }
      ctx.shadowBlur=0;
    }
  }
  const audio=createDeckAudio();
  const ui=createDeckUI({model},audio,{fonts:{sans:'"WX Text", sans-serif',serif:'"WX Serif", serif'}});
  const deck=createDeck({root:stage.parentElement,model,audio,ui,onRender:render});
  const bench=new URLSearchParams(location.search).has('bench'), interactive=!bench&&!window.__RENDER;
  if(!interactive) ui.el.style.display='none';
  async function prepareAudio(){
    const stems=await renderDeckStems({sampleRate:24000});
    for(const [key,name] of [['pad','和声'],['pulse','脉冲'],['lead','主奏']]) audio.setStem(key,{name,buffer:stems[key]});
    const chime=await renderVoChime({sampleRate:24000});audio.setVoCues(timing.shots.map(s=>({at:s.t0,buffer:chime})));
  }
  if(interactive) window.addEventListener('pointerdown',()=>audio.ensureContext(),{once:true});
  stage.addEventListener('webglcontextlost',e=>{e.preventDefault();lost=true;deck.stop();status.textContent='正在恢复画面…';});
  stage.addEventListener('webglcontextrestored',()=>{look?.dispose();look=null;lastTier=null;lost=false;render(model.getSnapshot().time);status.textContent='';if(interactive) deck.start();});
  Object.assign(window,{render,TIMELINE:timing,DUR:timing.DUR,FPS:timing.fps,TEXTS:t=>{render(t);return rows;}});
  if(bench) window.__BENCH={model,renderer,world,deck,audio,prepareAudio,checkBrush(){
    const missing = [], seen = new Set();
    let tested = 0;
    for (const face of film.fonts) {
      const text = film.texts.filter(row => row.font === face.family).map(row => row.text).join('') + (face.extra ?? '');
      const font = `${face.weight} 48px "${face.family}"`;
      for (const ch of new Set(text)) {
        if (!/\p{Script=Han}/u.test(ch)) continue;
        fonts.assert(face.family, ch);
        seen.add(ch);
        tested++;
        const { strokes } = extractGlyphStrokes(ch, { font, size: 48 });
        if (!strokes.length || !buildBrushGlyph(ch, { font, size: 48, strokes, span: [0, 1] }).idx.length) {
          missing.push({ family: face.family, ch });
        }
      }
    }
    if (!seen.size) throw Error('笔画检查没有遍历到脚本汉字');
    return { han: seen.size, tested, missing };
  },get rows(){return rows;},get restored(){return !lost;}};
  render(0);status.textContent='';window.READY=true;
  if(interactive){deck.start();prepareAudio().catch(err=>ui.toast(err.message));}
}
boot().catch(err=>{document.querySelector('#status').textContent=err.message;console.error(err);});
