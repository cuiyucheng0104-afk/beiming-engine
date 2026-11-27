// 同样的注入轨迹与粒子种子。流体使用上游 pass，帧号回退时从同一初态重放。
import * as THREE from 'three';
import { clamp, mulberry } from '../../../engine/core/math.js';
import { createFullscreen, renderTarget } from '../../../engine/look/pass.js';
import { shaders } from './upstream-fluid.js';

const edge = 192;
const fieldSize = 28;
const empty = new THREE.Vector3(0, 0, -1);
const negative = new THREE.Color(0, 0, 0);
const pair = () => {
  const targets = [renderTarget(edge, edge), renderTarget(edge, edge)];
  let i = 0;
  return { targets, get read() { return targets[i].texture; }, next() { i = 1 - i; return targets[i]; }, reset() { i = 0; } };
};

function injections(shot, onset) {
  return Array.from({ length: fieldSize }, (_, i) => {
    const a = i / (fieldSize - 1);
    if (shot === 0) {
      const spiral = i * 2.39;
      const radius = .014 + .074 * a;
      return { f: onset + i, x: .47 + Math.cos(spiral) * radius, y: .54 + Math.sin(spiral) * radius, vx: Math.cos(spiral) * (106 + 65 * a), vy: Math.sin(spiral) * (106 + 65 * a), r: .0015, amount: .14 };
    }
    const bend = Math.sin(a * Math.PI * 1.3);
    return { f: onset + i, x: .21 + .57 * a, y: .33 + .10 * bend + .22 * a, vx: 100 + 22 * bend, vy: 97 + 134 * Math.sin(i * .69), r: .0017, amount: .15 };
  });
}

function makeFluid(renderer, fx) {
  const vel = pair(), dye = pair(), pressure = pair();
  const curl = renderTarget(edge, edge), div = renderTarget(edge, edge);
  const texel = new THREE.Vector2(1 / edge, 1 / edge);
  const uv = new THREE.Vector2(), rgb = new THREE.Vector3();
  const passes = Object.fromEntries(Object.entries(shaders).map(([key, src]) => [
    key, fx.material(src, { texelSize: { value: texel } }),
  ]));
  function draw(key, uniforms, target) {
    const pass = passes[key];
    for (const [name, value] of Object.entries(uniforms)) {
      const item = pass.uniforms[name] ??= { value };
      item.value = value;
    }
    fx.draw(pass, target);
  }
  function swap(key, uniforms, target) { draw(key, uniforms, target.next()); }

  return {
    get texture() { return dye.read; },
    reset() {
      const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
      renderer.setClearColor(negative, 0);
      for (const buffer of [vel, dye, pressure]) {
        buffer.reset();
        for (const target of buffer.targets) {
          renderer.setRenderTarget(target);
          renderer.clear();
        }
      }
      renderer.setClearColor(clear, alpha);
    },
    step(input) {
      const dt = 1 / 24;
      swap('advection', { uVelocity: vel.read, uSource: vel.read, dt, dissipation: .984 }, vel);
      swap('advection', { uVelocity: vel.read, uSource: dye.read, dt, dissipation: .990 }, dye);
      if (input) {
        const { x,y,vx,vy,r,amount } = input;
        uv.set(x * 2 - 1, y * 2 - 1);
        swap('splat', { uTarget: vel.read, point: uv, aspectRatio: 1, color: rgb.set(vx, vy, 0), radius: r * 2.5 }, vel);
        swap('splat', { uTarget: dye.read, point: uv, aspectRatio: 1, color: rgb.setScalar(amount), radius: r }, dye);
      }
      draw('curl', { uVelocity: vel.read }, curl);
      swap('vorticity', { uVelocity: vel.read, uCurl: curl.texture, dt, curl: 22 }, vel);
      draw('divergence', { uVelocity: vel.read }, div);
      swap('clear', { uTexture: pressure.read, value: .9 }, pressure);
      for (let i = 0; i < 6; i++) swap('pressure', { uPressure: pressure.read, uDivergence: div.texture }, pressure);
      swap('gradientSubtract', { uPressure: pressure.read, uVelocity: vel.read }, vel);
    },
  };
}

const composition = /* glsl */`
uniform sampler2D dye, cpu, gpu;
uniform vec3 pane;
uniform vec2 paneSize;
uniform vec3 deposits[${fieldSize}];
uniform float strength[${fieldSize}];
uniform float shot;
varying vec2 vUv;

float hash(vec2 p){ return fract(sin(dot(p,vec2(41.4,259.1)))*43758.5453); }
float noise(vec2 p) {
  vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1)),f.x),f.y);
}
void main(){
  bool b=gl_FragCoord.x>=pane.y;
  vec2 uv=(gl_FragCoord.xy-vec2(b?pane.y:pane.x,pane.z))/paneSize;
  vec3 col=vec3(.004,.008,.011);
  if (all(greaterThan(uv,vec2(0))) && all(lessThan(uv,vec2(1)))) {
    float grain=noise(uv*vec2(490.,320.))-.5;
    float vignette=1.-.60*dot(uv-.5,uv-.5);
    float y=uv.y;
    if (shot<1.5) {
      float d=0.;
      for(int i=0;i<${fieldSize};i++){
        vec3 s=deposits[i];
        if(s.z<0.) continue;
        float age=s.z;
        vec2 p=uv-s.xy;
        if(shot>.5) p.y-=age*.0018;
        float radius=.0015+age*(shot<.5?.000095:.00018);
        float wob=.70+.60*noise(uv*(shot<.5?129.:40.)+float(i)*.23);
        d+=exp(-dot(p,p)/(radius*wob))*exp(-age*.034)*strength[i];
      }
      if(b) d=texture2D(dye,uv).r;
      if(shot<.5) {
        vec3 paper=vec3(.74,.64,.45)*vignette+(grain+.35*(noise(uv*75.)-.5))*.072;
        col=mix(paper,vec3(.013,.027,.031),1.-exp(-d*3.3));
        col+=vec3(.20,.10,.055)*d*exp(-d*8.)*.42;
      } else {
        vec3 bg=mix(vec3(.014,.019,.031),vec3(.028,.051,.065),y)*vignette+grain*.01;
        float haze=1.-exp(-d*2.5);
        col=mix(bg,mix(vec3(.29,.43,.50),vec3(.92,.67,.38),smoothstep(.33,.74,uv.x)),haze);
      }
    } else {
      vec3 dots=b?texture2D(gpu,uv).rgb:texture2D(cpu,uv).rgb;
      vec3 haze=mix(vec3(.012,.024,.031),vec3(.029,.055,.067),y)*vignette;
      float grid=smoothstep(.982,1.,max(fract(uv.x*16.),fract(uv.y*12.)))*.009;
      col=haze+grid+grain*.007+dots;
    }
    float border=min(min(uv.x,1.-uv.x)*paneSize.x,min(uv.y,1.-uv.y)*paneSize.y);
    col=mix(vec3(.11,.16,.18),col,smoothstep(0.,1.6,border));
  }
  gl_FragColor=vec4(col,1.);
  #include <colorspace_fragment>
}`;

function makeType(renderer) {
  const n = 7000, random = mulberry(20911);
  const canvas = document.createElement('canvas');
  canvas.width = 620;
  canvas.height = 288;
  const ctx = canvas.getContext('2d');
  ctx.font = '900 224px "PingFang SC", "Hiragino Sans GB", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('北冥', 310, 147);
  const data = ctx.getImageData(0, 0, 620, 288).data;
  const eligible = [];
  for (let i = 0; i < 620 * 288; i++) if (data[i * 4 + 3] > 120) eligible.push(i);
  if (eligible.length < 1000) throw new Error('聚字点阵不足');
  const origin = new Float32Array(n * 3), target = new Float32Array(n * 3);
  const seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 3, pixel = eligible[Math.floor(random() * eligible.length)];
    const a = random() * Math.PI * 2, r = Math.sqrt(random()) * .88;
    origin[j] = Math.cos(a) * r;
    origin[j + 1] = Math.sin(a) * r;
    target[j] = (pixel % 620 / 620 - .5) * 1.70;
    target[j + 1] = (.5 - Math.floor(pixel / 620) / 288) * .82;
    seeds[i] = random();
  }
  const pointsVertex = /* glsl */`
    attribute vec3 destination;
    attribute float seed;
    uniform float p, enhanced, pointScale;
    varying vec3 pointColor;
    void main() {
      vec3 newPosition = mix(position, destination, p);
      if (enhanced > .5) {
        float spread = sin(3.14159265*p);
        float angle = seed*6.283185+5.0*p;
        newPosition.xy += vec2(cos(angle),sin(angle)) * spread * (.12+.18*seed);
      }
      pointColor = mix(vec3(.14,.49,.50), vec3(.99,.53,.19), seed);
      gl_Position=vec4(newPosition,1.);
      gl_PointSize=pointScale*(1.+1.65*seed);
    }`;
  // 透明度衰减公式派生自 useMorphParticles/shaders/main.frag，MIT 许可见作品目录。
  const pointsFragment = /* glsl */`
    varying vec3 pointColor;
    uniform float enhanced;
    void main(){
      float d = length(gl_PointCoord-.5);
      float alpha = enhanced>.5 ? clamp(.19/max(d,.001)-(1.-.47),0.,1.) : step(d,.47)*.72;
      gl_FragColor=vec4(pointColor*(.17 + .12*enhanced),alpha);
    }`;
  const geoCpu = new THREE.BufferGeometry(), geoGpu = new THREE.BufferGeometry();
  function geometry(g, vertices) {
    g.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    g.setAttribute('destination', new THREE.BufferAttribute(target, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
  }
  geometry(geoCpu, origin.slice());
  geometry(geoGpu, origin);
  const layers = [geoCpu, geoGpu].map((geo, i) => {
    const scene = new THREE.Scene();
    const material = new THREE.ShaderMaterial({ vertexShader:pointsVertex, fragmentShader:pointsFragment,
      uniforms:{ p:{value:0}, enhanced:{value:i}, pointScale:{value:1} },
      blending:THREE.AdditiveBlending, transparent:true, depthTest:false, depthWrite:false });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    scene.add(points);
    return { scene, material, target:renderTarget(1,1) };
  });
  const camera = new THREE.Camera();
  return {
    layers,
    resize(w,h) { for (const layer of layers) { layer.target.setSize(w,h); layer.material.uniforms.pointScale.value = Math.max(1, h/480); } },
    draw(progress) {
      const attr = geoCpu.getAttribute('position');
      for (let i = 0; i < attr.array.length; i++) attr.array[i] = origin[i] * (1 - progress) + target[i] * progress;
      attr.needsUpdate = true;
      layers[1].material.uniforms.p.value = progress;
      for (const layer of layers) {
        renderer.setRenderTarget(layer.target);
        renderer.render(layer.scene, camera);
      }
    },
  };
}

export function buildEffects(renderer, timing) {
  const fx = createFullscreen(renderer);
  const fluid = makeFluid(renderer, fx);
  const type = makeType(renderer);
  const onset = timing.events.map(event => event.frame - timing.shot(event.shot).in);
  const inputs = [injections(0, onset[0]), injections(1, onset[1])];
  const deposits = Array.from({ length: fieldSize }, () => empty.clone());
  const strengths = Array(fieldSize).fill(0);
  const compositionMat = fx.material(composition, {
    deposits: { value: deposits }, strength: { value: strengths },
    pane: { value: new THREE.Vector3() }, paneSize:{ value: new THREE.Vector2() },
    shot:{ value: 0 }, dye: { value: null },
    cpu: { value: type.layers[0].target.texture }, gpu: { value: type.layers[1].target.texture },
  });
  let simulatedShot = -1, lastFrame = -1;
  return {
    resize(w,h) {
      const pw = Math.round(w*.45), ph = Math.round(h*.65);
      type.resize(pw, ph);
      compositionMat.uniforms.pane.value.set(Math.round(w*.04),Math.round(w*.51),Math.round(h*.12));
      compositionMat.uniforms.paneSize.value.set(pw,ph);
    },
    render(shot, frame) {
      if (shot < 2) {
        const track = inputs[shot];
        if (simulatedShot !== shot || frame < lastFrame) { fluid.reset(); simulatedShot = shot; lastFrame = -1; }
        for (let f = lastFrame + 1; f <= frame; f++) fluid.step(track[f-onset[shot]]);
        lastFrame = frame;
        track.forEach(({x,y,f,amount},i) => { deposits[i].set(x,y,frame-f); strengths[i]=amount; });
        compositionMat.uniforms.dye.value = fluid.texture;
      } else {
        const p = clamp((frame-onset[shot])/41);
        type.draw(p*p*(3-2*p));
      }
      compositionMat.uniforms.shot.value = shot;
      fx.draw(compositionMat, null);
    },
  };
}
