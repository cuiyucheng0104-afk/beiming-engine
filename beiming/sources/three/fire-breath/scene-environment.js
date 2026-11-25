// World-space canyon. The same eroded beds carry the lit material, receive the
// travelling emitter lights, cast shadows and supply the geometry for depth/ID.
import { create as heightFog } from '../../../cards/atmosphere/height-fog/three.js';
import { GLSL_PX_LOD } from '../../../cards/shading/px-lod/three.js';

function randomStream(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
const noise = `
float h3(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
float n3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  vec2 h=vec2(0.,1.);
  return mix(mix(mix(h3(i),h3(i+h.yxx),f.x),mix(h3(i+h.xyx),h3(i+h.yyx),f.x),f.y),
    mix(mix(h3(i+h.xxy),h3(i+h.yxy),f.x),mix(h3(i+h.xyy),h3(i+h.yyy),f.x),f.y),f.z);}
float layers(vec3 p){float v=0.,a=.55;for(int i=0;i<5;i++){v+=a*n3(p);p=p.yzx*2.03+7.13;a*=.49;}return v;}`;

function skyDome(T) {
  const material = new T.ShaderMaterial({
    side: T.BackSide,
    depthWrite: false,
    uniforms: { clock: { value: 0 } },
    vertexShader: `varying vec3 ray;
    void main(){ ray=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `varying vec3 ray; uniform float clock; ${noise}
    // Intersect the rising turrets in sky space, recover the first surface normal and
    // light it towards the same sun as the terrain. No screen-space billboards.
    void bank(vec3 d,vec3 center,vec3 radii,float storm,inout float nearest,inout vec3 col){
      vec3 ro=-center/radii, rd=d/radii;float a=dot(rd,rd),b=dot(ro,rd);
      float detail=layers(d*54.+clock*.012);float shape=1.+.67*(detail-.49);
      float h=b*b-a*(dot(ro,ro)-shape*shape);if(h<0.)return;
      float hit=(-b-sqrt(h))/a;if(hit<=0.||hit>=nearest)return;
      nearest=hit;vec3 surface=hit*d;vec3 n=normalize((surface-center)/(radii*radii));
      vec3 q=surface*4.4+vec3(clock*.017,0.,0.); float grain=layers(q);
      vec3 N=normalize(n+1.3*(vec3(layers(q+.16*vec3(1,0,0)),layers(q+.16*vec3(0,1,0)),layers(q+.16*vec3(0,0,1)))-grain));
      float diffuse=max(dot(N,normalize(vec3(.56,.42,.71))),0.);
      vec3 shadow=mix(vec3(.22,.26,.33),vec3(.033,.041,.068),storm);
      vec3 sun=mix(vec3(1.15,1.07,.91),vec3(.096,.110,.152),storm);
      col=mix(shadow,sun,.77*diffuse+.23*grain)*(.72+.44*grain);
    }
    void main(){vec3 d=normalize(ray);vec3 p=d*9.+vec3(clock*.018,0.,0.);float cloud=layers(p*vec3(.85,2.4,1.));
      vec3 sky=mix(vec3(.11,.145,.24),vec3(.032,.044,.078),smoothstep(-.03,.87,d.y));
      sky+=vec3(.21,.20,.21)*smoothstep(.39,.84,cloud)*(1.-.42*d.y);float nearest=1e4;
      bank(d,vec3(-4.,1.25,-8.),vec3(1.85,1.12,1.8),0.,nearest,sky);
      bank(d,vec3(4.7,1.4,-9.2),vec3(1.8,1.8,1.6),.1,nearest,sky);
      for(int j=0;j<16;j++){float k=float(j);float a=k*2.39996;
        vec3 center=vec3(-.97+.75*cos(a),1.44+k*.25+.24*sin(2.*a),-5.8+.5*sin(a));
        bank(d,center,vec3(.69+.044*k,1.20,.84+.03*k),.93,nearest,sky);}
      gl_FragColor=vec4(sky,1.);}`,
  });
  const mesh = new T.Mesh(new T.SphereGeometry(5000, 42, 24), material);
  mesh.renderOrder = -100;
  return mesh;
}

// Each horizontal bed has its own worn lip; angular joints persist vertically
// across beds. The vertices line up across the seam, so smooth normals don't open cracks.
function towerGeometry(T, low, high, foot, crown, lean, seed) {
  const pos = [],
    index = [],
    around = 48,
    rows = Math.ceil((high - low) / 1.5),
    top = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i < around; i++) {
      const a = (2 * Math.PI * i) / around,
        y = low + ((high - low) * j) / rows,
        u = j / rows;
      const relief =
        0.09 * Math.sin(a * 5 + seed) +
        0.055 * Math.sin(a * 9 - (0.25 * y) / 10) +
        0.035 * Math.cos(a * 15 + seed + 0.06 * y);
      const bed = Math.floor((y + 1.9 * Math.sin(3 * a + seed)) / 4.5);
      const lip = 0.5 * Math.cos(bed * 6.7 + Math.floor(a * 4) * 3.4) + 0.31 * Math.sin(y * 1.6 + a * 2);
      const r = ((foot * (1 - u) + crown * u) * (1 + relief) + lip) * (1 + 0.11 * Math.cos(u * 14));
      pos.push(r * Math.cos(a) + lean[0] * u, y + 0.63 * Math.sin(3 * a + seed), r * Math.sin(a) + lean[1] * u);
      if (j === rows) top.push(j * around + i);
      if (j < rows) {
        const v = j * around + i,
          w = j * around + ((i + 1) % around);
        index.push(v, v + around, w, w, v + around, w + around);
      }
    }
  const center = pos.length / 3;
  pos.push(lean[0], high + 0.6, lean[1]);
  top.forEach((k, i) => index.push(center, top[(i + 1) % around], k));
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function rockMaterial(T, lod, height) {
  const mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.87 });
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 localSite;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nlocalSite=(modelMatrix*vec4(transformed,1.)).xyz;',
      );
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 localSite;\n${noise}\n${lod ? GLSL_PX_LOD : ''}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
      vec3 p=localSite;float grit=layers(p*.65); float y=p.y+.12*p.x+.45*sin(.3*p.z)+1.1*grit;
      vec3 joint=abs(fract(vec3(p.x*.24+.13*sin(.13*y),y*.35,p.z*.21)+.19*grit)-.5);
      float seam=min(joint.y,max(joint.z,joint.x)*.6); float fine=${lod ? `shadePxLod(.18,1.,max(length(dFdx(p)),length(dFdy(p))),1.2,5.)` : '1.'};
      float granite=.56+.46*grit+.12*sin(y*1.2)-.40*(1.-smoothstep(.005,.060,seam))*fine;
      vec3 bed=mix(vec3(.16,.116,.100),vec3(.49,.405,.322),layers(p*vec3(.18,.07,.18)));
      float patina=smoothstep(.41,.64,layers(p*vec3(.44,.069,.41)))*smoothstep(.16,.60,grit);
      diffuseColor.rgb*=mix(granite*bed,vec3(.065,.071,.044),patina*.80);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
      float faceHeight= .12*grit - .085*(1.-smoothstep(.003,.085,seam))+.15*layers(localSite*vec3(.58,.12,.58));
      vec3 dp1=dFdx(-vViewPosition),dp2=dFdy(-vViewPosition);
      vec3 rr=cross(dp2,normal),ss=cross(normal,dp1);float det=dot(dp1,rr);
      normal=normalize(max(abs(det),1.e-10)*normal-sign(det)*(dFdx(faceHeight)*rr+dFdy(faceHeight)*ss));`,
      );
  };
  return mat;
}

// Wind-slanted drops in a periodic world volume. Draw the optical streak in view
// space, compare to the resolved device depth, and conserve coverage below a pixel.
function rainField(T, random) {
  const plane = new T.PlaneGeometry(1, 1),
    g = new T.InstancedBufferGeometry();
  g.index = plane.index;
  g.setAttribute('position', plane.attributes.position);
  const drops = Float32Array.from({ length: 16000 * 4 }, random);
  g.setAttribute('drop', new T.InstancedBufferAttribute(drops, 4));
  g.instanceCount = drops.length / 4;
  const uniforms = { time: { value: 0 }, zMap: { value: null }, screen: { value: new T.Vector2(1, 1) } };
  const material = new T.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: T.AdditiveBlending,
    vertexShader: `attribute vec4 drop; uniform float time; uniform vec2 screen; varying vec2 uvDrop; varying float energy;
    void main(){vec3 p=vec3(fract(drop.x-time*.045)*160.-80.,fract(drop.y-time*(.17+.04*drop.w))*137.+3.,drop.z*120.-62.);
      vec3 a=(viewMatrix*vec4(p,1.)).xyz;vec3 b=(viewMatrix*vec4(p+vec3(.49,1.75,-.17)*(.65+.65*drop.w),1.)).xyz;
      vec4 ca=projectionMatrix*vec4(a,1.),cb=projectionMatrix*vec4(b,1.); vec2 delta=(cb.xy/cb.w-ca.xy/ca.w)*screen;
      vec2 tangent=delta/max(length(delta),.001);vec4 clip=mix(ca,cb,position.y+.5);
      float pixels=.019*screen.y*projectionMatrix[1][1]/max(1.,-a.z);
      clip.xy+=2.*vec2(-tangent.y,tangent.x)*position.x*max(1.,pixels)/screen*clip.w; gl_Position=clip;
      uvDrop=position.xy+.5; energy=min(1.,pixels)*(.15+.7*pow(drop.w,6.));}`,
    fragmentShader: `uniform sampler2D zMap; uniform vec2 screen; varying vec2 uvDrop; varying float energy;
      void main(){if(gl_FragCoord.z>texture2D(zMap,gl_FragCoord.xy/screen).r)discard;
        float a=(1.-abs(2.*uvDrop.x-1.))*sin(3.14159*uvDrop.y)*energy;
        gl_FragColor=vec4(vec3(.31,.39,.60),a);}`,
  });
  const mesh = new T.Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return {
    mesh,
    update(time) {
      uniforms.time.value = time;
    },
    setDepth(tex) {
      uniforms.zMap.value = tex;
      uniforms.screen.value.set(tex.image.width, tex.image.height);
    },
  };
}

// Low strata of suspended water, advected along the canyon. Opacity is proportional
// to physical thickness, not screen size; both the directional key and the moving
// fire pool scatter off each bank. Device-depth intersections feather over metres.
function valleyMist(T, random) {
  const quad = new T.PlaneGeometry(1, 1),
    g = new T.InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute('position', quad.attributes.position);
  g.setAttribute('seed', new T.InstancedBufferAttribute(Float32Array.from({ length: 126 * 4 }, random), 4));
  g.instanceCount = 126;
  const uniforms = {
    tm: { value: 0 },
    zMap: { value: null },
    screen: { value: new T.Vector2() },
    firePos: { value: new T.Vector3() },
    fireCol: { value: new T.Color() },
    power: { value: 0 },
  };
  const vert = `attribute vec4 seed;uniform float tm;varying vec2 q;varying vec3 world;varying float vz,jitter,bank;
    void main(){q=2.*position.xy;jitter=seed.w;vec3 c=vec3(fract(seed.x+tm*.008)*165.-82.5,
    12.+86.*seed.z*seed.z+5.*sin(6.28*seed.x+tm*.06),-104.+116.*seed.y);
    // Orographic cloud wraps the windward shoulders, then streams downwind.
    bank=0.;if(gl_InstanceID<21){int site=gl_InstanceID%3;
      vec3 shoulder=site==0?vec3(-45.,90.,-96.):site==1?vec3(-18.,60.,-54.):vec3(10.,60.,-66.);
      c=shoulder+vec3((fract(seed.x-tm*.033)-.5)*42.,seed.z*3.8+sin(tm*.21+seed.y*6.),seed.y*8.+6.);bank=1.;}
    vec4 eye=viewMatrix*vec4(c,1.);
    vec2 extent=vec2(19.+seed.y*28.,3.3+seed.w*5.6);eye.xy+=extent*position.xy;
    vz=-eye.z;world=c+vec3((extent*position.xy).x,(extent*position.xy).y,0.);gl_Position=projectionMatrix*eye;}`;
  const frag = `${noise}\nuniform sampler2D zMap;uniform vec2 screen;uniform float tm,power;uniform vec3 firePos,fireCol;
    varying vec2 q;varying vec3 world;varying float vz,jitter,bank;void main(){float d=texture2D(zMap,gl_FragCoord.xy/screen).r;
    float z=3000./(6000.-d*5999.5);float rim=1.-dot(q,q);if(rim<=0.||z<=vz)discard;
    float field=layers(vec3(q*vec2(4.3,2.2)+vec2(jitter*45.+tm*.08,0.),jitter*11.));
    float alpha=mix(.225,.36,bank)*rim*rim*smoothstep(.29,.82,field)*smoothstep(0.,4.,z-vz);
    vec3 light=vec3(.94,.54,.32)*(.5+field)+fireCol*power/(25.+dot(world-firePos,world-firePos))*.64;
    gl_FragColor=vec4(light,alpha);}`;
  const m = new T.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new T.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  return {
    mesh,
    update(s) {
      uniforms.tm.value = s.time;
      uniforms.firePos.value.fromArray(s.light.position);
      uniforms.fireCol.value.fromArray(s.light.color);
      uniforms.power.value = s.light.intensity;
    },
    setDepth(tex) {
      uniforms.zMap.value = tex;
      uniforms.screen.value.set(tex.image.width, tex.image.height);
    },
  };
}

export function createEnvironment(T, params, width, height) {
  const disabled = new Set(params.disableCards ?? []),
    rand = randomStream(718),
    canyon = new T.Group(),
    sky = skyDome(T);
  const fog = disabled.has('atmo.height-fog') ? null : heightFog({ THREE: T }, { sunLit: 0.35, gloom: 0.8 });
  const rock = rockMaterial(T, !disabled.has('shade.px-lod'), height);
  fog?.patchMaterial(rock);
  // Different shader variants must not share a key after the atmosphere patch wraps the material.
  rock.customProgramCacheKey = () => `bedded-rock:${+!!fog}:${+!disabled.has('shade.px-lod')}:${height}`;
  const wood = new T.MeshStandardMaterial({ color: 0x733c2a, roughness: 0.9 }),
    tile = new T.MeshStandardMaterial({ color: 0x342e31, roughness: 0.46, side: T.DoubleSide });
  const leaves = new T.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    side: T.DoubleSide,
    flatShading: true,
  });
  for (const m of [wood, tile, leaves]) fog?.patchMaterial(m);
  function add(g, m, x = 0, y = 0, z = 0) {
    const o = new T.Mesh(g, m);
    o.position.set(x, y, z);
    o.castShadow = o.receiveShadow = true;
    canyon.add(o);
    return o;
  }
  const leafPos = [],
    leafColors = [],
    barkPos = [];
  // Tapered limbs collected into a single static wood mesh. The trees grow on the bed
  // shoulders rather than being painted onto the view; they also enter the shadow pass.
  function branch(a, b, r) {
    const axis = new T.Vector3()
      .fromArray(b)
      .sub(new T.Vector3(...a))
      .normalize();
    const right = new T.Vector3(1, 0, 0).cross(axis).normalize(),
      up = axis.clone().cross(right);
    const ring = (p, radius, j) =>
      new T.Vector3(...p)
        .addScaledVector(right, radius * Math.cos((j * Math.PI) / 3))
        .addScaledVector(up, radius * Math.sin((j * Math.PI) / 3))
        .toArray();
    for (let j = 0; j < 6; j++)
      barkPos.push(
        ...ring(a, r, j),
        ...ring(a, r, j + 1),
        ...ring(b, r * 0.6, j + 1),
        ...ring(b, r * 0.6, j + 1),
        ...ring(b, r * 0.6, j),
        ...ring(a, r, j),
      );
  }
  function grove(x, y, z, scale, autumn) {
    const lean = (rand() - 0.5) * 1.8 * scale,
      trunk = [x + lean, y + scale * 3.4, z + 0.28 * scale];
    branch([x, y, z], trunk, 0.18 * scale);
    for (let j = 0; j < 8; j++) {
      const u = j / 9,
        angle = j * 2.4 + rand() * 0.8,
        span = scale * (1.7 - 0.9 * u);
      const tip = [x + lean + span * Math.cos(angle), y + (1.8 + 2.4 * u) * scale, z + span * Math.sin(angle)];
      branch([x + u * lean, y + scale * (1 + u * 2.1), z], tip, 0.08 * scale);
      for (let k = 0; k < 4; k++) {
        const tint = rand(),
          c = autumn
            ? [0.38 + 0.31 * tint, 0.028 + 0.082 * tint, 0.009 + 0.008 * tint]
            : [0.018 + 0.047 * tint, 0.049 + 0.081 * tint, 0.018 + 0.016 * tint];
        foliage(
          tip[0] + (rand() - 0.5) * span,
          tip[1] + rand() * 0.35 * scale,
          tip[2] + (rand() - 0.5) * span,
          scale * (0.32 + 0.43 * rand()),
          c,
        );
      }
    }
  }
  // Low-poly foliage crowns, assembled into one mesh so individual needles do not need their own draws.
  function foliage(x, y, z, r, color) {
    const n = 13,
      a0 = rand() * 6.28,
      pts = [];
    for (let j = 0; j < n; j++) {
      const a = a0 + (2 * Math.PI * j) / n,
        rr = r * (0.43 + 0.91 * rand());
      pts.push([x + Math.cos(a) * rr, y + rand() * 0.35 * r, z + Math.sin(a) * rr]);
    }
    for (let j = 0; j < n; j++) {
      leafPos.push(...pts[j], x + 0.14 * r, y + 0.44 * r, z, ...pts[(j + 1) % n]);
      const shade = 0.5 + 0.82 * rand();
      for (let k = 0; k < 3; k++) leafColors.push(...color.map((c) => c * shade));
    }
  }
  function tower(x, z, h, r, q, lean, forest = true) {
    add(towerGeometry(T, -6, h, r, q, lean, rand() * 12), rock, x, 0, z);
    if (!forest) return;
    for (let i = 0; i < 115; i++) {
      const u = 0.12 + 0.88 * rand(),
        ang = rand() * Math.PI * 2,
        rr = (r * (1 - u) + q * u) * (1 + 0.15 * rand()),
        y = u * (h + 6) - 6;
      const ax = x + lean[0] * u + rr * Math.cos(ang),
        az = z + lean[1] * u + rr * Math.sin(ang),
        sz = 0.65 + rand() * 1.8;
      const autumn = Math.sin(ang * 3 + 0.08 * y + x) > 0.62,
        pigment = autumn
          ? [0.22 + rand() * 0.28, 0.043 + rand() * 0.045, 0.012]
          : [0.019 + rand() * 0.023, 0.056 + rand() * 0.044, 0.023];
      if (i % 6 === 0) grove(ax, y, az, sz, autumn);
      else
        for (let k = 0; k < 4; k++)
          foliage(
            ax + Math.cos(k * 2.4) * sz * 0.5,
            y + 0.55 * k * sz,
            az + Math.sin(k * 2.4) * sz * 0.56,
            sz * (1 - 0.17 * k),
            pigment,
          );
    }
  }
  tower(10, -66, 102, 12.5, 5.8, [-2, 3]);
  tower(-18, -54, 72, 9, 4.4, [2, -2]);
  tower(-3, -41, 45, 5.2, 2.7, [0, 0]);
  tower(39, -80, 86, 11.5, 5.2, [3, 0]);
  tower(-45, -96, 120, 14, 6.2, [0, 0]);
  for (let i = 0; i < 13; i++) {
    const a = (i - 6) * 0.15,
      d = 260 + rand() * 180;
    tower(d * Math.sin(a), -d * Math.cos(a), 72 + 100 * rand(), 17 + 10 * rand(), 7, [0, 3], false);
  }
  // Valley banks recede away from the lens as the walls rise.
  for (const side of [-1, 1]) {
    const pos = [],
      ind = [],
      n = 56,
      m = 40;
    for (let j = 0; j <= m; j++)
      for (let i = 0; i <= n; i++) {
        const t = i / n,
          u = j / m,
          z = 112 - 292 * t,
          h = side < 0 ? 145 : 34 + 70 * t,
          y = -5 + u * h;
        const x =
          side *
          (22 + t * 54 + 0.25 * (y + 5) + 19 * u * u + 2.6 * Math.sin(0.12 * z) + 1.8 * Math.cos(0.19 * y + 0.07 * z));
        pos.push(x, y, z);
        if (i < n && j < m) {
          const k = j * (n + 1) + i,
            a = [k, k + 1, k + n + 1, k + 1, k + n + 2, k + n + 1];
          ind.push(...(side < 0 ? a : a.reverse()));
        }
      }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(ind);
    g.computeVertexNormals();
    add(g, rock);
  }
  for (let i = 0; i < 34; i++) {
    const side = i % 2 === 0 ? -1 : 1,
      z = -18 - 24 * rand(),
      x = side * (13 + 33 * rand());
    grove(x, 20.2, z, 1.0 + 2.1 * rand(), rand() < 0.74);
  }
  for (const [x, y, z, r, h] of [
    [-27, 24, -6, 15, 23],
    [32, 19, 7, 19, 18],
    [-15, 6, 29, 6, 6],
  ]) {
    const shelf = add(towerGeometry(T, -h, 0, r * 1.25, r * 0.85, [1, 0], r), rock, x, y, z);
    shelf.scale.z = 0.82;
    for (let k = 0; k < 9; k++) {
      const a = k * 0.7;
      grove(x + r * 0.83 * Math.cos(a), y - 0.2, z + 0.75 * r * Math.sin(a), 1.1 + 2.2 * rand(), rand() < 0.75);
    }
  }
  // Use a separate stream for the cliff forest: adding a bank cannot relocate the
  // foliage or the mist on the opposite side of the valley.
  const cliffRandom = randomStream(312);
  for (const side of [-1, 1]) {
    for (let j = 0; j < 72; j++) {
      const t = 0.16 + 0.59 * cliffRandom(),
        u = 0.08 + 0.87 * cliffRandom();
      const z = 112 - 292 * t,
        h = side < 0 ? 145 : 34 + 70 * t,
        y = -5 + u * h;
      const x =
        side *
        (22 + t * 54 + 0.25 * (y + 5) + 19 * u * u + 2.6 * Math.sin(0.12 * z) + 1.8 * Math.cos(0.19 * y + 0.07 * z));
      grove(x - side * 0.7, y, z, 1.5 + cliffRandom() * 2.6, cliffRandom() < 0.21);
    }
  }
  const bark = new T.BufferGeometry();
  bark.setAttribute('position', new T.Float32BufferAttribute(barkPos, 3));
  bark.computeVertexNormals();
  add(bark, wood);
  const turf = new T.BufferGeometry();
  turf.setAttribute('position', new T.Float32BufferAttribute(leafPos, 3));
  turf.setAttribute('color', new T.Float32BufferAttribute(leafColors, 3));
  turf.computeVertexNormals();
  add(turf, leaves);
  add(new T.BoxGeometry(110, 25, 48), rock, 0, 8, -36);
  const water = new T.MeshStandardMaterial({ color: 0x35545a, roughness: 0.32 });
  add(new T.BoxGeometry(130, 1, 220), water, 0, -2, -14);
  const lantern = new T.MeshStandardMaterial({
    color: 0xd56830,
    emissive: new T.Color(1, 0.27, 0.045),
    emissiveIntensity: 1.75,
    roughness: 0.6,
  });
  const paper = lantern.clone();
  paper.emissiveIntensity = 2.3;
  const flame = new T.MeshBasicMaterial({ color: new T.Color(12, 6.1, 1.6) });
  const windowPaper = new T.MeshStandardMaterial({
    color: 0xda8a40,
    emissive: new T.Color(0.78, 0.275, 0.05),
    roughness: 0.78,
  });
  const beams = new T.MeshStandardMaterial({ color: 0xa73317, roughness: 0.63 });
  function hall(x, y, z, w, d) {
    // Paper screen set inside a dark timber lattice. Its diffuse glow reads in the
    // display image without turning an entire building into HDR fire pixels.
    add(new T.BoxGeometry(w * 0.74, 2.7, 0.13), windowPaper, x, y + 2.06, z - 0.09 * d);
    for (let j = -8; j <= 8; j++)
      add(
        new T.BoxGeometry(j % 4 === 0 ? 0.21 : 0.085, 2.92, 0.18),
        beams,
        x + j * w * 0.046,
        y + 2.04,
        z - 0.09 * d + 0.12,
      );
    for (let j = 0; j < 4; j++)
      add(new T.BoxGeometry(w * 0.76, 0.105, 0.18), beams, x, y + 0.74 + j * 0.8, z - 0.09 * d + 0.12);
    add(new T.BoxGeometry(w * 1.02, 0.32, d * 0.91), beams, x, y + 3.82, z);
    add(new T.BoxGeometry(w * 1.06, 0.65, d), wood, x, y, z);
    add(new T.BoxGeometry(w, 0.48, d * 0.9), wood, x, y + 4.0, z);
    for (const dx of [-0.41, 0, 0.41])
      for (const dz of [-0.37, 0.37]) {
        add(new T.CylinderGeometry(0.34, 0.42, 4.6, 8), wood, x + dx * w, y + 2.3, z + dz * d);
        add(new T.BoxGeometry(1.7, 0.49, 1.5), wood, x + dx * w, y + 3.64, z + dz * d);
      }
    for (const dx of [-0.32, -0.14, 0.14, 0.32]) {
      add(
        new T.SphereGeometry(x > 0 ? 0.15 : 0.27, 12, 8),
        x > 0 ? paper : lantern,
        x + dx * w,
        y + 2.94,
        z + d * 0.36,
      );
      if (x < 0) {
        // Open-sided lanterns in the timber gallery: hot core behind a slatted shade.
        const core = add(new T.SphereGeometry(0.046, 12, 8), flame, x + dx * w, y + 2.9, z + d * 0.36 + 0.27);
        core.scale.y = 1.9;
        for (const side of [-1, 0, 1])
          add(new T.BoxGeometry(0.037, 0.6, 0.06), wood, x + dx * w + side * 0.14, y + 2.92, z + d * 0.36 + 0.32);
      }
      add(new T.BoxGeometry(0.65, 0.16, 0.66), tile, x + dx * w, y + 3.25, z + d * 0.36);
    }
    for (const dz of [-0.34, 0.34]) add(new T.BoxGeometry(w, 0.2, 0.22), wood, x, y + 0.98, z + dz * d);
    const p = [],
      idx = [];
    for (let j = 0; j < 5; j++)
      for (let i = 0; i < 9; i++) {
        const u = i / 4 - 1,
          v = j / 2 - 1;
        p.push(u * w * 0.6, 4.1 + 2.4 * (1 - Math.abs(v)) ** 1.8 + 0.85 * Math.abs(u * v) ** 3, v * d * 0.66);
        if (j < 4 && i < 8) {
          const k = j * 9 + i;
          idx.push(k, k + 9, k + 1, k + 1, k + 9, k + 10);
        }
      }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(p, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    add(g, tile, x, y, z);
    add(new T.BoxGeometry(w * 0.85, 0.24, 0.23), wood, x, y + 6.34, z);
    // Uprights form open galleries, with a smaller enclosed storey under each upper roof.
    for (const dx of [-0.36, 0.36]) {
      add(new T.BoxGeometry(w * 0.15, 2.8, d * 0.55), wood, x + dx * w, y + 1.72, z - 0.18 * d);
      for (let k = 0; k < 3; k++)
        add(new T.BoxGeometry(0.11, 1.2, 0.13), tile, x + (dx + (k - 1) * 0.04) * w, y + 2.3, z + 0.115 * d);
    }
  }
  hall(0, 20.5, -17, 18, 10);
  hall(0, 25.5, -17, 12, 8);
  hall(-27, 24, -6, 15, 9);
  hall(-27, 29.1, -6, 9.7, 6.5);
  hall(32, 19, 7, 18, 11);
  hall(32, 22.5, 6, 11, 8);
  // The lanterns also illuminate wood and overhanging foliage. Their casings and
  // the nearby roof shade cast real geometry silhouettes in the opaque pass.
  for (const [x, y, z] of [
    [-27, 28, -2],
    [0, 25, -14],
    [32, 24, 10],
  ]) {
    const lamp = new T.PointLight(new T.Color(1, 0.41, 0.15), 18, 21, 2);
    lamp.position.set(x, y, z);
    canyon.add(lamp);
  }
  const rain = rainField(T, randomStream(9127)),
    mist = valleyMist(T, randomStream(4059)),
    air = new T.Group();
  air.add(rain.mesh, mist.mesh);
  return {
    sky,
    canyon,
    rain: air,
    setDepth(tex) {
      rain.setDepth(tex);
      mist.setDepth(tex);
    },
    update(s) {
      sky.material.uniforms.clock.value = s.time;
      rain.update(s.time);
      mist.update(s);
    },
    dispose() {
      air.removeFromParent();
      const mats = new Set();
      for (const group of [sky, canyon, air])
        group.traverse((o) => {
          if (o.isMesh) {
            o.geometry.dispose();
            mats.add(o.material);
          }
        });
      for (const m of mats) m.dispose();
      fog?.dispose();
    },
  };
}
