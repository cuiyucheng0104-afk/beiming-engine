import * as THREE from 'three';

const smooth = x => { const u = Math.max(0, Math.min(1, x)); return u * u * (3 - 2 * u); };
const box = new THREE.BoxGeometry(1, 1, 1);
const warm = '#ffc46b';

export function createWorld(textures) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0d0c10');
  const camera = new THREE.PerspectiveCamera(38, 16 / 9, .1, 180);
  const theater = new THREE.Group(), data = new THREE.Group();
  scene.add(theater, data, new THREE.HemisphereLight('#fff0cf', '#423326', 1.15));
  const spot = new THREE.SpotLight(warm, 1050, 55, .56, .3);
  spot.position.set(7, 11, 6); spot.target.position.set(.7, 1.2, -2);
  spot.castShadow = true; spot.shadow.mapSize.set(512, 512); spot.shadow.bias = -.0004;
  spot.userData.stageLight = true; scene.add(spot, spot.target);
  const fiber = textures.paper;
  fiber.wrapS = fiber.wrapT = THREE.RepeatWrapping;
  const card = color => new THREE.MeshToonMaterial({ color, map: fiber });
  const paper = card('#f7ecd7'), kraft = card('#a68868'), ink = card('#443128');
  const lacquer = new THREE.MeshBasicMaterial({ color: '#d2452c' });
  function block(parent, x, y, z, w, h, d, material) {
    const m = new THREE.Mesh(box, material); m.position.set(x, y, z); m.scale.set(w, h, d);
    m.castShadow = m.receiveShadow = true; m.userData.outline = true; parent.add(m); return m;
  }
  function plate(tex, w, h, z, cut) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, alphaTest: cut, side: THREE.DoubleSide }));
    m.position.set(0, 2, z); theater.add(m); return m;
  }
  plate(textures.clouds_far, 138, 77.625, -48, 0);
  const near = plate(textures.proscenium, 38, 21.375, 5, .45);
  near.position.y = 3.7;
  block(theater, 0, -.68, -1, 15, .55, 8, kraft);
  block(theater, 0, -.32, -1, 14.6, .18, 7.6, paper);
  // 悬桥、层叠楼板和透光格栅共用同一组纸材，让近镜能看清切边。
  block(theater, -.7, 1.9, -.4, 10.5, .22, 1.5, paper);
  for (const x of [-5.4, -3.2, 1.2, 3.7]) block(theater, x, .8, -.4, .23, 2.1, 1.1, kraft);
  for (let i = 0; i < 14; i++) block(theater, -5 + i * .28, i * .073, 1.24, .3, .24 + i * .14, 1.38, paper);
  for (let i = 0; i < 8; i++) {
    const slab = block(theater, 2.2, .35 + i * .56, -2, 3.65 - i * .13, .16, 2.55, paper);
    slab.rotation.y = i * .035;
  }
  block(theater, 2.2, 2.1, -2, .88, 4.55, .72, ink);
  for (let i = 0; i < 9; i++) block(theater, .88 + i * .31, 3.2, -1.18, .085, 2.48, .12, kraft);
  const seal = block(theater, -1.25, 2.1, -.26, .85, .085, .65, lacquer);
  const ribbon = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    [-5,.05,2],[-3,1.15,1.5],[-1.25,2.12,-.26],[.5,2.34,-1],[2.1,4.45,-2],
  ].map(p => new THREE.Vector3(...p))), 80, .025, 5, false), lacquer);
  theater.add(ribbon);
  const motes = new Float32Array(1500 * 3);
  let seed = 1987;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < motes.length; i += 3) motes.set([random()*10-4,random()*7,random()*6-3],i);
  const grains = new THREE.BufferGeometry(); grains.setAttribute('position', new THREE.BufferAttribute(motes,3));
  const dust = new THREE.Points(grains,new THREE.PointsMaterial({color:warm,size:.018,transparent:true,opacity:.55,depthWrite:false})); theater.add(dust);
  const voxels = new THREE.InstancedMesh(box,new THREE.MeshLambertMaterial(),30000);
  const stamp = new THREE.Object3D(), color = new THREE.Color();
  const height = (x,z) => .16 + 4.9*Math.exp(-((x-1.4)**2/5+(z+.7)**2/1.8)) + 2.1*Math.exp(-((x+3)**2/3+(z-.55)**2/2));
  for (let i=0;i<30000;i++) {
    // 互质步长打散网格，降档时从首个实例截取也能看全山形。
    const j=(i*10007)%30000, x=(j%200-100)*.07, z=(Math.floor(j/200)-75)*.055, h=height(x,z);
    stamp.scale.set(.056,h,.043); stamp.position.set(x,h/2,z); stamp.updateMatrix(); voxels.setMatrixAt(i,stamp.matrix);
    color.setHSL(.092,.55,.23+.095*h+.065*random()); voxels.setColorAt(i,color);
  }
  data.add(voxels);
  const crest = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({length:70},(_,i)=>{
    const x=i/5-7; return new THREE.Vector3(x,height(x,-.7)+.11,-.7);
  })),100,.036,5,false),lacquer); data.add(crest);
  const air = [
    {y:1,thick:1.1,density:.025,color:'#886445',start:0,end:52,noise:.35},
    {y:3.2,thick:.9,density:.017,color:'#80684d',start:0,end:64,noise:.5},
    {y:6,thick:1.7,density:.009,color:'#a49176',start:0,end:72,noise:.4},
  ];
  function update(id, u, pointer, cfg) {
    const isData=id==='A09'||id==='A10'; data.visible=isData; theater.visible=!isData;
    voxels.count=cfg.instances; grains.setDrawRange(0,cfg.dust);
    const travel = id==='A08' ? smooth(u) : .14;
    const focal=26+40*travel+(pointer[1]-.5)*6;
    camera.setFocalLength(isData?38:focal);
    const target=new THREE.Vector3().lerpVectors(new THREE.Vector3(0,1.1,-1),new THREE.Vector3(2.1,3.25,-1.26),travel);
    const dist=(26-22.6*travel)*focal/32;
    camera.position.set(target.x+dist*.32,target.y+dist*.22,target.z+dist);
    if(isData){ target.set(0,1.8,0); camera.position.set(7.2,7.6,16); }
    camera.lookAt(target); camera.updateMatrixWorld();
    spot.position.x=7+(pointer[0]-.5)*2.5;
    spot.intensity=isData?1350:1050; spot.target.position.copy(target);
    const unfold=id==='A08'?smooth(u/.12):1;
    seal.rotation.x=(1-unfold)*Math.PI*.5; ribbon.geometry.setDrawRange(0,Math.floor(unfold*ribbon.geometry.index.count/3)*3);
    dust.rotation.y=.08*Math.sin(u*Math.PI*2); crest.visible=id==='A10'||u>.42;
    const focus = Math.max(.25,camera.position.distanceTo(target)+(pointer[0]-.5)*dist*.75);
    return {haze:air.slice(0,cfg.hazeLayers),lights:[{pos:[2.1,3,-1.3],range:5,color:warm,intensity:.5,glow:.055}],
      shaft:cfg.shaftSteps?{steps:cfg.shaftSteps,strength:.18}:false,
      dof:cfg.shaftSteps?{focus,near:focus*.45,far:focus*.65,maxNear:7,maxFar:20}:false};
  }
  return {scene,camera,update,voxels};
}
