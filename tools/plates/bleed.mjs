#!/usr/bin/env node
// 底板出血（过扫描）计算：一段镜头里相机怎么动，这一层底板每条边至少要画到画框外多少像素（craft/two-five-d.md §2.1 的公式）。
//   o = f·|T⊥|/D + f·tan|Δ转角| − a·(1 − 1/m)，再加羽化宽度 e 与安全余量 s = max(0.25·o, 16)；拉镜（m < 1）时扩张项变成 + a·(1/m − 1)
//   f = (H/2)/tan(fov/2)（竖直视场）；m = D/(D − Tz)；a = 画框边到扩张中心的距离（左右 W/2，上下 H/2，沿视轴推拉）
// 只适用于层面正对相机、转角较小；有滚转、大角度摇镜时改用逐帧投影四角的数值方法（或改用穹顶）。
import { runCli, CliError, EXIT } from '../lookdev/lib/cli.mjs';

const USAGE = `
用法：node tools/plates/bleed.mjs --depth <D 米> --fov <竖直视场 度> [--tx 米] [--ty 米] [--tz 米] [--pan 度] [--tilt 度]
                                  [--feather <羽化 像素>] [--size 1920x1080] [--json]
  算一层底板每条边要画到画框外多少设计稿像素（craft/two-five-d.md §2.1）。位移都在起始机位的相机坐标系里量：
  --tx 横移、--ty 升降、--tz 前推（向前为正，拉镜写负数）；--pan / --tilt 一段镜头里最大的水平 / 俯仰转角。
  --feather 截断边从透明到实心的宽度（起始机位屏幕像素，默认 0）；--size 设计稿尺寸（默认 1920x1080）。
例：node tools/plates/bleed.mjs --depth 1800 --fov 16 --tx 2.5 --ty 0.5 --tz 14 --feather 40
退出码：0；2 用法错误。
`;

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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bleed.mjs')) await runCli({
  command: 'plates:bleed',
  usage: USAGE,
  spec: { depth: 'number', fov: 'number', tx: 'number', ty: 'number', tz: 'number', pan: 'number', tilt: 'number', feather: 'number', size: 'string' },
  async main({ opts, args, log }) {
    if (args.length) throw new CliError(EXIT.USAGE, 'extra-args', `多余的参数：${args.join(' ')}`);
    if (!(opts.depth > 0)) throw new CliError(EXIT.USAGE, 'bad-depth', '--depth 必填，正数（米）');
    if (!(opts.fov > 0 && opts.fov < 180)) throw new CliError(EXIT.USAGE, 'bad-fov', '--fov 必填，0–180 之间的竖直视场（度）');
    if ((opts.tz ?? 0) >= opts.depth) throw new CliError(EXIT.USAGE, 'bad-tz', `--tz ${opts.tz} 不小于层深 ${opts.depth}：相机会推过这一层`);
    const m = /^(\d+)x(\d+)$/.exec(opts.size || '1920x1080');
    if (!m) throw new CliError(EXIT.USAGE, 'bad-size', `--size ${opts.size} 写成 1920x1080`);
    const r = bleed({ D: opts.depth, fov: opts.fov, tx: opts.tx ?? 0, ty: opts.ty ?? 0, tz: opts.tz ?? 0, pan: opts.pan ?? 0, tilt: opts.tilt ?? 0, feather: opts.feather ?? 0, W: +m[1], H: +m[2] });
    for (const [k, v] of [['左右边', r.leftRight], ['上下边', r.topBottom]])
      log(`${k}：平移 ${v.shift} + 转角 ${v.turn} ${v.expand >= 0 ? '+' : '−'} 扩张 ${Math.abs(v.expand)} = ${v.o} px；加羽化 ${v.feather}、余量 ${v.safety} → 每侧至少画出画框 ${v.total} px`);
    return r;
  },
});
