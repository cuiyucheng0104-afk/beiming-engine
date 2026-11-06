import {T,V,M,group,box,ball,tube,mesh,batch,tree,rock,mountain,moss,cloud,distant,roof,house,paper,scroll,candle,bowl,book,boat,person,asset,sky,water,bird,ground,paving,mulberry,inkTexture,palette} from './world.js';
const cfg=(title,cam,at,fov=40,extra={})=>({title,cam,at,fov,...extra});
export async function makeScene(id,scene){return await builders[id](scene);}
function room(scene){sky(scene,{interior:true});ground(scene,30,-.05);box(scene,[0,7,-7],[26,14,.5],'bark');box(scene,[-9,7,-1],[.6,14,18],'bark');
 for(let x=-8;x<=8;x+=4){box(scene,[x,7,-6.6],[.4,14,.4],'wood');box(scene,[x,11,-1],[.3,.45,12],'wood');}
 // 左窗的实体格栅投下条状阴影。
 box(scene,[-8.5,4.4,-3],[.12,4.7,4.7],'blue');for(let z=-5.4;z<-.5;z+=.38)box(scene,[-8.3,4.4,z],[.18,4.8,.06],'wood');for(let y=2.1;y<6.9;y+=.55)box(scene,[-8.2,y,-3],[.19,.06,4.8],'wood');
 for(let i=0;i<4;i++){box(scene,[4.7,1+i*1.5,-6],[6,.14,1],'wood');for(let j=0;j<6;j++)book(scene,[2.3+j*.82,1.15+i*1.5,-6],[.7,.18,1],['red','blue','cream'][j%3],.02*j);}
}
function desk(scene,w=12,d=5){box(scene,[0,2.5,0],[w,.28,d],'wood',.09);for(const x of [-w*.42,w*.42])for(const z of [-d*.4,d*.4])box(scene,[x,1.25,z],[.32,2.5,.32],'wood',.04);for(let x=-w/2+.3;x<w/2;x+=.6)tube(scene,[[x,2.65,-d/2],[x,2.65,d/2]],.008,'dark');}
function jars(scene,R,n=7){for(let i=0;i<n;i++){let x=-5+R()*10,z=-1.8+R()*3.7;bowl(scene,[x,2.66,z],.4+R()*.5,i%2?'blue':'bronze');}}
function banners(scene,R,n=35,range=[14,18,10],offset=[0,10,0]){for(let i=0;i<n;i++){let p=[offset[0]+(R()-.5)*range[0],offset[1]+(R()-.5)*range[1],offset[2]+(R()-.5)*range[2]];paper(scene,p,[.35+R()*.5,.6+R()*.9],i,[R()*2,R()*6,R()*2],.07);}}
function stele(parent,pos,s=1,ry=0,seed=1){const g=group(parent,pos,s,ry);box(g,[0,.3,0],[2,.6,1.1],'rock',.12);box(g,[0,2.9,0],[1.5,4.7,.45],'rock',.14);ball(g,[0,5.15,0],[.75,.42,.24],'rock');
 let mat=palette('rock',{color:'#ffffff',map:inkTexture(seed,false),side:T.DoubleSide,shade1:null,shade2:null,shade1Tint:[.5,.48,.68],shade2Tint:[.3,.32,.5]});let p=mesh(new T.PlaneGeometry(1.25,3.8),mat,g);p.position.set(0,2.85,.233);
 for(const x of [-.65,.65])tube(g,[[x,.7,.27],[x,4.9,.27]],.035,'gold');moss(g,[0,.64,0],1,.8,20,seed);return g;}
function island(scene,pos,scale){let g=group(scene,pos);rock(g,[0,-scale*.14,0],[scale,scale*.3,scale*.72],31);moss(g,[0,scale*.06,0],scale*.85,scale*.6,200,34);return g;}
const builders={
 '01':async scene=>{
  room(scene);desk(scene,12,5);const R=mulberry(101);
  const a=await asset(scene,'scholar',[0,2.6,-1.9],5.2,0);a.name='真实人物主体';
  scroll(scene,[-.8,2.7,.65],1.2,2,.2);scroll(scene,[3.4,2.7,.9],.75,4,-.4);
  for(let i=0;i<5;i++)book(scene,[-4.3,2.8+i*.2,-.6],[1.6,.18,2.4],i%2?'blue':'cream',-.1);
  candle(scene,[-3.3,2.7,.8],1.2);bowl(scene,[2.8,2.7,-.6],.8,'bronze');bowl(scene,[-2.5,2.7,-.5],.6,'dark');
  // 明确的毛笔笔杆、墨池和卷轴均为独立实物。
  
  box(scene,[-2.5,2.76,-.8],[1.3,.17,.8],'dark',.12);for(let i=0;i<4;i++)tube(scene,[[3.2+i*.13,2.8,1.5],[4+i*.13,2.8,0]],.035,'wood');
  candle(scene,[5.2,1.8,-4.5],1.9);jars(scene,R,3);
  return cfg('烛下挥毫',[6.6,5.8,10],[0,4.6,-.6],42,{interior:true,light:[-7,11,7],shadowSpan:18,fog:false});
 },
 '02':async scene=>{
  room(scene);desk(scene,13,6);const R=mulberry(202);
  for(let i=0;i<7;i++)scroll(scene,[-4.5+R()*8,2.68,-1+R()*3],.6+R()*.35,i,(R()-.5)*1.7);
  // 带空腔、足圈、凸起兽面纹、提梁的三维青铜觚。
  let g=group(scene,[-.9,3.2,.2],1,0);g.rotation.z=-1.15;g.rotation.x=.25;
  const profile=[[.03,0],[.65,0],[.7,.12],[.45,.35],[.4,1.3],[.72,2.1],[.97,2.35],[.98,2.48],[.88,2.48],[.67,2.12],[.32,1.3],[.31,.4],[0,.27]].map(p=>new T.Vector2(...p));
  mesh(new T.LatheGeometry(profile,96),M.bronze,g);
  for(const y of [.15,.55,1.1,1.65,2.2]){let r=y<1.3?.46:.4+(y-1.3)*.52;let o=mesh(new T.TorusGeometry(r,.035,8,64),M.gold,g);o.rotation.x=Math.PI/2;o.position.y=y;}
  for(let i=0;i<18;i++){let a=i/18*Math.PI*2,x=Math.cos(a),z=Math.sin(a);tube(g,[[x*.48,.55,z*.48],[x*.55,.8,z*.55],[x*.45,1.05,z*.45]],.025,'gold');}
  for(const s of [-1,1])tube(g,[[s*.43,.8,0],[s*.95,.75,0],[s*.95,1.25,0],[s*.5,1.3,0]],.07,'bronze');
  let sword=group(scene,[2.6,2.85,1.4],1,-.65);const sh=new T.Shape();sh.moveTo(-.27,0);sh.lineTo(-.23,3.8);sh.lineTo(0,4.65);sh.lineTo(.23,3.8);sh.lineTo(.27,0);sh.closePath();let b=mesh(new T.ExtrudeGeometry(sh,{depth:.06,bevelEnabled:true,bevelThickness:.03,bevelSize:.03,bevelSegments:2}),M.blue,sword);b.rotation.x=-Math.PI/2;tube(sword,[[0,.03,0],[0,.03,-1.05]],.12,'dark');box(sword,[0,.02,.05],[1.1,.15,.25],'gold',.06);tube(sword,[[0,.09,.3],[0,.09,3.9]],.015,'cream');
  for(let i=0;i<4;i++)candle(scene,[-5+i*3,2.7,-2],1.4+(i%2)*.5);bowl(scene,[-4.2,2.7,1],.8);book(scene,[4.4,2.9,-.3],[1.5,.3,2.2]);
  return cfg('青铜案头',[5,4.5,7.2],[0,3.25,.4],42,{interior:true,light:[-5,10,8],shadowSpan:16,fog:false});
 },
 '03':async scene=>{
  sky(scene);water(scene,0);const R=mulberry(303);
  const b=boat(scene,[0,.1,0],1.2,-.2,{cover:false});const a=await asset(b,'boatman',[.8,.7,0],4.5,-.15);
  tube(b,[[4,-.3,1.3],[2,4,1],[.8,7,.6]],.07,'wood');
  for(const side of [-1,1]){for(let i=0;i<7;i++){let x=side*(9+R()*7),z=-10-i*8;rock(scene,[x,-.2,z],[4+R()*3,2.5,5],i+30);tree(scene,[x,1,z],1.6+R()*.9,i+50,{pine:false});moss(scene,[x,2,z],4,4,45,i);}}
  tree(scene,[-9,0,3],2.2,76);tree(scene,[12,0,-4],2,79);distant(scene,{seed:32,h:34,start:-90});
  for(let i=0;i<10;i++){rock(scene,[-8+R()*16,-.5,-4-R()*35],[1.8,.8,1.5],i);}
  return cfg('烟雨舟人',[10,4.6,15],[0,3.1,-1],42,{light:[-12,22,8],shadowSpan:35,fogDensity:.008});
 },
 '04':async scene=>{
  sky(scene);water(scene,0);island(scene,[0,1,0],17);const a=await asset(scene,'pavilion',[0,2.4,0],26,.12);
  tree(scene,[-17,2,-3],1.35,401,{pine:true});tree(scene,[16,2,-9],1.4,402,{pine:true});tree(scene,[-8,3,-13],1.3,405,{pine:true});
  for(let i=0;i<5;i++)rock(scene,[-12+i*6,-.5,12],[4,2,3],406+i);distant(scene,{seed:45,span:220,start:-100,h:46});
  cloud(scene,[-45,12,-160],4.5,51);cloud(scene,[65,16,-200],5.5,52);
  for(let i=0;i<13;i++)bird(scene,[-18+i*3,31+Math.sin(i*.7)*3,-13-i*.8],.65,4+i);
  boat(scene,[21,.2,22],.8,-.7);person(scene,[23,1.1,22],.75,0,'cream');
  return cfg('云山楼阁',[30,17,43],[0,8.7,-3],40,{light:[-45,65,35],shadowSpan:65,fogDensity:.0036});
 },
 '05':async scene=>{
  sky(scene);ground(scene,140);paving(scene,{w:16,d:65,z:-11});const R=mulberry(505);
  for(let side of [-1,1])for(let i=0;i<4;i++){let x=side*(10+R()*2),z=6-i*14;house(scene,[x,0,z],1.1,side*Math.PI/2,{stories:i===3?2:1});}
  // 巷尾的马头墙与门楼，清晰可辨的屋檐、砖石、木格窗。
  house(scene,[0,0,-41],1.8,0,{stories:2,open:true});for(const side of [-1,1]){box(scene,[side*13,6,-40],[9,12,1],'cream');for(let j=0;j<4;j++)box(scene,[side*(9+j*1.1),11.7+j*.7,-40],[1.2,.5,1.35],'roof');}
  for(const side of [-1,1])for(let i=0;i<3;i++){let g=group(scene,[side*6.1,0,3-i*10],1,side*.1);box(g,[0,1.6,0],[3.4,.13,2.3],'wood');for(const x of [-1.5,1.5])for(const z of [-1,1])tube(g,[[x,0,z],[x,3.4,z]],.065,'wood');
   const aw=box(g,[0,3.5,0],[4.3,.08,3.5],i%2?'cream':'blue');aw.rotation.z=side*.1;
   for(let j=0;j<5;j++){bowl(g,[-1.25+j*.62,1.68,.3],.38,'bronze');for(let k=0;k<3;k++)ball(g,[-1.25+j*.62+(R()-.5)*.25,1.91,.3+(R()-.5)*.2],[.1,.1,.1],j%2?'red':'gold');}}
  for(let i=0;i<14;i++)person(scene,[(R()-.5)*8,0,3-R()*35],.7+R()*.3,R()*6,['cream','blue','red','bark'][i%4],i%3===0);
  tree(scene,[-12,0,-9],2.8,518);tree(scene,[14,0,-27],3,519);tree(scene,[-18,0,8],2.2,524);moss(scene,[-8,.08,2],1.6,7,120,508);
  banners(scene,R,8,[7,4,25],[0,6,-12]);
  return cfg('林间市集',[2.7,5.4,24],[0,4.2,-15],43,{light:[-28,45,-10],shadowSpan:60,fogDensity:.007});
 },
 '06':async scene=>{await temple(scene,606);return cfg('碑林风起',[12,5.2,22],[-1,7.4,-9],48,{light:[-20,40,-5],shadowSpan:65,fogDensity:.0048});},
 '07':async scene=>{await temple(scene,607);return cfg('仰望藏书楼',[-5,2.7,13],[1,16,-9],66,{light:[-20,40,-5],shadowSpan:65,fogDensity:.0048});},
 '08':async scene=>{
  sky(scene);water(scene,0,10000);const R=mulberry(808);
  // 蜿蜒河道由两岸真实山体围合，远近有不同尺度和密度。
  for(let row=0;row<7;row++){let z=35-row*52,curve=Math.sin(row*.9)*30;for(const side of [-1,1])for(let i=0;i<3;i++){
   let x=curve+side*(35+i*35+R()*10),h=20+R()*50+(row<2?5:0);mountain(scene,[x,-3,z+(R()-.5)*22],h,13+R()*15,808+row*27+i+(side+1)*300,{green:row<4});}}
  for(let row=0;row<5;row++)cloud(scene,[-30+R()*65,6+R()*5,-40-row*60],5+R()*4,row+88);
  for(let i=0;i<6;i++)rock(scene,[-22+i*5,-1,31-i*2],[6,1.5,6],i+808);
  boat(scene,[-3,.2,12],.7,-.4);person(scene,[0,1,12],.6,0,'cream');for(let i=0;i<8;i++)bird(scene,[-18+i*3,40+Math.sin(i)*2,-40-i*2],.65,i);
  distant(scene,{seed:818,rows:3,span:1000,start:-480,h:70,step:200});return cfg('江山云海',[100,110,149],[-5,-18,-73],49,{light:[-80,120,40],shadowSpan:190,fogDensity:.0017,far:8000});
 },
 '09':async scene=>{
  sky(scene,{night:true});water(scene,0);const R=mulberry(909);
  for(let i=0;i<11;i++)rock(scene,[-38+i*8,-1,-12-R()*5],[7,2.6,8],i+909);
  for(let i=0;i<7;i++)house(scene,[-27+i*9,1,-17-R()*6],.85+R()*.25,(R()-.5)*.1,{lit:true});
  tree(scene,[-10,1,-14],2.8,919);tree(scene,[26,1,-24],2.7,926);distant(scene,{seed:91,h:38,start:-100,span:220});
  const dock=group(scene,[10,.7,-3]);for(let i=0;i<13;i++)box(dock,[0,0,-i*.45],[3,.15,.4],'wood');for(const z of [0,-5.4])for(const x of [-1.3,1.3])tube(dock,[[x,-2,z],[x,.55,z]],.13,'wood');
  boat(scene,[4,.2,8],1.1,-.14);tree(scene,[-18,-1,12],1.25,930,{bare:true});rock(scene,[-18,-1,12],[4.5,1.7,3],934);moss(scene,[-18,.5,12],3,2,70,936);
  for(let i=0;i<3;i++){let g=group(scene,[10+i*3,2,-17]);ball(g,[0,0,0],[.24,.34,.24],M.glow);}
  return cfg('暮色江村',[17,9,43],[0,5,-13],43,{night:true,light:[-30,50,30],shadowSpan:70,fogDensity:.005});
 }
};
async function temple(scene,seed){sky(scene);ground(scene,100);paving(scene,{w:34,d:38,z:-4});const R=mulberry(seed);
 await asset(scene,'pavilion',[-16,0,-14],29,.32);await asset(scene,'pavilion',[18,1,-21],32,-.3);house(scene,[1,1,-38],1.8,0,{stories:2});
 for(let side of [-1,1])for(let i=0;i<4;i++){mountain(scene,[side*(24+R()*8),-4,-10-i*14],18+R()*23,8+R()*7,seed+i*22+(side+1)*100);tree(scene,[side*23,10+i*3,-i*16],1.7,seed+i*12);}
 stele(scene,[-6,0,5],1.6,.25,1);stele(scene,[6,0,0],1.9,-.24,2);stele(scene,[0,0,-11],1.3,.08,3);stele(scene,[-12,0,-9],1.1,.3,5);
 banners(scene,R,72,[29,28,33],[0,13,-4]);for(let i=0;i<20;i++)rock(scene,[(R()-.5)*28,-.1,6-R()*25],[.5+R(),.4,.7],seed+i);
 moss(scene,[-8,.12,5],4,8,150,seed);moss(scene,[8,.12,-5],5,8,150,seed+8);
}
