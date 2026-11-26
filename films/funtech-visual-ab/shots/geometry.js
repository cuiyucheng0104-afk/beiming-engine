import * as THREE from 'three';
import { renderTarget } from '../../../engine/look/pass.js';

export function buildGeometry(renderer) {
  const targets = [renderTarget(1,1,{depthBuffer:true}),renderTarget(1,1,{depthBuffer:true})];
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, .1, 100);
  scene.background = new THREE.Color('#102a36');
  scene.add(new THREE.HemisphereLight('#d5e9f2','#7c483c',2.5));
  const light = new THREE.DirectionalLight('#ffe1a9',2.4);
  light.position.set(3,7,5); scene.add(light);
  const copper = new THREE.MeshToonMaterial({color:'#ba7756'});
  const shell = new THREE.MeshToonMaterial({color:'#569a9b'});
  const display = new THREE.MeshBasicMaterial({color:'#ffd18a'});
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(5.9,4.3),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
  scene.add(plane);
  const forms = [new THREE.IcosahedronGeometry(1.2,4), new THREE.IcosahedronGeometry(1.2,0)];
  const mesh = new THREE.Mesh(forms[0],shell);
  const wobble = new THREE.IcosahedronGeometry(1.27,18);
  const source = wobble.attributes.position.array.slice();
  const actor = new THREE.Group(), head = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.16,1.42,.71),copper);
  actor.add(body,head); head.add(mesh); head.position.y=1.08;
  mesh.scale.set(.66,.55,.49);
  const eyes = [-.29,.29].map(x => {
    const eye=new THREE.Mesh(new THREE.BoxGeometry(.17,.13,.10),display);
    eye.position.set(x,.025,.565); head.add(eye); return eye;
  });
  const arms = [-.81,.81].map(x => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(.23,.9,.31),shell);
    arm.position.set(x,-.04,0); actor.add(arm); return arm;
  });
  scene.add(actor);
  const orb = new THREE.Mesh(wobble,copper); scene.add(orb);
  const center = new THREE.Vector3(), size = new THREE.Vector3();
  function pose(t,b,id) {
    const move = b && id==='asset-clips' ? (t < .5 ? 'wave' : 'nod') : 'idle';
    head.rotation.set(move==='nod' ? .44*Math.sin(t*18) : 0, .12*Math.sin(t*7), 0);
    arms[1].rotation.z=move==='wave' ? -1.8+.35*Math.sin(t*22) : .18;
    arms[0].rotation.z=-.18;
    actor.rotation.y=.25*Math.sin(t*4);
    actor.position.set(0,-.48,0);
    mesh.geometry=forms[b && id==='asset-lod' ? 1 : 0];
    display.color.set(b && id==='asset-faces' && t>.4 ? '#70ffe2' : '#ffd18a');
    for(const eye of eyes) eye.scale.y=b && id==='asset-faces' ? .24+.76*Math.abs(Math.cos(t*5.5)) : 1;
  }
  return {
    resize(w,h) {
      camera.aspect=w/h; camera.updateProjectionMatrix();
      for(const target of targets) target.setSize(w,h);
    },
    draw(id,t,texture) {
      if(plane.material.map!==texture) { plane.material.map=texture; plane.material.needsUpdate=true; }
      plane.visible=id==='video-plane'; orb.visible=id==='wobble'; actor.visible=id.startsWith('asset-');
      return targets.map((target,i) => {
        const b=i===1;
        camera.position.set(0,0,8.8); camera.lookAt(0,0,0);
        if(plane.visible) {
          const yaw = .33+.34*Math.sin(t*5);
          plane.rotation.set(b ? .13 : 0,b ? yaw : 0,0);
          if(b) { camera.position.x=-.65+1.3*t; camera.lookAt(0,0,0); }
        }
        if(actor.visible) {
          pose(t,b,id);
          if(id==='asset-framing') {
            actor.position.x=-.8+t*1.6;
            actor.scale.setScalar(.7+.8*t);
            if(b) {
              const box=new THREE.Box3().setFromObject(actor);
              box.getCenter(center); box.getSize(size);
              camera.position.copy(center); camera.position.z+=size.length()*1.7;
              camera.lookAt(center);
            }
          } else actor.scale.setScalar(1);
        }
        if(orb.visible) {
          const p=wobble.attributes.position;
          for(let j=0;j<p.count;j++){
            const x=source[j*3],y=source[j*3+1],z=source[j*3+2];
            const s=b ? 1+.15*Math.sin(x*9+t*7)*Math.cos(y*7+z*5-t*8) : 1;
            p.setXYZ(j,x*s,y*s,z*s);
          }
          p.needsUpdate=true; wobble.computeVertexNormals(); orb.rotation.y=t*1.25;
        }
        renderer.setRenderTarget(target); renderer.render(scene,camera);
        return target.texture;
      });
    },
  };
}
