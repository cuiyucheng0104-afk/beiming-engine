// agx-mhc 查找表：对数整形曲线、.cube 的烘焙和查表、按 colorRef 分流的显示编码。
// 场景参考镜头的颜色层是场景线性光（Rec.709 原色），HDR 级会超过 1.0；三维查找表的定义域只有 0 到 1，
// 所以必须先过对数整形再查表，不整形直接查会把 1.0 以上全部切平。显示参考镜头只差一步 sRGB 编码，不查表。
// 这里的 applyShaperAndLut 和 ffmpegFilter 给出的滤镜链是同一条算式：整形 → lut3d（四面体插值）。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 对数整形的三个常数。midGray 是线性光里的中灰（无单位的场景线性值）；minStops、maxStops 是相对中灰的曝光档数，
 * 取的是 Blender 色彩配置里 AgX Log 的分配范围，共 25 档：线性 0.18 × 2^−12.47393 ≈ 3.2e-5 到 0.18 × 2^12.5260688 ≈ 1061。
 */
export const SHAPER = Object.freeze({ midGray: 0.18, minStops: -12.47393, maxStops: 12.5260688 });

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 线性光 [r, g, b]（≥ 0，可以远大于 1）→ 对数域 [0, 1]。不大于 0 的值落在 0。 */
export const shaperEncode = (linearRgb) => linearRgb.map((v) =>
  (v > 0 ? clamp01((Math.log2(v / SHAPER.midGray) - SHAPER.minStops) / (SHAPER.maxStops - SHAPER.minStops)) : 0));

/** 显示空间的线性编码值 [r, g, b] → sRGB 编码值，先截到 [0, 1]。 */
export const srgbEncode = (linearRgb) => linearRgb.map((v) => {
  const c = clamp01(v);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
});

/** 读 .cube 的文本。只认三维表、定义域 0 到 1；返回 { size, data }，data 按红最快、蓝最慢排，每点三个数。 */
export function parseCube(text) {
  let size = 0;
  const values = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('TITLE')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') size = Number(parts[1]);
    else if (parts[0] === 'DOMAIN_MIN' || parts[0] === 'DOMAIN_MAX') {
      const want = parts[0] === 'DOMAIN_MIN' ? 0 : 1;
      if (parts.slice(1).some((p) => Number(p) !== want)) throw new Error(`.cube 的定义域必须是 0 到 1，读到 ${line}`);
    } else if (/^[A-Z][A-Z_0-9]*$/.test(parts[0])) throw new Error(`.cube 里有不认识的关键字：${parts[0]}`);
    else values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (!Number.isInteger(size) || size < 2) throw new Error('.cube 缺 LUT_3D_SIZE');
  if (values.length !== size ** 3 * 3 || values.some((v) => !Number.isFinite(v))) throw new Error(`.cube 应该有 ${size ** 3} 行数据，读到 ${values.length / 3} 行`);
  return { size, data: Float64Array.from(values) };
}

/** 在 [0, 1]³ 上查三维表，四面体插值（和 FFmpeg lut3d 的 interp=tetrahedral 同一种）。 */
function lookup(lut, rgb) {
  const n = lut.size, base = [0, 0, 0], frac = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const s = clamp01(rgb[i]) * (n - 1);
    base[i] = Math.min(Math.floor(s), n - 2);
    frac[i] = s - base[i];
  }
  const at = (p) => (p[0] + n * (p[1] + n * p[2])) * 3;
  // 从格子的近角出发，按小数部分从大到小的次序每次沿一个轴走一步，走到远角
  const order = [0, 1, 2].sort((a, b) => frac[b] - frac[a]);
  const corner = [...base], out = [0, 0, 0];
  let prev = at(corner);
  for (let c = 0; c < 3; c++) out[c] = lut.data[prev + c];
  for (const axis of order) {
    corner[axis] += 1;
    const next = at(corner);
    for (let c = 0; c < 3; c++) out[c] += (lut.data[next + c] - lut.data[prev + c]) * frac[axis];
    prev = next;
  }
  return out;
}

/** 场景线性光 [r, g, b] → 显示空间的 sRGB 编码值 [0, 1]：先过对数整形，再查 lut（parseCube 的返回值）。 */
export const applyShaperAndLut = (linearRgb, lut) => lookup(lut, shaperEncode(linearRgb));

/** 按镜头的 colorRef 分流：scene 走整形加查表（必须给 lut），display 只做 sRGB 编码。 */
export function displayEncode(linearRgb, colorRef, lut) {
  if (colorRef === 'display') return srgbEncode(linearRgb);
  if (colorRef === 'scene') return applyShaperAndLut(linearRgb, lut);
  throw new Error(`colorRef 只能是 scene、display，给的是 ${colorRef}`);
}

/**
 * 同一条分流写成 FFmpeg 的滤镜链，输入必须是线性光的浮点平面格式（gbrpf32le）。cubePath 是 .cube 的路径，只有 scene 用。
 * 路径里不得有单引号、冒号、反斜杠（滤镜参数的转义不在这里做）。
 */
export function ffmpegFilter(colorRef, cubePath) {
  const planes = (expr) => ['r', 'g', 'b'].map((p) => `${p}='${expr.replaceAll('V', `${p}(X,Y)`)}'`).join(':');
  if (colorRef === 'display') return `geq=${planes('if(lte(clip(V,0,1),0.0031308),12.92*clip(V,0,1),1.055*pow(clip(V,0,1),1/2.4)-0.055)')}`;
  if (colorRef !== 'scene') throw new Error(`colorRef 只能是 scene、display，给的是 ${colorRef}`);
  if (/['\\:]/.test(cubePath)) throw new Error('查找表的路径里不得有单引号、冒号、反斜杠');
  const { midGray, minStops, maxStops } = SHAPER;
  const shaper = `if(gt(V,0),clip((log(V/${midGray})/log(2)-(${minStops}))/${maxStops - minStops},0,1),0)`;
  return `geq=${planes(shaper)},lut3d=file='${cubePath}':interp=tetrahedral`;
}

/** 起一个一次性的后台 Blender 跑 bake_agx.py。不出声（-noaudio），不读用户配置（--factory-startup）。 */
export function runBlenderJob(blenderBin, job, limitMs = 120000) {
  if (!blenderBin) {
    const e = new Error('没有 Blender：烘 AgX 查找表要用 Blender 自带的色彩配置');
    e.code = 'env.missing-tool';
    throw e;
  }
  if (!Number.isInteger(limitMs) || limitMs < 1 || limitMs > 2147483647) throw new Error('limitMs 必须是 1 到 2147483647 的整数');
  return new Promise((ok, fail) => {
    execFile(blenderBin, ['-b', '-noaudio', '--factory-startup', '--python-exit-code', '1', '--python', join(HERE, 'bake_agx.py'), '--', JSON.stringify(job)],
      { maxBuffer: 16 * 1024 * 1024, timeout: limitMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
        if (!err) return ok();
        if (err.code === 'ENOENT') err.code = 'env.missing-tool';
        if (err.killed) return fail(new Error(`Blender 烘表任务被终止（时限 ${limitMs} 毫秒）`, { cause: err }));
        const diagnostic = `${stdout}\n${stderr}`.trim().split('\n').slice(-6).join(' | ');
        err.message = `Blender 跑 bake_agx.py 失败：${diagnostic || err.message}`;
        fail(err);
      });
  });
}

/**
 * 烘 agx-mhc 三维查找表：gridSize³ 个点，输入是 shaperEncode 之后的 [0, 1]，输出是显示空间的 sRGB 编码值。
 * 写成标准 .cube（每个数 6 位小数），返回文件内容的哈希：sha256: 加 64 位小写十六进制。
 * 复算：对 outPath 的全部字节算 SHA-256；同一个 Blender 版本、同一个 gridSize 烘出的文件逐字节相同。
 */
export async function bakeAgxLut({ blenderBin, gridSize = 65, outPath, limitMs }) {
  if (!Number.isInteger(gridSize) || gridSize < 2) throw new Error(`gridSize 必须是不小于 2 的整数，给的是 ${gridSize}`);
  const dir = await mkdtemp(join(dirname(outPath), '.agx-'));
  const staged = join(dir, 'agx.cube');
  try {
    await runBlenderJob(blenderBin, { mode: 'bake', gridSize, outPath: staged, shaper: SHAPER }, limitMs);
    const hash = createHash('sha256').update(await readFile(staged)).digest('hex');
    await rename(staged, outPath);
    return `sha256:${hash}`;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
