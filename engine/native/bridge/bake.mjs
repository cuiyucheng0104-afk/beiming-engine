// 北冥引擎 · 原生层 · 资产桥（浏览器端）：把 engine/shade 卡通材质的**反照率钩子**烘成贴图 / 顶点色。
// 只烘固有色（斑纹、腹白、眼睛纹样、表面层），不烘视角相关的卡通光照与墨线——光照交给原生端的 ToonMaterial。
// 由 examples/raea/tools/export-kun-browser.mjs 原样抽出，算式不变（鲲的 GLB 逐字节一致即以此为前提）。
//
//   bakeMaterial(source, pointMode, w, h)        生成烘焙用 ShaderMaterial：source 是 engine/shade 的卡通材质（读 userData.toon /
//                                               userData.toonOpts 的 fragmentPars / fragmentAlbedo 钩子与 surface.js 的表面层）
//   renderBake(renderer, g, source, w, h, points)  三角形模式按 uv 铺满 w×h；points=true 时每个顶点一个像素点（顶点色烘焙）
//                                               → Uint8Array RGBA（w·h·4）
//   texturePBR(renderer, g, source, name, w = 512, h = 256, roughness = 0.87)
//                                               按 uv 烘成一张 sRGB 贴图，返回带这张贴图的 MeshStandardMaterial（名字 = name）
import * as T from 'three';
import { patchLayer } from '../../shade/surface.js';
import { NOISE_GLSL } from '../../shade/noise.glsl.js';
import { SS_GLSL } from '../../shade/util.glsl.js';

export function bakeMaterial(source, pointMode, width, height) {
  const opts = source.userData.toonOpts || {}, layer = patchLayer();
  return new T.ShaderMaterial({
    uniforms: {...source.userData.toon, diffuse: {value:source.color}, bakeSize:{value:new T.Vector2(width,height)}},
    side:T.DoubleSide, depthTest:false, depthWrite:false,
    vertexShader:`
      attribute vec3 aLoft; attribute float aChord;
      ${pointMode ? 'attribute vec3 aBakeObj, aBakeLocal, aBakeColor; uniform vec2 bakeSize;' : ''}
      varying vec3 vToonObj, vLoft, vLocal, vTint; varying float vNy, vChord;
      void main(){
        vToonObj=${pointMode?'aBakeObj':'position'}; vLocal=${pointMode?'aBakeLocal':'position'};
        vLoft=aLoft;vNy=normal.y;vChord=aChord;vTint=${pointMode?'aBakeColor':'vec3(1.0)'};
        ${pointMode ? 'float id=float(gl_VertexID);vec2 p=vec2(mod(id,bakeSize.x),floor(id/bakeSize.x));gl_Position=vec4((p+0.5)/bakeSize*2.0-1.0,0.0,1.0);gl_PointSize=1.0;' : 'gl_Position=vec4(uv*2.0-1.0,0.0,1.0);'}
      }`,
    fragmentShader:`
      uniform vec3 diffuse,uInkColor;uniform float uInkTime;
      varying vec3 vToonObj,vTint;
      ${opts.fragmentPars || ''}
      ${layer.pars}${NOISE_GLSL}${SS_GLSL}
      void main(){
        vec4 diffuseColor=vec4(diffuse*vTint,1.0);float toonInk=0.0;vec4 toonOverlay=vec4(0.0);
        ${layer.surface}${opts.fragmentAlbedo || ''}
        vec3 c=mix(diffuseColor.rgb,uInkColor,clamp(toonInk,0.0,1.0));
        c=mix(c,toonOverlay.rgb,clamp(toonOverlay.a,0.0,1.0));
        gl_FragColor=vec4(c,1.0);
        #include <colorspace_fragment>
      }`,
  });
}

export function renderBake(renderer, g, source, w, h, points = false) {
  // 源材质没用到的属性取默认值
  const target = new T.WebGLRenderTarget(w,h,{depthBuffer:false,stencilBuffer:false});
  target.texture.colorSpace = points ? T.LinearSRGBColorSpace : T.SRGBColorSpace;
  const mat = bakeMaterial(source, points, w, h);
  mat.defaultAttributeValues.aLoft=[0,0,0];mat.defaultAttributeValues.aChord=[0];
  const obj = points ? new T.Points(g,mat) : new T.Mesh(g,mat);
  obj.frustumCulled=false;
  const scene = new T.Scene();scene.add(obj);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);renderer.setClearColor(source.color,1);renderer.clear();
  renderer.render(scene,new T.Camera());
  const pixels = new Uint8Array(w*h*4);renderer.readRenderTargetPixels(target,0,0,w,h,pixels);
  renderer.setRenderTarget(prev);target.dispose();mat.dispose();
  return pixels;
}

export function texturePBR(renderer, g, original, name, w=512, h=256, roughness=.87) {
  const pixels=renderBake(renderer,g,original,w,h);
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d'), image=ctx.createImageData(w,h);
  for(let y=0;y<h;y++) image.data.set(pixels.subarray(y*w*4,(y+1)*w*4),(h-1-y)*w*4);
  ctx.putImageData(image,0,0);
  const map=new T.CanvasTexture(canvas);map.name=name+'-albedo';map.colorSpace=T.SRGBColorSpace;
  const mat=new T.MeshStandardMaterial({color:0xffffff,map,roughness,metalness:0,side:original.side});
  mat.name=name;return mat;
}
