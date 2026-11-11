#!/usr/bin/env node
// 底板出血（过扫描）计算：一段镜头里相机怎么动，这一层底板每条边至少要画到画框外多少像素（craft/two-five-d.md §2.1 的公式）。
//   o = f·|T⊥|/D + f·tan|Δ转角| − a·(1 − 1/m)，再加羽化宽度 e 与安全余量 s = max(0.25·o, 16)；拉镜（m < 1）时扩张项变成 + a·(1/m − 1)
//   f = (H/2)/tan(fov/2)（竖直视场）；m = D/(D − Tz)；a = 画框边到扩张中心的距离（左右 W/2，上下 H/2，沿视轴推拉）
// 只适用于层面正对相机、转角较小；有滚转、大角度摇镜时改用逐帧投影四角的数值方法（或改用穹顶）。
import { CliError, defineCommand, isMain, runCli } from '../lib/cli.mjs';

export function bleed({ D, fov, tx = 0, ty = 0, tz = 0, pan = 0, tilt = 0, feather = 0, W = 1920, H = 1080 }) {
  const f = (H / 2) / Math.tan(fov * Math.PI / 360), m = D / (D - tz);
  const side = (T, a, rot) => {
    const shift = f * Math.abs(T) / D, turn = f * Math.tan(Math.abs(rot) * Math.PI / 180);
    const expand = m >= 1 ? -a * (1 - 1 / m) : a * (1 / m - 1);
    const o = shift + turn + expand, need = Math.max(0, o);
    const s = Math.max(0.25 * need, 16);
    return { shift: +shift.toFixed(1), turn: +turn.toFixed(1), expand: +expand.toFixed(1), o: +o.toFixed(1), feather, safety: +s.toFixed(1), total: Math.ceil(need + feather + s) };
  };
  return { f: +f.toFixed(1), m: +m.toFixed(4), leftRight: side(tx, W / 2, pan), topBottom: side(ty, H / 2, tilt) };
}

export const command = defineCommand({
  name: 'plates:bleed',
  summary: '算一层底板每条边要画到画框外多少设计稿像素（craft/two-five-d.md §2.1 的出血公式）',
  usage: ['node tools/plates/bleed.mjs --depth <米> --fov <度> [--tx 米] [--ty 米] [--tz 米] [--pan 度] [--tilt 度] [--feather 像素] [--size 1920x1080] [--json]'],
  description: [
    '位移都在起始机位的相机坐标系里量：--tx 横移、--ty 升降、--tz 前推（拉镜写负数）；--pan / --tilt 一段镜头里最大的水平 / 俯仰转角。',
    '--feather 是截断边从透明到实心的宽度（起始机位屏幕像素）。只适用于层面正对相机、转角较小；大角度摇镜改用穹顶（engine/stage/dome.js）。',
  ],
  options: {
    depth: { type: 'number', arg: '<米>', describe: '这一层离起始机位的视深 D（必填，正数）' },
    fov: { type: 'number', arg: '<度>', describe: '竖直视场（必填，0–180）' },
    tx: { type: 'number', arg: '<米>', describe: '横移' },
    ty: { type: 'number', arg: '<米>', describe: '升降' },
    tz: { type: 'number', arg: '<米>', describe: '前推（拉镜写负数）' },
    pan: { type: 'number', arg: '<度>', describe: '最大水平转角' },
    tilt: { type: 'number', arg: '<度>', describe: '最大俯仰转角' },
    feather: { type: 'number', arg: '<像素>', min: 0, describe: '羽化宽度，默认 0' },
    size: { type: 'string', arg: '<宽x高>', describe: '设计稿尺寸，默认 1920x1080' },
  },
  examples: ['node tools/plates/bleed.mjs --depth 1800 --fov 16 --tx 2.5 --ty 0.5 --tz 14 --feather 40'],
  exitCodes: { 0: '成功', 2: '用法错误' },
  run(ctx) {
    const o = ctx.opts;
    if (!(o.depth > 0)) throw new CliError('usage.bad-depth', '--depth 必填，正数（米）', '例：--depth 1800');
    if (!(o.fov > 0 && o.fov < 180)) throw new CliError('usage.bad-fov', '--fov 必填，0–180 之间的竖直视场（度）', '例：--fov 16');
    if ((o.tz ?? 0) >= o.depth) throw new CliError('usage.bad-tz', `--tz ${o.tz} 不小于层深 ${o.depth}：相机会推过这一层`, '把 --tz 改小，或这一层改成三维物体');
    const m = /^(\d+)x(\d+)$/.exec(o.size || '1920x1080');
    if (!m) throw new CliError('usage.bad-size', `--size ${o.size} 写成 1920x1080`, null);
    const r = bleed({ D: o.depth, fov: o.fov, tx: o.tx ?? 0, ty: o.ty ?? 0, tz: o.tz ?? 0, pan: o.pan ?? 0, tilt: o.tilt ?? 0, feather: o.feather ?? 0, W: +m[1], H: +m[2] });
    for (const [k, v] of [['左右边', r.leftRight], ['上下边', r.topBottom]])
      ctx.out(`${k}：平移 ${v.shift} + 转角 ${v.turn} ${v.expand >= 0 ? '+' : '−'} 扩张 ${Math.abs(v.expand)} = ${v.o} px；加羽化 ${v.feather}、余量 ${v.safety} → 每侧至少画出画框 ${v.total} px`);
    return { data: r };
  },
});

if (isMain(import.meta.url)) await runCli(command);
