import * as THREE from 'three';
import { createKun } from './kun.js';
import { createFerry,createWake } from './ferry.js';
import { createPeng,createFeatherSwarm } from './peng.js';
import { drawActor } from './actors.js';
import { drawBirds } from './birds.js';
import { PALETTE as P,setToonGlobals } from './toon.js';
import { wideLook,actorLook,heroLook } from './locked-look.js';
import { plate,plateCopy,canvasLayer,cutoutPlane,glowSprite } from '../engine/stage/plates.js';
import { aimCamera,placeOnScreen,screenToWorld,fillScreen,project } from '../engine/stage/camera.js';
import { wireOutlines } from '../engine/stage/outline.js';
import { clamp,lerp,ss,mulberry,DEG } from '../engine/core/math.js';

const ACTORS=new Set(['profile','helm','rope','radio','switch','glasses','shell','title']);
const sat=(x,a,b)=>ss(clamp((x-a)/(b-a)));
export function buildWorld({W,H,K,tex,dialogue=[],lips={}}) {
 const scene=new THREE.Scene();scene.fog=new THREE.FogExp2('#A99BD9',0.000195);
 const camera=new THREE.PerspectiveCamera(16,W/H,1,40000);
 const origin=new THREE.Vector3(0,33,0),keyDir=new THREE.Vector3(-.72,.12,-.68).normalize();
 aimCamera(camera,origin,0,1.4*DEG);
 const layers={};
 function layer(n,map,order,opacity=1){ const m=plate(map,order,{opacity});layers[n]=m;scene.add(m);return m; }
 layer('sky',tex.sky_dawn,0);layer('back',tex.clouds_back,1);
 layer('city',tex.skyline_pudong,3);layer('river',tex.river,4);
 const reflTex=plateCopy(tex.skyline_pudong_reflect);layer('reflect',reflTex,4.5,.92);
 const mistTex=plateCopy(tex.mist_low,{wrap:true});layer('mist',mistTex,5,.72);mistTex.repeat.x=2.2;
 layer('shore',tex.skyline_bund,6);
 layer('frontA',tex.clouds_front_a,6.6);layer('frontB',tex.clouds_front_b,6.7);
 const key=new THREE.DirectionalLight('#ffd3b0',1);scene.add(key,key.target);
 const kun=createKun({lod:.72,wisps:false,blinkPeriod:5.7,blinkOffset:1.5});
 wireOutlines(kun.group,{alpha:1});scene.add(kun.group);
 const peng=createPeng({lod:1});wireOutlines(peng.group,{alpha:1});scene.add(peng.group);
 const feathers=createFeatherSwarm({count:180,seed:713});scene.add(feathers.group);
 const ferry=createFerry();wireOutlines(ferry.group,{alpha:1});scene.add(ferry.group);
 const cabinWindows=ferry.group.children.find(o=>o.isGroup);
 const wake=createWake();wake.renderOrder=5.2;scene.add(wake);
 const sun=glowSprite(P.apricot,{order:2.6,amt:.22,core:1.2,squash:1.6});scene.add(sun);
 const art=canvasLayer(Math.round(W*K),Math.round(H*K));
 const front=cutoutPlane(art.tex,{order:12,cut:.5});scene.add(front);
 const refs={kun, peng, ferry};
 const rng=mulberry(91122),ripples=Array.from({length:90},()=>({x:rng(),y:rng(),s:rng(),p:rng()*7}));
 let current=null,lastActorKey='';

 function pos(mesh,x,y,width,depth,height){placeOnScreen(mesh,camera,W,H,x,y,width,depth,height);}
 function placeModel(obj,x,y,depth,scale){ obj.position.copy(screenToWorld(camera,W,H,x,y,depth)); obj.scale.setScalar(scale); }
 function update(t,f,shot){
  current=shot; const local=t-shot.start,dur=shot.end-shot.start,u=clamp(local/dur),e=ss(u);
  const close=ACTORS.has(shot.kind), sea=shot.kind==='sea'||shot.kind==='peng'||shot.kind==='feathers'||shot.scene>=8;
  const dawn=shot.scene>=12, dark=shot.scene===11, turning=shot.scene===8;
  const seq=shot.kind==='reflection'?49:Number(String(shot.id).replace(/\D/g,''))||0;
  const waterTime=shot.kind==='reflection'?320+local:t;
  // 每镜起始画幅固定；镜头每帧平滑，角色使用自身量化时钟。
  camera.fov=16;camera.updateProjectionMatrix();aimCamera(camera,origin,0,1.4*DEG);
  const pan=shot.motion==='track'?(e-.5)*W*.1:0;
  const tilt=shot.motion==='tilt'?(e-.5)*H*.12:0;
  const push=shot.motion==='push'?1+.055*e:1;
  const variant=(seq%3-1)*.035*W;
  let horizon=sea?H*.66:H*.59;
  if(shot.kind==='peng')horizon=H*.84;
  if(shot.kind==='reflection')horizon=H*.56;
  if(shot.kind==='feathers')horizon=H*1.35;
  if(close)horizon=H*.8;
  const placeLayer=(n,x,y,w,d,h)=>pos(layers[n],W/2+(x-W/2)*push-pan*(n==='shore'?1:.15),H/2+(y-H/2)*push+tilt,w*push,d,h&&h*push);
  layers.sky.material.map=close?tex.shotB_sky:tex.sky_dawn;
  layers.sky.userData.aspect=layers.sky.material.map.image.width/layers.sky.material.map.image.height;
  placeLayer('sky',W*.5,(close||shot.kind==='feathers')?H*.5:horizon-H*.40,W*1.28,20000,close?H*1.25:H*1.45);
  placeLayer('back',W*.60+variant,H*.25+tilt,W*1.18,6000);
  placeLayer('city',W*.52+variant,horizon-400,W*.83,shot.scene>=3?4200:1500);
  placeLayer('river',W*.5,horizon+H*.55,W*1.3,1450,H*1.15);
  placeLayer('reflect',W*.52+variant,horizon+240,W*.83,1449,480);
  placeLayer('mist',W*.5,horizon,W*1.4,1300,330);
  placeLayer('shore',350,horizon+220,1500,520);
  placeLayer('frontA',-W*.17-pan*.3,H*.10+tilt,W*.9,650);
  placeLayer('frontB',W*1.12-pan*.3,H*.04+tilt,W*.7,420);
  layers.city.visible=layers.reflect.visible=!close&&(!sea||shot.scene===8||shot.scene===10);
  layers.city.material.opacity=sea?.24:1;
  layers.reflect.material.opacity=sea?.3:.92;
  layers.shore.visible=!sea&&!close&&shot.kind!=='reflection'&&shot.scene<7;
  layers.back.visible=!close;layers.river.visible=!close;layers.mist.visible=!close;
  layers.frontA.visible=layers.frontB.visible=!close;
  layers.frontA.material.opacity=.7;layers.frontB.material.opacity=.85;
  if(shot.kind==='feathers'){layers.frontA.material.opacity=.42;layers.frontB.material.opacity=.5;}
  // 暗场只撤场景中的光源；色阶/调色/纸纹仍使用原片参数。
  const darkness=dark?.11:1;
  for(const m of Object.values(layers))m.material.color.setScalar(darkness);
  mistTex.offset.x=waterTime*.004;reflTex.offset.x=Math.sin(Math.floor(waterTime*12)*1.8)*.0009;
  sun.visible=dawn;pos(sun,W*.73,horizon-20,W*.9,15000,W*.5);
  sun.material.uniforms.amt.value=dawn?(.22+1.5*sat(t,440,475)):.22;

  kun.group.visible=!!shot.kun&&shot.glasses!==false&&!close&&shot.kind!=='peng';
  const near=shot.framing==='medium',under=shot.framing==='under';
  let kd=under?1300:near?2600:3650;
  let kx=W*(.52+.10*Math.sin(seq*1.7)),ky=H*(under?.20:.30);
  let yaw=Math.PI-.05,roll=-.08;
  if(shot.scene===5){kx=W*(.55+.12*Math.sin(t*.055));roll=-.12+.08*Math.sin(t*.09);}
  if(shot.scene===7){kx=W*(.45+.08*e);ky=H*.27;}
  if(turning){yaw=Math.PI-2.5*e;kx=W*(.50+.22*e);ky=H*(.28-.07*Math.sin(e*Math.PI));}
  if(shot.scene===10){kx=W*.62;ky=H*.27;kd=3750;}
  if(shot.scene===12){
   const dive=sat(t,420,438);kx=W*(.53+.10*e);ky=lerp(H*.28,H*.90,dive);roll=-.12-.9*dive;
   if(t>440){ky=H*(.9-.62*sat(t,440,455));roll=lerp(-.9,.38,sat(t,440,455));}
  }
  if(shot.scene===13){kx=W*.5;ky=H*.37;kd=2600;roll=.22;}
  if(shot.kind==='reflection'){ky=H*.22;kx=W*.62;kd=3750;}
  placeModel(kun.group,kx-pan*.2,ky+Math.sin(t*.32)*4,kd,1);
  kun.group.rotation.set(under?.32:.08,yaw,roll);
  const kh=shot.scene>=12?2:3,kt=Math.floor(f/kh)*kh/24;
  kun.setPose(kt);kun.group.updateMatrixWorld(true);
  key.position.copy(keyDir);key.target.position.set(0,0,0);
  if(kun.group.visible)kun.fitShadow(key,{size:2048});
  peng.group.visible=shot.kind==='peng'||(shot.scene===13&&t>=468&&shot.kind==='sea')||(shot.scene===14&&shot.kind==='sea');
  const ps=sat(t,468,486);
  const pengD=shot.scene===14?18000:shot.framing==='medium'?1250:shot.framing==='under'?1100:1750;
  placeModel(peng.group,W*(.52-.15*ps),H*(.45-.23*ps),pengD,shot.scene===14?.18:1);
  peng.group.rotation.set(.40,Math.PI-.95,-.08+ps*.3);
  if(shot.id==='S067')peng.group.rotation.set(.2,Math.PI-.22,.12);
  if(shot.id==='S068')peng.group.rotation.set(-.3,Math.PI-.7,.4);
  if(shot.id==='S070')peng.group.rotation.set(.6,Math.PI-.7,.42);
  if(shot.id==='S072')peng.group.rotation.set(1.05,Math.PI-.15,-.12);
  peng.setPose(t-455,{spread:sat(t,463,470),flap:1,flight:1});
  if(peng.group.visible)peng.fitShadow(key,{size:2048});
  feathers.group.visible=shot.kind==='feathers'||(shot.scene===13&&t<475);
  feathers.group.position.copy(kun.group.position);feathers.group.rotation.copy(kun.group.rotation);
  feathers.setPose(kt,{amount:sat(t,455,460),burst:sat(t,459,466)});
  if(shot.id==='S066'){placeModel(feathers.group,W*.52,H*.48,1900,1);kun.group.visible=false;}
  // swarm.setPose 管理自己的 visible，必须在调用后设置镜头可见性。
  feathers.group.visible=shot.kind==='feathers';

  const ferryOn=!close&&shot.kind!=='feathers'&&shot.kind!=='reflection'&&shot.kind!=='birds';
  ferry.group.visible=ferryOn;
  const fy=H*(sea?.79:.75),fx=W*(shot.scene===7?.52:.40)+pan*.3;
  const fd=sea?900:1100,fs=shot.framing==='overhead'?2.4:shot.kind==='peng'?.65:1;
  placeModel(ferry.group,fx,fy,fd,fs);ferry.group.rotation.set(.025*Math.sin(t*.8),Math.PI+.4,.014*Math.sin(t*.9));
  if(cabinWindows)cabinWindows.visible=!dark;
  ferry.lights.white.visible=!dark;ferry.lights.sternLamp.visible=!dark;
  ferry.lights.red.visible=ferry.lights.green.visible=true;
  wake.visible=ferryOn;pos(wake,fx+W*.07,fy+10,W*.22,fd-10,32);
  wake.material.uniforms.uT.value=t;wake.material.uniforms.uOpacity.value=dark?.3:.85;

  fillScreen(front,camera,W,H,10);
  const aq=Math.floor(t*12)/12,cacheKey=[shot.id,aq,Math.round(u*10000)].join(':');
  if(cacheKey!==lastActorKey){
   const ctx=art.ctx;ctx.setTransform(K,0,0,K,0,0);ctx.clearRect(0,0,W,H);
   drawEnvironment(ctx,waterTime,shot,{horizon,fx,fy,dark,sea,u,seq,filmTime:t});
   if(close||shot.kind==='deck'){
    const speaking=dialogue.some(d=>t>=d.start&&t<d.end&&['林潮','lin','linchao'].includes(d.speaker)&&(lips[d.id]?.[Math.floor((t-d.start)*12)]??0)>.12);
    const qu=clamp(Math.floor(local*12)/12/dur);let ap=qu,wear=shot.glasses!==false;
    if(shot.kind==='rope')ap=shot.id==='S004'?.08+.52*qu:shot.id==='S032'?.63+.35*qu:.50+.12*qu;
    if(shot.kind==='switch'&&shot.scene===6)ap=1-qu;
    if(shot.kind==='glasses'){
     wear=true;
     if(shot.id==='S006')ap=.57+.43*qu;
     else if(shot.id==='S048')ap=.02+.48*qu;
     else if(shot.id==='S050')ap=.5+.5*qu;
     else if(shot.id==='S073')ap=.1+.08*qu;
     else ap=.02+.16*Math.sin(qu*Math.PI);
    }
    drawActor(ctx,aq,W,H,{mode:shot.kind==='title'?'shell':shot.kind,progress:shot.kind==='title'?1:ap,glasses:wear,talking:speaking,lights:shot.kind==='switch'?1:dark?.1:1,mirror:false});
   }
   if(shot.kind==='birds'){
    if(shot.id==='S001')drawBirds(ctx,.7+u*2.2,W,H);
    else{
     // 开场的鸟只飞回栏杆：与片末鹏的远行形成动作对照。
     ctx.save();ctx.fillStyle=P.ink;ctx.fillRect(0,H*.82,W,16);ctx.strokeStyle=P.kunShade1;ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(0,H*.82);ctx.lineTo(W,H*.82);ctx.stroke();
     for(let i=0;i<5;i++){
      const x=W*(.23+i*.135),y=H*.8-Math.sin(Math.min(1,u*1.8)*Math.PI)*H*(.06+i*.014);
      ctx.fillStyle=P.ink;ctx.beginPath();ctx.ellipse(x,y,17,11,-.2,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(x+17,y-8,7,0,7);ctx.fill();
      if(u<.6){const flap=Math.cos(Math.floor(t*12)/12*12+i);ctx.beginPath();ctx.moveTo(x-10,y);ctx.quadraticCurveTo(x-25,y-30*flap,x-40,y-40*flap);ctx.lineTo(x+3,y+3);ctx.fill();}
      ctx.strokeStyle=P.ink;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x-3,y+8);ctx.lineTo(x-3,H*.82);ctx.moveTo(x+5,y+8);ctx.lineTo(x+5,H*.82);ctx.stroke();
     }ctx.restore();
    }
   }
   art.tex.needsUpdate=true;lastActorKey=cacheKey;
  }
  setToonGlobals({inkTime:Math.floor(f/2),fillGain:dark?.1:shot.scene>=12?.62:.55,exposure:1,fillDir:[.08,-1,.1],keyDir:keyDir.toArray(),skyGain:1});
 }

 function drawEnvironment(ctx,t,s,{horizon,fx,fy,dark,sea,u,seq,filmTime}){
  if(ACTORS.has(s.kind)){
   if(['rope','shell','title','helm','switch','radio'].includes(s.kind)){
    ctx.save();
    const deck=['rope','shell','title'].includes(s.kind);
    const edge=deck?H*.06:H*.33;
    ctx.fillStyle=deck?P.kunShade1:P.kunShade2;ctx.fillRect(0,edge,W,H-edge);
    const g=ctx.createLinearGradient(0,edge,W,H);g.addColorStop(0,'rgba(242,160,166,.22)');g.addColorStop(.5,'rgba(42,45,82,0)');g.addColorStop(1,'rgba(42,45,82,.55)');ctx.fillStyle=g;ctx.fillRect(0,edge,W,H-edge);
    if(deck){
     ctx.strokeStyle=P.ink;ctx.lineWidth=3;
     for(let i=-6;i<13;i++){ctx.beginPath();ctx.moveTo(W*.42+i*W*.065,edge);ctx.lineTo(i*W*.2,H);ctx.stroke();}
     for(let j=1;j<10;j++){const y=edge+(H-edge)*(j/10)**1.7;ctx.globalAlpha=.2;ctx.strokeStyle=P.kunRim;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y+15);ctx.stroke();}
     ctx.globalAlpha=.12;ctx.lineWidth=1;for(let i=0;i<100;i++){const x=(i*223)%W,y=edge+(i*89)%(H-edge);ctx.strokeStyle=i%2?P.kunRim:P.ink;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+25+i%80,y-8);ctx.stroke();}
    }else{
     // 舱窗仍透出原片天空，操纵台与舱壁留在同一平涂体系里。
     ctx.fillStyle=P.ink;ctx.fillRect(W*.06,0,14,edge);ctx.fillRect(W*.92,0,18,edge);ctx.fillRect(0,edge-10,W,20);
     ctx.strokeStyle=P.lavender;ctx.globalAlpha=.55;ctx.lineWidth=2;ctx.strokeRect(W*.13,H*.4,W*.74,H*.48);
     ctx.globalAlpha=1;for(let j=0;j<7;j++){ctx.fillStyle=P.kunShade1;ctx.fillRect(W*(.12+j*.12),H*.89,W*.08,8);}
    }
    ctx.restore();
   }
   return;
  }
  ctx.save();
  // 水面上的光不是一张静止背景：细浪、波峰与回程线具有各自时钟。
  if(s.kind!=='feathers'){
   ctx.strokeStyle=dark?'rgba(156,143,216,.12)':'rgba(255,224,202,.30)';ctx.lineWidth=1.6;
   for(const r of ripples){const y=horizon+35+r.y*(H-horizon);if(y>H)continue;
    const x=(r.x*W+t*(2+r.s*7))%(W+180)-90,len=8+r.s*70*(y/H);
    ctx.globalAlpha=.4+.45*Math.sin(r.p+t*.8)**2;ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo(x+len*.45,y-2*Math.sin(t+r.p),x+len,y);ctx.stroke();}
   ctx.globalAlpha=1;
  }
  if(!['deck','birds','reflection','feathers'].includes(s.kind)){
   const bw=(sea?132:108)*(s.framing==='overhead'?2.4:s.kind==='peng'?.65:1);
   ctx.save();ctx.globalAlpha=dark?.22:.48;ctx.fillStyle=P.kunShade1;
   ctx.beginPath();ctx.ellipse(fx,fy+8,bw*.48,5,0,0,Math.PI*2);ctx.fill();
   ctx.strokeStyle=P.anemone;ctx.lineWidth=2;
   for(let z=0;z<2;z++){
    ctx.beginPath();ctx.moveTo(fx+bw*.35,fy+3);
    ctx.bezierCurveTo(fx+bw*.8,fy+z*9,fx+bw*1.2,fy+5+z*18,fx+bw*2.6,fy+5+z*28);ctx.stroke();
   }
   ctx.restore();
  }
  // 上海桥梁是手绘平面结构，保留背景空间，不把城市替换成写实模型。
  if(s.id==='S035'){
   const y=H*(.26+.045*u);ctx.fillStyle=P.city;ctx.strokeStyle=P.ink;ctx.lineWidth=3;
   ctx.fillRect(-20,y,W+40,12);ctx.fillRect(W*.2,y-180,13,210);ctx.fillRect(W*.82,y-180,13,210);
   ctx.beginPath();ctx.moveTo(-20,y);ctx.bezierCurveTo(W*.13,y,W*.15,y-180,W*.2,y-180);ctx.bezierCurveTo(W*.3,y-10,W*.65,y-10,W*.82,y-180);ctx.bezierCurveTo(W*.9,y-10,W*.95,y,W+20,y);ctx.stroke();
   ctx.lineWidth=1;for(let i=0;i<42;i++){const x=i*W/41,yy=y-180*Math.abs(Math.cos((x/W-.2)*Math.PI*1.6));ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x,yy);ctx.stroke();}
  }
  if(s.scene>=8&&s.scene<=12){
   // 江口灯塔与固定航标给空间方向；船关灯不等于熄灭航行灯。
   const x=W*.88,y=horizon;ctx.fillStyle=P.city;
   ctx.beginPath();ctx.moveTo(x-11,y);ctx.lineTo(x-6,y-70);ctx.lineTo(x+6,y-70);ctx.lineTo(x+11,y);ctx.fill();
   ctx.fillRect(x-9,y-76,18,7);ctx.fillStyle=P.window;ctx.globalAlpha=.5+.4*Math.sin(t*.8)**8;ctx.fillRect(x-5,y-72,10,5);ctx.globalAlpha=1;
  }
  if(s.scene===6||s.scene===7){
   ctx.save();const g=ctx.createLinearGradient(fx,fy,fx-250,H*.28);g.addColorStop(0,'rgba(255,232,207,.24)');g.addColorStop(1,'rgba(255,232,207,0)');ctx.fillStyle=g;
   ctx.beginPath();ctx.moveTo(fx,fy-15);ctx.lineTo(fx-400,H*.2);ctx.lineTo(fx-50,H*.12);ctx.closePath();ctx.fill();ctx.restore();
  }
  if(s.scene===5&&s.framing==='close'&&s.kind==='city'){
   ctx.save();ctx.fillStyle=P.city;ctx.fillRect(W*.23,H*.06,W*.64,H*.88);
   const glass=ctx.createLinearGradient(W*.23,0,W*.87,H);glass.addColorStop(0,P.cloudShade);glass.addColorStop(.5,P.kunShade1);glass.addColorStop(1,P.pink);ctx.fillStyle=glass;ctx.globalAlpha=.64;ctx.fillRect(W*.25,H*.08,W*.60,H*.82);ctx.globalAlpha=1;
   ctx.strokeStyle=P.ink;ctx.lineWidth=12;for(let i=0;i<5;i++){const x=W*(.25+i*.15);ctx.beginPath();ctx.moveTo(x,H*.08);ctx.lineTo(x,H*.9);ctx.stroke();}for(let j=0;j<4;j++){const y=H*(.08+j*.275);ctx.beginPath();ctx.moveTo(W*.25,y);ctx.lineTo(W*.85,y);ctx.stroke();}
   ctx.strokeStyle=P.kunRim;ctx.lineWidth=2;ctx.strokeRect(W*.25,H*.08,W*.60,H*.82);
   if(s.id==='S023'){
    ctx.translate(W*.54,H*.46);ctx.rotate(-.15+Math.sin(t*.6)*.015);ctx.fillStyle=P.barnacle;ctx.strokeStyle=P.barnacleShade;ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(0,90);ctx.bezierCurveTo(-140,30,-130,-100,0,-110);ctx.bezierCurveTo(130,-100,140,30,0,90);ctx.fill();ctx.stroke();
    for(let i=0;i<11;i++){const a=-Math.PI+.18+i*(Math.PI-.36)/10;ctx.beginPath();ctx.moveTo(0,90);ctx.quadraticCurveTo(Math.cos(a)*100,20,Math.cos(a)*125,Math.sin(a)*120-5);ctx.stroke();}
   }
   ctx.restore();
  }
  if(s.scene===5&&s.glasses!==false){
   ctx.save();ctx.globalAlpha=.5;ctx.lineWidth=3;ctx.strokeStyle=P.weedB;
   for(let i=0;i<14;i++){let x=W*(.26+i*.04),y=s.framing==='close'?H*.8:horizon-80-Math.sin(i)*90,len=s.framing==='close'?250*ss(u):135;ctx.beginPath();ctx.moveTo(x,y);ctx.bezierCurveTo(x+Math.sin(t*.3+i)*16,y-len*.3,x-16,y-len*.7,x+Math.sin(t*.3+i)*18,y-len);ctx.stroke();}
   ctx.restore();
  }
  if(s.kind==='deck'){
   ctx.fillStyle=P.ink;ctx.beginPath();ctx.moveTo(0,H*.94);ctx.lineTo(W*.45,H*.82);ctx.lineTo(W*.76,H);ctx.lineTo(0,H);ctx.fill();
   ctx.strokeStyle=P.kunShade1;ctx.lineWidth=9;ctx.beginPath();ctx.moveTo(0,H*.82);ctx.lineTo(W*.42,H*.70);ctx.lineTo(W*.76,H*.96);ctx.stroke();
   ctx.lineWidth=5;for(let i=0;i<6;i++){let x=i*W*.11;ctx.beginPath();ctx.moveTo(x,H*.83);ctx.lineTo(x,H);ctx.stroke();}
   if(s.scene===2){
    const x=W*(.20+.20*u),y=H*.99,q=Math.floor(t*12)/12;
    ctx.save();ctx.fillStyle=P.kunShade2;ctx.translate(x,y);ctx.beginPath();ctx.arc(0,-115,15,0,7);ctx.fill();ctx.beginPath();ctx.moveTo(-15,-100);ctx.lineTo(-22,-45);ctx.lineTo(18,-45);ctx.lineTo(14,-100);ctx.fill();ctx.strokeStyle=P.kunShade2;ctx.lineCap='round';ctx.lineWidth=12;for(let z of [-1,1]){ctx.beginPath();ctx.moveTo(z*8,-48);ctx.lineTo(z*8+Math.sin(q*7)*z*17,-8);ctx.stroke();}ctx.restore();
   }
  }
  if(s.kind==='reflection'){
   const g=ctx.createLinearGradient(0,H*.1,0,H);g.addColorStop(0,'rgba(42,45,82,0)');g.addColorStop(1,'rgba(42,45,82,.48)');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
  }
  if(filmTime>=433&&filmTime<464&&['sea','feathers'].includes(s.kind)){
   const growth=sat(filmTime,433,447),fall=1-sat(filmTime,451,464),peak=growth*fall;
   const cx=W*.54,base=H*.73,spread=W*(.12+.20*growth),height=H*.45*peak;
   ctx.save();ctx.fillStyle=P.kunBase;ctx.globalAlpha=1;
   // 卷浪采用不对称的实色块与断裂泡沫；避免等距竖线把水画成悬索桥。
   function waveShape(h,offset=0){
    const b=base+offset;ctx.beginPath();ctx.moveTo(cx-spread,b);
    ctx.bezierCurveTo(cx-spread*.68,b-8,cx-spread*.59,b-h*.68,cx-spread*.22,b-h*.9);
    ctx.bezierCurveTo(cx-spread*.08,b-h*1.13,cx+spread*.38,b-h*1.04,cx+spread*.30,b-h*.68);
    ctx.bezierCurveTo(cx+spread*.25,b-h*.48,cx+spread*.06,b-h*.61,cx+spread*.02,b-h*.73);
    ctx.bezierCurveTo(cx+spread*.17,b-h*.38,cx+spread*.55,b-h*.10,cx+spread,b);
    ctx.closePath();
   }
   waveShape(height);ctx.fill();
   ctx.save();waveShape(height);ctx.clip();
   ctx.fillStyle=P.kunShade1;waveShape(height*.76,18*peak);ctx.fill();
   ctx.fillStyle=P.lavender;waveShape(height*.53,26*peak);ctx.fill();
   ctx.strokeStyle=P.cloudLit;ctx.lineWidth=10;ctx.globalAlpha=.42;
   for(let i=0;i<11;i++){const x=cx-spread*.62+i*spread*.12,y=base-height*(.13+.45*((i*7)%11)/11);ctx.beginPath();ctx.moveTo(x,y);ctx.quadraticCurveTo(x+40,y-12,x+70+i%3*18,y-38*peak);ctx.stroke();}
   ctx.restore();
   ctx.strokeStyle=P.kunRim;ctx.lineWidth=12;ctx.beginPath();ctx.moveTo(cx-spread*.9,base-3);
   ctx.bezierCurveTo(cx-spread*.6,base-30,cx-spread*.56,base-height*.67,cx-spread*.22,base-height*.9);
   ctx.bezierCurveTo(cx-spread*.08,base-height*1.13,cx+spread*.38,base-height*1.04,cx+spread*.3,base-height*.68);ctx.stroke();
   for(let i=0;i<105;i++){
    const ph=i/104,flow=ph+(t*.06)%1,x=cx+spread*(-.5+.86*ph)+Math.sin(i*2.399+t*.4)*18*peak;
    const y=base-height*(.80+.26*Math.sin(ph*Math.PI))-(8+((i*19)%49))*peak*Math.sin(flow*Math.PI)**2;
    ctx.fillStyle=i%4===0?P.anemone:P.kunRim;ctx.globalAlpha=.75;ctx.beginPath();ctx.ellipse(x,y,3+i%7,2+i%4,-.6,0,Math.PI*2);ctx.fill();
   }
   ctx.globalAlpha=.7;ctx.strokeStyle=P.anemone;ctx.lineWidth=3;
   for(let j=0;j<8;j++){const radius=(filmTime-433)*22+j*24;ctx.beginPath();ctx.ellipse(cx,base+12,radius,radius*.12,0,0,Math.PI*2);ctx.stroke();}
   ctx.restore();
  }
  ctx.restore();
 }
 return {scene,camera,update,refs,look:(t,s)=>ACTORS.has(s.kind)?actorLook(t):['peng','feathers'].includes(s.kind)?heroLook(t,sat(t,468,486)):wideLook(t)};
}
