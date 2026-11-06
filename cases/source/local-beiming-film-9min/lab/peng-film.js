// Standalone, on-demand render lab: /index.html?test=peng-film&view=world
// view: world | hero | wide | head | feather | underside | swarm | film
// Optional ?t=471&lod=1&spread=1&flap=.4&depth=1300. No animation loop.
import * as THREE from 'three';
import { createPeng, createFeatherSwarm } from '../src/peng.js';
import { PALETTE, TOON_SHARED } from '../src/toon.js';
import { createLook } from '../src/look.js';
import { clamp, ss, lerp } from '../engine/core/math.js';

const query = new URLSearchParams(location.search), W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
renderer.setPixelRatio(1); renderer.setSize(W, H); renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, W / H, 0.5, 12000);
const light = new THREE.DirectionalLight(PALETTE.kunRim, 1); light.position.set(280, 400, 260); scene.add(light, light.target);
const peng = createPeng({ lod: Number(query.get('lod') ?? 1) }); scene.add(peng.group);
const swarm = createFeatherSwarm({ count: 200, seed: 20261105 }); scene.add(swarm.group);

// Original palette sky, kept behind the model and out of the ID pass.
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { uTop: { value: new THREE.Color(PALETTE.zenith) }, uMid: { value: new THREE.Color(PALETTE.lavender) }, uLow: { value: new THREE.Color(PALETTE.pink) } },
  vertexShader: 'varying vec3 vSky; void main(){vSky=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: `varying vec3 vSky; uniform vec3 uTop,uMid,uLow; void main(){
    float h=normalize(vSky).y; vec3 c=mix(uLow,uMid,smoothstep(-.35,.15,h));
    c=mix(c,uTop,smoothstep(.1,.75,h)); gl_FragColor=vec4(c,1.);
    #include <colorspace_fragment>
  }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(6000, 32, 20), skyMat);
sky.name = 'peng-lab-sky'; sky.userData.outlineOccluder = false; scene.add(sky);

const look = createLook(renderer, W, H, { ss: 1, msaa: 2, paperUrl: null });
await look.ready;
const params = { outline: { width: 1.8, inner: 0.48, near: 0, far: 1600, farScale: 0.8, wobble: 0.35, breakup: 0 },
  kuwahara: false, bloom: false, grade: false, paper: false, vignette: 0.08, grain: 0 };
const label = document.createElement('div');
label.style.cssText = 'position:absolute;left:32px;top:25px;z-index:20;color:#EAF6FF;font:12px/1.8 system-ui;letter-spacing:2px;pointer-events:none;';
document.body.appendChild(label);
let view = query.get('view') || 'world';
let time = Number(query.get('t') ?? 471);
function shot(t, selected) {
  time = t; view = selected;
  const local = t - 455, unfold = ss(clamp(local / 7));
  peng.group.position.set(0, 0, 0); peng.group.rotation.set(0, 0, 0); peng.group.scale.setScalar(1);
  swarm.group.position.set(0, 0, 0); swarm.group.rotation.set(0, 0, 0);
  swarm.setPose(local, { amount: 0 });
  const flight = selected === 'film' || selected === 'world' || selected === 'hero' || selected === 'wide';
  peng.setPose(local, { spread: Number(query.get('spread') ?? (selected === 'film' ? lerp(0.2, 1, unfold) : 1)),
    flap: Number(query.get('flap') ?? (flight ? (selected === 'film' ? lerp(1, 0.22, ss((local - 12) / 18)) : 0.4) : 0)),
    flight: flight ? 1 : 0 });
  camera.up.set(0, 1, 0); camera.fov = 40;
  if (selected === 'world' || selected === 'swarm' || selected === 'hero') {
    // Main world's supplied placement and 16-degree -Z camera, close depth 950.
    peng.group.rotation.set(selected === 'hero' ? 0.32 : 0.28, Math.PI - (selected === 'hero' ? 0.95 : 0.4), -0.08);
    swarm.group.rotation.copy(peng.group.rotation);
    camera.fov = 16; camera.position.set(0, 0, Number(query.get('depth') ?? (selected === 'hero' ? 1350 : 950))); camera.lookAt(0, 0, 0);
    if (selected === 'swarm') swarm.setPose(local, { amount: 1, burst: 0.6 });
  } else if (selected === 'head') {
    camera.fov = 25; camera.position.set(185, 102, 235); camera.lookAt(94, 46, 0);
  } else if (selected === 'feather') {
    camera.fov = 37; camera.position.set(5, 148, 255); camera.lookAt(-61, 20, 199);
  } else if (selected === 'underside') {
    camera.position.set(415, -340, 470); camera.lookAt(-24, -2, 0); camera.fov = 46;
  } else if (selected === 'film') {
    peng.group.position.y = 210 * ss((local - 4) / 31);
    peng.group.position.x = local * 1.6;
    peng.group.rotation.set(0, -0.15, 0.07);
    const track = peng.group.position.clone().add(new THREE.Vector3(-35, 10, 0));
    const pull = ss((local - 5) / 18);
    camera.position.copy(track).add(new THREE.Vector3(lerp(240, 470, pull), lerp(160, 235, pull), lerp(330, 660, pull)));
    camera.lookAt(track); camera.fov = 44;
    if (local < 9) swarm.setPose(local, { amount: ss(local / 2) * (1 - ss((local - 6) / 3)), burst: ss((local - 1) / 6) });
  } else {
    camera.position.set(420, 390, 570); camera.lookAt(-28, 5, 0); camera.fov = 44;
  }
  camera.updateProjectionMatrix(); peng.fitShadow(light, { size: 2048 });
  TOON_SHARED.uInkTime.value = Math.floor(Math.round(local * 24) / 2) * 2 / 24;
  look.render(scene, camera, { ...params, t: local });
  label.innerHTML = `北冥 / 鹏 · ${selected.toUpperCase()}<br><span style="opacity:.65;font-size:10px">${t.toFixed(2)} S · 24 FPS · ORIGINAL PALETTE · SPAN 600</span>`;
}
window.DUR = 490;
window.render = t => shot(t, view);
window.pengLab = { peng, swarm, scene, camera, renderer, look, render: (t = time, selected = view) => shot(t, selected) };
shot(time, view); window.READY = true;
