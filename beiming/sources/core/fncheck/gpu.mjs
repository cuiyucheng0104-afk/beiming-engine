// 被测一侧：把登记的 WGSL 函数包进自动生成的计算着色器，在无头 Chrome 的 WebGPU 上跑，读回结果。
// 页面由本机 127.0.0.1 的临时 http 服务给出：about:blank 不是安全上下文，没有 navigator.gpu。
// 输入输出走同源二进制 GET / POST，不经 base64。
import { Buffer } from 'node:buffer';
import http from 'node:http';
import { launchBrowser } from '../../../../engine/render/lib/gpu.mjs';
import { missing } from './cycles/build.mjs';
import { width } from './registry.mjs';

/** 生成计算着色器：每个线程算一组，输入按 f32 紧凑排列（不用 vec3 存储，免得按 16 字节对齐） */
export function kernel(source, f) {
  let o = 0;
  const at = () => `inp[b + ${o++}u]`;
  const args = f.inputs.map(([, type]) => (type === 'vec3f' ? `vec3f(${at()}, ${at()}, ${at()})` : at()));
  const store = f.out === 1 ? 'outp[i] = r;' : 'outp[i * 3u] = r.x; outp[i * 3u + 1u] = r.y; outp[i * 3u + 2u] = r.z;';
  return `${source}
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;
@compute @workgroup_size(64)
fn fncheck_main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.y * nwg.x * 64u + gid.x;
  if (i * ${f.out}u >= arrayLength(&outp)) { return; }
  let b = i * ${o}u;
  let r = ${f.wgsl}(${args.join(', ')});
  ${store}
}
`;
}

const PAGE = `<!doctype html><meta charset="utf-8"><script>
window.runAll = async jobs => {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter || adapter.info?.isFallbackAdapter) return { error: 'no-adapter' };
  const L = adapter.limits;
  const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: L.maxStorageBufferBindingSize, maxBufferSize: L.maxBufferSize } });
  for (const j of jobs) {
    const input = await (await fetch('/in/' + j.name)).arrayBuffer();
    const outBytes = j.n * j.nOut * 4;
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code: j.code });
    const errs = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error');
    if (errs.length) return { error: j.name + ' 编不过：' + errs.map(m => m.lineNum + ':' + m.linePos + ' ' + m.message).join('；') };
    const pipe = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'fncheck_main' } });
    const inB = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outB = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rb = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(inB, 0, input);
    const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: inB } }, { binding: 1, resource: { buffer: outB } }] });
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

/** jobs: [{ f, input: Float32Array, source: WGSL 原文 }] → { adapter, outputs: Float32Array[] }（与 jobs 同序） */
export async function runGpu(jobs) {
  const ins = new Map(jobs.map(j => [j.f.name, j.input]));
  const outs = new Map();
  const srv = http.createServer((req, res) => {
    const [, kind, name] = req.url.split('/');
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
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
    try { browser = await launchBrowser(); } catch (e) { throw missing(`无头浏览器起不来：${e.message}`); }
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const r = await page.evaluate(js => globalThis.runAll(js), jobs.map(j => ({ name: j.f.name, code: kernel(j.source, j.f), n: j.input.length / width(j.f), nOut: j.f.out })));
    if (r.error === 'no-adapter') throw missing('没有硬件 WebGPU 适配器（软件渲染没有 WebGPU）');
    if (r.error) throw new Error(`WebGPU：${r.error}`);
    return {
      adapter: r.adapter,
      outputs: jobs.map(j => { const b = outs.get(j.f.name); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); }),
    };
  } finally {
    await browser?.close();
    srv.close();
  }
}
