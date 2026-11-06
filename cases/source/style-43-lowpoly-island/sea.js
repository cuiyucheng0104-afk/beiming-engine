// 低多边形海：顶点按多组正弦起伏，flatShading 让每个三角面各自反光；浅海由岛屿形状画出的浅水图决定
// 夜里近处更暗、远处向天边变亮；顶灯在水面上投一道暖色光带（uLamp）
import * as THREE from 'three';

export function waveH(x, z, t, amp = 1) {
  return amp * (.07 * Math.sin(.9 * x + 1.2 * t) + .055 * Math.sin(.8 * z - 1.0 * t + 1.3)
    + .04 * Math.sin(1.55 * (x + z) + 1.9 * t) + .028 * Math.sin(2.2 * x - 1.8 * z + 2.5 * t));
}
const WAVE_GLSL = `
  float waveH(vec2 p, float t, float amp){
    return amp * (.07 * sin(.9 * p.x + 1.2 * t) + .055 * sin(.8 * p.y - 1.0 * t + 1.3)
      + .04 * sin(1.55 * (p.x + p.y) + 1.9 * t) + .028 * sin(2.2 * p.x - 1.8 * p.y + 2.5 * t));
  }`;
export const SPAN = 48;

export function makeSea(scene) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 512;
  const sg = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.NoColorSpace; tex.flipY = false;
  const U = {
    uTime: { value: 0 }, uAmp: { value: 1 }, uDeep: { value: new THREE.Color('#3aa3b8') }, uShal: { value: new THREE.Color('#86e0d2') },
    uShallow: { value: tex }, uSpan: { value: SPAN }, uFoam: { value: new THREE.Color('#ffffff') },
    uFwd: { value: new THREE.Vector2(0, -1) }, uTgt: { value: new THREE.Vector2() }, uSpanF: { value: 20 }, uNight: { value: 0 },
    uLamp: { value: new THREE.Vector4(0, 0, 0, 0) }, uLampCol: { value: new THREE.Color('#ffc676') }, uCam: { value: new THREE.Vector2(1, 0) },
  };
  const mk = (near) => {
    const m = new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: .6, metalness: 0 });
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nuniform float uTime, uAmp; varying vec2 vW;${WAVE_GLSL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec4 wp0 = modelMatrix * vec4(transformed, 1.);
          vW = wp0.xz;
          transformed.z += waveH(wp0.xz, uTime, uAmp);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform vec3 uDeep, uShal, uFoam, uLampCol; uniform sampler2D uShallow; uniform float uSpan, uSpanF, uNight, uTime; uniform vec2 uFwd, uTgt, uCam; uniform vec4 uLamp; varying vec2 vW;\nfloat hh(vec2 p){ p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec2 suv = vW / uSpan + .5;
          float s = ${near ? 'texture2D(uShallow, suv).r' : '0.'};
          if (suv.x < 0. || suv.y < 0. || suv.x > 1. || suv.y > 1.) s = 0.;
          vec3 wc = mix(uDeep, uShal, smoothstep(.05, .85, s));
          wc = mix(wc, uFoam, smoothstep(.9, .99, s) * .5);
          float farK = dot(vW - uTgt, uFwd) / uSpanF;
          wc *= mix(1., mix(.55, 1.12, smoothstep(-.55, .9, farK)), uNight);
          diffuseColor.rgb = wc;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          // 顶灯在水面上的倒影带：沿"灯→相机"方向的一条窄带，每个面片随机闪烁
          if (uLamp.w > 0.) {
            vec2 rel = vW - uLamp.xy;
            float along = dot(rel, uCam), across = abs(rel.x * uCam.y - rel.y * uCam.x);
            float band = smoothstep(.0, 1.5, along) * exp(-along * .07) * smoothstep(.55 + along * .05, 0., across);
            vec2 cell = floor(vW * 2.4); float tw = hh(cell + floor(uTime * 6.) * .137);
            totalEmissiveRadiance += uLampCol * band * uLamp.w * (.25 + pow(tw, 10.) * 2.6);
          }`);
    };
    return m;
  };
  const near = new THREE.Mesh(new THREE.PlaneGeometry(150, 150, 150, 150).toNonIndexed(), mk(true)); near.rotation.x = -Math.PI / 2; scene.add(near);
  const far = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000, 160, 160), mk(false)); far.rotation.x = -Math.PI / 2; far.position.y = -.55; scene.add(far);
  function drawShallow(blobs) {
    sg.fillStyle = '#000'; sg.fillRect(0, 0, 512, 512);
    const k = 512 / SPAN;
    sg.globalCompositeOperation = 'lighten';
    for (const [x, z, r, a] of blobs) {
      const px = (x / SPAN + .5) * 512, py = (z / SPAN + .5) * 512, rr = r * k;
      const gr = sg.createRadialGradient(px, py, 0, px, py, rr);
      gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(.55, `rgba(255,255,255,${a * .8})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
      sg.fillStyle = gr; sg.beginPath(); sg.arc(px, py, rr, 0, 7); sg.fill();
    }
    sg.globalCompositeOperation = 'source-over'; tex.needsUpdate = true;
  }
  return { near, far, U, drawShallow };
}
