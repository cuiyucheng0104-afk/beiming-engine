// 北冥引擎 · 离屏出片 · GPU 侧 RGBA8 → 有限范围 BT.709 yuv420p 转换与读回缓冲池：
// 把渲染目标里的 sRGB RGBA8 纹素在同一个 GPUDevice 上转换成平面布局 Y(W×H) | U(W/2×H/2) | V(W/2×H/2)，
// 读回与管道带宽从 4 字节/像素降到 1.5 字节/像素（减少 62.5%），并省去 FFmpeg 的 CPU swscale 缩放滤镜。
// 采用 16 位定点整数系数（CU/CV 三项和严格为 0，任意中性灰恒得 Cb=Cr=128），CPU 与 WGSL 跨驱动逐字节一致。
//   rgbaToYuv420pCpu(rgba, width, height) → Uint8Array   纯函数参考实现（长度 width × height × 1.5）
//   createYuvPacker({ device, width, height }) → { packTexture(gpuTexture) → Promise<Uint8Array>, dispose() }
//     packTexture 在返回前已把纹理拷贝、WGSL 计算与 staging 拷贝一次性提交进队列，安全配合流水线 inflight 复用同一个渲染目标。

const CY_R = 11966, CY_G = 40254, CY_B = 4064, Y_BIAS = (16 << 16) + (1 << 15);
const CU_R = -6596, CU_G = -22189, CU_B = 28785;
const CV_R = 28785, CV_G = -26145, CV_B = -2640;
const C_BIAS = (128 << 18) + (1 << 17);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function rgbaToYuv420pCpu(rgba, width, height) {
  if (width < 2 || height < 2 || width % 2 || height % 2) throw new RangeError(`yuv420p 要求偶数宽高，收到 ${width}x${height}`);
  if (rgba.length !== width * height * 4) throw new RangeError(`RGBA 字节数不符：收到 ${rgba.length}，应为 ${width * height * 4}`);
  const luma = width * height, cw = width >> 1, ch = height >> 1, chroma = cw * ch;
  const out = new Uint8Array(luma + chroma * 2);
  for (let i = 0; i < luma; i++) {
    const o = i * 4;
    out[i] = clamp((Y_BIAS + CY_R * rgba[o] + CY_G * rgba[o + 1] + CY_B * rgba[o + 2]) >> 16, 16, 235);
  }
  const uBase = luma, vBase = luma + chroma;
  for (let cy = 0; cy < ch; cy++) {
    const r0 = (cy * 2) * width * 4, r1 = r0 + width * 4;
    for (let cx = 0; cx < cw; cx++) {
      const a = r0 + cx * 8, b = a + 4, c = r1 + cx * 8, d = c + 4;
      const sr = rgba[a] + rgba[b] + rgba[c] + rgba[d];
      const sg = rgba[a + 1] + rgba[b + 1] + rgba[c + 1] + rgba[d + 1];
      const sb = rgba[a + 2] + rgba[b + 2] + rgba[c + 2] + rgba[d + 2];
      const k = cy * cw + cx;
      out[uBase + k] = clamp((C_BIAS + CU_R * sr + CU_G * sg + CU_B * sb) >> 18, 16, 240);
      out[vBase + k] = clamp((C_BIAS + CV_R * sr + CV_G * sg + CV_B * sb) >> 18, 16, 240);
    }
  }
  return out;
}

const WGSL = /* wgsl */`
struct Params {
  width: u32,
  height: u32,
  strideU32: u32,
  lumaWords: u32,
  chromaW: u32,
  chromaPixels: u32,
  chromaWords: u32,
  pad: u32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

fn lumaByte(px: u32) -> u32 {
  let r = i32(px & 0xffu);
  let g = i32((px >> 8u) & 0xffu);
  let b = i32((px >> 16u) & 0xffu);
  let y = (1081344 + 11966 * r + 40254 * g + 4064 * b) >> 16u;
  return u32(clamp(y, 16, 235));
}

fn rgbVec(px: u32) -> vec3<i32> {
  return vec3<i32>(i32(px & 0xffu), i32((px >> 8u) & 0xffu), i32((px >> 16u) & 0xffu));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i < P.lumaWords) {
    var yWord: u32 = 0u;
    for (var k: u32 = 0u; k < 4u; k = k + 1u) {
      let p = i * 4u + k;
      let y = p / P.width;
      let x = p - y * P.width;
      let yv = lumaByte(src[y * P.strideU32 + x]);
      yWord = yWord | (yv << (k * 8u));
    }
    dst[i] = yWord;
  }
  if (i < P.chromaWords) {
    var uWord: u32 = 0u;
    var vWord: u32 = 0u;
    for (var k: u32 = 0u; k < 4u; k = k + 1u) {
      let c = i * 4u + k;
      if (c < P.chromaPixels) {
        let cy = c / P.chromaW;
        let cx = c - cy * P.chromaW;
        let r0 = (cy * 2u) * P.strideU32 + cx * 2u;
        let r1 = r0 + P.strideU32;
        let s = rgbVec(src[r0]) + rgbVec(src[r0 + 1u]) + rgbVec(src[r1]) + rgbVec(src[r1 + 1u]);
        let u = u32(clamp((33685504 - 6596 * s.x - 22189 * s.y + 28785 * s.z) >> 18u, 16, 240));
        let v = u32(clamp((33685504 + 28785 * s.x - 26145 * s.y - 2640 * s.z) >> 18u, 16, 240));
        uWord = uWord | (u << (k * 8u));
        vWord = vWord | (v << (k * 8u));
      }
    }
    dst[P.lumaWords + i] = uWord;
    dst[P.lumaWords + P.chromaWords + i] = vWord;
  }
}
`;

const pipelineCache = new WeakMap();
function getPipeline(device) {
  let p = pipelineCache.get(device);
  if (!p) {
    const module = device.createShaderModule({ code: WGSL });
    p = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    pipelineCache.set(device, p);
  }
  return p;
}

export function createYuvPacker({ device, width, height }) {
  if (width < 2 || height < 2 || width % 2 || height % 2) throw new RangeError(`yuv420p 要求偶数宽高，收到 ${width}x${height}`);
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const strideU32 = bytesPerRow >>> 2;
  const lumaPixels = width * height, lumaWords = lumaPixels >>> 2;
  const chromaW = width >>> 1, chromaH = height >>> 1, chromaPixels = chromaW * chromaH;
  const chromaWords = Math.ceil(chromaPixels / 4);
  const totalWords = lumaWords + chromaWords * 2;
  const gpuBytes = totalWords * 4;
  const outBytes = lumaPixels + chromaPixels * 2;
  const contiguous = chromaWords * 4 === chromaPixels;
  const workgroups = Math.ceil(lumaWords / 256);

  const U = globalThis.GPUBufferUsage, M = globalThis.GPUMapMode;
  const uniformBuf = device.createBuffer({ size: 32, usage: U.UNIFORM | U.COPY_DST });
  device.queue.writeBuffer(uniformBuf, 0, new Uint32Array([width, height, strideU32, lumaWords, chromaW, chromaPixels, chromaWords, 0]));
  const srcBuf = device.createBuffer({ size: bytesPerRow * height, usage: U.COPY_DST | U.STORAGE });
  const yuvBuf = device.createBuffer({ size: gpuBytes, usage: U.STORAGE | U.COPY_SRC });

  const pipeline = getPipeline(device);
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuf } },
      { binding: 1, resource: { buffer: srcBuf } },
      { binding: 2, resource: { buffer: yuvBuf } },
    ],
  });

  const free = [];
  let disposed = false;
  const takeStaging = () => free.pop() || device.createBuffer({ size: gpuBytes, usage: U.COPY_DST | U.MAP_READ });

  return {
    packTexture(gpuTexture) {
      if (disposed) return Promise.reject(new Error('YuvPacker 已释放'));
      const staging = takeStaging();
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: gpuTexture, origin: { x: 0, y: 0, z: 0 } },
        { buffer: srcBuf, bytesPerRow },
        { width, height, depthOrArrayLayers: 1 },
      );
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.end();
      encoder.copyBufferToBuffer(yuvBuf, 0, staging, 0, gpuBytes);
      device.queue.submit([encoder.finish()]);

      return staging.mapAsync(M.READ).then(() => {
        const mapped = new Uint8Array(staging.getMappedRange(0, gpuBytes));
        let out;
        if (contiguous) {
          out = mapped.slice(0, outBytes);
        } else {
          out = new Uint8Array(outBytes);
          out.set(mapped.subarray(0, lumaPixels), 0);
          out.set(mapped.subarray(lumaPixels, lumaPixels + chromaPixels), lumaPixels);
          const vOff = (lumaWords + chromaWords) * 4;
          out.set(mapped.subarray(vOff, vOff + chromaPixels), lumaPixels + chromaPixels);
        }
        staging.unmap();
        if (disposed) staging.destroy();
        else free.push(staging);
        return out;
      }, err => {
        try { staging.destroy(); } catch { /* 已销毁 */ }
        throw err;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      uniformBuf.destroy();
      srcBuf.destroy();
      yuvBuf.destroy();
      while (free.length) free.pop().destroy();
    },
  };
}
