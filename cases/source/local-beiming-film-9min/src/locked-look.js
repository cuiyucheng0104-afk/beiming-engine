// 原版10秒的 A/B/C 三组逐镜头参数；这里只移动到可复用函数，不重新调色。
import { lerp, ss, seg } from '../engine/core/math.js';
export function wideLook(t) { return {
 t, outline:{width:2.3,near:300,far:3000,farScale:0.6,wobble:1.1,tint:0.2},
 kuwahara:{radius:3,farRadius:6.5,farStart:700,farEnd:2200,strength:1},
 bloom:{strength:0.72,threshold:0.66,radius:0.7,knee:0.25},
 grade:{exposure:1,warmth:0.12,lift:[0.02,0.012,0.045],gamma:0.96,gain:1.02,saturation:1.1,shoulder:0.9},
 paper:{strength:0.14},vignette:0.24,grain:0.65,fog:null
}; }
export function actorLook(t) { return {
 t,outline:false,kuwahara:{radius:1.6,farRadius:6,farStart:30,farEnd:60,strength:1,protect:[1.05,1.6]},
 bloom:{strength:0.85,threshold:0.7,radius:0.75,knee:0.3},
 grade:{exposure:1,warmth:0.13,lift:[0.02,0.012,0.045],gamma:0.97,gain:1.01,saturation:1.08,shoulder:0.9},
 paper:{strength:0.12},vignette:0.26,grain:0.65,fog:null
}; }
export function heroLook(t,end=0) { return {
 t,outline:{width:2.6,near:90,far:700,farScale:0.55,wobble:1.2,tint:0.15},
 kuwahara:{radius:4,farRadius:7,farStart:900,farEnd:3000,strength:1},
 bloom:{strength:lerp(0.6,1.05,end),threshold:lerp(0.72,0.6,end),radius:lerp(0.7,0.8,end),knee:0.25},
 grade:{exposure:lerp(1,1.2,end),warmth:lerp(0.12,0.2,end),lift:[lerp(0.02,0.05,end),lerp(0.012,0.04,end),lerp(0.04,0.05,end)],gamma:0.96,gain:1.02,saturation:1.1,shoulder:0.9},
 paper:{strength:0.13},vignette:lerp(0.24,0.16,end),grain:0.65,fog:null
}; }
