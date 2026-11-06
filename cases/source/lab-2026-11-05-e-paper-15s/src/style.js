export const E = {sky:'#b9beb1',horizon:'#e9d0a9',fog:'#a6afa3',water:'#4c6868',rock:'#a9a697',leaf:'#475a50',roof:'#39494b',wood:'#a84031',paper:'#e3d5b8',accent:'#e9a45c',shadow:'#323842',ink:'#252f33',light:'#ffe1ba'};
export const LOOK={
 outline:{width:1.65,color:E.ink,wobble:.4,boilFps:12,warp:85,pressure:.18,breakup:.025,inner:.42,near:100,far:2500,farScale:.8,opacity:.85,tint:.12},
 kuwahara:{radius:1.2,farRadius:1.2,strength:.28,q:8,farStart:2000,farEnd:4000,protect:null},
 bloom:{strength:.12,threshold:.86,radius:.55,knee:.15,tint:E.light},
 grade:{exposure:1.06,warmth:0,lift:0,gamma:1,gain:1,saturation:1.03,shoulder:1},
 paper:{strength:.055,scale:.85},vignette:.07,grain:.10,fog:null
};
export const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
export const ease=x=>{x=clamp(x);return x*x*(3-2*x)};
export const seg=(t,a,b)=>ease((t-a)/(b-a));
export const mix=(a,b,t)=>a+(b-a)*t;
export const poseTime=t=>Math.floor(t*12+1e-5)/12;
export const TIMELINE={duration:15,fps:24,lift:1.2,pageCover:4.0,court:4.2,fold:6.2,foldDone:8.2,reveal:9.1,river:9.7};
