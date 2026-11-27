import { RawShaderMaterial, Vector2, Vector3, Vector4 } from 'three';
import { HASH_NOISE } from '../../../engine/look/glsl.js';
import { createGrade } from '../../../engine/look/grade.js';
import { createBloom } from '../../../engine/look/bloom.js';
import { FS_VERT, renderTarget } from '../../../engine/look/pass.js';
import { upstreamShaders } from './upstream.js';

const vary = 'varying vec2 vUv;';
const plate = /* glsl */`
uniform float t;
uniform int kind;
${HASH_NOISE}
${vary}
void main() {
  vec2 q = vUv, p = q - vec2(.6 + .17 * sin(t*6.), .64);
  p.x *= 1.25;
  float d = length(p) - .122 + .012 * sin(28. * atan(p.y,p.x));
  float sun = 1. - smoothstep(.0,.006,d);
  float grain = vnoise(q*190., 292u);
  float hills = .31 + .1 * sin(q.x*8.) + .045 * sin(q.x*19.) + .016 * sin(q.x*51.);
  float land = 1. - smoothstep(hills,hills+.009,q.y);
  vec3 sky = mix(vec3(.83,.39,.23),vec3(.06,.15,.29),q.y);
  vec3 ground = mix(vec3(.021,.082,.116),vec3(.09,.23,.28),q.y*1.5);
  vec3 color = mix(mix(sky,vec3(1.,.87,.56),sun),ground,land);
  color += .026 * grain + .014 * sin(q.y*420.) * land;
  if(kind == 1) color = mix(color.bgr,vec3(.12,.75,.62), .22);
  if(kind == 2) {
    float m = vnoise(q*13. + vec2(t*2.,0.), 14u);
    float a = smoothstep(.08,.55,m) * sin(3.14*q.x) * sin(3.14*q.y);
    gl_FragColor = vec4(.2+m*.66,.24+.5*vnoise(q*16., 72u),.71,a);
  } else if(kind == 3) {
    gl_FragColor = vec4(mix(vec3(.1,.8,.18),vec3(.92,.68,.35),1. - smoothstep(-.02,.016,d)),1.);
  } else if(kind == 4) {
    gl_FragColor = vec4(mix(ground,vec3(.92,.68,.35),sun),1.);
  } else gl_FragColor = vec4(color,1.);
}`;

const presentation = /* glsl */`
uniform sampler2D baseImage, nextImage, effectImage;
uniform float progress;
uniform int mode;
${vary}
void main(){
  vec4 a = texture2D(baseImage,vUv), b = texture2D(nextImage,vUv), c = texture2D(effectImage,vUv);
  vec3 outColor = c.rgb;
  if(mode == 1) outColor = mix(a.rgb,b.rgb,progress);
  if(mode == 2) outColor = mix(a.rgb,b.rgb,clamp(c.r,0.,1.));
  if(mode == 3) outColor = mix(a.rgb,c.rgb,c.a);
  if(mode == 4) {
    vec2 q = (vUv-.5) * vec2(1.,1.55) + .5;
    outColor = q.y < 0. || q.y > 1. ? vec3(.025,.045,.057) : texture2D(baseImage,q).rgb;
  }
  if(mode == 6) outColor = c.rgb * c.a;
  if(mode == 5) outColor = mix(a.rgb,c.rgb,.18);
  gl_FragColor = vec4(outColor,1.);
}`;

const gestures = /* glsl */`
uniform sampler2D image;
uniform float t;
uniform int mode;
${vary}
vec2 point(float s){return vec2(.12+.76*s, .5+.23*sin(s*6.28));}
void main(){
  vec2 drift = vec2(0.);
  float line = 0.;
  for(int i=0;i<32;i++){
    float age = float(i)/90.;
    vec2 p = vUv-point(max(0.,t-age));
    float weight = exp(-dot(p,p)*90.) * max(0.,1.-age*2.5);
    drift += weight * vec2(sin(age*35.),cos(age*35.))*.014;
    line = max(line,exp(-dot(p,p)*3200.));
  }
  vec3 c = texture2D(image,vUv + (mode == 1 || mode == 2 || mode == 4 ? drift : vec2(0.))).rgb;
  if(mode < 2 || mode == 4) c = mix(c,vec3(.75,1.,.82),line*.5);
  gl_FragColor = vec4(c,1.);
}`;

export function buildMaterials(fx) {
  const [source, next, map, history, left, right, raw] = Array.from({length:7}, () => renderTarget(1,1));
  const quad = (glsl, values) => fx.material(glsl, Object.fromEntries(Object.entries(values).map(([name,value]) => [name,{value}])));
  const fixture = quad(plate, { t:0, kind:0 });
  const blend = quad(presentation, { baseImage:source.texture, nextImage:next.texture, effectImage:raw.texture, progress:0, mode:0 });
  const brush = quad(gestures,{image:source.texture,t:0,mode:0});
  const poster = `
    uniform sampler2D image;
    ${vary}
    void main() {
      vec2 q = vUv;
      vec3 c = texture2D(image,q).rgb;
      float band = step(.5,fract(q.x*6.));
      gl_FragColor = vec4(mix(c,c.brg,band*.65),1.);
    }`;
  const custom = quad(poster,{image:source.texture});
  const rawPass = new RawShaderMaterial({
    vertexShader:'precision highp float; attribute vec3 position; attribute vec2 uv; '+FS_VERT,
    fragmentShader:'precision highp float; '+poster,
    uniforms:custom.uniforms,depthTest:false,depthWrite:false,
  });
  const plainNoise = quad(`${HASH_NOISE} ${vary} uniform float t;
    void main(){gl_FragColor=vec4(vec3(vnoise(vUv*10.+t,91u)*.68),1.);}`, { t:0 });
  const grade = createGrade(fx), bloom = createBloom(fx);
  const rgb = (x,y,z) => new Vector3(x,y,z);
  const wh = new Vector2(), wide = new Vector2();
  const defaults = {
    uTexture:source.texture, u_texture:source.texture, uTexture0:source.texture, uTexture1:next.texture,
    uMap:map.texture, uBackbuffer:history.texture, u_alphaMap:map.texture, noise:map.texture, isTexture:true, isNoise:true,
    uTime:0, u_time:0, timeStrength:2, noiseOctaves:4, fbmOctaves:4, warpOctaves:3, warpDirection:new Vector2(11,9), warpStrength:34, scale:.065,
    u_pattern:1, u_complexity:1.51, u_complexityAttenuation:.1, u_iterations:7, u_timeStrength:.35, u_scale:.018,
    noiseStrength:new Vector2(.11,.21), laminateLayer:7, laminateInterval:new Vector2(.7,.43),
    laminateDetail:2.1, distortion:.13, colorFactor:2,
    uColor1:rgb(.52,.42,.46), uColor2:rgb(.44,.46,.41), uColor3:rgb(1,.92,1), uColor4:rgb(.03,.24,.53), uRgbWeight:rgb(.2126,.7152,.0722),
    uColor0:rgb(.03,.09,.23), uColor1Duo:rgb(1,.81,.44),
    u_brightness:rgb(.2126,.7152,.0722), u_min:.19, u_max:.57,
    u_isAlphaMap:true, uMapIntensity:.25, u_isDodgeColor:false, u_dodgeColor:rgb(1,1,1),
    uResolution:wh, uTextureResolution:wh, u_resolution:wh, mapIntensity:.27, edgeIntensity:.32, progress:0,
    dirX:1, dirY:-.35, epicenter:new Vector2(.5,.5), padding:0, uBlurSize:12,
    uBegin:new Vector2(.04,0), uEnd:new Vector2(-.24,0), uStrength:.48,
    uProgress:0, uWidth:.38, uEpicenter:new Vector2(-.18,.12), uMode:0,
    u_keyColor:rgb(.1,.8,.18), u_similarity:.055, u_smoothness:.12, u_spill:.2,
    u_color:new Vector4(1,1,1,1), u_contrast:1, u_gamma:1,
  };
  const overrides = {
    useColorStrata:{laminateDetail:new Vector2(2.1,2.8),distortion:new Vector2(.13,.35),colorFactor:rgb(.55,.82,.98),timeStrength:new Vector2(.15,.22)},
    useDuoTone:{uColor1:defaults.uColor1Duo},
    useHSV:{u_brightness:1.12,u_saturation:.44},
    useBrightnessPicker:{u_min:.33,u_max:.56},
    useWave:{uStrength:.08},
    useChromaKey:{u_texture:history.texture,u_brightness:0},
    useCoverTexture:{uTextureResolution:wide},
  };
  const effects = Object.fromEntries(Object.entries(upstreamShaders).map(([name, glsl]) => [
    name,quad(glsl,Object.fromEntries([...glsl.matchAll(/uniform\s+\w+\s+(\w+);/g)].map(([,key]) => {
      const value = overrides[name]?.[key] ?? defaults[key];
      if (value === undefined) throw Error(`Undefined fixture for ${name}.${key}`);
      return [key,value];
    }))),
  ]));
  function drawPlate(target, kind, t) {
    fixture.uniforms.t.value = t;
    fixture.uniforms.kind.value = kind;
    fx.draw(fixture,target);
  }
  function present(target,image,mode,t) {
    blend.uniforms.effectImage.value = image;
    blend.uniforms.mode.value = mode;
    blend.uniforms.progress.value = t;
    fx.draw(blend,target);
  }
  return {
    resize(w,h) {
      wh.set(w,h); wide.set(w,h/1.55);
      for(const target of [source,next,map,history,left,right,raw]) target.setSize(w,h);
      bloom.resize(w,h);
    },
    plate(t) { drawPlate(source,0,t); return source.texture; },
    draw({id,effect},t) {
      drawPlate(source, id === 'chroma' ? 4 : 0,t);
      if (id === 'blank' || id === 'raw-blank') {
        fx.draw(id === 'blank' ? custom : rawPass,right);
        return [source.texture,right.texture];
      }
      if (effect === 'derived') {
        brush.uniforms.t.value = t;
        brush.uniforms.mode.value = id === 'brush' ? 0 : 3;
        fx.draw(brush,left);
        brush.uniforms.mode.value = id === 'brush' ? 1 : id === 'flow-light' ? 4 : 2;
        fx.draw(brush,right);
        return [left.texture,right.texture];
      }
      if (id === 'transition' || id.startsWith('wave-')) drawPlate(next,1,t);
      if (['alpha','blend','displace','transition','strata'].includes(id)) drawPlate(map,2,t);
      if (id === 'trail') drawPlate(history,0,Math.max(0,t-4/48));
      if (id === 'chroma') drawPlate(history,3,t);
      if (id === 'noise') {
        plainNoise.uniforms.t.value = t;
        fx.draw(plainNoise,left);
      } else if (['hsv','palette','duotone'].includes(id)) {
        grade.render({src:source.texture,grade:{saturation:id === 'hsv' ? 1.18 : .75,warmth:.35,exposure:1.04}},left);
      } else if (id === 'brightness') {
        present(left,bloom.render(source.texture,{threshold:.54,knee:.1,radius:.55}),0,t);
      } else {
        const mode = id==='transition' || id.startsWith('wave-') ? 1 : id === 'cover' ? 4 : ['alpha','blend'].includes(id) ? 5 : 0;
        present(left,mode === 5 ? map.texture : source.texture,mode,t);
      }
      const mat = effects[effect];
      const changes = {uTime:t,u_time:t,progress:t,uProgress:t,uMode:['wave-radial','wave-horizontal','wave-vertical'].indexOf(id)};
      for (const [name,value] of Object.entries(changes)) if (mat.uniforms[name]) mat.uniforms[name].value = value;
      fx.draw(mat,raw);
      present(right,raw.texture,id.startsWith('wave-') ? 2 : id === 'brightness' ? 6 : ['chroma','blend'].includes(id) ? 3 : 0,t);
      return [left.texture,right.texture];
    },
  };
}
