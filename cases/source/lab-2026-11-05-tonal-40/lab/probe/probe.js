import * as T from 'three';import {makeMaterial,bind,applyPreset} from '../material.js';import {presets} from '../presets.js';
const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true,powerPreference:'high-performance'});renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.NoToneMapping;renderer.debug.onShaderError=(g,p,v,f)=>{throw new Error(g.getShaderInfoLog(f));};document.body.appendChild(renderer.domElement);
const scene=new T.Scene();scene.background=new T.Color('#282b2f');const camera=new T.PerspectiveCamera(36,innerWidth/innerHeight,.1,100);camera.position.set(0,0,11);camera.lookAt(0,0,0);
const sun=new T.DirectionalLight('#ffffff',1);sun.position.set(-5,2,1);scene.add(sun);
const mat=makeMaterial('paper');const sphere=bind(new T.Mesh(new T.SphereGeometry(2.5,128,96),mat),mat,{castShadow:false,receiveShadow:false});scene.add(sphere);
let current=presets[0];window.setVariant=id=>{current=presets.find(x=>x.id===id);applyPreset({...current,palette:{...current.palette,paper:'#aaaaaa',shadow:'#000000',light:'#ffffff',accent:'#000000'}});window.render(0);};
window.render=()=>renderer.render(scene,camera);window.info=()=>({preset:current,probe:true,three:T.REVISION});window.DUR=1;window.setVariant('A1');window.READY=true;
