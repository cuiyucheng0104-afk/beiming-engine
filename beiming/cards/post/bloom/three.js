// 场景线性 HDR。不依赖包解析器；页面在 create 时提供与 renderer 同版的 THREE。
const LIMIT = 65504; // binary16 最大有限值
const DEFAULTS = { enabled: true, additive: false, threshold: 0, knee: 0, intensity: 0.085, radius: 1, clamp: LIMIT };
const BOUNDS = { threshold: LIMIT, knee: LIMIT, intensity: 1, radius: 8, clamp: LIMIT };

function settings(params) {
  const p = { ...DEFAULTS, ...params };
  p.intensity = params.intensity ?? params.strength ?? DEFAULTS.intensity;
  for (const key of ['enabled','additive']) if (typeof p[key] !== 'boolean') throw new TypeError(`${key} 必须是布尔量`);
  for (const [key,max] of Object.entries(BOUNDS)) {
    if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] > max) throw new RangeError(`${key} 超出 [0, ${max}]`);
  }
  return p;
}

// 每个 tap 用源图的 texel 为单位。把重叠的四个 2×2 平均核展开合并，避免重复取样。
const FIRST = [[-1,-1,1],[1,-1,1],[-1,1,1],[1,1,1]];
const WIDE = [[0,0,4],[-2,-2,1],[2,-2,1],[-2,2,1],[2,2,1],
  [-2,0,2],[2,0,2],[0,-2,2],[0,2,2], ...FIRST.map(([x,y]) => [x,y,4])]; // 权重和 32
const TENT = Array.from({length:9}, (_, i) => {
  const x = i%3-1, y = Math.floor(i/3)-1;
  return [x,y,(2-Math.abs(x))*(2-Math.abs(y))];
});
const halfSize = n => Math.max(1, Math.floor(n / 2));

// 较老的 JS 宿主没有 f16round；次正规数和中点同样按 IEEE nearest-even 舍入。
const half = Math.f16round ?? (v => {
  if (v === 0) return 0;
  const step = 2 ** Math.max(-24, Math.floor(Math.log2(v))-10), units = v/step, lo = Math.floor(units);
  return step * (units-lo === 0.5 ? lo+(lo%2) : Math.round(units));
});

// 源坐标以像素中心为整数，与归一化 UV 的 clamp-to-edge / bilinear 一致。
function sample({width:w,height:h,data}, stride, x, y, out) {
  x = Math.min(w-1, Math.max(0,x)); y = Math.min(h-1, Math.max(0,y));
  const ix = Math.floor(x), iy = Math.floor(y), fx = x-ix, fy = y-iy;
  const a = stride*(iy*w+ix), b = a+(ix+1 < w ? stride : 0);
  const dy = iy+1 < h ? w*stride : 0;
  for (let c=0; c<3; c++) {
    const top = data[a+c]+fx*(data[b+c]-data[a+c]);
    const bottom = data[a+dy+c]+fx*(data[b+dy+c]-data[a+dy+c]);
    out[c] = top+fy*(bottom-top);
  }
}

function filter(src, stride, width, height, kernel, p, base) {
  const data = new Float32Array(width*height*3), rgb = [0,0,0];
  const radius = base ? p.radius : 1;
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    const sx = (x+0.5)*src.width/width-0.5, sy = (y+0.5)*src.height/height-0.5;
    let r=0, g=0, b=0, total=0;
    for (const [dx,dy,gain] of kernel) {
      sample(src,stride,sx+dx*radius,sy+dy*radius,rgb);
      let w = gain;
      if (kernel === FIRST) {
        for (let c=0; c<3; c++) rgb[c] = Math.min(p.clamp,Math.max(0,rgb[c]));
        const peak = Math.max(rgb[0],rgb[1],rgb[2]);
        // 软膝以阈值为中心，阈值和膝宽为零时完整保留暗部。
        const soft = Math.min(2*p.knee, Math.max(0,peak-p.threshold+p.knee));
        const kept = Math.max(peak-p.threshold, p.knee ? soft*soft/(4*p.knee) : 0);
        const fraction = peak > 0 ? Math.min(1,kept/peak) : 0;
        w = 1/(1+peak*fraction);
        for (let c=0; c<3; c++) rgb[c] *= fraction;
      }
      r+=w*rgb[0]; g+=w*rgb[1]; b+=w*rgb[2]; total+=w;
    }
    const i = 3*(y*width+x);
    if (base) {
      data[i] = half(0.38*base.data[i]+0.62*r/total);
      data[i+1] = half(0.38*base.data[i+1]+0.62*g/total);
      data[i+2] = half(0.38*base.data[i+2]+0.62*b/total);
    } else {
      data[i] = half(r/total); data[i+1] = half(g/total); data[i+2] = half(b/total);
    }
  }
  return { width,height,data };
}

/** RGB(A) 浮点按行紧排；返回独立的合成帧和由大到小的 RGB 中间层，不改变输入。 */
export function bloomReference({width,height,color}, params={}) {
  const p = settings(params), stride = color?.length/(width*height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width<1 || height<1 ||
      !(color instanceof Float32Array) || (stride!==3 && stride!==4)) throw new TypeError('需要 width × height 的 Float32 RGB 或 RGBA color');
  const out = color.slice(), down = [], up = [];
  if (!p.enabled || p.intensity===0) return {color:out,down,up};
  let src = {width,height,data:color};
  for (let i=0; i<4; i++) {
    src = filter(src,i ? 3 : stride,halfSize(src.width),halfSize(src.height),i ? WIDE : FIRST,p);
    down.push(src);
  }
  for (let i=2; i>=0; i--) {
    const base = down[i];
    src = filter(src,3,base.width,base.height,TENT,p,base);
    up[i] = src;
  }
  const rgb=[0,0,0], sourceGain=p.additive ? 1 : 1-p.intensity;
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    sample(src,3,(x+0.5)*src.width/width-0.5,(y+0.5)*src.height/height-0.5,rgb);
    const i = (y*width+x)*stride;
    for (let c=0; c<3; c++) out[i+c] = sourceGain*color[i+c]+p.intensity*rgb[c];
  }
  return {color:out,down,up};
}

const VERTEX = `varying vec2 pos;
void main(){ pos = uv; gl_Position = vec4(position.xy,0.0,1.0); }`;
const HEADER = `varying vec2 pos; uniform sampler2D tInput;`;
// 宿主的场景纹理可能声明 NEAREST；不改动共享采样状态，在首级显式插值。
const KARIS = `${HEADER}
uniform float threshold, knee, ceiling;
vec3 prefilter(vec2 coord){
  ivec2 size = textureSize(tInput,0);
  vec2 xy = clamp(coord,vec2(0.),vec2(size-1));
  ivec2 a = ivec2(floor(xy)), b = min(a+1,size-1); vec2 f = fract(xy);
  vec3 c = mix(mix(texelFetch(tInput,a,0).rgb,texelFetch(tInput,ivec2(b.x,a.y),0).rgb,f.x),
               mix(texelFetch(tInput,ivec2(a.x,b.y),0).rgb,texelFetch(tInput,b,0).rgb,f.x),f.y);
  c = clamp(c,vec3(0.),vec3(ceiling));
  float peak=max(max(c.r,c.g),c.b), s=clamp(peak-threshold+knee,0.,2.*knee);
  float kept=max(peak-threshold,knee>0. ? s*s/(4.*knee) : 0.);
  return c*(peak>0. ? min(1.,kept/peak) : 0.);
}
void main(){
  vec2 center=pos*vec2(textureSize(tInput,0))-0.5; vec4 accum=vec4(0.);
  for(int y=-1;y<=1;y+=2) for(int x=-1;x<=1;x+=2){
    vec3 c=prefilter(center+vec2(x,y)); accum+=vec4(c,1.)/(1.+max(max(c.r,c.g),c.b));
  }
  gl_FragColor=vec4(accum.rgb/accum.a,1.);
}`;

function weightedShader(kernel, isUp) {
  const body=kernel.map(([x,y,w])=>`${w}.0*texture2D(tInput,pos+vec2(${x}.0,${y}.0)*stepUV).rgb`).join('+\n');
  return `${HEADER} uniform sampler2D base; uniform float radius;
void main(){ vec2 stepUV=${isUp ? 'radius' : '1.0'}/vec2(textureSize(tInput,0));
  vec3 result=(${body})/${isUp ? '16.' : '32.'};
  gl_FragColor=vec4(${isUp ? 'mix(texture2D(base,pos).rgb,result,0.62)' : 'result'},1.);
}`;
}
const COMPOSE = `${HEADER} uniform sampler2D glow; uniform float intensity; uniform bool additive;
void main(){
  vec4 c=texelFetch(tInput,ivec2(pos*vec2(textureSize(tInput,0))),0);
  if(intensity>0.) {
    vec3 b=texture2D(glow,pos).rgb;
    c.rgb=additive ? c.rgb+intensity*b : mix(c.rgb,b,intensity);
  }
  gl_FragColor=c;
}`;

/** 宿主把全尺寸输入填入 object.material.uniforms.tInput，再像普通后期通道一样绘制。 */
export function create({THREE:T}, params={}) {
  const p = settings(params), geo = new T.PlaneGeometry(2,2), camera = new T.Camera();
  const targets = {down:[],up:[]};
  const material = (fragmentShader,values) => new T.ShaderMaterial({vertexShader:VERTEX,fragmentShader,
    uniforms:Object.fromEntries(Object.entries({tInput:null,...values}).map(([k,value])=>[k,{value}])),
    depthTest:false,depthWrite:false,blending:T.NoBlending,toneMapped:false});
  const first = material(KARIS,{threshold:p.threshold,knee:p.knee,ceiling:p.clamp});
  const wide = material(weightedShader(WIDE,false),{}), tent = material(weightedShader(TENT,true),{base:null,radius:p.radius});
  const compose = material(COMPOSE,{glow:null,additive:p.additive,intensity:p.enabled ? p.intensity : 0});
  const object = new T.Mesh(geo,compose), quad = new T.Mesh(geo,first);
  object.name='post.bloom'; object.frustumCulled=quad.frustumCulled=false;
  function fit(list,i,width,height) {
    const rt=list[i] ??= new T.WebGLRenderTarget(width,height,{type:T.HalfFloatType,depthBuffer:false,
      minFilter:T.LinearFilter,magFilter:T.LinearFilter,generateMipmaps:false});
    rt.setSize(width,height);
    return rt;
  }
  object.onBeforeRender = renderer => {
    if (!p.enabled || p.intensity===0) return;
    let source=compose.uniforms.tInput.value;
    let width=source?.image?.width, height=source?.image?.height;
    if (!width || !height) throw new TypeError('tInput 需要带尺寸的场景线性颜色纹理');
    const destination=renderer.getRenderTarget(), face=renderer.getActiveCubeFace(), mip=renderer.getActiveMipmapLevel();
    const draw = (mat,rt) => {
      mat.uniforms.tInput.value=source; quad.material=mat;
      renderer.setRenderTarget(rt); renderer.render(quad,camera); source=rt.texture;
    };
    try {
      for (let i=0;i<4;i++) {
        width=halfSize(width); height=halfSize(height);
        draw(i===0 ? first : wide, fit(targets.down,i,width,height));
      }
      for (let i=2;i>=0;i--) {
        const base=targets.down[i]; tent.uniforms.base.value=base.texture;
        draw(tent,fit(targets.up,i,base.width,base.height));
      }
      compose.uniforms.glow.value=source;
    } finally { renderer.setRenderTarget(destination,face,mip); }
  };
  return {object,targets,dispose(){
    for (const rt of [...targets.down,...targets.up]) rt.dispose();
    for (const mat of [first,wide,tent,compose]) mat.dispose();
    geo.dispose();
  }};
}
