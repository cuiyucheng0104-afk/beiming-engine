// 北冥引擎 · 全屏 pass 的公共底座：一个自建的全屏三角形，把片元着色器画进渲染目标。
// （不用 three 的 FullScreenQuad：它的 dispose 会删掉全局共享的几何体。）
//
//   FS_VERT                          全屏顶点着色器，给片元着色器一个 varying vUv
//   createFullscreen(renderer) → {
//     draw(mat, target)              把材质画满 target（null = 屏幕）
//     material(fs, uniforms, defines?) 用 FS_VERT 建一个不测深度、不写深度的 ShaderMaterial
//     dispose()
//   }
//   renderTarget(w, h, o?)           HalfFloat、无深度、双线性过滤的渲染目标；o 覆盖任意选项

import * as THREE from 'three';

export const FS_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

export function createFullscreen(renderer) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mesh = new THREE.Mesh(geo); mesh.frustumCulled = false;
  return {
    draw(mat, target) { mesh.material = mat; renderer.setRenderTarget(target); renderer.render(mesh, cam); },
    material: (fs, uniforms, defines = {}) => new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: fs, uniforms, defines, depthTest: false, depthWrite: false }),
    dispose() { geo.dispose(); },
  };
}

export const renderTarget = (w, h, o = {}) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, ...o });
