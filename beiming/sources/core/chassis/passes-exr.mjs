#!/usr/bin/env node
// 北冥 · 出层目录转多层 EXR：`render-pack --passes 目录` 出的通道声明 passes.json 加逐通道文件（.f32、.u32），照输出通道
// 契约的名字（通道名.分量名：color.R、depth.Z、objectId.id、objectId.coverage、normal.X…）写成一个单部件扫描线 EXR，
// 用 beiming/verify/exr/exr.mjs 的 writeExr 写、readExr 读回，逐通道逐字节比；通道名逐个过 isPassChannel。
//   node beiming/sources/core/chassis/passes-exr.mjs <出层目录> --width W --height H [-o frame.exr] [--zip]
// 层文件没有文件头，所以画面尺寸要给。文件名照 core-render 的写法（帧源接口契约 3.3）：一个通道的分量类型都相同时是「通道名.类型」；不同时第一个分量在
// 「通道名.类型」，其余分量各在「通道名.分量名.类型」（objectId 的 id 在 objectId.u32、coverage 在 objectId.coverage.f32）。
// 退出码：0 写好且往返逐位相同；4 往返不同、通道名不合契约或文件对不上通道声明；2 用法错误。
import { Buffer } from 'node:buffer';
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
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
      // 分灯组 lightgroup:<名> 的文件名里冒号换成连字符（core-render write_passes 的写法；Windows 的文件名不收冒号）
      const base = ch.name.replaceAll(':', '-');
      const file = c.type === ch.components[0].type ? `${base}.${c.type}` : `${base}.${c.name}.${c.type}`;
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

/** 写 EXR 并读回逐字节比。返回 { bytes, names, problems }：problems 空就是往返逐位相同、名字都合契约。
 *  tamper 只给负对照用：拿写好的字节、返回读回时用的字节（测试借它改坏一个通道，看比较抓不抓得到） */
export function passesToExr(dir, [width, height], { compression = 0, tamper } = {}) {
  const p = readPasses(dir, [width, height]);
  const names = Object.keys(p.channels).sort();
  const problems = names.filter(n => !isPassChannel(n)).map(n => `通道名 ${n} 不在输出通道契约的登记表里`);
  const bytes = writeExr({ width, height, channels: p.channels, compression });
  const back = readExr(tamper ? tamper(Buffer.from(bytes)) : bytes, { requiredChannels: names });
  if (Object.keys(back.channels).length !== names.length) problems.push(`读回 ${Object.keys(back.channels).length} 个通道，写进去 ${names.length} 个`);
  for (const n of names) {
    const a = p.channels[n], b = back.channels[n];
    if (a.constructor !== b.constructor || Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) !== 0) problems.push(`${n} 往返不逐位相同`);
  }
  return { bytes, names, problems };
}

/** 命令行；返回退出码。用法错误抛带 exit 2 的错。架构守卫不许这里引 tools/ 下的命令行框架，所以用 node:util 的 parseArgs */
export function main(argv) {
  const { values: o, positionals: [dir] } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: 'string', short: 'o' }, zip: { type: 'boolean' }, width: { type: 'string' }, height: { type: 'string' } } });
  const size = [Number(o.width), Number(o.height)];
  if (!dir || !size.every(n => Number.isInteger(n) && n > 0)) throw usage('用法：passes-exr.mjs <出层目录> --width W --height H [-o frame.exr] [--zip]');
  if (!fs.existsSync(path.join(dir, 'passes.json'))) throw usage(`${dir} 下没有 passes.json：给 render-pack --passes 写的目录`);
  let r;
  try {
    r = passesToExr(dir, size, { compression: o.zip ? 2 : 0 });
  } catch (e) {
    console.error(`✗ ${e.message}（尺寸与出层时不同，或目录里少了文件）`);
    return 4;
  }
  const out = o.out ?? path.join(dir, 'frame.exr');
  fs.writeFileSync(out, r.bytes);
  console.log(`${size[0]}×${size[1]}，${r.names.length} 个通道：${r.names.join('、')}`);
  for (const p of r.problems) console.log(`✗ ${p}`);
  console.log(r.problems.length ? `有 ${r.problems.length} 处不对` : `往返逐位相同，写到 ${out}`);
  return r.problems.length ? 4 : 0;
}

export const usage = message => Object.assign(new Error(message), { exit: 2 });

/** 当脚本直接跑时：错带 exit 的照它退出，parseArgs 的用法错退出 2 */
export function runMain(url, fn) {
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url)) {
    Promise.resolve().then(() => fn(process.argv.slice(2))).then(code => { process.exitCode = code; }, e => {
      console.error(`错误：${e.message}`);
      process.exitCode = e.exit ?? (String(e.code).startsWith('ERR_PARSE_ARGS') ? 2 : 1);
    });
  }
}

runMain(import.meta.url, main);
