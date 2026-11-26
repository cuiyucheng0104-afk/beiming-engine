import { canvasLayer } from '../../../engine/stage/plates.js';

const W = 560, H = 402;
const clamp = x => Math.min(1, Math.max(0, x));
const colors = ['#397d84','#b86a4d','#807eb0','#b69a56','#557951','#7795ad'];

export function buildSite() {
  const layers = [canvasLayer(W,H),canvasLayer(W,H)];
  function card(ctx,i,x,y,w,h,photoShift=0,reveal=1,noise=false) {
    ctx.fillStyle = '#22333b'; ctx.fillRect(x,y,w,h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x,y,w,h-25); ctx.clip();
    ctx.globalAlpha = noise ? 1 : reveal;
    const gradient = ctx.createLinearGradient(x,y,x+w,y+h);
    gradient.addColorStop(0,colors[i%colors.length]); gradient.addColorStop(1,'#122432');
    ctx.fillStyle = gradient; ctx.fillRect(x,y,w,h);
    ctx.fillStyle = '#e7c393';
    ctx.beginPath(); ctx.arc(x+w*.68,y+h*.35+photoShift,h*.16,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#11252e';
    ctx.beginPath(); ctx.moveTo(x,y+h); ctx.lineTo(x,y+h*.64+photoShift);
    ctx.lineTo(x+w*.38,y+h*.32+photoShift); ctx.lineTo(x+w*.8,y+h*.8+photoShift);
    ctx.lineTo(x+w,y+h*.54+photoShift); ctx.lineTo(x+w,y+h); ctx.fill();
    if(noise) {
      ctx.fillStyle = '#22333b';
      for(let row=0;row<13;row++) for(let col=0;col<32;col++) {
        const rank = ((col*381 + row*177 + col*row*37)%997)/997;
        if(rank>reveal) ctx.fillRect(x+w*col/32,y+h*row/13,w/32+1,h/13+1);
      }
    }
    ctx.restore();
    ctx.fillStyle = '#e7dcbb'; ctx.font = '13px monospace';
    ctx.fillText(`BEIMING / 0${i+1}`,x+9,y+h-8);
  }
  function section(ctx,n,x,alpha) {
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x,0);
    card(ctx,n,24,76,512,266);
    ctx.restore();
  }
  function text(ctx,label,x,y,size=16,color='#f0d4ab') {
    ctx.fillStyle=color; ctx.font=`bold ${size}px sans-serif`; ctx.fillText(label,x,y);
  }
  function additional(ctx,id,t,b) {
    if(id==='layout' || id==='responsive') {
      const narrow=t>.37, width=narrow ? 314 : 512;
      ctx.strokeStyle='#78a5ad'; ctx.strokeRect(24,69,width,273);
      ctx.save(); ctx.beginPath(); ctx.rect(24,69,width,273); ctx.clip();
      for(let i=0;i<4;i++) {
        const single=narrow&&b;
        card(ctx,i,32+(single ? 0 : i%2*248),77+(single ? i : Math.floor(i/2))*121,single ? 297 : 238,113);
      }
      ctx.restore();
      text(ctx,`${width} px  /  ${b&&narrow?1:2} COL`,24,375,13);
    } else if (id==='parallax' || id==='float' || id==='hover') {
      card(ctx,4,24,79,512,269,b&&id==='parallax' ? 65*(1-t) : 0);
      for(let i=0;i<3;i++){
        const lift=b && id==='float' ? 25*Math.sin(t*6+i) : b&&id==='hover'&&Math.floor(t*3)===i ? -32 : 0;
        const x=39+i*163,y=199+(id==='parallax' ? (b ? 66 : 40)*t : lift);
        if(lift<-10) { ctx.fillStyle='#ecc983'; ctx.fillRect(x-3,y-3,157,113); }
        card(ctx,i,x,y,151,107);
      }
    } else if(id==='loop') {
      const offset = b ? t*640 : Math.min(274,t*640);
      for(let i=0;i<(b?8:4);i++) card(ctx,i%4,28+i*164-offset,105,153,182);
    } else if(id==='loader') {
      card(ctx,1,24,75,512,257,0,b ? 1 : 0);
      if(b) { ctx.fillStyle='#22333b'; ctx.fillRect(24+512*t,75,512*(1-t),232); }
      ctx.fillStyle='#edc994'; ctx.fillRect(24,348,512*(b?t:.08),4);
      text(ctx,b ? `PREVIEW ${Math.floor(t*100)}%` : 'POSTER',24,378,13);
    } else if(id==='modal') {
      card(ctx,0,24,76,251,143); card(ctx,1,285,76,251,143); card(ctx,2,24,228,512,125);
      if(b && t>.2 && t<.84) {
        ctx.fillStyle='#0a141aca'; ctx.fillRect(0,55,W,347);
        card(ctx,1,72,91,416,249);
        text(ctx,'×',450,126,30);
      }
    } else if(id==='tabs') {
      const n=Math.floor(t*3);
      for(let i=0;i<3;i++) {
        ctx.fillStyle=i===n ? '#397d84' : '#22333b'; ctx.fillRect(24+i*172,77,168,32);
        text(ctx,['FILMS','DEMOS','NOTES'][i],36+i*172,99,13);
      }
      for(let i=0;i<(b?1:2);i++) card(ctx,n+i,24+i*260,121,b?512:252,215);
    } else if(id==='accordion') {
      for(let i=0;i<3;i++) {
        const open=b ? i===Math.floor(t*3) : i===0, y=78+i*89;
        ctx.fillStyle='#22333b'; ctx.fillRect(24,y,512,36);
        text(ctx,`0${i+1}  ${['CAMERA','MATERIAL','DELIVERY'][i]}`,37,y+24,15);
        if(b) text(ctx,open?'−':'+',509,y+24,17);
        if(open) text(ctx,'24 FPS / 16:9 / BEIMING ENGINE',38,y+61,13,'#a5d9d7');
      }
    } else {
      const note=id==='note-edit';
      const lines = note ? ['# SHOT 03','- Review the water pass','- Check the far reflection','- Lock the cut']
        : ['THE NORTH SEA','A FIELD GUIDE TO','LIGHT AND WATER'];
      for(let i=0;i<lines.length;i++) {
        const value=note ? lines[i].slice(0,Math.ceil(lines[i].length*clamp(t*1.8+(3-i)*.14))) : lines[i];
        text(ctx,b&&note ? value.replace(/^# /,'').replace(/^- /,'• ') : value,38,122+i*57,b&&i===0?32:21);
      }
      if(!b && !note) {
        ctx.fillStyle='#10212a'; ctx.fillRect(30,83,510,231);
        text(ctx,'THE NORTH SEA A FIELD',38,126,24);
        text(ctx,'GUIDE TO LIGHT AND WATER',38,173,24);
      }
    }
  }
  function panel(ctx,id,t,b) {
    ctx.fillStyle = '#10212a'; ctx.fillRect(0,0,W,H);
    ctx.fillStyle = '#f0d4ab'; ctx.font = 'bold 18px sans-serif';
    ctx.fillText('BEIMING / WORKS',24,38);
    ctx.fillStyle = '#658890'; ctx.fillRect(24,48,512,1);
    if (['layout','responsive','parallax','float','hover','loop','loader','modal','tabs','accordion','breakline','note-edit'].includes(id)) {
      additional(ctx,id,t,b);
    } else if(id === 'split-text') {
      const word = 'BEIMING';
      for(let i=0;i<word.length;i++) {
        const p = b ? clamp((t-i*.075)*2.4) : t;
        ctx.globalAlpha = p; ctx.fillStyle = '#f0d4ab'; ctx.font = 'bold 63px monospace';
        ctx.fillText(word[i],66+i*63,214+(b ? (1-p)*55 : 0));
      }
      ctx.globalAlpha=1;
    } else if(id === 'route-wait' || id === 'route-sync') {
      if(!b) { section(ctx,0,0,1-t); section(ctx,2,0,t); }
      else if(id === 'route-wait') {
        if(t<.5) section(ctx,0,-150*t,1-t*2);
        else section(ctx,2,(1-t)*150,(t-.5)*2);
      } else { section(ctx,0,-W*t,1); section(ctx,2,W*(1-t),1); }
    } else if(id === 'embed') {
      if(b) {
        ctx.strokeStyle='#78bbc1'; ctx.strokeRect(17,65,526,298);
        ctx.fillStyle='#a5d9d7'; ctx.font='13px monospace';
        ctx.fillText('HOST → PREVIEW  /  SCROLL_PROGRESS',29,349);
      }
      card(ctx,3,25,75,510,238,-52*t);
      ctx.fillStyle='#edc994'; ctx.fillRect(26,321,508*t,4);
    } else {
      const scroll = id === 'route-restore' ? (t<.45 ? t*400 : b ? 125 : 0) : t*190;
      let drawn=0;
      ctx.save(); ctx.beginPath(); ctx.rect(24,63,512,291); ctx.clip();
      for(let i=0;i<colors.length;i++) {
        const x=24+(i%2)*260,y=70+Math.floor(i/2)*148-scroll;
        if(b && id==='visibility' && (y>354 || y+132<63)) continue;
        if(b && id==='scroll') {
          ctx.fillStyle='#75c0b3'; ctx.fillRect(x-2,y-2,256,136);
        }
        card(ctx,i,x,y,252,132,b && id==='thumbnail' ? 48*(t-.5) : 0,id==='reveal' ? t : 1,b && id==='reveal');
        drawn++;
      }
      ctx.restore();
      ctx.fillStyle='#9db8bb'; ctx.font='13px monospace';
      ctx.fillText(id==='visibility' ? `DRAW CALLS  ${drawn}` : `SCROLL  ${Math.round(scroll)} PX`,24,381);
    }
  }
  return (id,t) => layers.map(({ctx,tex},i) => {
    panel(ctx,id,t,i===1);
    tex.needsUpdate=true;
    return tex;
  });
}
