// 北冥引擎 · 页面型作品一条命令出片：事件表 → 声音 → 拍点核对 → 逐帧 → 封装（−14 LUFS）→ 海报 → 成片核对。
//   node engine/render/build.mjs <影片目录> [--workers 4] [--skip-video]
// 影片目录要在仓库内（页面由 engine/render/page.mjs 的本地服务器提供），满足页面约定（window.DUR / render(t) / READY，可选 EV / TIMELINE / TEXTS）。
// 读 <影片>/film.json：
//   { fps: 24, size: [1920, 1080], poster?: 秒（默认片长的 0.6）, cuecheck?: { silence?: ['S'], grid?: 2, tolMs?: 0.5, quietDb?: 15 } }
// 步骤，产物都在 <影片>/out/（已被 .gitignore）：
//   1. engine/render/events.mjs   window.EV → <影片>/events.json；有 window.TIMELINE 时再写 timeline.json
//   2. <影片>/mix.py（有才跑）     用 $BEIMING_PY（默认 python3，需要 numpy / scipy / numba / soundfile）在仓库根目录运行，应写 out/mix.wav
//   3. film.json 写了 cuecheck    python -m engine.audio.cuecheck，超差即停
//   4. engine/render/video.mjs    逐帧 → out/video.mp4（--skip-video 时跳过 4–6，只出声音与核对）
//   5. engine/render/mux.sh       有 out/mix.wav 就封装成 out/<目录名>.mp4；没有声音就把 video.mp4 复制过去（无声片）
//   6. engine/render/still.mjs    海报 → out/poster.jpg
//   7. ffprobe                    打印成片的帧数、尺寸、音轨，与 film.json 对照，不符则退出码 1
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dir = args[0];
if (!dir || dir.startsWith('--')) { console.error('用法：node engine/render/build.mjs <影片目录> [--workers 4] [--skip-video]'); process.exit(2); }
const film = path.resolve(dir), name = path.basename(film), out = path.join(film, 'out');
const cfgPath = path.join(film, 'film.json');
if (!fs.existsSync(cfgPath)) { console.error(`缺少 ${cfgPath}`); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const fps = cfg.fps || 24, [w, h] = cfg.size || [1920, 1080], size = `${w}x${h}`;
const workers = opt('--workers', '4'), PY = process.env.BEIMING_PY || 'python3';
fs.mkdirSync(out, { recursive: true });

const run = (cmd, a, label) => {
  console.log(`\n▶ ${label}`);
  execFileSync(cmd, a, { cwd: ROOT, stdio: 'inherit' });
};

run('node', ['engine/render/events.mjs', film, '--size', size], '1/7 事件表');
const mix = path.join(film, 'mix.py'), wav = path.join(out, 'mix.wav');
if (fs.existsSync(mix)) run(PY, [mix, film], '2/7 声音（mix.py）');
else console.log('\n▶ 2/7 没有 mix.py：按无声片处理');
if (cfg.cuecheck) {
  const c = cfg.cuecheck, a = ['-m', 'engine.audio.cuecheck', film];
  if (c.silence?.length) a.push('--silence', c.silence.join(','));
  if (c.grid) a.push('--grid', String(c.grid));
  if (c.tolMs != null) a.push('--tol-ms', String(c.tolMs));
  if (c.quietDb != null) a.push('--quiet-db', String(c.quietDb));
  run(PY, a, '3/7 声画拍点核对');
}
if (args.includes('--skip-video')) process.exit(0);

const video = path.join(out, 'video.mp4'), master = path.join(out, `${name}.mp4`);
run('node', ['engine/render/video.mjs', film, '--size', size, '--fps', String(fps), '--workers', workers, '--out', video], '4/7 逐帧渲染');
if (fs.existsSync(wav)) run('sh', ['engine/render/mux.sh', video, wav, master, String(fps), '0'], '5/7 音画封装');
else { console.log('\n▶ 5/7 无声：直接用 video.mp4'); fs.copyFileSync(video, master); }

const dur = JSON.parse(fs.readFileSync(path.join(film, 'events.json'), 'utf8')).dur;
const poster = String(cfg.poster ?? +(dur * 0.6).toFixed(2));
run('node', ['engine/render/still.mjs', film, poster, '--size', size, '--out', out, '--prefix', 'poster_'], '6/7 海报');
fs.renameSync(path.join(out, `poster_${poster}.jpg`), path.join(out, 'poster.jpg'));

console.log('\n▶ 7/7 成片核对');
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
  'stream=codec_type,width,height,nb_read_frames,sample_rate,channels', '-of', 'json', master]).toString()).streams;
const v = probe.find(s => s.codec_type === 'video'), a = probe.find(s => s.codec_type === 'audio');
const want = Math.round(dur * fps);
console.log(`${master}\n  画面 ${v.width}×${v.height}  ${v.nb_read_frames} 帧（应为 ${want}）  音轨 ${a ? `${a.sample_rate} Hz × ${a.channels}` : '无'}`);
if (v.width !== w || v.height !== h || +v.nb_read_frames !== want || (fs.existsSync(wav) && !a)) { console.error('成片与 film.json 不符'); process.exit(1); }
