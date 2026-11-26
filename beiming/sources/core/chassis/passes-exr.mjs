#!/usr/bin/env node
// 北冥 · 出层目录转多层 EXR：`render-pack --passes 目录` 出的通道声明 passes.json 加逐通道文件（.f32、.u32），照输出通道
// 契约的名字（通道名.分量名：color.R、depth.Z、objectId.id、objectId.coverage、normal.X…）写成一个单部件扫描线 EXR，
// 用 beiming/verify/exr/exr.mjs 的 writeExr 写、readExr 读回，逐通道逐字节比；通道名逐个过 isPassChannel。
//   node beiming/sources/core/chassis/passes-exr.mjs <出层目录> --width W --height H [-o frame.exr] [--zip]
// 层文件没有文件头，所以画面尺寸要给。文件名照 core-render 的写法（帧源接口契约 3.3）：一个通道的分量类型都相同时是「通道名.类型」；不同时第一个分量在
// 「通道名.类型」，其余分量各在「通道名.分量名.类型」（objectId 的 id 在 objectId.u32、coverage 在 objectId.coverage.f32）。
// 退出码：0 写好且往返逐位相同；4 往返不同、通道名不合契约或文件对不上通道声明；2 用法错误。
import fs from 'node:fs';
import path from 'node:path';
import { CliError, defineCommand, isMain, runCli } from '../../../../tools/lib/cli.mjs';
import { isPassChannel, readExr, writeExr } from '../../../verify/exr/exr.mjs';

const TYPED = { f32: Float32Array, u32: Uint32Array };

/** 出层目录 → { channels: { 'color.R': Float32Array, … }, table }。文件没有文件头，画面尺寸由调用方给；每个文件的长度照
 *  尺寸与 passes.json 的分量数核对 */
export function readPasses(dir, [width, height]) {
  const table = JSON.parse(fs.readFileSync(path.join(dir, 'passes.json'), 'utf8'));
  if (table.format !== 'passes/0.1') throw new Error(`通道声明的 format 是 ${table.format}，不是 passes/0.1`);
  const channels = {};
  for (const ch of table.channels) {
    const groups = new Map();
    ch.components.forEach((c, at) => {
      const file = c.type === ch.components[0].type ? `${ch.name}.${c.type}` : `${ch.name}.${c.name}.${c.type}`;
      if (!groups.has(file)) groups.set(file, { type: c.type, list: [] });
      groups.get(file).list.push({ name: c.name, at });
    });
    for (const [file, { type, list }] of groups) {
      if (!TYPED[type]) throw new Error(`${ch.name}.${list[0].name} 的类型 ${type} 不认识`);
      const bytes = fs.readFileSync(path.join(dir, file));
      const data = new TYPED[type](bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const k = list.length, n = data.length / k;
      if (!Number.isInteger(n)) throw new Error(`${file} 的长度不是 ${k} 个分量的整数倍`);
      if (n !== width * height) throw new Error(`${file} 有 ${n} 个像素，别的通道是 ${width}×${height}`);
      list.forEach(({ name }, j) => {
        const plane = new TYPED[type](n);
        for (let i = 0; i < n; i++) plane[i] = data[i * k + j];
        channels[`${ch.name}.${name}`] = plane;
      });
    }
  }
  return { channels, table };
}

/** 写 EXR 并读回逐字节比。返回 { bytes, names, problems }：problems 空就是往返逐位相同、名字都合契约 */
export function passesToExr(dir, [width, height], { compression = 0 } = {}) {
  const p = readPasses(dir, [width, height]);
  const names = Object.keys(p.channels).sort();
  const problems = names.filter(n => !isPassChannel(n)).map(n => `通道名 ${n} 不在输出通道契约的登记表里`);
  const bytes = writeExr({ width, height, channels: p.channels, compression });
  const back = readExr(bytes, { requiredChannels: names });
  if (Object.keys(back.channels).length !== names.length) problems.push(`读回 ${Object.keys(back.channels).length} 个通道，写进去 ${names.length} 个`);
  for (const n of names) {
    const a = p.channels[n], b = back.channels[n];
    if (a.constructor !== b.constructor || Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) !== 0) problems.push(`${n} 往返不逐位相同`);
  }
  return { bytes, names, problems };
}

export const command = defineCommand({
  name: 'chassis-passes-exr',
  summary: '出层目录（passes.json 加 .f32、.u32）转多层 EXR，读回逐位比',
  usage: ['node beiming/sources/core/chassis/passes-exr.mjs <出层目录> --width W --height H [-o frame.exr] [--zip]'],
  positionals: [{ name: 'dir', label: '<出层目录>', describe: 'render-pack --passes 写的目录', required: true }],
  options: {
    out: { type: 'string', short: 'o', arg: '<文件>', describe: 'EXR 写到哪里；默认出层目录下的 frame.exr' },
    zip: { type: 'boolean', describe: '按扫描线 ZIPS 压缩（默认不压缩）' },
    width: { type: 'string', arg: '<W>', describe: '画面宽（render-pack 的 --width）' },
    height: { type: 'string', arg: '<H>', describe: '画面高（render-pack 的 --height）' },
  },
  exitCodes: { 0: '写好，往返逐位相同', 2: '用法错误', 4: '往返不同或通道对不上' },
  async run(ctx) {
    const dir = ctx.args.dir;
    if (!fs.existsSync(path.join(dir, 'passes.json'))) throw new CliError('usage.no-passes', `${dir} 下没有 passes.json`, '给 render-pack --passes 写的目录');
    const size = [Number(ctx.opts.width), Number(ctx.opts.height)];
    if (!size.every(n => Number.isInteger(n) && n > 0)) throw new CliError('usage.size', '要给 --width 与 --height（正整数）', '与出层时 render-pack 的尺寸相同');
    let r;
    try {
      r = passesToExr(dir, size, { compression: ctx.opts.zip ? 2 : 0 });
    } catch (e) {
      return { error: { code: 'contract.passes-exr', message: e.message, hint: '尺寸与出层时不同，或目录里少了文件' } };
    }
    const out = ctx.opts.out ?? path.join(dir, 'frame.exr');
    fs.writeFileSync(out, r.bytes);
    ctx.out(`${size[0]}×${size[1]}，${r.names.length} 个通道：${r.names.join('、')}`);
    for (const p of r.problems) ctx.out(`✗ ${p}`);
    ctx.out(r.problems.length ? `有 ${r.problems.length} 处不对` : `往返逐位相同，写到 ${out}`);
    return { data: { out, channels: r.names, problems: r.problems }, outputs: [{ path: out, kind: 'image' }], ...(r.problems.length && { error: { code: 'contract.passes-exr', message: r.problems[0], hint: '逐条见上' } }) };
  },
});

if (isMain(import.meta.url)) await runCli(command);
