import * as GL from 'three';
import * as GPU from '/node_modules/three/build/three.webgpu.js';
import { pageTiming } from '../../engine/production/timeline.js';
import { paint } from './shots/plate.js';

const timing = pageTiming(await (await fetch('./film.json')).json());
const main = document.querySelector('main');
const w = Math.round((window.__RENDER?.width ?? main.clientWidth)*.45);
const h = Math.round((window.__RENDER?.height ?? main.clientHeight)*.633);
const gpu = new GPU.WebGPURenderer({ antialias:false });
await gpu.init();
if (!gpu.backend.isWebGPUBackend) throw Error('需要 WebGPU 后端才能执行材质对照');
const gl = new GL.WebGLRenderer({antialias:false});
const position = GPU.positionLocal;
const nodeMaterial = new GPU.MeshBasicNodeMaterial();
const stripe = position.y.mul(9).add(position.x.mul(3)).sin().mul(.5).add(.5);
nodeMaterial.colorNode = GPU.mix(GPU.color('#214657'), GPU.color('#eaa960'), stripe.smoothstep(.4,.6));

function sceneFor(T,material) {
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(34,w/h,.01,100);
  scene.background = new T.Color('#10212a');
  camera.position.set(0,0,5);
  const cube = new T.Mesh(new T.BoxGeometry(1.65,1.65,1.65),material);
  scene.add(cube);
  return {scene,camera,cube};
}
const webgl = sceneFor(GL,new GL.MeshNormalMaterial());
const webgpu = sceneFor(GPU,nodeMaterial);
const sheets=Array.from({length:2},()=>Object.assign(document.createElement('canvas'),{width:w,height:h}));
const main2d=sheets[0].getContext('2d');
const worker2d=sheets[1].getContext('bitmaprenderer');
const worker=new Worker(new URL('./shots/worker.js',import.meta.url),{type:'module'});

for(const renderer of [gl,gpu]) renderer.setSize(w,h,false);
for(const canvas of [gl.domElement,gpu.domElement,...sheets]) {
  canvas.className='panel'; canvas.style.width=''; canvas.style.height=''; main.prepend(canvas);
}
for (const canvas of [sheets[0], gl.domElement]) canvas.style.left='4%';
for (const canvas of [sheets[1], gpu.domElement]) canvas.style.left='51%';

const title=document.querySelector('#title'), note=document.querySelector('#note');
async function draw(t) {
  const { index,localFrame }=timing.at(t);
  const shot=timing.shots[index];
  const phase=localFrame/(shot.out-shot.in);
  for(const canvas of [gl.domElement,gpu.domElement]) canvas.hidden=index!==0;
  for(const canvas of sheets) canvas.hidden=index!==1;
  title.textContent=index===0 ? 'WebGPU 节点材质' : 'Worker 画布';
  note.textContent=index===0 ? '左：WebGL 法线材质 · 右：WebGPU TSL 条纹' : '左：主线程 · 右：Worker 收到相同轨迹，绘制像素应一致';
  if(index===0) {
    for(const {cube} of [webgl,webgpu]) cube.rotation.set(.35+phase,.4+phase*2,.09);
    gl.render(webgl.scene,webgl.camera);
    gpu.render(webgpu.scene,webgpu.camera);
  } else {
    paint(main2d,w,h,phase);
    const image=await new Promise((resolve,reject) => {
      worker.onmessage=({data})=>resolve(data);
      worker.onerror=reject;
      worker.postMessage({w,h,t:phase});
    });
    worker2d.transferFromImageBitmap(image);
  }
}

let queue=Promise.resolve();
function render(t) {
  const task=queue.then(()=>draw(t));
  queue=task.catch(()=>{});
  return task;
}
Object.assign(window,{DUR:timing.DUR,FPS:timing.fps,TIMELINE:timing,render,READY:true});
if(!window.__RENDER) {
  document.querySelector('nav').hidden=false;
  document.querySelector('#toggle').hidden=true;
  const slider=document.querySelector('#scrub');
  slider.max=timing.frameCount-1;
  slider.oninput=()=>render(Number(slider.value)/timing.fps);
  await render(0);
}
