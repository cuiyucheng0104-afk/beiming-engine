import { create as fogCard } from '../../../cards/atmosphere/height-fog/three.js';
import { create as patchCard } from '../../../cards/mechanism/three-patch/index.mjs';
import { GLSL_PX_LOD, computePxK } from '../../../cards/shading/px-lod/three.js';
import { evaluateThinLine } from '../../../cards/shading/thin-line/three.js';
import { cross, off, lengths } from './motion-flight.js';

function solid(T, color, roughness = 0.48, metalness = 0.06) {
  return new T.MeshStandardMaterial({ color, roughness, metalness });
}
function buffer(T, pos, nor, uv, idx) {
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
// One static buffer per material/joint, including the tiny teeth, barbels and branching antlers.
function sculpt(T, root) {
  const buckets = new Map();
  function append(m, g) {
    let a = buckets.get(m);
    if (!a) buckets.set(m, (a = { p: [], n: [], uv: [], ix: [] }));
    const base = a.p.length / 3;
    for (const x of g.attributes.position.array) a.p.push(x);
    for (const x of g.attributes.normal.array) a.n.push(x);
    for (const x of g.attributes.uv.array) a.uv.push(x);
    for (const x of g.index.array) a.ix.push(x + base);
    g.dispose();
  }
  function oval(m, c, r, rot = [0, 0, 0]) {
    const g = new T.SphereGeometry(1, 16, 12);
    g.applyMatrix4(
      new T.Matrix4().compose(
        new T.Vector3(...c),
        new T.Quaternion().setFromEuler(new T.Euler(...rot)),
        new T.Vector3(...r),
      ),
    );
    append(m, g);
  }
  function tip(m, knots, radii, sides = 6) {
    const curve = new T.CatmullRomCurve3(knots.map((v) => new T.Vector3(...v))),
      steps = Math.max(5, knots.length * 3),
      frames = curve.computeFrenetFrames(steps, false),
      p = [],
      n = [],
      uv = [],
      ix = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps,
        t = u * (radii.length - 1),
        j = Math.min(radii.length - 2, Math.floor(t)),
        r = Math.max(0.004, radii[j] + (radii[j + 1] - radii[j]) * (t - j)),
        c = curve.getPointAt(u);
      for (let k = 0; k <= sides; k++) {
        const angle = (2 * Math.PI * k) / sides,
          v = frames.normals[i]
            .clone()
            .multiplyScalar(Math.cos(angle))
            .addScaledVector(frames.binormals[i], Math.sin(angle));
        p.push(...c.clone().addScaledVector(v, r).toArray());
        n.push(...v.toArray());
        uv.push(u, k / sides);
        if (i && k) {
          const d = i * (sides + 1) + k;
          ix.push(d - sides - 2, d - 1 - sides, d, d - sides - 2, d, d - 1);
        }
      }
    }
    const g = buffer(T, p, n, uv, ix);
    g.computeVertexNormals();
    append(m, g);
  }
  function snout(m, stations, mandible = false) {
    const p = [],
      n = [],
      uv = [],
      idx = [],
      rings = 44,
      sides = 40;
    for (let j = 0; j <= rings; j++) {
      const u = j / rings,
        raw = u * (stations.length - 1),
        k = Math.min(stations.length - 2, Math.floor(raw)),
        f = raw - k;
      const [Z, Y, R, H] = stations[k].map((a, i) => a + (stations[k + 1][i] - a) * f);
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * 2 * Math.PI,
          x = Math.cos(a),
          y = Math.sin(a),
          bulge = 0.11 * Math.cos(Z * 5.1 + 3 * x) * Math.max(0, Math.abs(x) - 0.5);
        p.push(
          Math.sign(x) * Math.abs(x) ** 0.89 * (R + bulge),
          Y + Math.sign(y) * Math.abs(y) ** 0.83 * H * (mandible && y > 0 ? 0.45 : !mandible && y < 0 ? 0.53 : 1),
          Z,
        );
        n.push(0, 1, 0);
        uv.push(u, s / sides);
        if (j && s) {
          const d = j * (sides + 1) + s;
          idx.push(d - sides - 2, d - sides - 1, d, d - sides - 2, d, d - 1);
        }
      }
    }
    const g = buffer(T, p, n, uv, idx);
    g.computeVertexNormals();
    append(m, g);
  }
  function finish() {
    for (const [m, a] of buckets) root.add(new T.Mesh(buffer(T, a.p, a.n, a.uv, a.ix), m));
  }
  return { oval, tip, snout, finish };
}
function headRig(T, rival, materials) {
  const { skin, crest, horn, bone, dark, lining, tuft } = materials;
  const lip = new T.MeshPhysicalMaterial({
    color: rival ? 0x8696b5 : 0xa44731,
    roughness: 0.38,
    clearcoat: 1,
    clearcoatRoughness: 0.13,
    ior: 1.38,
  });
  // A thin translucent film across the canine roots and the vermilion border. The
  // wet underside catches a narrow, warm reflection only when the passing flame lights it.
  const gloss = { point: { value: new T.Vector3() }, power: { value: 0 } };
  const enamel = new T.ShaderMaterial({
    uniforms: gloss,
    vertexShader: `varying vec3 wp,wn,lo;varying vec3 rearAxis;void main(){rearAxis=normalize(mat3(modelMatrix)*vec3(0,0,-1));vec4 p=modelMatrix*vec4(position,1.);wp=p.xyz;wn=mat3(modelMatrix)*normal;lo=position;gl_Position=projectionMatrix*viewMatrix*p;}`,
    fragmentShader: `varying vec3 wp,wn,lo,rearAxis;uniform vec3 point;uniform float power;void main(){vec3 l=point-wp;float d=length(l);l/=max(d,.01);vec3 n=normalize(wn),v=normalize(cameraPosition-wp),h=normalize(l+v);float nl=clamp(dot(n,l),0.,1.),nh=clamp(dot(n,h),0.,1.),vh=clamp(dot(v,h),0.,1.);float fres=.055+.945*pow(1.-vh,5.);float gloss=pow(nh,160.)*fres*120./max(.28,4.*dot(v,n));float e=power/max(1.,pow(d,1.7));vec3 ivory=vec3(.74,.66,.57)*(.25+.75*max(dot(n,normalize(vec3(.558,.423,.714))),0.));float flankLight=1.-smoothstep(.59,.92,dot(l,rearAxis));float phase=pow(max(0.,-dot(v,l)),3.);float bevel=pow(max(0.,-dot(n,l)),3.)*pow(1.-abs(dot(v,n)),.8);float through=14.*phase*bevel*smoothstep(4.,7.4,lo.z);gl_FragColor=vec4(ivory+vec3(1.,.42,.1)*e*flankLight*(nl*(.09+gloss)+through),1.);}`,
  });
  const wetEye = new T.ShaderMaterial({
    uniforms: {
      irisColor: { value: new T.Color(rival ? 0.18 : 1, rival ? 0.28 : 0.48, rival ? 0.75 : 0.055) },
      catchWarm: { value: rival ? 0.45 : 1 },
    },
    vertexShader: `varying vec3 n,v;void main(){vec4 world=modelMatrix*vec4(position,1.);n=normalize(mat3(modelMatrix)*normal);v=cameraPosition-world.xyz;gl_Position=projectionMatrix*viewMatrix*world;}`,
    fragmentShader: `varying vec3 n,v;uniform vec3 irisColor;uniform float catchWarm;void main(){vec3 N=normalize(n),V=normalize(v),L=normalize(vec3(.558,.423,.714));float F=pow(1.-max(0.,dot(N,V)),4.);float highlight=pow(max(0.,dot(N,normalize(V+L))),190.);gl_FragColor=vec4(irisColor*(.22+.45*max(0.,dot(N,L)))+vec3(.22,.29,.46)*F+vec3(1.,.78,.52)*highlight*(21.*catchWarm),1.);}`,
  });
  const skull = new T.Group(),
    jaw = new T.Group(),
    mane = new T.Group(),
    whiskers = new T.Group();
  skull.add(jaw, mane, whiskers);
  const a = sculpt(T, skull),
    j = sculpt(T, jaw),
    m = sculpt(T, mane),
    w = sculpt(T, whiskers);
  // Long tapering muzzle, high nasal arch and a narrower mobile mandible. Local +Z is forward.
  a.snout(skin, [
    [-5, -0.18, 0.1, 0.2],
    [-4, 0.03, 1.91, 1.47],
    [-2.4, 0.02, 2.88, 2.28],
    [-0.9, 0.11, 2.81, 2.04],
    [0.5, -0.03, 2.22, 1.92],
    [1.9, -0.26, 1.78, 1.47],
    [3.7, -0.3, 1.56, 1.03],
    [5.2, -0.49, 1.25, 0.94],
    [6.7, -0.45, 0.92, 0.79],
    [7.5, -0.3, 1.03, 0.87],
    [8.1, -0.38, 0.53, 0.61],
    [8.34, -0.4, 0.04, 0.07],
  ]);
  a.oval(lining, [0, -0.9, 3.32], [1.37, 0.22, 3.76]);
  j.snout(
    skin,
    [
      [-3.1, -1.13, 0.09, 0.1],
      [-1.92, -1.38, 1.62, 0.97],
      [0, -1.48, 1.67, 0.82],
      [2, -1.53, 1.36, 0.76],
      [4.2, -1.63, 1.11, 0.69],
      [5.8, -1.69, 0.9, 0.67],
      [6.53, -1.77, 0.55, 0.55],
      [6.86, -1.73, 0.12, 0.16],
    ],
    true,
  );
  j.oval(lining, [0, -1.22, 2.83], [1.3, 0.21, 3.34]);
  for (const sign of [-1, 1]) {
    const side = (coords) => coords.map(([x, y, z]) => [x * sign, y, z]);
    a.oval(crest, [sign * 1.64, 1.62, 1.13], [0.65, 0.39, 1.97], [0.03, sign * 0.18, sign * 0.3]);
    a.oval(dark, [sign * 1.94, 1.11, 1.77], [0.55, 0.62, 0.66]);
    a.oval(wetEye, [sign * 2.18, 1.15, 1.92], [0.48, 0.51, 0.52]);
    a.oval(dark, [sign * 2.62, 1.13, 2.04], [0.055, 0.25, 0.064]);
    if (rival) {
      for (let k = 0; k < 12; k++) {
        const z = 7.56 - 0.48 * k,
          x = 1.0 + 0.07 * k;
        a.oval(enamel, [sign * x, -1.008 - 0.035 * Math.cos(k * 2.1), z], [0.12 + 0.045 * (k % 3), 0.14, 0.205]);
      }
    }
    a.tip(
      lip,
      side([
        [1.81, -0.84, 1.1],
        [1.4, -0.9, 3.87],
        [1.11, -0.83, 5.66],
        [0.96, -0.77, 7.23],
        [0.75, -0.82, 7.61],
        [0.08, -0.76, 7.89],
      ]),
      [0.1, 0.13, 0.12, 0.18, 0.16, 0.06],
      12,
    );
    a.oval(dark, [sign * 0.76, 0.2, 7.48], [0.22, 0.18, 0.34], [0.32, 0, sign * 0.32]);
    a.oval(crest, [sign * 2.4, -0.43, -0.22], [0.76, 0.61, 1.6]);
    // A forked, narrowing horn has independent brow tine, main beam and upper crown.
    const lift = rival ? 2.0 : 1,
      back = rival ? 0.75 : 1;
    a.tip(
      horn,
      side([
        [1.58, 1.34, -1.3],
        [2.25, 2.48 * lift, -2.65],
        [3.04, 3.0 * lift, -4.4 * back],
        [3.88, 3.35 * lift, -6.14 * back],
        [4.43, 4.2 * lift, -7.7 * back],
      ]),
      [0.6, 0.49, 0.33, 0.16, 0],
      10,
    );
    a.tip(
      horn,
      side([
        [2.78, 2.9 * lift, -3.95 * back],
        [2.77, 3.81 * lift, -4.25 * back],
        [2.48, 4.65 * lift, -4.9 * back],
      ]),
      [0.36, 0.17, 0],
    );
    a.tip(
      horn,
      side([
        [3.66, 3.23 * lift, -5.82 * back],
        [4.4, 3.34 * lift, -6.01 * back],
        [5.01, 3.55 * lift, -6.25 * back],
      ]),
      [0.23, 0.12, 0],
    );
    for (let k = 0; k < 17; k++) {
      const z = 7.45 - 0.4 * k,
        x = 0.84 + (0.7 * k) / 17,
        h = k === 3 ? 0.97 : 0.37 + 0.25 * ((k + 1) % 3);
      a.tip(
        bone,
        side([
          [x, -0.71, z],
          [x * 1.03, -0.7 - h * 0.58, z - 0.09],
          [x * 0.94, -0.7 - h, z - 0.23],
        ]),
        [0.16, 0.1, 0.012],
        10,
      );
      if (z < 6.5)
        j.tip(
          bone,
          side([
            [x, -1.42, z - 0.13],
            [x * 0.99, -1.16, z - 0.08],
            [x * 0.96, -0.91, z - 0.13],
          ]),
          [0.12, 0.07, 0],
        );
    }
    for (let k = 0; k < 32; k++) {
      const u = k / 31,
        phase = k * 2.399,
        rootX = 1.32 + 1.14 * Math.sin(Math.PI * u),
        rootY = 1.65 - 3.0 * u,
        rootZ = 0.7 - 3.35 * u,
        reach = 3.5 + 2.8 * (0.5 + 0.5 * Math.sin(phase));
      m.tip(
        k % 3 === 0 ? horn : crest,
        side([
          [rootX, rootY, rootZ],
          [rootX + 0.8, rootY + 0.28 * Math.cos(phase), rootZ - 1.1],
          [rootX + 1.0 + 1.5 * u, rootY - 0.4 + 1.3 * Math.sin(phase), rootZ - reach * 0.65],
          [rootX + 1.35 + 1.2 * Math.sin(phase + 0.7), rootY - 0.5 + 1.4 * Math.cos(phase), rootZ - reach],
        ]),
        [0.28, 0.29, 0.15, 0],
      );
    }
    for (let k = 0; k < 11; k++) {
      const z = 3.4 - k * 0.42;
      j.tip(
        crest,
        side([
          [1.1, -1.58, z],
          [1.33, -2.45, z - 0.24],
          [1.04 + 0.25 * Math.sin(k), -3.2 - 0.85 * Math.sin(k * 0.4), z - 1.5],
        ]),
        [0.16, 0.15, 0],
      );
    }
    w.tip(
      tuft,
      side([
        [1.12, 0.22, 4.71],
        [2.6, 1.02, 5.02],
        [4.6, 1.88, 2.55],
        [6.85, 1.46, -2.65],
        [7.8, 0.55, -6.6],
        [7.85, 1.3, -8.5],
      ]),
      [0.096, 0.085, 0.06, 0.042, 0.023, 0],
    );
  }
  a.finish();
  j.finish();
  m.finish();
  w.finish();
  if (!rival) enamel.dispose();
  return { skull, jaw, mane, whiskers, gloss };
}
function limbRig(T, skin, crest, bone, side) {
  const o = new T.Group(),
    b = sculpt(T, o),
    s = side;
  b.tip(
    skin,
    [
      [0, 0, 0],
      [1.5 * s, -1.6, 1.1],
      [2.5 * s, -3.8, 1.5],
      [3.0 * s, -4.5, 4.3],
      [3.16 * s, -5.8, 5.4],
    ],
    [1.19, 0.94, 0.7, 0.43, 0.35],
    9,
  );
  for (let i = 0; i < 3; i++) {
    const d = (i - 1) * 0.72;
    b.tip(
      crest,
      [
        [3.16 * s, -5.8, 5.4],
        [(3.2 + d * 0.65) * s, -6.4, 6.04],
        [(3.3 + d) * s, -6.4, 6.85 - 0.24 * Math.abs(d)],
      ],
      [0.26, 0.19, 0.08],
    );
    b.tip(
      bone,
      [
        [(3.3 + d) * s, -6.4, 6.85 - 0.24 * Math.abs(d)],
        [(3.3 + d * 1.1) * s, -6.55, 7.11],
        [(3.25 + d * 1.25) * s, -6.82, 7.32],
      ],
      [0.13, 0.09, 0],
    );
  }
  b.finish();
  return o;
}
export function creature(T, i, params, height) {
  const root = new T.Group(),
    pale = Boolean(i),
    skin = solid(T, pale ? 0xb3c4e0 : 0xc12c23, 0.58, 0.04),
    crest = solid(T, pale ? 0xc1ccdf : 0xf7b453, 0.5, 0.09),
    bone = new T.MeshPhysicalMaterial({
      color: pale ? 0xe4edff : 0xffedcf,
      roughness: 0.24,
      clearcoat: 0.77,
      clearcoatRoughness: 0.15,
    }),
    horn = solid(T, pale ? 0xcbdaef : 0xe7bb79, 0.41),
    dark = solid(T, 0x261d27, 0.24),
    lining = solid(T, pale ? 0x706778 : 0x95352c),
    tuft = solid(T, pale ? 0xf0f4ff : 0xffcc6c),
    hide = skin.clone();
  tuft.transparent = true;
  const materials = [skin, crest, bone, horn, dark, lining, tuft, hide];
  const fog = fogCard(
    { THREE: T },
    {
      mistDensity: 0.0023,
      airDensity: 0.00042,
      heightScale: 23,
      gloom: 0.78,
      sunLit: 0.4,
      sunDir: [0.558, 0.423, 0.714],
    },
  );
  if (!off(params, 'atmo.height-fog')) materials.forEach((v) => fog.patchMaterial(v));
  const px = { value: computePxK(28, height) },
    shared = {
      uExcite: { value: 0 },
      uClock: { value: 0 },
      uPxK: px,
      uPxLodParams: { value: new T.Vector3(0.25, 1.2, 4.5) },
    };
  // Backlit translucent keratin: the tip transmits more of the sun than the stout root.
  const warmHorn = horn.onBeforeCompile;
  horn.onBeforeCompile = function (sh, r) {
    warmHorn.call(this, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float taper;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntaper=uv.x;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float taper;')
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>\nvec3 lightVector=normalize(mat3(viewMatrix)*vec3(.558,.423,.714));float translucence=pow(1.-abs(dot(normal,lightVector)),${pale ? '1.55' : '3.5'})*smoothstep(.05,.83,taper);reflectedLight.indirectDiffuse+=vec3(1.,.69,.37)*translucence*${pale ? '2.75' : '1.05'};`,
      );
  };
  horn.customProgramCacheKey = () => `keratin-${i}-${+!off(params, 'atmo.height-fog')}`;
  const paintFace = skin.onBeforeCompile;
  skin.onBeforeCompile = function (sh, r) {
    paintFace.call(this, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 facePoint;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nfacePoint=position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 facePoint;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
      vec2 plate=vec2(facePoint.z*3.8,atan(facePoint.y,facePoint.x)*8.4);plate.x+=mod(floor(plate.y),2.)*.5;vec2 facet=fract(plate)-.5;float bevel=1.-smoothstep(.03,.13,abs(facet.x+.23-facet.y*facet.y));diffuseColor.rgb=mix(diffuseColor.rgb,vec3(${pale ? '.51,.62,.88' : '.78,.26,.095'}),bevel*.54);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\nfloat lift=.085*(.5+facet.x)*cos(2.9*facet.y)-.016*bevel;vec3 dx=dFdx(-vViewPosition),dy=dFdy(-vViewPosition),A=cross(dy,normal),B=cross(normal,dx);float J=dot(dx,A);normal=normalize(abs(J)*normal-sign(J)*(dFdx(lift)*A+dFdy(lift)*B));`,
      );
  };
  skin.customProgramCacheKey = () => `face-scutes-${i}-${+!off(params, 'atmo.height-fog')}`;
  // Relief and gold rims are parameterized by arc length rather than world coordinates, so the scales move with the skin.
  // Existing fog hooks run first. Cache separate programs for the geometry's scale field and ordinary skin.
  const paint = hide.onBeforeCompile;
  hide.onBeforeCompile = function (shader, r) {
    paint.call(this, shader, r);
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 skinUV;varying float eyeDepth;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nskinUV=uv;eyeDepth=-mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec2 skinUV;varying float eyeDepth;uniform float uExcite,uClock;\n${GLSL_PX_LOD}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
      vec2 tiles=skinUV*vec2(${i ? '190.' : '210.'},28.);tiles.x+=.5*mod(floor(tiles.y),2.);vec2 cell=fract(tiles)-.5;float scallop=abs(cell.x+.23-1.15*cell.y*cell.y);float edge=1.-smoothstep(.022,.102,scallop);float belly=1.-smoothstep(-.90,-.57,cos(skinUV.y*6.28318));float detail=${off(params, 'shade.px-lod') ? '1.' : 'shadePxLod(.31,eyeDepth,uPxK,1.2,4.5)'};
      float flank=clamp(.58+.36*cos(6.283*skinUV.y)+.20*sin(skinUV.x*120.),0.,1.);diffuseColor.rgb=mix(vec3(${i ? '.34,.44,.66' : '.44,.009,.016'}),vec3(${i ? '.72,.79,.95' : '.68,.027,.021'}),flank);
      float tileLift=(.45+.55*cos(cell.y*3.8))*(.4+cell.x*.55);diffuseColor.rgb*=.78+.24*tileLift;diffuseColor.rgb=mix(diffuseColor.rgb,vec3(${i ? '.75,.83,1.' : '.93,.37,.06'}),detail*edge*.65);
      float seam=1.-smoothstep(.025,.105,abs(fract(skinUV.x*142.+.38*cos(6.283*skinUV.y))-.5));diffuseColor.rgb=mix(diffuseColor.rgb,mix(vec3(${i ? '.40,.51,.73' : '.21,.031,.018'}),vec3(${i ? '.73,.81,.96' : '.94,.49,.15'}),seam),belly);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\nfloat ridgeHeat=(.42+.58*pow(.5+.5*sin(skinUV.x*${(lengths[i] * 0.22).toFixed(2)}+uClock*5.5),.9))*(1.-smoothstep(0.,.72,skinUV.x));totalEmissiveRadiance+=vec3(${pale ? '1.2,2.6,5.' : '5.,.85,.10'})*edge*edge*(.012+.78*uExcite*ridgeHeat)*(1.-belly)*(.55+.45*detail)*smoothstep(.1,.74,dot(normalize(vNormal),normalize(vViewPosition)));`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\nfloat relief=detail*((.14*tileLift-.068*edge)*(1.-belly)-.036*seam*belly);vec3 sx=dFdx(-vViewPosition),sy=dFdy(-vViewPosition),bx=cross(sy,normal),by=cross(normal,sx);float det=dot(sx,bx);normal=normalize(abs(det)*normal-sign(det)*(dFdx(relief)*bx+dFdy(relief)*by));`,
      );
  };
  hide.customProgramCacheKey = () => `flight-scale-${i}-${+!off(params, 'atmo.height-fog')}-${off(params, 'shade.px-lod')}`;
  if (!off(params, 'three.patch'))
    patchCard({ THREE: T }).attachMaterialPatch(hide, [
      {
        stage: 'fragmentShader',
        mode: 'after',
        anchor: '#include <roughnessmap_fragment>',
        code: '\nroughnessFactor=mix(.53,.37,edge*detail);\n',
      },
      {
        stage: 'fragmentShader',
        mode: 'after',
        anchor: '#include <lights_fragment_end>',
        code: '\nreflectedLight.indirectSpecular+=vec3(.24,.15,.065)*edge*detail*pow(1.-abs(dot(normalize(vViewPosition),normal)),2.);\n',
      },
    ]);
  const h = headRig(T, pale, { skin, crest, horn, bone, dark, lining, tuft });
  root.add(h.skull);
  const limbs = [];
  const hoof = solid(T, pale ? 0x858fac : 0x572e24, 0.7),
    toe = solid(T, pale ? 0x7b89a5 : 0x922e26, 0.72);
  if (!off(params, 'atmo.height-fog')) {
    fog.patchMaterial(hoof);
    fog.patchMaterial(toe);
  }
  for (let k = 0; k < 4; k++) {
    const l = limbRig(T, skin, toe, hoof, k % 2 ? 1 : -1);
    limbs.push(l);
    root.add(l);
  }
  const rings = 151,
    sides = 28,
    count = rings * (sides + 1),
    uv = [],
    idx = [],
    radii = [],
    angles = Array.from({ length: sides + 1 }, (_, j) => [
      Math.cos((j * 2 * Math.PI) / sides),
      Math.sin((j * 2 * Math.PI) / sides),
    ]);
  for (let z = 0; z < rings; z++) {
    const f = z / (rings - 1);
    radii.push(
      (pale ? 3.1 : 3.6) * Math.pow(1 - f, 0.63) * (0.72 + 0.28 * Math.sin(Math.min(1, f * 3) * Math.PI * 0.7)) + 0.035,
    );
    for (let a = 0; a <= sides; a++) {
      uv.push(f, a / sides);
      const b = z * (sides + 1) + a;
      if (z && a) idx.push(b - sides - 2, b - sides - 1, b, b - sides - 2, b, b - 1);
    }
  }
  const tube = buffer(T, new Float32Array(count * 3), new Float32Array(count * 3), uv, idx),
    skinMesh = new T.Mesh(tube, hide);
  skinMesh.frustumCulled = false;
  root.add(skinMesh);
  // The auxiliary ID/depth pass replaces the material and does not apply instanceMatrix.
  // Store each swept, curved dorsal spine in the same world-space mesh in all passes.
  const nSpines = 146,
    spineSides = 6,
    spineRings = 6,
    ridx = [],
    rUV = [];
  for (let n = 0; n < nSpines; n++)
    for (let j = 0; j < spineRings; j++)
      for (let k = 0; k < spineSides; k++) {
        rUV.push(k / spineSides, j / (spineRings - 1));
        if (j) {
          const a = (n * spineRings + j) * spineSides + k,
            b = a - k + ((k + 1) % spineSides);
          ridx.push(a - spineSides, b - spineSides, b, a - spineSides, b, a);
        }
      }
  const ridgeGeo = buffer(
      T,
      new Float32Array(nSpines * spineRings * spineSides * 3),
      new Float32Array(nSpines * spineRings * spineSides * 3),
      rUV,
      ridx,
    ),
    ridge = new T.Mesh(ridgeGeo, crest);
  ridge.frustumCulled = false;
  root.add(ridge);
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  const M = new T.Matrix4(),
    x = new T.Vector3(),
    y = new T.Vector3(),
    z = new T.Vector3(),
    v = new T.Vector3();
  function orient(o, c, up, front) {
    x.fromArray(cross(up, front)).normalize();
    M.makeBasis(x, y.fromArray(up), z.fromArray(front));
    o.quaternion.setFromRotationMatrix(M);
    o.position.fromArray(c);
  }
  return {
    root,
    update(body, state, hPx = height) {
      px.value = computePxK(state.camera.fov, hPx);
      shared.uClock.value = state.time;
      shared.uExcite.value =
        (pale ? 0.1 : 0.06) * (0.5 + 0.5 * Math.sin(1.7 * state.time + (pale ? 2 : 0))) +
        (pale ? 0 : 0.9 * state.breath.intensity);
      const spine = body.spine,
        at = (f) => spine[Math.round(f * (spine.length - 1))],
        pa = tube.attributes.position,
        na = tube.attributes.normal;
      for (let j = 0; j < rings; j++) {
        const n = at(j / (rings - 1)),
          r = radii[j];
        for (let a = 0; a <= sides; a++) {
          const [c, s] = angles[a],
            k = j * (sides + 1) + a;
          const nx = n.nor[0] * c + n.bin[0] * s,
            ny = n.nor[1] * c + n.bin[1] * s,
            nz = n.nor[2] * c + n.bin[2] * s;
          pa.setXYZ(k, n.pos[0] + r * nx, n.pos[1] + r * ny, n.pos[2] + r * nz);
          na.setXYZ(k, nx, ny, nz);
        }
      }
      pa.needsUpdate = na.needsUpdate = true;
      tube.computeBoundingSphere();
      tube.computeBoundingBox();
      const rp = ridgeGeo.attributes.position,
        rn = ridgeGeo.attributes.normal;
      for (let j = 0; j < nSpines; j++) {
        const f = j / nSpines,
          n = at(f),
          r = radii[Math.round(f * (rings - 1))],
          len = (1.7 + 2.25 * Math.exp(-f * 5)) * (0.78 + 0.23 * Math.sin(j * 2.3)) * Math.sqrt(1 - f),
          bank = 0.25 * Math.sin(j * 2.4);
        for (let ring = 0; ring < spineRings; ring++) {
          const t = ring / (spineRings - 1),
            wide = (1 - t) * (0.44 + 0.24 * Math.sin(t * 3));
          for (let k = 0; k < spineSides; k++) {
            const a = (k * 2 * Math.PI) / spineSides,
              A = Math.cos(a),
              B = Math.sin(a),
              ix = (j * spineRings + ring) * spineSides + k;
            v.fromArray(n.pos)
              .addScaledVector(y.fromArray(n.nor), r * 0.96 + len * (t - 0.32 * t * t))
              .addScaledVector(x.fromArray(n.tan), len * t * (0.25 + 1.05 * t) + A * wide)
              .addScaledVector(z.fromArray(n.bin), len * t * bank + B * wide * 0.64);
            rp.setXYZ(ix, v.x, v.y, v.z);
            v.copy(x).multiplyScalar(A).addScaledVector(z, B).addScaledVector(y, 0.21).normalize();
            rn.setXYZ(ix, v.x, v.y, v.z);
          }
        }
      }
      rp.needsUpdate = rn.needsUpdate = true;
      ridgeGeo.computeBoundingSphere();
      ridgeGeo.computeBoundingBox();
      h.gloss.point.value.fromArray(state.light.position);
      h.gloss.power.value = state.light.intensity;
      orient(h.skull, body.head, body.up, body.forward);
      h.jaw.rotation.x = pale ? 0.07 : 0.08 + state.breath.intensity * 0.32;
      h.mane.rotation.z = 0.045 * state.baked;
      h.whiskers.rotation.x = 0.06 * state.baked;
      const dist = Math.hypot(...body.head.map((v, j) => v - state.camera.position[j])),
        thin = evaluateThinLine(0.066, dist, { viewportHeight: hPx, fovYDeg: state.camera.fov, minPx: 1.2 });
      // Widening the barbels via their cross-section (not by enlarging their span) conserves integrated line energy.
      const width = off(params, 'shade.thin-line') ? 1 : thin.clampedWorldWidth / 0.066;
      for (const whisker of h.whiskers.children) {
        const g = whisker.geometry,
          ps = g.attributes.position,
          ns = g.attributes.normal;
        g.userData.centered ??= ps.array.slice();
        const raw = g.userData.centered;
        for (let k = 0; k < ps.count; k++) {
          const grow = (width - 1) * 0.033;
          ps.setXYZ(
            k,
            raw[3 * k] + grow * ns.getX(k),
            raw[3 * k + 1] + grow * ns.getY(k),
            raw[3 * k + 2] + grow * ns.getZ(k),
          );
        }
        ps.needsUpdate = true;
      }
      tuft.opacity = off(params, 'shade.thin-line') ? 1 : thin.effectiveAlpha;
      limbs.forEach((o, k) => {
        const f = (k < 2 ? 23 : 86) / 172,
          n = at(f),
          front = n.tan.map((v) => -v),
          side = k % 2 ? 1 : -1,
          reach = pale ? 0 : 0.4 * state.breath.intensity;
        const r = radii[Math.round(f * (rings - 1))],
          shoulder = n.pos.map((v, j) => v + 0.65 * side * r * n.bin[j] - 0.4 * r * n.nor[j]),
          phase = 0.3 * f * lengths[i] + side;
        const raw = Math.min(1, Math.max(0, (body.speed - 13) / 17)),
          tuck = raw * raw * (3 - 2 * raw) * (1 - 0.8 * reach),
          stroke = 0.3 * Math.sin(state.time * 1.25 + phase);
        orient(o, shoulder, n.nor, front);
        o.rotateX(
          (0.25 + stroke) * (1 - tuck) + (1.26 + 0.1 * stroke) * tuck - reach * (k < 2 ? 1.15 : 0.35) * (1 - tuck),
        );
        o.rotateZ(
          -side * ((0.25 + 0.12 * Math.sin(0.9 * state.time + phase)) * (1 - tuck) + 0.07 * tuck + 0.32 * reach),
        );
        o.scale.setScalar(pale ? 0.86 : 1);
      });
    },
    dispose() {
      fog.dispose();
    },
  };
}
