import * as THREE from 'three';
import {E} from './style.js';
// E3 plates remain 2D artwork. The shader adds restrained multiplane-like drift,
// water shimmer and flame light; it is not presented as a reconstructed environment.
export async function createBackground(W,H){
 const load=async name=>{const t=await new THREE.TextureLoader().loadAsync(`./assets/plates/${name}.png`);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=8;return t};
 const [desk,court,river]=await Promise.all(['desk','court','river'].map(load));
 const U={a:{value:desk},b:{value:court},c:{value:river},time:{value:0},aspect:{value:W/H},
  ra:{value:desk.image.width/desk.image.height},rb:{value:court.image.width/court.image.height},rc:{value:river.image.width/river.image.height}};
 const material=new THREE.ShaderMaterial({uniforms:U,depthWrite:false,depthTest:false,
 vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
 fragmentShader:`varying vec2 vUv;uniform sampler2D a,b,c;uniform float time,aspect,ra,rb,rc;
 float ss(float a,float b,float x){return smoothstep(a,b,x);}
 float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
 vec2 fit(vec2 uv,float r){if(r>aspect)uv.x=(uv.x-.5)*aspect/r+.5;else uv.y=(uv.y-.5)*r/aspect+.5;return uv;}
 void main(){
  float t=time;vec2 uv=vUv;
  float q=ss(0.,4.2,t);vec2 u=(uv-vec2(.51,.50))/(1.10-.055*q)+vec2(.51,.50);
  u.x+=q*.018;u.y-=q*.010;
  vec3 A=texture2D(a,fit(u,ra)).rgb;
  vec2 flame=(uv-vec2(.258,.48))*vec2(aspect,1.);
  float glow=exp(-dot(flame,flame)*130.)*(.018+.009*sin(t*10.)+.005*sin(t*23.));
  A+=glow*vec3(1.,.53,.16);
  float k=ss(4.0,9.6,t);vec2 v=(uv-.5)/(1.09-.025*k)+.5;
  // Far architecture moves less than the near frame. No whole-frame watery wobble.
  float near=smoothstep(.12,.9,abs(uv.x-.5)*2.);v.x+=(k-.5)*(.016+near*.025);v.y-=k*.035;
  vec3 B=texture2D(b,fit(v,rb)).rgb;
  float j=ss(9.0,15.,t);vec2 w=(uv-.5)/(1.13-.095*j)+.5;w.x+=.025*j;w.y-=.009*j;
  float water=smoothstep(.49,.05,uv.y)*smoothstep(.15,.45,uv.x)*(1.-smoothstep(.65,.85,uv.x));
  w.x+=sin(uv.y*250.+t*1.4)*.0008*water;
  vec3 C=texture2D(c,fit(w,rc)).rgb;
  // First change is hidden by the hero paper. Second is a ragged mist wipe.
  vec3 col=mix(A,B,ss(3.98,4.22,t));
  float rag=.018*sin(uv.y*57.)+.010*sin(uv.y*137.+uv.x*25.);
  float wipe=ss(uv.x-.12+rag,uv.x+.12+rag,(t-9.0)/.65);
  col=mix(col,C,wipe);
  gl_FragColor=vec4(col,1.);
 }`});
 const mesh=new THREE.Mesh(new THREE.PlaneGeometry(W,H),material);mesh.position.z=-900;mesh.renderOrder=-100;mesh.userData.outline=false;mesh.userData.outlineOccluder=false;
 return {mesh,update(t){U.time.value=t}};
}
