// 被测一侧：把登记的 WGSL 函数包进自动生成的计算着色器，在无头 Chrome 的 WebGPU 上跑，读回结果。
// 页面由本机 127.0.0.1 的临时 http 服务给出：about:blank 不是安全上下文，没有 navigator.gpu。
// 输入输出走同源二进制 GET / POST，不经 base64。
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromeArgs, chromeExecutable } from '../../../../engine/render/lib/gpu.mjs';
import { missing } from './cycles/build.mjs';
import { size } from './registry.mjs';

/** 广义 Schlick 的两张表（各 4096 个数，接在一起）：内核放在表缓冲里，这里照样绑成存储缓冲 lut（第 2 个绑定）。
 *  数据与内核读的是同一份文件（../shaders/ggx_gen_schlick.tables；内核一侧 path/src/lib.rs 的 ggx_gen_schlick_tables） */
export const LUT = Float32Array.from(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shaders', 'ggx_gen_schlick.tables'), 'utf8')
  .split('\n').filter(l => !l.trimStart().startsWith('//')).flatMap(l => l.split(',')).map(s => s.trim()).filter(Boolean).map(s => Number(s.replace(/f$/, ''))));
if (LUT.length !== 8192 || LUT.some(Number.isNaN)) throw new Error('ggx_gen_schlick.tables 应有 8192 个数');

/** 移植的查表函数要的三个函数（../shaders/util.wgsl 的 lookup_table_read_buf 上面的说明），与内核 path/shaders/pathtrace.wgsl
 *  的同名函数对应：内核从整个表缓冲里取数、偏移是表的首地址，这里 lut 只放这两张表 */
export const LUT_PRELUDE = `@group(0) @binding(2) var<storage, read> lut: array<f32>;
fn lookup_table_fetch(i: i32) -> f32 { return lut[i]; }
fn table_ggx_gen_schlick_ior_s() -> i32 { return 0; }
fn table_ggx_gen_schlick_s() -> i32 { return 4096; }`;

/** 生成计算着色器：每个线程算一组，输入按 f32 紧凑排列（不用 vec3 存储，免得按 16 字节对齐）。source 是拼好的 WGSL 模块 */
export function kernel(source, f) {
  let o = 0;
  const at = () => `inp[b + ${o++}u]`;
  const args = f.inputs.map(([, type]) => {
    if (type === 'f32') return at();
    const n = size(type);
    return `vec${n}f(${Array.from({ length: n }, at).join(', ')})`;
  });
  const parts = typeof f.out === 'number' ? [['r', f.out]] : Object.entries(f.out).map(([k, n]) => [`r.${k}`, n]);
  let w = 0;
  const store = parts.flatMap(([e, n]) => (n === 1 ? [`outp[c + ${w++}u] = f32(${e});`] : Array.from({ length: n }, (_, k) => `outp[c + ${w++}u] = ${e}[${k}];`)));
  return `${source}
${LUT_PRELUDE}
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;
@compute @workgroup_size(64)
fn fncheck_main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.y * nwg.x * 64u + gid.x;
  if (i * ${w}u >= arrayLength(&outp)) { return; }
  let b = i * ${o}u;
  let c = i * ${w}u;
  let r = ${f.call ? f.call(args) : `${f.wgsl}(${args.join(', ')})`};
  ${store.join('\n  ')}
}
`;
}

const PAGE = `<!doctype html><meta charset="utf-8"><script>
window.runAll = async jobs => {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter || adapter.info?.isFallbackAdapter) return { error: 'no-adapter' };
  const L = adapter.limits;
  const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: L.maxStorageBufferBindingSize, maxBufferSize: L.maxBufferSize } });
  // 布局写明三个绑定：layout 'auto' 会去掉没用到的 lut，绑定组就对不上了
  const ro = { type: 'read-only-storage' }, C = GPUShaderStage.COMPUTE;
  const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: C, buffer: ro }, { binding: 1, visibility: C, buffer: { type: 'storage' } }, { binding: 2, visibility: C, buffer: ro }] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const lut = await (await fetch('/lut')).arrayBuffer();
  const lutB = device.createBuffer({ size: lut.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(lutB, 0, lut);
  for (const j of jobs) {
    const input = await (await fetch('/in/' + j.name)).arrayBuffer();
    const outBytes = j.n * j.nOut * 4;
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code: j.code });
    const errs = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error');
    if (errs.length) return { error: j.name + ' 编不过：' + errs.map(m => m.lineNum + ':' + m.linePos + ' ' + m.message).join('；') };
    const pipe = device.createComputePipeline({ layout, compute: { module, entryPoint: 'fncheck_main' } });
    const inB = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outB = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rb = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(inB, 0, input);
    const bg = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: inB } }, { binding: 1, resource: { buffer: outB } }, { binding: 2, resource: { buffer: lutB } }] });
    // 一维调度最多 65535 个工作组，超了不报异常、只得到全零；所以按二维排
    const groups = Math.ceil(j.n / 64), x = Math.min(groups, 65535), y = Math.ceil(groups / x);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(x, y); pass.end();
    enc.copyBufferToBuffer(outB, 0, rb, 0, outBytes);
    device.queue.submit([enc.finish()]);
    const err = await device.popErrorScope();
    if (err) return { error: j.name + '：' + err.message };
    await rb.mapAsync(GPUMapMode.READ);
    const out = rb.getMappedRange().slice(0);
    rb.unmap(); inB.destroy(); outB.destroy(); rb.destroy();
    await fetch('/out/' + j.name, { method: 'POST', body: out });
  }
  const { vendor, architecture, device: dev, description } = adapter.info;
  return { adapter: { vendor, architecture, device: dev, description } };
};
</script>`;

// Linux 上无头 Chrome 默认不开 WebGPU。只加 --enable-unsafe-webgpu 拿到的是软件适配器，再加 Vulkan 才是真显卡（NVIDIA 上实测）
const WEBGPU_ARGS = process.platform === 'linux' ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] : [];

/** jobs: [{ name, code: 计算着色器（入口 fncheck_main）, input: Float32Array, n: 线程数, nOut: 每个线程写几个 f32 }]
 *  → { adapter, outputs: Float32Array[] }（与 jobs 同序） */
export async function runGpu(jobs) {
  const ins = new Map(jobs.map(j => [j.name, j.input]));
  const outs = new Map();
  const srv = http.createServer((req, res) => {
    const [, kind, name] = req.url.split('/');
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (req.url === '/lut') return res.end(Buffer.from(LUT.buffer, LUT.byteOffset, LUT.byteLength));
    if (kind === 'in' && ins.has(name)) { const a = ins.get(name); return res.end(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); }
    if (kind === 'out' && req.method === 'POST') {
      const chunks = [];
      return req.on('data', c => chunks.push(c)).on('end', () => { outs.set(name, Buffer.concat(chunks)); res.end(); });
    }
    res.writeHead(404).end();
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  let browser;
  try {
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ executablePath: chromeExecutable(), args: [...chromeArgs(), ...WEBGPU_ARGS, '--mute-audio'] });
    } catch (e) { throw missing(`无头浏览器起不来：${String(e.message).split('\n')[0]}`); }
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const r = await page.evaluate(js => globalThis.runAll(js), jobs.map(({ name, code, n, nOut }) => ({ name, code, n, nOut })));
    if (r.error === 'no-adapter') throw missing('没有硬件 WebGPU 适配器（软件渲染没有 WebGPU）');
    if (r.error) throw new Error(`WebGPU：${r.error}`);
    return {
      adapter: r.adapter,
      outputs: jobs.map(j => { const b = outs.get(j.name); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); }),
    };
  } finally {
    await browser?.close();
    srv.close();
  }
}
