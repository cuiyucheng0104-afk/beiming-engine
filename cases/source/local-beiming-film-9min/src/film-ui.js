import { PALETTE as P } from './toon.js';
import { clamp,ss } from '../engine/core/math.js';
import { loadFonts } from '../engine/overlay/text.js';
import { loadHUDFonts,drawTitle,setTitleLayout,HUD_T } from './hud.js';
export async function prepareFonts(){
 await loadHUDFonts();
 await loadFonts([['BM Film SC','./fonts/NotoSansSC-film.woff2','300 500']]);
 Object.assign(HUD_T,{titleA:[535,535.65],titleB:[535.65,536.35],subIn:999,subFull:1000});
 setTitleLayout({x:.36,y:.43,size:.24,shade:.7});
}
const fade=(t,a,b)=>ss(clamp((t-a)/.25))*ss(clamp((b-t)/.25));
export function drawFilmUI(ctx,t,W,H,shot,dialogue,eye=null){
 const k=H/1040;
 const text=(s,x,y,sz=28,col=P.hud,align='left')=>{
  ctx.font=`400 ${sz*k}px "BM Film SC",sans-serif`;ctx.textAlign=align;ctx.textBaseline='middle';
  ctx.shadowColor='rgba(24,26,53,.9)';ctx.shadowBlur=7*k;ctx.fillStyle=col;ctx.fillText(s,x*W,y*H);ctx.shadowBlur=0;
 };
 const card=(lines,x,y,width=.27)=>{
  ctx.save();ctx.fillStyle='rgba(25,32,69,.48)';ctx.strokeStyle='rgba(234,246,255,.55)';ctx.lineWidth=k;
  ctx.beginPath();ctx.roundRect(x*W,y*H,width*W,(lines.length*42+24)*k,14*k);ctx.fill();ctx.stroke();
  lines.forEach((line,i)=>text(line,x+.016,y+(34+42*i)*k/H,26));ctx.restore();
 };
 ctx.save();
 // 界面只出现在眼镜第一视角，避免把字幕当成现实里的悬浮招牌。
 const pov=shot.glasses!==false&&['city','sea','eye','reflection','peng'].includes(shot.kind);
 if(pov){
  if((t>=38&&t<44)||(t>=305&&t<316)||(t>=495&&t<504)){
   const a=t<60?[38,44]:t<400?[305,316]:[495,504];ctx.globalAlpha=fade(t,...a);
   card([t<60?'远洋聘书 · 回复截止 06:00':t<400?'距回复截止 · 一小时十二分':'距回复截止 · 四分钟'],.065,.085,.34);ctx.globalAlpha=1;
  }
  if(t>=84&&t<92){
   const x=eye?.x??W*.55,y=eye?.y??H*.45,r=eye?.r??H*.09;
   ctx.save();ctx.globalAlpha=fade(t,84,92);ctx.strokeStyle=P.hudAccent;ctx.lineWidth=1.3*k;
   for(let i=0;i<4;i++){let a=i*Math.PI/2+.1;ctx.beginPath();ctx.arc(x,y,r*1.25,a,a+.35);ctx.stroke();}
   text(t<86.5?'识别中…':'未能识别',(x+r*1.5)/W,y/H,27);ctx.restore();
  }
  if(t>=175&&t<250){
   const a=fade(t,175,250);ctx.save();ctx.globalAlpha=a;ctx.strokeStyle=P.hudAccent;ctx.lineWidth=2*k;ctx.shadowColor=P.hudAccent;ctx.shadowBlur=5*k;
   ctx.beginPath();ctx.moveTo(W*.36,H*.93);ctx.bezierCurveTo(W*.55,H*.72,W*.34,H*.55,W*.73,H*.47);ctx.stroke();ctx.shadowBlur=0;
   card(['导航 · 吴淞口',`${Math.max(2,Math.round(23-(t-175)*.27))} km`],.72,.78,.21);ctx.restore();
  }
  if(t>=486&&t<490){ctx.save();ctx.globalAlpha=fade(t,486.1,490);text('已保存',.91,.1,24,P.hud,'right');ctx.restore();}
  if(t>=510&&t<521){ctx.save();ctx.globalAlpha=fade(t,510,521);card(['回复远洋公司',t<515?'我接受。':'我接受。   已发送'],.66,.18,.27);ctx.restore();}
 }
 const d=dialogue.find(d=>t>=d.start&&t<d.end);
 if(d){
  ctx.save();ctx.globalAlpha=fade(t,d.start,d.end);ctx.font=`400 ${32*k}px "BM Film SC",sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';
  const lines=d.text.length>24?[d.text.slice(0,Math.ceil(d.text.length/2)),d.text.slice(Math.ceil(d.text.length/2))]:[d.text];
  const g=ctx.createLinearGradient(0,H*.83,0,H);g.addColorStop(0,'rgba(20,24,48,0)');g.addColorStop(1,'rgba(20,24,48,.5)');ctx.fillStyle=g;ctx.fillRect(0,H*.83,W,H*.17);
  lines.forEach((line,i)=>{const y=H*.925-(lines.length-1-i)*42*k;ctx.lineJoin='round';ctx.lineWidth=4*k;ctx.strokeStyle='rgba(24,27,50,.8)';ctx.strokeText(line,W/2,y);ctx.fillStyle='#fff4ea';ctx.fillText(line,W/2,y);});
  ctx.restore();
 }
 if(t>=486&&t<486.12){ctx.globalAlpha=(1-(t-486)/.12)*.65;ctx.fillStyle='#FFF4EA';ctx.fillRect(0,0,W,H);ctx.globalAlpha=1;}
 if(t>=535){ctx.fillStyle=`rgba(29,36,69,${.35*ss(clamp((t-535)/1))})`;ctx.fillRect(0,0,W,H);drawTitle(ctx,t,W,H);}
 if(t<1){ctx.fillStyle=`rgba(29,36,69,${1-ss(t)})`;ctx.fillRect(0,0,W,H);}
 if(t>539){ctx.fillStyle=`rgba(29,36,69,${ss(t-539)})`;ctx.fillRect(0,0,W,H);}
 ctx.restore();
}
