// The room: a white 1:2000 model of Treasure Island + Yerba Buena Island on a dark plinth, a projector above it,
// house lights and a real sun. Data colour is projected light only: added to the lit white surface in the shader
// (projLight), scaled by how squarely a surface faces the projector, limited to the throw, never painted in.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makePost } from '/core/three/post.js';

export const S = 1 / 2000;                       // 1 model unit = 1 model metre = 2000 real metres
const lin = h => new THREE.Color(h);
export const PAL = {
  water: '#0f3a9e',      // today's bay
  flood: '#2f86ff',      // land under +1 m
  front: '#bfeaff',      // the advancing edge of the water
  pick: '#ffab45',       // a building the water reaches (the one categorical accent)
  shade: '#1b2a63',      // projected shade while the sun is out
  sun: '#ffd8a8',
  black: '#0a0d15', base: '#3a3f4a',
};

export function makeStudio(W, H, M, keyData) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(2); renderer.setSize(W, H);
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;
  document.getElementById('stage').appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.002, 9);
  const post = makePost(renderer, scene, camera, W, H, { ssaa: 2, ao: true, aoRadius: .006, aoScale: 1.3, aoThickness: .01, aoAmt: .8 });
  post.bloom.strength = .34; post.bloom.radius = .5; post.bloom.threshold = .85;
  post.dof.ao.updateGtaoMaterial({ samples: 24 }); post.dof.ao.updatePdMaterial({ radius: 10, samples: 24, rings: 3 });
  post.vig.uniforms.amt.value = .45;

  {   // the room: dark, a faint pool of light behind the plinth
    const c = document.createElement('canvas'); c.width = 512; c.height = 288;
    const g = c.getContext('2d'), gr = g.createRadialGradient(256, 130, 10, 256, 150, 330);
    gr.addColorStop(0, '#1a1c21'); gr.addColorStop(.5, '#0a0b0d'); gr.addColorStop(1, '#030304');
    g.fillStyle = gr; g.fillRect(0, 0, 512, 288);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; scene.background = tex;
  }
  const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(new RoomEnvironment(), .02).texture;

  const PW = M.size[0] * S, PD = M.size[1] * S;
  const [GW, GH] = M.grid;
  // the fill key field (metres above MHHW; <= 0 is today's water) as a half-float texture, linear filtered
  const half = new Uint16Array(GW * GH);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(Math.max(-20, Math.min(200, keyData[i])));
  const keyTex = new THREE.DataTexture(half, GW, GH, THREE.RedFormat, THREE.HalfFloatType);
  keyTex.minFilter = keyTex.magFilter = THREE.LinearFilter; keyTex.flipY = false; keyTex.colorSpace = THREE.NoColorSpace; keyTex.needsUpdate = true;

  const U = {
    uProj: { value: 0 }, uNow: { value: 0 }, uDim: { value: 1 }, uS: { value: S },
    uKey: { value: 0 }, uWaterOn: { value: 0 }, uWashR: { value: -1 }, uPick: { value: 0 }, uHitT: { value: 99 }, uSunOn: { value: 0 }, uHgtBand: { value: 1 },
    uKeyTex: { value: keyTex }, uPlate: { value: new THREE.Vector2(PW, PD) },
    uProjPos: { value: new THREE.Vector3(0, 3.2, .4) },
    cWater: { value: lin(PAL.water) }, cFlood: { value: lin(PAL.flood) }, cFront: { value: lin(PAL.front) }, cPick: { value: lin(PAL.pick) },
    cShade: { value: lin(PAL.shade) }, cBlack: { value: lin(PAL.black) }, cBase: { value: lin(PAL.base) },
  };

  const HEAD = /* glsl */`
  uniform float uProj, uNow, uDim, uS, uKey, uWaterOn, uWashR, uPick, uHitT, uSunOn, uHgtBand;
  uniform sampler2D uKeyTex; uniform vec2 uPlate; uniform vec3 uProjPos;
  uniform vec3 cWater, cFlood, cFront, cPick, cShade, cBlack, cBase;
  varying vec4 vData; varying vec3 vWP; varying vec3 vWN;
  float keyAt(){ vec2 uv = vWP.xz / uPlate + .5; if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return -1.; return texture2D(uKeyTex, uv).r; }
  // kind 0 building, 1 plate (terrain + water inlay), 2 plinth
  vec3 projLight(float kind, float k){
    vec3 N = normalize(vWN);
    float dirK = .42 + .58 * max(dot(N, normalize(uProjPos - vWP)), 0.);
    vec2 q = abs(vWP.xz) - (uPlate * .5 + .03);
    float thr = 1. - smoothstep(0., .03, max(q.x, q.y));
    vec3 c = cBlack;
    // the sun is out: the data is put away, the projector only paints the shade a deep blue
    c = mix(c, cShade * (kind < .5 ? .6 : .38), uSunOn);
    // the water layer arrives as a soft wash spreading from the projector axis
    float wash = smoothstep(.10, -.10, length(vWP.xz) - uWashR) * uWaterOn;
    vec3 w = cBlack;
    if (kind > .5 && kind < 1.5) {
      if (k <= 0.) {
        float rip = .5 + .5 * sin(vWP.x * 900. + vWP.z * 310. + uNow * 1.7) * sin(vWP.z * 700. - vWP.x * 200. - uNow * 1.1);
        w = cWater * (.62 + .1 * rip) * (1. - .55 * uPick);
      } else {
        float fw = max(fwidth(k) * 1.5, .0004);
        float fl = smoothstep(uKey + fw, uKey - fw, k) * step(.0005, uKey);
        float front = exp(-pow((k - uKey) / (fw * 2.2), 2.)) * step(.0005, uKey) * step(uKey, .9995) * (1. - uPick);
        vec3 land = cBase * .45 * (1. - uPick);
        w = mix(land, cFlood * (1. + .35 * uPick), fl) + cFront * front * .75;
      }
    } else if (kind < .5) {
      float picked = step(vData.w, uNow);
      vec3 bc = cBase * (1. - uPick);
      float e = uNow - vData.w, eh = uNow - uHitT;
      float flash = picked * exp(-max(e, 0.) / .16), flash2 = picked * uPick * exp(-max(eh, 0.) / .3);
      bc = mix(bc, cPick * (1. + .7 * uPick), picked * smoothstep(0., .06, e)) + vec3(1., .88, .7) * (flash * .55 + flash2 * .6);
      // the water line on the walls of the buildings it has reached
      float wy = uKey * uS;
      float under = smoothstep(wy + .00003, wy - .00003, vWP.y) * picked * (1. - step(.5, abs(N.y)));
      bc = mix(bc, cFlood * 1.25, under);
      // the rising level (native move): a soft band of cold light climbs every facade on the island at once,
      // from the foot of the wall to uKey · uHgtBand of the building's own height, with a brighter crest at its top.
      // It is the gauge, not the flood: the flood itself is the plate's blue and the amber pick-out.
      float wall = 1. - step(.5, abs(N.y));
      float foot = max(vData.x, 0.) * uS, hh = max(vData.y, 1.) * uS;
      float fy = (vWP.y - foot) / hh, top = uKey * uHgtBand;
      float on = step(.0005, uKey) * wall * (1. - uPick);
      float band = smoothstep(top + .05, top - .07, fy) * smoothstep(-.02, .04, fy) * on;
      float crest = exp(-pow((fy - top) / .035, 2.)) * on * step(uKey, .9995);
      float gain = 1. - picked * .75;
      bc += (cFlood * .62 * band + cFront * 1.5 * crest) * gain;
      w = bc;
    }
    c = mix(c, w, wash);
    return c * dirK * thr * uProj * uDim;
  }`;

  function projMaterial(kind, opts) {
    const m = new THREE.MeshStandardMaterial(opts);
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nattribute vec4 aData; varying vec4 vData; varying vec3 vWP; varying vec3 vWN;`)
        .replace('#include <fog_vertex>', `#include <fog_vertex>\n vData = aData; vWP = (modelMatrix * vec4(transformed, 1.)).xyz; vWN = normalize(mat3(modelMatrix) * objectNormal);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${HEAD}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n float kk = ${kind === 1 ? 'keyAt()' : '1.'}; float wm = ${kind === 1 ? 'step(kk, 0.)' : '0.'}; diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.09, .11, .15), wm);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, .34, wm);`)
        .replace('#include <opaque_fragment>', `outgoingLight += projLight(${kind}.0, kk) * mix(diffuseColor.rgb, vec3(1.), ${kind === 1 ? '.55' : '.1'}) * 1.35;\n#include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => 'proj' + kind;
    return m;
  }

  // ---------------------------------------------------------------- buildings: footprints extruded from their LiDAR ground
  function buildCity(pickT) {
    const pos = [], nor = [], dat = [];
    const push = (p, n, d) => { pos.push(...p); nor.push(...n); dat.push(...d); };
    const area = r => { let a = 0; for (let i = 0; i < r.length; i++) { const [x0, z0] = r[i], [x1, z1] = r[(i + 1) % r.length]; a += x0 * z1 - x1 * z0; } return a / 2; };
    const prism = (rings, y0, y1, d) => {
      rings.forEach((r, ri) => {
        const A = area(r), sgn = (A > 0 ? 1 : -1) * (ri ? -1 : 1);
        for (let i = 0; i < r.length; i++) {
          const [x0, z0] = r[i], [x1, z1] = r[(i + 1) % r.length];
          const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz); if (L < 1e-9) continue;
          const nx = dz / L * sgn, nz = -dx / L * sgn;
          const a = [x0, y0, z0], b = [x1, y0, z1], c = [x1, y1, z1], e = [x0, y1, z0];
          const cx = (b[1] - a[1]) * (e[2] - a[2]) - (b[2] - a[2]) * (e[1] - a[1]);
          const cz = (b[0] - a[0]) * (e[1] - a[1]) - (b[1] - a[1]) * (e[0] - a[0]);
          const tri = cx * nx + cz * nz > 0 ? [a, b, c, a, c, e] : [a, c, b, a, e, c];
          for (const p of tri) push(p, [nx, 0, nz], d);
        }
      });
      const V = THREE.Vector2;
      const contour = rings[0].map(([x, z]) => new V(x, z)), holes = rings.slice(1).map(r => r.map(([x, z]) => new V(x, z)));
      const all = contour.concat(...holes);
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
        const p = all[i], q = all[j], r = all[k];
        const up = (q.y - p.y) * (r.x - p.x) - (q.x - p.x) * (r.y - p.y) > 0;
        for (const v of (up ? [p, q, r] : [p, r, q])) push([v.x, y1, v.y], [0, 1, 0], d);
      }
    };
    for (const [bi, rings] of M.p) {
      const [base, h, , kb] = M.b[bi];
      const rs = rings.map(r => r.map(([x, z]) => [x * S, z * S]));
      prism(rs, -0.0008, (Math.max(base, 0) + h) * S, [base, h, kb, pickT.has(bi) ? pickT.get(bi) : 99]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('aData', new THREE.Float32BufferAttribute(dat, 4));
    return g;
  }
  const zero = g => { g.setAttribute('aData', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 4), 4)); return g; };

  // ---------------------------------------------------------------- terrain: the plate top is the real ground (1:1 vertical)
  function buildTerrain(terr) {
    const st = 2, nx = Math.floor(GW / st), nz = Math.floor(GH / st);
    const pos = new Float32Array(nx * nz * 3), idx = [];
    const hAt = (c, r) => { const k = keyData[r * GW + c], t = terr[r * GW + c]; return k <= 0 ? -.0004 : Math.max(t, 0) * S; };
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const c = i === nx - 1 ? GW - 1 : i * st, r = j === nz - 1 ? GH - 1 : j * st;
      const o = (j * nx + i) * 3;
      pos[o] = (M.origin[0] + (c + .5) * M.cell) * S; pos[o + 1] = hAt(c, r); pos[o + 2] = (M.origin[1] + (r + .5) * M.cell) * S;
    }
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    return zero(g);
  }

  function build(pickT, terr) {
    const white = '#f3f3f1';
    const city = new THREE.Mesh(buildCity(pickT), projMaterial(0, { color: white, roughness: .9, metalness: 0 }));
    city.castShadow = city.receiveShadow = true; scene.add(city);
    const ground = new THREE.Mesh(buildTerrain(terr), projMaterial(1, { color: white, roughness: .92 }));
    ground.castShadow = true; ground.receiveShadow = true; scene.add(ground);
    const RIM = .025, PT = .02;
    const plateBox = new THREE.Mesh(zero(new THREE.BoxGeometry(PW + RIM * 2, PT, PD + RIM * 2)), projMaterial(1, { color: '#e9e6e0', roughness: .9 }));
    plateBox.position.y = -PT / 2 - .0006; plateBox.receiveShadow = true; scene.add(plateBox);
    const plinth = new THREE.Mesh(zero(new THREE.BoxGeometry(PW + .24, .9, PD + .24)), projMaterial(2, { color: '#17181a', roughness: .5 }));
    plinth.position.y = -PT - .45 - .0006; plinth.receiveShadow = true; scene.add(plinth);
  }

  // ---------------------------------------------------------------- lights: house (soft key) and the sun (real direction)
  const house = new THREE.DirectionalLight('#ffffff', 2);
  house.position.setFromSphericalCoords(4, THREE.MathUtils.degToRad(42), THREE.MathUtils.degToRad(200)); house.castShadow = true;
  Object.assign(house.shadow.camera, { left: -1.0, right: 1.0, top: 1.0, bottom: -1.0, near: .5, far: 9 });
  house.shadow.mapSize.set(4096, 4096); house.shadow.radius = 4; house.shadow.bias = -.0001; house.shadow.normalBias = .0004;
  scene.add(house, house.target);
  const sun = new THREE.DirectionalLight(PAL.sun, 0);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -1.0, right: 1.0, top: 1.0, bottom: -1.0, near: .5, far: 12 });
  sun.shadow.mapSize.set(4096, 4096); sun.shadow.radius = 1.5; sun.shadow.bias = -.00012; sun.shadow.normalBias = .0003;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight('#dfe7f2', '#141414', .3); scene.add(hemi);

  return { renderer, scene, camera, post, U, build, house, sun, hemi, PW, PD };
}
