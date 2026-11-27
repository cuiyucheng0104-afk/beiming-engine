// WonderX Phase 2 v4 · 共享常量、确定性随机、程序化拉丝金属贴图与 H6 同源数据
import * as THREE from 'three';

export const PALETTE = {
  obsidian: '#07080B',
  obsidianMid: '#101218',
  titaniumDark: '#1C212B',
  titaniumMid: '#485264',
  titaniumLight: '#8A94A6',
  porcelain: '#F2F4F8',
  vermilion: '#D2452C',
  iceCyan: '#4CE0F5',
  warmTungsten: '#FFB85C',
  blueprintBg: '#0B2346',
};

// H6 / 第九幕严格同源数据：左屏传统白底 PPT 与右屏 3D 实时场景共享同一组指标
export const H6_PLATFORM_DATA = {
  title: '2027 光学算力平台核心指标汇报',
  kpis: [
    { label: '峰值光学算力', value: '4.8 PFLOPS', sub: 'FP8 稀疏矩阵实测' },
    { label: '片上光互连带宽', value: '1.6 TB/s', sub: '64 通道全双工波导' },
    { label: '能效比代际跃升', value: '3.4×', sub: '性能 / 瓦对比上代' },
  ],
  breakdown: [
    { name: '光子矩阵内核', pct: 42, color: '#D2452C' },
    { name: '高速片上互连', pct: 28, color: '#4CE0F5' },
    { name: '实时渲染管线', pct: 19, color: '#FFB85C' },
    { name: '系统调度控制', pct: 11, color: '#8A94A6' },
  ],
  tableRows: [
    ['光子矩阵内核', '42%', '2.02 PFLOPS', '672 GB/s'],
    ['高速片上互连', '28%', '1.34 PFLOPS', '448 GB/s'],
    ['实时渲染管线', '19%', '0.91 PFLOPS', '304 GB/s'],
    ['系统调度控制', '11%', '0.53 PFLOPS', '176 GB/s'],
  ],
};

// 确定性 Mulberry32 PRNG（零 Math.random，确保 window.render(t, input) 逐像素复现）
export function createRng(seed = 20261127) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const u = clamp((x - e0) / Math.max(1e-6, e1 - e0), 0, 1);
  return u * u * (3 - 2 * u);
};
export const easeOutCubic = t => 1 - Math.pow(1 - clamp(t), 3);
export const easeInOutCubic = t => {
  const u = clamp(t);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
};

// 纯程序化拉丝钛合金粗糙度/微纹贴图（零旧纸纹、零外部图片依赖）
export function createBrushedMetalTexture(seed = 808) {
  const w = 256, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const rng = createRng(seed);
  ctx.fillStyle = '#787e88';
  ctx.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    const shade = 104 + Math.floor((rng() - 0.5) * 34);
    ctx.fillStyle = `rgb(${shade},${shade + 3},${shade + 8})`;
    ctx.fillRect(0, y, w, 1);
  }
  for (let i = 0; i < 420; i++) {
    const y = Math.floor(rng() * h);
    const x = Math.floor(rng() * w);
    const len = 28 + Math.floor(rng() * 140);
    const alpha = 0.05 + rng() * 0.12;
    ctx.fillStyle = rng() > 0.5 ? `rgba(235,244,255,${alpha})` : `rgba(12,16,24,${alpha})`;
    ctx.fillRect(x, y, len, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.needsUpdate = true;
  return tex;
}

// 纯程序化冷暗精密校准网格地面贴图
export function createGridFloorTexture() {
  const sz = 512;
  const canvas = document.createElement('canvas');
  canvas.width = sz;
  canvas.height = sz;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#090B10';
  ctx.fillRect(0, 0, sz, sz);
  // 次网格
  ctx.strokeStyle = 'rgba(76, 224, 245, 0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const p = (i * sz) / 8 + 0.5;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, sz); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(sz, p); ctx.stroke();
  }
  // 主网格线
  ctx.strokeStyle = 'rgba(138, 148, 166, 0.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, sz - 2, sz - 2);
  // 十字校准点
  ctx.strokeStyle = 'rgba(210, 69, 44, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sz / 2 - 10, sz / 2); ctx.lineTo(sz / 2 + 10, sz / 2);
  ctx.moveTo(sz / 2, sz / 2 - 10); ctx.lineTo(sz / 2, sz / 2 + 10);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 16);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// 合并多个 BufferGeometry 为单一非索引几何（附带局部高度与半径属性，供 H5b 单一网格四着色器验证使用）
export function mergeGeometriesClean(items) {
  let totalVerts = 0;
  const prepared = items.map(({ geo, matrix, partId = 0 }) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(matrix);
    g.computeVertexNormals();
    const pos = g.getAttribute('position');
    totalVerts += pos.count;
    return { g, partId };
  });
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const partIds = new Float32Array(totalVerts);
  let offset = 0;
  for (const { g, partId } of prepared) {
    const pos = g.getAttribute('position');
    const norm = g.getAttribute('normal');
    positions.set(pos.array, offset * 3);
    normals.set(norm.array, offset * 3);
    partIds.fill(partId, offset, offset + pos.count);
    offset += pos.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.setAttribute('aPartId', new THREE.BufferAttribute(partIds, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}
