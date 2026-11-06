import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'raea';
import { Camera3d } from 'raea/camera';
import { Transform, Quat } from 'raea/transform';
import { Mesh3d, Cuboid, Sphere, Cylinder, Cone } from 'raea/mesh';
import { StandardMaterial, ToonMaterial } from 'raea/pbr';
import { AmbientLight, DirectionalLight } from 'raea/light';
import { Model, ImagePlane, ToneMapping, Bloom, Shadows, FramePass, ShaderMesh, Group, Canvas3D, Grade } from 'raea/3d';

const ASSETS = true;
const clamp=(x:number)=>Math.max(0,Math.min(1,x));
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const seed=(n:number)=>{const x=Math.sin(n*127.1+43.7)*43758.5453;return x-Math.floor(x);};
const COLOR={sky:'#9C8FD8',ink:'#2A2D52',city:'#4B4A8C',warm:'#FFD3B0',lit:'#FFB26B'};
const tr=(p:number[],s:number|number[]=1,r:number[]=[0,0,0])=>Transform.fromXyz(p[0],p[1],p[2]).withScale(typeof s==='number'?[s,s,s]:s).withRotation(Quat.fromEuler('XYZ',r[0],r[1],r[2]));

// Positions and geometry persist between frames; only their transforms are keyed.
const BUILDINGS=Array.from({length:36},(_,i)=>({x:(i-18)*3.7,z:-47-seed(i+80)*24,w:1.2+seed(i+3)*1.8,h:3+seed(i+4)**2*13,d:1.3+seed(i+8)*1.4}));
function Block({name,p,size,color=COLOR.city}:{name:string,p:number[],size:number[],color?:string}){
 return <Mesh3d name={name} transform={tr(p)}><Cuboid half_size={size.map(x=>x/2)} /><ToonMaterial base_color={color} shadow_color="#343D69" steps={3}/></Mesh3d>;
}
function City(){return <>
 {BUILDINGS.map((b,i)=><Group key={i} position={[b.x,b.h/2,b.z]}>
  <Block name={'building-'+i} p={[0,0,0]} size={[b.w,b.h,b.d]}/>
  <Block name={'light-'+i} p={[b.w*.27,0,b.d*.505]} size={[.085,b.h*.7,.025]} color={i%3?'#E0AB86':'#FFC46B'}/>
 </Group>)}
 <Mesh3d name="pearl-stem" transform={tr([-30,8,-46])}><Cylinder radius={.28} half_height={8}/><ToonMaterial base_color="#736DB0" steps={3}/></Mesh3d>
 {[6.1,11.9].map((y,i)=><Mesh3d key={i} name={'pearl-ball'+i} transform={tr([-30,y,-46])}><Sphere radius={i?1.15:1.8}/><ToonMaterial base_color="#AA85B5" shadow_color="#4E5888" steps={3}/></Mesh3d>)}
 <Mesh3d name="pearl-tip" transform={tr([-30,17,-46])}><Cone radius={.22} height={4}/><ToonMaterial base_color="#B397C2" steps={3}/></Mesh3d>
 </>;}

const WATER=`
fn shade(in: VertexOutput) -> vec4<f32> {
 let p = in.world_position.xz; let t=globals.time;
 var uv=vec2<f32>(p.x/170.0+.5,(-p.y+30.0)/160.0);
 uv.x+=sin(p.y*1.2+t*.8)*.002+sin(p.y*.3-t*.4)*.003;
 uv.y+=sin(p.x*.28+p.y*.6-t*.5)*.0015;
 uv=clamp(uv,vec2<f32>(.015),vec2<f32>(.985));
 var c=textureSample(tex_water,samp_water,uv).rgb;
 c=c*.37+vec3<f32>(.018,.022,.055);
 let s=sin(p.y*2.7+sin(p.x*.27+t*.4)*1.3-t*.7);
 let r=sin(p.x*.54+p.y*.2+t*.3);
 let path=exp(-pow((p.x+26.0)/13.0,2.0));
 c+=vec3<f32>(.14,.08,.04)*smoothstep(.91,1.0,s)*smoothstep(.45,.9,r)*path;
 let d=length(p-view.world_position.xz);
 return vec4<f32>(c,1.0-smoothstep(85.0,200.0,d));
}`;
const WAKE=`
fn shade(in:VertexOutput)->vec4<f32>{
 let uv=in.uv;let x=uv.x;
 let edge=(1.0-x)*.29+.025;
 let row=abs(uv.y-.5);
 let stripe=exp(-pow((row-edge)/.027,2.0));
 let torn=smoothstep(-.3,.6,sin(x*91.0+globals.time*1.4)+sin(uv.y*137.0-x*31.0));
 let a=stripe*torn*smoothstep(0.0,.22,x)*(1.0-smoothstep(.78,1.0,x))*.45;
 return vec4<f32>(.76,.53,.55,a);
}`;
const PAPER=`
fn hash(p:vec2<f32>)->f32{return fract(sin(dot(p,vec2<f32>(127.1,311.7)))*43758.5453);}
fn shade(in: FullscreenVertexOutput)->vec4<f32>{
 var c=frame(in.uv); let n=hash(floor(in.uv*vec2<f32>(1920.0,1040.0)));
 let vign=1.0-.12*pow(length(in.uv-.5)*1.4,2.0);
 c=vec4<f32>(c.rgb*vign+(n-.5)*.018,c.a);return c;
}`;

function Piece(){
 const f=useCurrentFrame(),t=f/24,q=Math.floor(f/3)*3/24;
 let eye:number[],at:number[],fov:number;
 if(t<3.5){eye=[mix(-11,-6,t/3.5),mix(4,5,t/3.5),mix(38,31,t/3.5)];at=[1,7.4,-1];fov=40;}
 else if(t<6){const u=(t-3.5)/2.5;eye=[mix(17,19,u),mix(12.2,13.1,u),mix(10,7.8,u)];at=[10.8,12.3,-1];fov=34;}
 else {const u=(t-6)/4;eye=[mix(26,30,u),mix(17,21,u),mix(29,35,u)];at=[3,10,-1];fov=42;}
 const kx=-2+t*.8,ky=13+Math.sin(q*.7)*.45, kz=-2;
 return <AbsoluteFill style={{background:COLOR.sky}}>
  <style>{`@font-face{font-family:Beiming;src:url('data:font/ttf;base64,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')}`}</style>
  <img src={staticFile('sky_dawn.png')} style={{position:'absolute',left:-60-t*2,top:-20,width:2040,height:1105}}/>
  <Canvas3D layered>
  <Camera3d transform={Transform.fromXyz(...eye).lookingAt(at)} projection={{Perspective:{fov:fov*Math.PI/180,near:.1,far:600}}}/>
  <AmbientLight brightness={160} color="#A99BD9"/>
  <DirectionalLight transform={Transform.fromXyz(-30,22,20).lookingAt([0,7,0])} color="#FFD3B0" illuminance={11500} shadow_maps_enabled/>
  <ToneMapping mode="none"/>
  <Shadows mapSize={2048} distance={140} firstCascade={70} cascades={2}/>
  {/* Distance fog disabled on alpha cards: canary premultiplied fog exposes their rectangles. */}
  <Bloom intensity={.12} threshold={1.2}/>
  <FramePass wesl={PAPER}/>
  <ImagePlane name="cloud-bank" src={staticFile('clouds_back.png')} position={[-28+t*.1,32,-140]} width={150} shadow={false}/>
  <ImagePlane name="skyline" src={staticFile("skyline_pudong.png")} position={[-10,8,-100]} width={180} height={30} shadow={false}/>
  <ShaderMesh name="river" shape={{primitive:'Plane3d',half_size:[350,350]}} wesl={WATER} textures={{water:'media/river.png'}} alpha="blend" position={[0,-.25,-40]}/>
  {ASSETS ? <Model name="kun" src={staticFile('kun.glb')} animation="Swim" time={(q+2)%10} loop position={[kx,ky,kz]} rotation={[-.08,-.18, mix(-.05,.10,clamp((t-6)/4))]}>
    <ToonMaterial steps={3} rim={{intensity:.40,width:.20,color:COLOR.warm}} outline={false}/>
    {['kun-body-PBR','kun-flukes-PBR','kun-fin-R-PBR','kun-fin-L-PBR'].map(material=><ToonMaterial key={material} material={material} steps={3} rim={{intensity:.40,width:.2,color:COLOR.warm}} outline={{width:1.5,color:COLOR.ink}}/>)}
    {['kun-weed-clumps-PBR','kun-kelp-PBR'].map(material=><ToonMaterial key={material} material={material} steps={3} base_color="#9CAED8" shadow_color="#424B68" rim={{intensity:.18,width:.13,color:COLOR.warm}} outline={false}/>)}
   </Model> : <Mesh3d name="kun-placeholder" transform={tr([kx,ky,kz],[15,3,3])}><Sphere radius={1}/><ToonMaterial base_color="#6E7BA8" steps={3}/></Mesh3d>}
  <ImagePlane name="left-cloud" src={staticFile('clouds_front_a.png')} position={[-34-t*.6,8,-25]} width={57} shadow={false}/>
  <ImagePlane name="right-cloud" src={staticFile('clouds_front_b.png')} position={[38+t*.9,7,-31]} width={63} shadow={false}/>
  {ASSETS ? <Model name="ferry" src={staticFile('ferry.glb')} position={[-3+t*.5,.1,11-t*.65]} rotation={[.025*Math.sin(t*2.2),-.45,.018*Math.cos(t*2)]} scale={2}>
   <ToonMaterial steps={3} rim={{intensity:.15,width:.15,color:COLOR.warm}} outline={{width:1.3,color:COLOR.ink}}/>
  </Model> : <Block name="ferry-placeholder" p={[-3+t*.5,.8,11-t*.65]} size={[3,1.2,1.2]} color="#E9DCC9"/>}
  <ShaderMesh name="wake" shape={{primitive:'Plane3d',half_size:[5,1.8]}} wesl={WAKE} alpha="blend" position={[-7.3+t*.5,-.23,8.9-t*.65]} rotation={[0,-.45,0]}/>
  {/* A near shore handrail gives a measurable foreground parallax, not a whole-frame zoom. */}
  {t<3.5 && <><Block name="foreground-rail" p={[-19,1.4,25]} size={[12,.13,.17]} color="#343D69"/>
  {[-24,-19,-14].map((x,i)=><Block key={i} name={'rail-'+i} p={[x,.7,25]} size={[.15,1.4,.15]} color="#343D69"/>)}</>}
  </Canvas3D>
  {t>=8.1 && <div style={{position:'absolute',left:120,top:152,color:'#FFF4EA',fontFamily:'Beiming',fontSize:132,letterSpacing:20,opacity:clamp((t-8.1)/.5)}}>北冥</div>}
 </AbsoluteFill>;
}
registerRoot(()=> <Composition id="beiming-raea" component={Piece} width={1920} height={1040} fps={24} durationInFrames={240}/>);
