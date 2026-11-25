import { create as ambient } from '../../../cards/post/ao/three.js';
import { create as glow } from '../../../cards/post/bloom/three.js';
import { create as volumetric } from '../../../cards/post/volumetric/three.js';
import { create as grading } from '../../../cards/post/grade-cl/three.js';
import { create as lensFx } from '../../../cards/post/lens-fx/three.js';
import { evaluatePostState } from '../../../cards/time/fx-post-state/index.mjs';
import { createWeather } from './post-weather.js';

// The preceding hits still have exponential tails at shot-in. All times are absolute seconds.
const events = [
  [24, 0.2, 1.5, { bloom: 0.05 }],
  [24.05, 0.12, 0.8, { exposure: 0.1 }],
  [24, 0.22, 1.15, { shake: 1 }],
  [39.1, 0.2, 0.9, { shake: 0.3 }],
  [42, 0.05, 0.5, { bloom: 0.04 }],
  [42, 0.04, 0.3, { flash: 0.8 }],
  [42, 0.04, 0.25, { exposure: 0.22 }],
  [42, 0.03, 0.5, { shake: 0.8 }],
  [42, 0.02, 0.16, { kick: 0.9 }],
].map(([at, attack, release, values]) => ({ kind: 'pulse', at, attack, release, ...values }));

// Pure frame/subframe clock shared by render and the metadata/determinism probes.
export function samplePostState(f, sub = 0, params = {}) {
  if (new Set(params.disableCards ?? []).has('fx.post-state'))
    return {
      exposure: 1,
      ao: 0.9,
      bloom: 0.06,
      shaft: 1,
      god: 0.55,
      ca: 0.006,
      vignette: 0.42,
      shake: 0,
      flash: 0,
      fade: 1,
      white: 0,
      lens: {
        kick: 0,
        fringe: 0,
        ring: { x: 0.5, y: 0.5, radius: 0, width: 0.05, strength: 0, squash: 1, angleDeg: 0 },
      },
    };
  return evaluatePostState((f + sub) / 60, { events, ...params.postState });
}

const vertex = `void main(){gl_Position=vec4(position.xy,0.,1.);}`;
const metric = `uniform sampler2D deviceDepth; uniform vec2 clip;
void main(){float d=texelFetch(deviceDepth,ivec2(gl_FragCoord.xy),0).r;
  float z=(clip.x*clip.y)/(clip.y-d*(clip.y-clip.x));
  gl_FragColor=vec4(z,d,0.,float(d<1.));}`;
const copy = `uniform sampler2D src; void main(){gl_FragColor=texelFetch(src,ivec2(gl_FragCoord.xy),0);}`;
// This is the scene-linear beauty path. Never inverse-transfer or expand the graded 8-bit target.
const composite = `uniform sampler2D src,glowMap,beamMap,deviceDepth;
uniform float mixGlow,flash; uniform vec3 lightColor; uniform bool displayOnly;
void main(){ivec2 p=ivec2(gl_FragCoord.xy); vec2 texel=1./vec2(textureSize(src,0));
  vec2 uv=gl_FragCoord.xy*texel; vec4 base=texelFetch(src,p,0); vec3 b=texture2D(glowMap,uv).rgb;
  float sh=0.; for(int y=-1;y<=1;y+=2)for(int x=-1;x<=1;x+=2)sh+=texture2D(beamMap,uv+4.*texel*vec2(x,y)).r;
  vec3 c=max(vec3(0.),mix(base.rgb,b,mixGlow)+sh*.25*lightColor*base.a)+b*flash*.25;
  if(displayOnly){c=mix(1.055*pow(c,vec3(1./2.4))-.055,12.92*c,lessThanEqual(c,vec3(.0031308)));}
  gl_FragColor=vec4(c,base.a); gl_FragDepth=texelFetch(deviceDepth,p,0).r;}`;

/** After render, passes holds GPU targets, not cached pixels. All RGBA rows are bottom-up:
 * readRenderTargetPixels(rt,0,0,rt.width,rt.height,buf); flip rows once for top-left images.
 * hdrScene = resolved opaque scene; hdrAo = AO composite; hdrFx = hdrAo + soft FX (no glow/shaft).
 * These and the bloom pyramid are scene-linear Rec.709 RGBA16F (buf: Uint16Array, decode IEEE half).
 * ao = final half-size visibility R; shaft = signed quarter-size scattering R, BEFORE tint/upsample.
 * depth = nearest RGBA32F (Float32Array): R=positive view Z in metres (far at sky), G=device Z,
 * A=hit. hdrScene.depthTexture, not depth.texture, is the device-depth sampler for soft particles.
 * finalSrgb = display-encoded RGBA8 (Uint8Array); grade already applies the transfer; no sRGB RT encode.
 * Disabling bloom removes its contribution to beauty/final; the pyramid remains measurable (mix=0).
 * Disabling AO sets its strength to zero; its independently observable visibility field is unchanged.
 * A non-null host target receives linear HDR beauty plus the opaque device depth, never finalSrgb. */
export function createPipeline(THREE, model, params = {}, width, height) {
  const T = THREE,
    ctx = { THREE, size: [width, height], fps: 60 };
  const off = new Set(params.disableCards ?? []),
    has = (id) => !off.has(id);
  const samples = params.msaaSamples ?? 4;
  if (![0, 2, 4].includes(samples)) throw new RangeError('msaaSamples must be 0, 2 or 4');
  const makeTarget = (name, opts = {}) => {
    const rt = new T.WebGLRenderTarget(width, height, {
      type: T.HalfFloatType,
      minFilter: T.LinearFilter,
      magFilter: T.LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
      ...opts,
    });
    rt.texture.name = name;
    return rt;
  };
  const { scene, camera, fxScene } = model,
    screen = new T.Camera();
  let sun = null;
  scene.traverse((o) => {
    if (!sun && o.isDirectionalLight && o.castShadow) sun = o;
  });
  const hdrScene = makeTarget('hdrScene', {
    samples,
    depthBuffer: true,
    depthTexture: new T.DepthTexture(width, height, T.FloatType),
  });
  const depth = makeTarget('depth', { type: T.FloatType, minFilter: T.NearestFilter, magFilter: T.NearestFilter });
  const hdrAo = makeTarget('hdrAo'),
    hdrFx = makeTarget('hdrFx'),
    finalSrgb = makeTarget('finalSrgb', { type: T.UnsignedByteType });
  const black = makeTarget('shaftOff');
  const passes = { hdrScene, depth, hdrAo, hdrFx, finalSrgb };
  const ao = ambient(ctx, params.ao),
    bloom = glow(ctx, { ...params.bloom, intensity: 1 }),
    volume = volumetric(ctx, params.volumetric);
  const weather = has('post.volumetric') ? createWeather(T, model) : null;
  const grade = grading(ctx, params.grade),
    lens = lensFx(ctx);
  // In the graded path sample the HDR image at the lens UV inside the grade card, not a second
  // filtered/rounded intermediate. The lens card owns the uniform state in both paths.
  for (const name of ['uKick', 'uFringe', 'uShake', 'uCaBase', 'uRing', 'uRingS'])
    grade.uniforms[name] = lens.uniforms[name];
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const shader = (fs, values, withDepth = false) => {
    const m = new T.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fs,
      uniforms: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }])),
      depthTest: withDepth,
      depthFunc: T.AlwaysDepth,
      depthWrite: withDepth,
      blending: T.NoBlending,
      toneMapped: false,
    });
    const o = new T.Mesh(geometry, m);
    o.frustumCulled = false;
    return o;
  };
  const transcribe = shader(metric, { deviceDepth: hdrScene.depthTexture, clip: new T.Vector2() });
  const blit = shader(copy, { src: null });
  const beauty = shader(
      composite,
      {
        src: null,
        glowMap: null,
        beamMap: null,
        deviceDepth: hdrScene.depthTexture,
        lightColor: new T.Vector3(),
        mixGlow: 0,
        flash: 0,
        displayOnly: false,
      },
      true,
    ),
    u = beauty.material.uniforms;
  const ungradedLens = has('post.grade-cl') ? null : makeTarget('ungradedLens');
  const full = [hdrScene, depth, hdrAo, hdrFx, finalSrgb, ...(ungradedLens ? [ungradedLens] : [])];
  function render(r, target, f, sub = 0) {
    const w = target?.width ?? width,
      h = target?.height ?? height,
      t = (f + sub) / 60;
    const before = r.getRenderTarget(),
      face = r.getActiveCubeFace(),
      level = r.getActiveMipmapLevel();
    const clearColor = r.getClearColor(new T.Color()),
      alpha = r.getClearAlpha(),
      autoClear = r.autoClear;
    const { enabled, autoUpdate, needsUpdate, type } = r.shadowMap;
    // renderPasses(null) always uses the design size even after a host draft-size render.
    for (const rt of full) rt.setSize(w, h);
    grade.setSize(w, h);
    lens.setSize(w, h);
    if (camera.aspect !== w / h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    const draw = (mesh, rt) => {
      r.setRenderTarget(rt);
      r.render(mesh, screen);
    };
    const st = samplePostState(f, sub, params);
    try {
      r.autoClear = false;
      r.setClearColor(0, 0);
      if (sun) {
        r.shadowMap.enabled = true;
        r.shadowMap.autoUpdate = true;
        r.shadowMap.type = T.PCFShadowMap;
      }
      r.setRenderTarget(hdrScene);
      // Binding realizes/resizes the depth attachment. Publish its dimensions before drawing opaque LODs.
      model.setDepth(hdrScene.depthTexture);
      r.clear();
      r.render(scene, camera);
      r.shadowMap.autoUpdate = false;
      transcribe.material.uniforms.clip.value.set(camera.near, camera.far);
      draw(transcribe, depth);
      ao.object.material.uniforms.strength.value = has('post.ao') ? st.ao : 0;
      const layers = ao.render(r, {
        color: hdrScene.texture,
        depth: hdrScene.depthTexture,
        camera,
        target: hdrAo,
        depthEncoding: 'device',
      });
      Object.assign(passes, { aoRaw: layers.raw, aoX: layers.blurX, ao: layers.filtered });
      blit.material.uniforms.src.value = hdrAo.texture;
      draw(blit, hdrFx);
      if (fxScene) r.render(fxScene, camera);
      // Only the pyramid is needed: the card's normal host hook computes it before drawing its combine mesh.
      bloom.object.material.uniforms.tInput.value = hdrFx.texture;
      bloom.object.onBeforeRender(r);
      for (const [i, rt] of bloom.targets.down.entries()) passes[`bloomDown${i}`] = rt;
      for (const [i, rt] of bloom.targets.up.entries()) passes[`bloomUp${i}`] = rt;
      passes.bloom = bloom.targets.up[0];
      const mixGlow = has('post.bloom') ? st.bloom : 0;
      let light = [0, 0, 0];
      if (weather) {
        const state = weather.frame(r, w, t, sun?.shadow),
          proj = camera.projectionMatrix.elements;
        light = state.lightColor.map((v) => v * st.shaft);
        volume.setFrame({
          ...state,
          cameraWorld: camera.matrixWorld.elements,
          inverseFocal: [1 / proj[0], 1 / proj[5]],
          skyDepth: (camera.far * camera.near) / (camera.far - 0.99999 * (camera.far - camera.near)),
        });
        passes.shaft = volume.renderShaft(r, depth.texture);
      } else {
        black.setSize(Math.max(2, w >> 2), Math.max(2, h >> 2));
        r.setRenderTarget(black);
        r.clear();
        passes.shaft = black;
      }
      const flash = has('post.bloom') ? st.flash : 0;
      // Disabling impact optics keeps the ordinary grade's static + camera-shake aberration.
      // Fold that small split into caBase so even a large shake cannot select the impact shader branch.
      const ordinaryCA = has('post.grade-cl') ? st.ca : 0;
      const lensState = has('post.lens-fx')
        ? { ...st, caBase: ordinaryCA }
        : {
            caBase: has('post.grade-cl') ? ordinaryCA + Math.min(st.shake * 0.02, 0.01) : 0,
            shake: 0,
            lens: { kick: 0, fringe: 0, ring: { strength: 0 } },
          };
      grade.uniforms.tC.value = hdrFx.texture;
      grade.uniforms.tB.value = passes.bloom.texture;
      grade.uniforms.tS.value = passes.shaft.texture;
      grade.apply(f, sub, { ...st, bloom: mixGlow, flash, exposure: st.exposure * 1.06, shaftColor: light });
      lens.apply(f, sub, lensState);
      u.src.value = hdrFx.texture;
      u.glowMap.value = passes.bloom.texture;
      u.beamMap.value = passes.shaft.texture;
      u.mixGlow.value = mixGlow;
      u.lightColor.value.fromArray(light);
      u.flash.value = flash;
      u.displayOnly.value = false;
      if (target) draw(beauty, target);
      if (ungradedLens) {
        lens.uniforms.tC.value = hdrFx.texture;
        draw(lens.object, ungradedLens);
        u.src.value = ungradedLens.texture;
        u.displayOnly.value = true;
        draw(beauty, finalSrgb);
      } else draw(grade.object, finalSrgb);
    } finally {
      Object.assign(r.shadowMap, { enabled, autoUpdate, needsUpdate, type });
      r.autoClear = autoClear;
      r.setClearColor(clearColor, alpha);
      r.setRenderTarget(before, face, level);
    }
  }
  return {
    passes,
    render,
    dispose() {
      for (const resource of [
        ...full,
        black,
        ao,
        bloom,
        volume,
        grade,
        lens,
        geometry,
        transcribe.material,
        blit.material,
        beauty.material,
      ])
        resource.dispose();
      weather?.dispose();
    },
  };
}
