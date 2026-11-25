// Scene-linear post pass. Arrays use WebGL row order (bottom row first) and column-major matrices.
// Directional shadows map world coordinates directly to [0,1]^3. No perspective divide.
const quarter = n => Math.max(2, Math.floor(n / 4));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fract = x => x - Math.floor(x);
const lerp = (a, b, t) => a + t * (b - a);
const f32 = Math.fround;
const smooth = (center, radius, x) => {
  const t = clamp(0.5 + (x - center) / (2 * radius), 0, 1);
  return t * t * (3 - 2 * t);
};
function size(w, h) {
  if (![w, h].every(n => Number.isInteger(n) && n > 0)) throw new TypeError('expected positive texture dimensions');
}
function vector(a, n, name) {
  if (!a || a.length !== n || !Array.from(a).every(Number.isFinite)) throw new TypeError(`invalid ${name}`);
}
function settings({enabled=true,beamGain=7,anisotropy=0,extinction=0,mode='correction'}={}) {
  if (!['correction','standalone'].includes(mode) || typeof enabled!=='boolean' || !Number.isFinite(beamGain) || beamGain<0 || beamGain>64 ||
      !Number.isFinite(anisotropy) || Math.abs(anisotropy)>0.95 || !Number.isFinite(extinction) || extinction<0 || extinction>10) {
    throw new RangeError('invalid volumetric scattering parameters');
  }
  return {enabled,beamGain,anisotropy,extinction,baseline:mode==='correction' ? 1 : 0};
}
function checkFrame(frame, gpu, anisotropy) {
  if (anisotropy!==0) {
    vector(frame.sunDirection,3,'sunDirection');
    if (!Math.hypot(...frame.sunDirection)) throw new TypeError('sunDirection must be nonzero');
  }
  vector(frame.cameraWorld, 16, 'cameraWorld'); vector(frame.inverseFocal, 2, 'inverseFocal'); vector(frame.lightColor, 3, 'lightColor');
  if (frame.skyDepth !== undefined && !(frame.skyDepth > 0)) throw new TypeError('invalid skyDepth');
  const { shadow, clouds } = frame;
  if (shadow !== null) {
    if (!shadow) throw new TypeError('supply shadow or explicitly use null for an unoccluded light');
    vector(shadow.matrix, 16, 'shadow.matrix');
    if (gpu) { if (!shadow.texture?.isTexture) throw new TypeError('missing shadow texture'); }
    else {
      size(shadow.width, shadow.height);
      if (shadow.data?.length !== shadow.width * shadow.height * (shadow.packed ? 4 : 1)) throw new TypeError('invalid shadow plane');
    }
  }
  if (!clouds) return;
  for (const [key,n] of [['slope',2],['azimuth',2],['offset',2],['storm',4],['segments',24],['radii',2]]) vector(clouds[key], n, `clouds.${key}`);
  if (![clouds.cover,clouds.frequency,clouds.ceiling,clouds.edge].every(Number.isFinite) || clouds.edge <= 0) throw new TypeError('invalid cloud field');
  if (gpu) { if (!clouds.texture?.isTexture) throw new TypeError('missing cloud texture'); }
  else { size(clouds.width, clouds.height); if (clouds.data?.length !== clouds.width * clouds.height * 4) throw new TypeError('invalid RGBA8 cloud tile'); }
}

// Return a bilinear sample, including edge extension for the shaft and periodic wrapping for the cloud tile.
function linear(data, w, h, u, v, stride = 1, channel = 0, repeat = false) {
  const px = (repeat ? fract(u) : clamp(u,0,1)) * w - 0.5, py = (repeat ? fract(v) : clamp(v,0,1)) * h - 0.5;
  const i = Math.floor(px), j = Math.floor(py), fx = px-i, fy = py-j;
  const x0 = repeat ? (i+w)%w : clamp(i,0,w-1), x1 = repeat ? (i+1)%w : clamp(i+1,0,w-1);
  const y0 = repeat ? (j+h)%h : clamp(j,0,h-1), y1 = repeat ? (j+1)%h : clamp(j+1,0,h-1);
  return lerp(lerp(data[(y0*w+x0)*stride+channel],data[(y0*w+x1)*stride+channel],fx),
    lerp(data[(y1*w+x0)*stride+channel],data[(y1*w+x1)*stride+channel],fx),fy);
}
function visibility(shadow, x, y, z) {
  if (!shadow) return 1;
  const {matrix:m,width:w,height:h,data} = shadow;
  const u=m[0]*x+m[4]*y+m[8]*z+m[12], v=m[1]*x+m[5]*y+m[9]*z+m[13], depth=m[2]*x+m[6]*y+m[10]*z+m[14];
  if (u<=0 || v<=0 || u>=1 || v>=1 || depth>=1) return 1;
  let i = Math.floor(v*h)*w + Math.floor(u*w), stored = data[i];
  if (shadow.packed) { // RGBA8, most significant byte first; alpha uses the full normalized interval.
    i *= 4; stored = data[i]/256 + data[i+1]/65536 + (data[i+2]+data[i+3]/255)/16777216;
  }
  return Number(depth - 0.0015 <= stored);
}
function opening(c, x, z, rough) {
  const lines=c.segments;
  let closed=1;
  for (let group=0; group<2; group++) {
    let dist=Infinity;
    for (let i=12*group; i<12*(group+1); i+=4) {
      const dx=lines[i+2]-lines[i], dz=lines[i+3]-lines[i+1], ox=x-lines[i], oz=z-lines[i+1];
      const t=clamp((ox*dx+oz*dz)/Math.max(0.001, dx*dx+dz*dz),0,1);
      dist=Math.min(dist,Math.hypot(ox-t*dx,oz-t*dz));
    }
    closed=Math.min(closed,smooth(c.radii[group],14,dist+rough*0.45));
  }
  return 1-closed;
}
function lightAt(c, x, y, z, vis, gain, baseline) {
  if (!c) return vis-baseline;
  const gx=x-y*c.slope[0], gz=z-y*c.slope[1], u=gx*c.frequency+c.offset[0], v=gz*c.frequency+c.offset[1];
  const sample = channel => linear(c.data,c.width,c.height,u,v,4,channel,true)/255;
  const direct=lerp(1,sample(0),c.cover), rough=(sample(1)-0.5)*70, rim=sample(2)*c.cover;
  const [front,strength,dusk,shade] = c.storm;
  const layer=strength*(1-smooth(front,c.edge,gz+rough))*(1-smooth(c.ceiling,9,y+0.3*rough));
  const hole=opening(c,gx,gz,rough);
  const daylight=direct*(1-layer*(1-hole))*(1-shade*smooth(dusk,20,gx*c.azimuth[0]+gz*c.azimuth[1]+rough));
  return daylight*(vis*(1+4.5*rim)-baseline) + vis*gain*direct*hole*layer;
}
// Round the intermediate to the precision of the half-float framebuffer (including ties to even).
function half(x) {
  if (!x) return x;
  const unit=2**Math.max(-24,Math.floor(Math.log2(Math.abs(x)))-10), v=x/unit, floor=Math.floor(v);
  return unit*(v-floor===0.5 ? floor+(floor&1) : Math.round(v));
}
/** Offline: depth is one positive view-Z distance per pixel (Infinity = sky); color is premultiplied RGBA.
 * skyDepth may be set to the metric sky cutoff of a normalized depth capture. lightColor includes shot strength. */
export function volumetricCPU(frame, params) {
  const {enabled,beamGain,anisotropy:g,extinction,baseline}=settings(params);
  const {width:w,height:h,depth,color:input} = frame;
  size(w,h); if(input?.length!==w*h*4) throw new TypeError('invalid color buffer');
  const sw=quarter(w), sh=quarter(h), shaft=new Float32Array(sw*sh), color=new Float32Array(input);
  const result={color,shaft,shaftWidth:sw,shaftHeight:sh};
  if (!enabled) return result;
  checkFrame(frame,false,g); if(depth?.length!==w*h) throw new TypeError('invalid metric depth plane');
  const {cameraWorld:m,inverseFocal,shadow,clouds,skyDepth=1e10,lightColor} = frame;
  const sun=frame.sunDirection, sunLength=g ? Math.hypot(...sun) : 1;
  for(let y=0;y<sh;y++) for(let x=0;x<sw;x++) {
    const u=(x+0.5)/sw,v=(y+0.5)/sh, sx=(2*u-1)*inverseFocal[0],sy=(2*v-1)*inverseFocal[1];
    const dx=m[0]*sx+m[4]*sy-m[8],dy=m[1]*sx+m[5]*sy-m[9],dz=m[2]*sx+m[6]*sy-m[10];
    const meters=(g || extinction) ? Math.hypot(dx,dy,dz) : 1;
    // HG relative to isotropic scattering (4π phase); Beer-Lambert uses ray length, not view Z.
    const cosTheta=g ? clamp((dx*sun[0]+dy*sun[1]+dz*sun[2])/(meters*sunLength),-1,1) : 0;
    const phase=(1-g*g)/(1+g*g-2*g*cosTheta)**1.5;
    let end=0;
    for(const oy of [-1,1]) for(const ox of [-1,1]) {
      const ix=clamp(Math.floor(u*w)+ox,0,w-1),iy=clamp(Math.floor(v*h)+oy,0,h-1);
      end=Math.max(end,depth[iy*w+ix]);
    }
    end=end>=skyDepth ? 110 : Math.min(240,end);
    const dot=f32(f32((x+0.5)*f32(0.06711056))+f32((y+0.5)*f32(0.00583715)));
    const jitter=fract(f32(f32(52.9829189)*fract(dot)));
    let sum=0;
    for(let i=0;i<14;i++) {
      const t=(i+jitter)/14, dist=end*t*(0.35+0.65*t);
      const px=m[12]+dist*dx, py=m[13]+dist*dy, pz=m[14]+dist*dz;
      const source=lightAt(clouds,px,py,pz,visibility(shadow,px,py,pz),beamGain,baseline);
      sum+=(0.1+Math.exp(-0.03*Math.max(0,py)))*source*(0.35+1.3*t)*(extinction ? Math.exp(-extinction*dist*meters) : 1);
    }
    shaft[y*sw+x]=half(sum*phase*end*(0.004/14));
  }
  for(let y=0,idx=0;y<h;y++) for(let x=0;x<w;x++,idx+=4) {
    const u=(x+0.5)/w,v=(y+0.5)/h;
    let s=0; for(const oy of [-4,4]) for(const ox of [-4,4]) s+=linear(shaft,sw,sh,u+ox/w,v+oy/h);
    for(let c=0;c<3;c++) color[idx+c]=Math.max(0,input[idx+c]+0.25*s*lightColor[c]*input[idx+3]);
  }
  return result;
}

const vertexShader=`varying vec2 uvScreen;
void main(){ uvScreen=position.xy*.5+.5; gl_Position=vec4(position.xy,0.,1.); }`;
const marchShader=`
#include <packing>
varying vec2 uvScreen;
uniform sampler2D tDepth, shadowTex, cloudTex;
uniform mat4 worldFromView, shadowProjection;
uniform vec2 invFocal, slope, azimuth, drift, radii;
uniform vec4 storm, lines[6];
uniform float skyCut, beamGain, frequency, cover, ceilingY, stormEdge;
uniform bool hasShadow, packedDepth, hasCloud;
uniform float anisotropy, extinction, baseline;
uniform vec3 sunDirection;
float visibility(vec3 p){
  if(!hasShadow) return 1.;
  vec3 q=(shadowProjection*vec4(p,1.)).xyz;
  if(q.x<=0. || q.x>=1. || q.y<=0. || q.y>=1. || q.z>=1.) return 1.;
  vec4 d=texture2D(shadowTex,q.xy);
  return step(q.z-.0015, packedDepth ? unpackRGBAToDepth(d) : d.r);
}
float lineDistance(vec2 p, vec4 ends){
  vec2 v=ends.zw-ends.xy, a=p-ends.xy;
  return length(a-v*clamp(dot(a,v)/max(.001,dot(v,v)),0.,1.));
}
float scatter(vec3 p){
  float vis=visibility(p);
  if(!hasCloud) return vis-baseline;
  vec2 ground=p.xz-p.y*slope;
  vec3 tile=texture2D(cloudTex,ground*frequency+drift).rgb;
  float rough=70.*(tile.g-.5), direct=mix(1.,tile.r,cover), rim=tile.b*cover;
  vec2 distanceToGap=vec2(1e15);
  for(int i=0;i<3;i++){
    distanceToGap=min(distanceToGap,vec2(lineDistance(ground,lines[i]),lineDistance(ground,lines[i+3])));
  }
  vec2 closure=smoothstep(radii-14.,radii+14.,distanceToGap+.45*rough);
  float hole=1.-min(closure.x,closure.y);
  float layer=storm.y*(1.-smoothstep(storm.x-stormEdge,storm.x+stormEdge,ground.y+rough));
  layer*=1.-smoothstep(ceilingY-9.,ceilingY+9.,p.y+.3*rough);
  float dusk=storm.w*smoothstep(storm.z-20.,storm.z+20.,dot(ground,azimuth)+rough);
  float sun=direct*(1.-layer*(1.-hole))*(1.-dusk);
  return sun*(vis*(1.+4.5*rim)-baseline) + vis*beamGain*direct*hole*layer;
}
float distanceAt(ivec2 pos,ivec2 sz){
  vec4 d=texelFetch(tDepth,clamp(pos,ivec2(0),sz-1),0);
  return d.a==0. ? skyCut : d.r;
}
void main(){
  ivec2 sz=textureSize(tDepth,0), p=ivec2(uvScreen*vec2(sz));
  float limit=0.;
  for(int y=-1;y<=1;y+=2) for(int x=-1;x<=1;x+=2) limit=max(limit,distanceAt(p+ivec2(x,y),sz));
  limit=limit>=skyCut ? 110. : min(240.,limit);
  vec3 ray=mat3(worldFromView)*vec3((2.*uvScreen-1.)*invFocal,-1.);
  float phase=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));
  float meters=length(ray), g=anisotropy;
  float cosTheta=clamp(dot(ray/meters,sunDirection),-1.,1.);
  float weight=(1.-g*g)/pow(1.+g*g-2.*g*cosTheta,1.5);
  float integral=0.;
  for(int i=0;i<14;i++){
    float t=(float(i)+phase)/14.;
    float z=limit*t*(.35+.65*t);
    vec3 point=worldFromView[3].xyz+ray*z;
    float density=.1+exp(-.03*max(0.,point.y));
    integral+=scatter(point)*density*(.35+1.30*t)*exp(-extinction*z*meters);
  }
  gl_FragColor=vec4(integral*weight*limit*(.004/14.),0.,0.,1.);
}`;
const combineShader=`varying vec2 uvScreen;
uniform sampler2D tInput, shaftTex;
uniform vec3 lightColor;
uniform bool enabled;
void main(){
  vec4 base=texelFetch(tInput,ivec2(gl_FragCoord.xy),0);
  if(enabled){
    vec2 d=4./vec2(textureSize(tInput,0)); float sum=0.;
    for(int y=-1;y<=1;y+=2) for(int x=-1;x<=1;x+=2) sum+=texture2D(shaftTex,uvScreen+vec2(x,y)*d).r;
    base.rgb=max(vec3(0.),base.rgb+(.25*sum*base.a)*lightColor);
  }
  gl_FragColor=base;
}`;
const slots = names => Object.fromEntries(names.split(' ').map(k=>[k,{value:null}]));
/** Native shot calls setFrame before drawing. Optional clouds: RGBA8 Repeat/Linear tile plus projection,
 * drift, two groups of three ground-plane segments and their radii. Shadow: scalar R or packed RGBA8, nearest.
 * renderShaft(renderer, metricDepthTexture) also exposes the internally owned quarter-size target for inspection. */
export function create({THREE}, params) {
  const {enabled,beamGain,anisotropy,extinction,baseline}=settings(params);
  const geom=new THREE.PlaneGeometry(2,2), scene=new THREE.Scene(), camera=new THREE.Camera();
  const mesh=(fragmentShader,uniforms)=>{
    const material=new THREE.ShaderMaterial({uniforms,vertexShader,fragmentShader, depthTest:false,depthWrite:false,
      blending:THREE.NoBlending,toneMapped:false});
    const quad=new THREE.Mesh(geom,material); quad.frustumCulled=false; return quad;
  };
  const u=slots('tDepth shadowTex cloudTex worldFromView shadowProjection invFocal slope azimuth drift radii storm lines skyCut beamGain frequency cover ceilingY stormEdge hasShadow packedDepth hasCloud anisotropy extinction baseline sunDirection');
  // All active uniforms (including those behind a dynamic branch) must have valid upload values.
  for (const k of ['slope','azimuth','drift','radii','invFocal']) u[k].value=new THREE.Vector2();
  for (const k of ['worldFromView','shadowProjection']) u[k].value=new THREE.Matrix4();
  u.storm.value=new THREE.Vector4(); u.lines.value=new Float32Array(24); u.beamGain.value=beamGain;
  u.anisotropy.value=anisotropy; u.extinction.value=extinction; u.baseline.value=baseline; u.sunDirection.value=new THREE.Vector3();
  const marcher=mesh(marchShader,u); scene.add(marcher);
  const out=slots('tInput tDepth shaftTex lightColor enabled'); out.lightColor.value=new THREE.Vector3(); out.enabled.value=enabled;
  const object=mesh(combineShader,out); object.name='post.volumetric';
  let target=null, ready=false;
  function setFrame(frame){
    checkFrame(frame,true,anisotropy);
    if (anisotropy) u.sunDirection.value.fromArray(frame.sunDirection).normalize();
    const {cameraWorld,inverseFocal,lightColor,shadow,clouds,skyDepth=1e10}=frame;
    u.worldFromView.value.fromArray(cameraWorld); u.invFocal.value.fromArray(inverseFocal); u.skyCut.value=Math.min(skyDepth,1e30);
    out.lightColor.value.fromArray(lightColor); u.hasShadow.value=Boolean(shadow); u.hasCloud.value=Boolean(clouds);
    u.shadowTex.value=shadow?.texture??null; u.packedDepth.value=Boolean(shadow?.packed);
    if (shadow) u.shadowProjection.value.fromArray(shadow.matrix);
    u.cloudTex.value=clouds?.texture??null;
    if (clouds){
      for (const key of ['slope','azimuth','radii','storm']) u[key].value.fromArray(clouds[key]);
      u.drift.value.fromArray(clouds.offset); u.lines.value.set(clouds.segments);
      u.ceilingY.value=clouds.ceiling; u.stormEdge.value=clouds.edge; u.frequency.value=clouds.frequency; u.cover.value=clouds.cover;
    }
    ready=true;
  }
  function renderShaft(renderer, depthTexture){
    if (!ready) throw new Error('post.volumetric requires setFrame before drawing');
    if (!depthTexture?.isTexture) throw new Error('post.volumetric requires metric tDepth');
    const {width,height}=depthTexture.image; size(width,height);
    const w=quarter(width),h=quarter(height);
    if (!target) target=new THREE.WebGLRenderTarget(w,h,{type:THREE.HalfFloatType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false});
    else target.setSize(w,h);
    u.tDepth.value=depthTexture;
    const old=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),level=renderer.getActiveMipmapLevel();
    try { renderer.setRenderTarget(target); renderer.render(scene,camera); }
    finally { renderer.setRenderTarget(old,face,level); }
    return target;
  }
  object.onBeforeRender=renderer=>{ if(enabled) out.shaftTex.value=renderShaft(renderer,out.tDepth.value).texture; };
  return {object,setFrame,renderShaft,dispose(){target?.dispose(); geom.dispose(); marcher.material.dispose(); object.material.dispose();}};
}
