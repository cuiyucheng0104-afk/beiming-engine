import {
  evaluateFireParticles,
  evaluateEmberParticles,
  evaluateSmokeParticles,
  makeDeterministicBirthAttributes,
} from '../../../cards/particle/fx-breath/index.mjs';
import { MINPX_VERTEX_GLSL, pixelWorldFactor } from '../../../cards/particle/minpx/three.js';
import { SOFT_DEPTH_GLSL } from '../../../cards/particle/soft/three.js';
import { applyPremultBlending } from '../../../cards/particle/premult/three.js';
import { poolEmitters } from '../../../cards/lighting/emit-pool/index.mjs';
import { smoothstep } from '../../../cards/motion/impulse/index.mjs';
import { add, unit, off, envelope, wakeTable } from './motion-flight.js';

const counts = [1100, 620, 170],
  attrs = counts.map((n, i) => makeDeterministicBirthAttributes(n, [11, 14, 114][i]));
export function emissionAt(time, body, params) {
  const direction = unit(add(body.forward, body.up, -0.62)),
    mouth = body.mouth;
  const intensity = envelope(time),
    run = smoothstep(46.45636, 46.89636, time),
    length = Math.max(2.5, 33 * run);
  const breath = { mouth, direction, intensity, length, limit: run < 1 ? length : 10000 };
  const wake = { uTime: time, uT0: 46.4, uSpan: 2.1, ...wakeTable(params) };
  const particles = off(params, 'fx.breath')
    ? { fire: [], embers: [], smoke: [] }
    : {
        fire: evaluateFireParticles({
          uTime: time,
          uMouth: mouth,
          uDir: direction,
          uLen: breath.limit,
          uReach: 1.95,
          uRoar: 0.28 * intensity,
          aR: attrs[0],
        }).particles,
        embers: evaluateEmberParticles({ ...wake, aR: attrs[1] }).particles,
        smoke: evaluateSmokeParticles({ ...wake, aR: attrs[2], uSR: 1.55, uSK: [1.2, 0.9, 1] }).particles,
      };
  const emit = (d, power, color, distance) => ({
    position: add(mouth, direction, d),
    intensity: power * intensity,
    color,
    distance,
  });
  const sources = [
    emit(Math.min(7, breath.limit / 2), 480 * (0.8 + 0.2 * Math.sin(time * 37)), [1, 0.4, 0.1], 150),
    emit(Math.max(3, length * 0.72), 1500 * (0.8 + 0.2 * Math.sin(time * 31 + 2)), [1, 0.42, 0.1], 210),
  ];
  return {
    breath,
    particles,
    light: poolEmitters(off(params, 'light.emit-pool') || off(params, 'fx.breath') ? [] : sources, {
      fallbackPosition: mouth,
    }),
  };
}

// The turbulent tip and the narrower incandescent ribbon are evaluated in world space;
// their depth fade uses the opaque camera pass, never an authored mask.
export const noise2 = `float hash21(vec2 p){vec3 q=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float n2(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash21(i),hash21(i+vec2(1,0)),f.x),mix(hash21(i+vec2(0,1)),hash21(i+1.),f.x),f.y);}
float fb(vec2 p){return .55*n2(p)+.28*n2(p*2.1+4.)+.12*n2(p*4.4+17.)+.05*n2(p*8.8);}`;
export function plumeMeshes(T, params, fxScene, width, height) {
  // Three independently seeded, periodic velocity bands. The domain scrolls down
  // the jet; it never depends on screen coordinates or on a representative frame.
  const flowNoise = `float lattice(vec2 cell,float period,float salt){vec2 q=mod(cell,period);return fract(43758.5453*sin(q.x*127.1+q.y*311.7+17.31*salt));}
    float periodicBand(vec2 st,float freq,float seed){float sum=0.,w=.5;for(int j=0;j<5;j++){vec2 x=fract(st)*freq,ij=floor(x),v=fract(x);v*=v*(3.-2.*v);float s=seed+float(j)*3.7;
      vec2 pair=vec2(mix(lattice(ij,freq,s),lattice(ij+vec2(1,0),freq,s),v.x),mix(lattice(ij+vec2(0,1),freq,s),lattice(ij+1.,freq,s),v.x));sum+=w*mix(pair.x,pair.y,v.y);freq*=2.;w*=.5;}return sum/.96875;}`;
  const u = {
    tDepth: { value: null },
    uRes: { value: new T.Vector2(width, height) },
    uNear: { value: 0.5 },
    uFar: { value: 6000 },
    uMinPx: { value: 1.25 },
    uPxK: { value: 0.001 },
    uHasDepth: { value: 0 },
    uTime: { value: 0 },
    uDir: { value: new T.Vector3() },
    uMouth: { value: new T.Vector3() },
    uLength: { value: 0 },
    uPower: { value: 0 },
  };
  const depth = `${SOFT_DEPTH_GLSL}\nuniform float uHasDepth;float vis(float z,float softness){return uHasDepth<0.5?1.:${off(params, 'particle.soft') ? 'step(sceneZ(),z)' : 'softZ(z,softness)'};}`;
  function material(vs, fs) {
    const m = new T.ShaderMaterial({
      uniforms: u,
      vertexShader: vs,
      fragmentShader: fs,
      toneMapped: false,
      transparent: true,
      side: T.DoubleSide,
      depthTest: false,
      depthWrite: false,
      forceSinglePass: true,
    });
    if (!off(params, 'particle.premult')) applyPremultBlending(m, T);
    else m.blending = T.NormalBlending;
    return m;
  }
  const groups = ['fire', 'embers', 'smoke'].map((kind, i) => {
    const base = new T.PlaneGeometry(1, 1),
      g = new T.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('uv', base.attributes.uv);
    const make = (n, s) => {
      const a = new T.InstancedBufferAttribute(new Float32Array(counts[i] * s), s);
      g.setAttribute(n, a);
      return a;
    };
    const pos = make('center', 3),
      prop = make('prop', 4),
      random = make('seed', 2);
    const vs = `${MINPX_VERTEX_GLSL}\nattribute vec3 center;attribute vec4 prop;attribute vec2 seed; uniform vec3 uDir;varying float vz,w,life;varying vec2 tc;void main(){tc=uv;vec4 v=modelViewMatrix*vec4(center,1.);vz=v.z;float e=1.;float size=${off(params, 'particle.minpx') ? 'prop.x' : 'minPxWorldSize(prop.x,v.z,uMinPx,uPxK,e)'};life=prop.z;w=prop.y*e;vec2 q=position.xy;float a=seed.x*6.283+prop.w*2.;vec2 axis=vec2(cos(a),sin(a));
      ${i === 0 ? 'if(seed.y>.78){vec2 projected=(viewMatrix*vec4(uDir,0.)).xy;axis=normalize(projected+vec2(1e-6));q*=vec2(3.*length(projected),.62);}' : ''}
      v.xy+=size*(q.x*axis+q.y*vec2(-axis.y,axis.x));gl_Position=projectionMatrix*v;}`;
    const fs = `${depth}\n${noise2}\nvarying float vz,w,life;varying vec2 tc;
    void main(){vec2 q=tc*2.-1.;float radius=length(q);float n=fb(q*4.+2.);float puff=1.-smoothstep(.16,1.,radius+.36*(n-.52));float a=w*vis(vz,${i === 2 ? '4.2' : i === 0 ? '3.' : '1.5'});
    ${i === 0 ? 'vec3 col=mix(vec3(4.2,2.3,.7),vec3(3.,.62,.06),smoothstep(0.,.30,life));col=mix(col,vec3(.9,.06,.015),smoothstep(.30,.85,life));float textureLight=clamp(.24+.42*puff+.35*n,0.,1.);vec3 emission=col*a*puff*(.10+2.3*pow(textureLight,3.))*.17*(1.-smoothstep(.55,1.,life));gl_FragColor=vec4(emission,0.);' : i === 1 ? 'float disk=1.-smoothstep(0.,1.,radius);gl_FragColor=vec4(vec3(12.,3.2,.50)*disk*disk*a,0.);' : 'float alpha=a*puff*.27;gl_FragColor=vec4(mix(vec3(.25,.11,.095),vec3(.045,.018,.024),life)*alpha,alpha);'} }`;
    const mesh = new T.Mesh(g, material(vs, fs));
    mesh.name = kind;
    mesh.frustumCulled = false;
    mesh.renderOrder = [3, 4, 1][i];
    fxScene.add(mesh);
    return function update(items) {
      g.instanceCount = items.length;
      for (let j = 0; j < items.length; j++) {
        const e = items[j],
          k = e.slot * 4,
          ar = attrs[i];
        pos.setXYZ(j, ...e.world);
        prop.setXYZW(j, e.sizeM, e.weight, e.lifeNorm ?? 0, e.age);
        random.setXY(j, ar[k], (ar[k] * 7.31 + ar[k + 2] * 3.7) % 1);
      }
      for (const a of [pos, prop, random]) a.needsUpdate = true;
    };
  });
  const uniforms = `uniform vec3 uMouth,uDir;uniform float uLength,uPower,uTime;varying vec2 tc;varying float vz;`;
  const ribbon = new T.Mesh(
    new T.PlaneGeometry(1, 1, 32, 1),
    material(
      `${uniforms}void main(){tc=uv;vec3 c=uMouth+uDir*uLength*uv.x;vec3 axis=normalize(cross(uDir,c-cameraPosition));float width=2.*mix(1.5,6.2,uv.x);vec4 v=viewMatrix*vec4(c+axis*position.y*width,1.);vz=v.z;gl_Position=projectionMatrix*v;}`,
      `${uniforms}${flowNoise}\n${depth}\nvoid main(){float x=tc.x,y=2.*tc.y-1.,distance=x*2.6,phase=uTime*3.6;float wide=periodicBand(vec2(.35*(distance-phase),.5+.16*y),4.,1.);float n=periodicBand(vec2(.80*distance-.62*phase,.2+.27*y),4.,9.),fine=periodicBand(vec2(1.9*distance-1.1*phase,.7+.45*y),8.,21.);float drift=(n-.5)*.85+(fine-.5)*.35;float r=(y+drift)/(1.+1.8*(wide-.5));float core=exp(-44.*r*r);float cloud=exp(-2.3*pow(y+drift,2.))*(.30+.9075*(n+fine));float veil=smoothstep(.42,.79,cloud)*max(0.,1.-y*y);float wave=pow(.5+.5*sin((2.6*x-3.6*uTime)*9.),6.);float ends=smoothstep(0.,.045,x)*(1.-smoothstep(.90,1.,x))*vis(vz,2.);vec3 radiance=vec3(9.,6.6,3.2)*core*(1.+wave)+vec3(3.6,.95,.10)*veil*(.7+1.6*cloud)*2.1;gl_FragColor=vec4(radiance*ends*uPower*.53,veil*ends*uPower*.72);}`,
    ),
  );
  const tip = new T.Mesh(
    new T.PlaneGeometry(1, 1),
    material(
      `${uniforms}void main(){tc=uv;vec4 v=viewMatrix*vec4(uMouth+uDir*max(3.,uLength*(.93+.05*sin(uTime*11.)+.03*sin(uTime*23.+1.))),1.);v.xy+=position.xy*mix(9.6,21.1,uLength/33.)*(.9+.1*sin(uTime*17.));vz=v.z;gl_Position=projectionMatrix*v;}`,
      `${uniforms}${noise2}\n${depth}\nvoid main(){vec2 q=2.*tc-1.,dir=q/max(length(q),.001);vec2 curl=vec2(fb(q*3.+uTime*.7),fb(q*3.7-uTime*.8))-.5;float r=length(q+curl*.33), swirl=fb(q*6.-dir*uTime*2.7);float radius=.085*(.83+.53*swirl);float knot=1.-smoothstep(radius*.46,radius,r);float reach=.19+.42*pow(fb(dir*3.9+uTime*.74),1.6)+.14*swirl;float flame=pow(clamp(1.-(r-radius)/reach,0.,1.),2.)*(.35+1.24*swirl);vec3 light=vec3(11.,8.,4.5)*knot+mix(vec3(3.,.5,.04),vec3(6.4,2.7,.45),flame)*flame*1.7*(1.-.6*knot)+vec3(.85,.4,.15)*exp(-4.5*r);gl_FragColor=vec4(light*.36*uPower*(1.-smoothstep(.8,1.,r))*vis(vz,4.),0.);}`,
    ),
  );
  for (const [j, o] of [ribbon, tip].entries()) {
    o.renderOrder = 5 + j;
    o.frustumCulled = false;
    fxScene.add(o);
  }
  let fov = 28;
  return {
    update(s) {
      fov = s.camera.fov;
      u.uPxK.value = pixelWorldFactor(fov, u.uRes.value.y);
      u.uTime.value = s.time;
      u.uDir.value.fromArray(s.breath.direction);
      u.uMouth.value.fromArray(s.breath.mouth);
      u.uLength.value = s.breath.length;
      // The hot core is not extinguished everywhere at the inlet instant. Blend in
      // a small advected radiance component using the travel time to the jet tip.
      u.uPower.value = 0.988 * s.breath.intensity + 0.012 * envelope(s.time - s.breath.length / 70);
      ribbon.visible = tip.visible = !off(params, 'fx.breath');
      groups.forEach((g, i) => g(s.particles[['fire', 'embers', 'smoke'][i]]));
    },
    setDepth(texture) {
      u.tDepth.value = texture;
      u.uHasDepth.value = Number(Boolean(texture));
      if (texture?.image) {
        u.uRes.value.set(texture.image.width, texture.image.height);
        u.uPxK.value = pixelWorldFactor(fov, u.uRes.value.y);
      }
    },
  };
}
