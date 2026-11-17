// 北冥引擎 · 离屏出片 · 底板面片（TSL / r187）：engine/stage/plates.js 的对应，同名同参数。面片都是 1×1 的单位平面，大小和位置交给
// engine/stage/camera.js 的 placeOnScreen（它可以直接摆 r187 的物体）；全部不参与描边（userData.outline = false）。
//
//   await createPlates({ THREE, TSL }) → { loadPlates, plateMat, plate, plateCopy, tileRepeat, canvasLayer, cropPlate, cutoutPlane, glowSprite }
//     loadPlates(names, { dir, linear })   读 <dir>/plates.json + PNG（tools/plates/png.mjs 解码，不经浏览器）→ { meta, tex }；dir 是文件系统路径
//     canvasLayer(w, h) → { canvas, ctx, tex }   画布是 @napi-rs/canvas（Skia）；tex 在上传时才读画布的像素（needsUpdate = true 再读一次）
//     其余与 A 路线同语义：plateMat / plate 直通 alpha、不写深度、不吃雾；cropPlate 椭圆软边裁片；cutoutPlane 彩色层 + 只写深度的遮罩层；
//     glowSprite 加色辉光（两层高斯 + 软边）
// 贴图约定与 A 路线一致：sRGB、行序按图片（flipY），mip 链 + 三线性过滤 + 各向异性 8（A 路线 TextureLoader / CanvasTexture 的设置）。
// mip 链由各自的后端生成（WebGL 驱动对 three 自己的降采样），远处缩小的底板两边会有细微差别。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../../../tools/plates/png.mjs';
import { loadCanvas } from '../canvas.mjs';

export async function createPlates({ THREE, TSL }) {
  const { createCanvas } = await loadCanvas();
  const { uniform, texture, uv, vec2, vec4, float, length, exp, pow, max, smoothstep, select } = TSL;
  const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);
  const flat = (m, order) => { m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false; return m; };
  const asImage = (t, { linear = false } = {}) => {
    t.colorSpace = linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.flipY = true; t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };

  function loadPlates(names, { dir, linear = [] } = {}) {
    const meta = JSON.parse(readFileSync(join(dir, 'plates.json'), 'utf8'));
    const M = {}; for (const p of meta.plates) M[p.name] = p;
    const tex = {};
    for (const n of names) {
      const file = join(dir, M[n] ? M[n].file : `${n}.png`);
      let png;
      try { png = decodePng(readFileSync(file)); } catch (e) { throw Object.assign(new Error(`底板读不了：${file}（${e.message}）`), { code: 'contract.plate' }); }
      tex[n] = asImage(new THREE.DataTexture(png.data, png.width, png.height, THREE.RGBAFormat), { linear: linear.includes(n) });
    }
    return { meta: M, tex };
  }

  // 底板本身已经画好了空气透视，所以不吃雾、不做色调映射
  const plateMat = (map, { opacity = 1, depthTest = true, color = 0xffffff, blending = THREE.NormalBlending, side = THREE.FrontSide } = {}) =>
    new THREE.MeshBasicMaterial({ map, color, transparent: true, opacity, depthWrite: false, depthTest, toneMapped: false, fog: false, blending, side });
  function plate(map, order, o = {}) {
    const m = flat(new THREE.Mesh(UNIT_PLANE, plateMat(map, o)), order);
    m.userData.aspect = map.image.width / map.image.height;
    return m;
  }
  function plateCopy(map, { wrap = false } = {}) {
    const t = map.clone();
    if (wrap) t.wrapS = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  }
  const tileRepeat = (map, wpx, hpx) => wpx / (hpx * (map.image.width / map.image.height));

  function canvasLayer(w, h) {
    const canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
    const tex = asImage(new THREE.DataTexture(null, w, h, THREE.RGBAFormat));
    Object.defineProperty(tex.image, 'data', { get: () => new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer), configurable: true });
    return { canvas, ctx, tex };
  }

  // ── 裁切软边面片 ── rect = [u0, v0, du, dv]（贴图 uv，v 向上）；soft = 椭圆遮罩从多大开始变软（0..1）
  function cropPlate(map, rect, { order = 5, opacity = 1, soft = 0.55, flip = false, tint = [1, 1, 1] } = {}) {
    const U = { rect: uniform(new THREE.Vector4(...rect)), opacity: uniform(opacity), soft: uniform(soft), flip: uniform(flip ? 1 : 0), tint: uniform(new THREE.Vector3(...tint)) };
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, toneMapped: false, fog: false });
    const q = vec2(select(U.flip.greaterThan(0.5), float(1).sub(uv().x), uv().x), uv().y);
    const c = texture(map, U.rect.xy.add(q.mul(U.rect.zw)));
    const d = uv().sub(0.5).mul(2);
    const m = float(1).sub(smoothstep(U.soft, 1, length(d.mul(vec2(1, 1.15)))));
    mat.colorNode = vec4(c.rgb.mul(U.tint), c.a.mul(m).mul(U.opacity));
    mat.userData.crop = U;
    const mesh = flat(new THREE.Mesh(UNIT_PLANE, mat), order);
    mesh.userData.aspect = (map.image.width * rect[2]) / (map.image.height * rect[3]);
    return mesh;
  }

  // ── 抠像面片 ── 彩色层正常透明混合；遮罩层只在 alpha > cut 处写深度（排序约定同 A 路线：更远的透明底板 order 要小于 order - 0.5）
  function cutoutPlane(tex, { order = 10, cut = 0.5 } = {}) {
    const g = new THREE.Group();
    const color = flat(new THREE.Mesh(UNIT_PLANE, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false, premultipliedAlpha: false })), order);
    const mask = flat(new THREE.Mesh(UNIT_PLANE, new THREE.MeshBasicMaterial({ map: tex, alphaTest: cut, transparent: true, colorWrite: false, depthWrite: true, fog: false })), order - 0.5);
    mask.userData.outlineOccluder = false;
    g.add(mask, color);
    g.userData.outline = false;
    return g;
  }

  // ── 加色辉光 ── 同 A 路线 GLOW_FS：exp(-3.2 r²)·0.65 + exp(-22 r²)·core + (1 - r)³·0.25，乘颜色与 amt
  function glowSprite(color, { order = 3, amt = 1, core = 1, squash = 1 } = {}) {
    const U = { color: uniform(new THREE.Color(color)), amt: uniform(amt), core: uniform(core), squash: uniform(squash) };
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
    const d = uv().sub(0.5).mul(2), dd = vec2(d.x, d.y.mul(U.squash)), r = length(dd), r2 = r.mul(r);
    const g = exp(r2.mul(-3.2)).mul(0.65).add(exp(r2.mul(-22)).mul(U.core)).add(pow(max(float(1).sub(r), 0), 3).mul(0.25));
    mat.colorNode = vec4(U.color.mul(g).mul(U.amt), 1);
    mat.uniforms = { color: U.color, amt: U.amt, core: U.core, squash: U.squash };   // 同 ShaderMaterial 的写法：作品照样 mat.uniforms.amt.value = …
    return flat(new THREE.Mesh(UNIT_PLANE, mat), order);
  }

  return { loadPlates, plateMat, plate, plateCopy, tileRepeat, canvasLayer, cropPlate, cutoutPlane, glowSprite };
}
