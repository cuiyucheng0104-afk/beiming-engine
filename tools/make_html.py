# -*- coding: utf-8 -*-
"""单文件播放页：给用户审片、给客户看成片用的一页 HTML。

用法：
  python tools/make_html.py <输入.mp4> <输出.html> [--film <作品目录或 film.json>] [--meta <清单.json>]
                            [--title 标题] [--embed auto|always|never]
  node tools/film/cli.mjs build / animatic 会自动调用（--meta 由编排器按 film.json 与本次运行写好）。

信息从哪来（前者优先）：
  标题        --title > --meta 的 title > film.json 的 title > 输入文件名
  画幅、时长  ffprobe 读输入视频（播放页按真实文件排版）> --meta > film.json；都没有时退出码 3
  帧率、镜头  --meta > film.json（v1：fps / dur；v2：output.fps / output.frameCount / shots）> ffprobe
  AIGC 标识   --meta 的 aigc > film.json 的 aigc.contains（决定 D11：页面左上角写「含 AI 生成画面」）
嵌入：auto（默认）40 MB 以内把视频 base64 内嵌成单文件，更大的改为引用同目录下的视频文件；always 一律内嵌
  （超过 300 MB 报错：浏览器单个字符串放不下）；never 一律引用（播放页与视频要放在一起）。
播放：先有声自动播放，被浏览器拦下就转静音并显示「开启声音」；系统开了「减少动态效果」时不自动播放；结束后停在最后一帧。
按键：空格 / K 播放暂停 · ← → 逐帧（会暂停）· Shift + ← → 上一个 / 下一个切点 · Home / End · M 静音 · F 全屏 · I 片子信息。
进度条下方是镜头分段与切点；右下角是时间码（时:分:秒:帧）与帧号——审片意见按帧号写（npm run film -- review … --issues "72: …"）。
退出码：0 成功；1 读写失败；2 用法错误；3 缺 ffprobe 且没有别的画幅来源。出错只打印一行原因。stdout / stderr 一律 UTF-8。
ffprobe 认环境变量 FFPROBE（与 tools/env/lib/ffmpeg.mjs 同一口径）。
"""
import argparse
import base64
import html
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

EMBED_AUTO_MAX = 40e6     # auto：40 MB 以内内嵌
EMBED_HARD_MAX = 300e6    # 内嵌上限：base64 后约 400 MB，浏览器单个字符串放不下


def die(msg, code=1):
    print(f'make_html.py：{msg}', file=sys.stderr)
    sys.exit(code)


def probe(path):
    """ffprobe 读 (宽, 高, 时长秒, 帧率)；ffprobe 不在或读不出时返回 None。"""
    exe = os.environ.get('FFPROBE') or shutil.which('ffprobe')
    if not exe:
        return None
    try:
        r = subprocess.run([exe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration,r_frame_rate',
                            '-show_entries', 'format=duration', '-of', 'json', str(path)], capture_output=True, text=True, check=True, timeout=120)
        j = json.loads(r.stdout)
        s = j['streams'][0]
        num, _, den = str(s.get('r_frame_rate') or '0/1').partition('/')
        fps = float(num) / float(den or 1) if float(den or 1) else 0.0
        dur = float(s.get('duration') or j.get('format', {}).get('duration') or 0)
        return int(s['width']), int(s['height']), dur, fps
    except Exception:
        return None


def read_film(arg):
    """film.json（v1 或 v2）里播放页用得到的字段；读不了时报用法错误。"""
    p = Path(arg)
    if p.is_dir():
        p = p / 'film.json'
    try:
        f = json.loads(p.read_text(encoding='utf-8'))
    except Exception as e:
        die(f'读不了作品描述 {p}：{e}', 2)
    out = {'title': f.get('title')}
    o = f.get('output') if isinstance(f.get('output'), dict) else None
    fps = (o or {}).get('fps', f.get('fps'))
    if isinstance(fps, (int, float)) and fps > 0:
        out['fps'] = fps
        frames = (o or {}).get('frameCount')
        if frames is None and isinstance(f.get('dur'), (int, float)):
            frames = round(f['dur'] * fps)
        if isinstance(frames, int) and frames > 0:
            out['frames'] = frames
            out['duration'] = frames / fps
    size = [(o or {}).get('width'), (o or {}).get('height')] if o else (f.get('size') or [None, None])
    if all(isinstance(v, int) and v > 0 for v in size[:2]):
        out['width'], out['height'] = size[0], size[1]
    shots = f.get('shots')
    if isinstance(shots, list) and shots and all(isinstance(s, dict) and isinstance(s.get('in'), int) and isinstance(s.get('out'), int) for s in shots):
        out['shots'] = [{'id': str(s.get('id', f'S{i + 1}')), 'in': s['in'], 'out': s['out']} for i, s in enumerate(shots)]
        out['cuts'] = [s['in'] for s in out['shots'][1:]]
    aigc = f.get('aigc')
    if isinstance(aigc, dict) and aigc.get('contains') is True:
        out['aigc'] = aigc.get('note') or '含 AI 生成画面'
    return out


def strict_parser(**kw):
    """命令约定库（tools/lib/cli.py）的严格解析器：中文报错、不接受选项缩写；--help 打印本文件开头的说明（中文）。"""
    sys.path.insert(0, str(Path(__file__).resolve().parent / 'lib'))
    try:
        from cli import ArgumentParser, CliError
    except ImportError:
        return argparse.ArgumentParser(allow_abbrev=False, add_help=False, **kw), None
    finally:
        sys.path.pop(0)
    return ArgumentParser(add_globals=False, add_help=False, **kw), CliError


def utf8_stdio():
    """Windows 中文版的控制台与管道默认是 GBK：入口处统一改成 UTF-8，中文标题与提示不会因编码出错。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass


def main(argv):
    if any(x in ('-h', '--help') for x in argv):
        print(__doc__.strip())
        return 0
    ap, CliError = strict_parser(prog='python tools/make_html.py')
    ap.add_argument('src', help='输入视频（.mp4）')
    ap.add_argument('dst', help='输出 HTML')
    ap.add_argument('--title', help='标题（默认取 film.json 或清单里的 title）')
    ap.add_argument('--film', help='作品目录或 film.json：标题、帧率、镜头表、AIGC 标识')
    ap.add_argument('--meta', help='编排器写的清单 JSON（title film run kind final profile fps frames width height duration shots cuts aigc）')
    ap.add_argument('--embed', choices=['auto', 'always', 'never'], default='auto', help='是否把视频内嵌进 HTML（默认 auto：40 MB 以内内嵌）')
    if CliError is None:
        ap.error = lambda msg: die(f'用法错误：{msg}（加 --help 看用法）', 2)
    try:
        a = ap.parse_args(argv)
    except Exception as e:  # tools/lib/cli.py 的 CliError：用法错误
        if CliError is not None and isinstance(e, CliError):
            die(f'用法错误：{e.message}（{e.hint or "加 --help 看用法"}）', 2)
        raise

    src, dst = Path(a.src), Path(a.dst)
    if not src.is_file():
        die(f'输入视频不存在：{src}', 2)
    meta = {}
    if a.film:
        meta.update({k: v for k, v in read_film(a.film).items() if v is not None})
    if a.meta:
        try:
            m = json.loads(Path(a.meta).read_text(encoding='utf-8'))
        except Exception as e:
            die(f'读不了清单 {a.meta}：{e}', 2)
        if not isinstance(m, dict):
            die(f'清单 {a.meta} 顶层必须是对象', 2)
        meta.update({k: v for k, v in m.items() if v is not None})
    if a.title:
        meta['title'] = a.title

    pr = probe(src)
    if pr:
        meta['width'], meta['height'], dur, pfps = pr
        if dur > 0:
            meta['duration'] = dur
        if not meta.get('fps') and pfps > 0:
            meta['fps'] = round(pfps, 3)
    for k in ('width', 'height', 'duration'):
        if not (isinstance(meta.get(k), (int, float)) and meta[k] > 0):
            die(f'不知道视频的{ {"width": "宽", "height": "高", "duration": "时长"}[k] }：ffprobe 读不出 {src.name}，--meta / --film 里也没有（装 FFmpeg 或传 --film）', 3)
    meta['fps'] = meta.get('fps') or 24
    meta.setdefault('frames', round(meta['duration'] * meta['fps']))
    meta['title'] = str(meta.get('title') or src.stem)
    shots = [s for s in (meta.get('shots') or []) if isinstance(s, dict) and isinstance(s.get('in'), int) and isinstance(s.get('out'), int)]
    meta['shots'] = shots
    meta['cuts'] = [c for c in (meta.get('cuts') or [s['in'] for s in shots[1:]]) if isinstance(c, int)]

    size = src.stat().st_size
    embed = a.embed == 'always' or (a.embed == 'auto' and size <= EMBED_AUTO_MAX)
    if embed and size > EMBED_HARD_MAX:
        die(f'{src.name} 有 {size / 1e6:.0f} MB，内嵌成 base64 会超出浏览器单个字符串的上限：改用 --embed never（播放页引用同目录的视频）', 2)
    if embed:
        try:
            reel = base64.b64encode(src.read_bytes()).decode('ascii')
        except OSError as e:
            die(f'读不了 {src}：{e}', 1)
        video_src = ''
    else:
        reel = ''
        video_src = os.path.relpath(src.resolve(), dst.resolve().parent).replace(os.sep, '/')

    public = {k: meta.get(k) for k in ('title', 'film', 'run', 'kind', 'final', 'profile', 'fps', 'frames', 'width', 'height', 'duration', 'shots', 'cuts', 'aigc')}
    page = (HTML.replace('__TITLE__', html.escape(meta['title']))
            .replace('__W__', str(int(meta['width']))).replace('__H__', str(int(meta['height'])))
            .replace('__META__', json.dumps(public, ensure_ascii=False).replace('</', '<\\/'))
            .replace('__SRCATTR__', f' src="{html.escape(video_src, quote=True)}"' if video_src else '')
            .replace('__B64__', reel))
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(dst.name + '.partial')
        tmp.write_text(page, encoding='utf-8')
        os.replace(tmp, dst)
    except OSError as e:
        die(f'写不了 {dst}：{e}', 1)
    print(f'{dst}  {dst.stat().st_size / 1e6:.1f} MB  {"内嵌视频" if embed else "引用 " + video_src}')
    return 0


HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#0d0e1c;--fg:#EAF6FF;--dim:rgba(234,246,255,.62);--faint:rgba(234,246,255,.2);--accent:#9FE8FF;--cut:#FF9E6B}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:"PingFang SC","Noto Sans SC",system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:center;overflow:hidden}
.stage{position:relative;width:min(100vw,calc(100vh*__W__/__H__));aspect-ratio:__W__/__H__}
video{width:100%;height:100%;display:block;background:#000}
.top{position:absolute;left:16px;top:14px;right:140px;font-size:13px;line-height:1.5;color:var(--dim);transition:opacity .4s;pointer-events:none}
.top b{color:var(--fg);font-weight:500;font-size:14px}
.top .aigc{display:inline-block;margin-top:4px;padding:1px 8px;border:1px solid var(--faint);border-radius:999px;font-size:11px}
.ui{position:absolute;left:0;right:0;bottom:0;padding:22px 16px 12px;background:linear-gradient(transparent,rgba(13,14,28,.78));transition:opacity .4s}
.hide .ui,.hide .top{opacity:0}
.row{display:flex;align-items:center;gap:12px}
button{font:inherit;font-size:13px;color:var(--fg);background:rgba(234,246,255,.12);border:1px solid rgba(234,246,255,.28);
  border-radius:999px;padding:6px 14px;cursor:pointer}
button:hover{background:rgba(234,246,255,.22)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.track{flex:1;position:relative;cursor:pointer;padding:6px 0}
.bar{height:4px;border-radius:2px;background:var(--faint);position:relative}
.bar i{position:absolute;left:0;top:0;bottom:0;background:var(--accent);border-radius:2px;width:0}
.shots{position:relative;height:14px;margin-top:6px;font-size:10px;color:var(--dim)}
.shots span{position:absolute;top:0;bottom:0;border-left:1px solid var(--faint);padding-left:4px;overflow:hidden;white-space:nowrap}
.shots span.cut{border-left:2px solid var(--cut)}
.t{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.t b{color:var(--fg);font-weight:500}
#sound{position:absolute;top:14px;right:16px;display:none}
#info{position:absolute;right:16px;top:56px;max-width:min(360px,60%);max-height:70%;overflow:auto;display:none;font-size:12px;line-height:1.6;
  background:rgba(13,14,28,.88);border:1px solid var(--faint);border-radius:10px;padding:10px 14px;color:var(--dim)}
#info b{color:var(--fg);font-weight:500}
#info table{border-collapse:collapse;margin-top:6px}#info td{padding:0 10px 0 0;font-variant-numeric:tabular-nums}
</style></head><body>
<div class="stage" id="stage">
  <video id="v" playsinline preload="auto"__SRCATTR__></video>
  <div class="top" id="top"></div>
  <button id="sound">开启声音</button>
  <div id="info"></div>
  <div class="ui" id="ui"><div class="row">
    <button id="pp">暂停</button>
    <div class="track" id="track"><div class="bar"><i id="fill"></i></div><div class="shots" id="shots"></div></div>
    <span class="t" id="tm"></span>
  </div></div>
</div>
<script id="meta" type="application/json">__META__</script>
<script id="reel" type="application/octet-stream">__B64__</script>
<script>
(() => {
  const M = JSON.parse(document.getElementById('meta').textContent);
  const $ = id => document.getElementById(id);
  const v = $('v'), pp = $('pp'), snd = $('sound'), stage = $('stage'), track = $('track'), fill = $('fill'), tm = $('tm'), info = $('info');
  const fps = M.fps || 24, frames = M.frames || Math.round((M.duration || 0) * fps), cuts = M.cuts || [];
  const reel = $('reel').textContent.trim();
  if (reel) {
    const s = atob(reel), u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    v.src = URL.createObjectURL(new Blob([u8], { type: 'video/mp4' }));
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const KIND = { build: '工作版出片', animatic: '动态预演', stills: '风格关键帧', render: '帧段' };
  const kind = M.final ? '终渲' : (KIND[M.kind] || M.kind);
  $('top').innerHTML = `<b>${esc(M.title)}</b>` + (M.run ? `<br>${esc([kind, M.profile, M.run].filter(Boolean).join(' · '))}` : '') + (M.aigc ? `<br><span class="aigc">${esc(M.aigc)}</span>` : '');
  // 镜头分段与切点
  const sh = $('shots');
  for (const s of M.shots || []) {
    const el = document.createElement('span');
    el.style.left = (s.in / frames * 100) + '%'; el.style.width = ((s.out - s.in) / frames * 100) + '%';
    if (s.in > 0) el.className = 'cut';
    el.textContent = s.id; el.title = `${s.id}：帧 ${s.in}–${s.out - 1}`;
    sh.appendChild(el);
  }
  if (!(M.shots || []).length) sh.style.display = 'none';
  info.innerHTML = `<b>${esc(M.title)}</b><br>${esc(M.film || '')} ${esc(M.run || '')}<br>${M.width}×${M.height} · ${fps} fps · ${frames} 帧 · ${(frames / fps).toFixed(2)} 秒${M.profile ? ' · ' + esc(M.profile) : ''}`
    + ((M.shots || []).length ? '<table>' + M.shots.map(s => `<tr><td>${esc(s.id)}</td><td>${s.in}–${s.out - 1}</td><td>${tc(s.in)}</td></tr>`).join('') + '</table>' : '');
  function tc(f) { const s = Math.floor(f / fps), p = n => String(n).padStart(2, '0'); return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f % fps)}`; }
  const frameNow = () => Math.min(frames - 1, Math.max(0, Math.floor(v.currentTime * fps + 1e-4)));
  const seekFrame = f => { f = Math.min(frames - 1, Math.max(0, f)); v.currentTime = (f + 0.5) / fps; };
  const label = () => { pp.textContent = v.paused ? (v.ended ? '重播' : '播放') : '暂停'; };
  const draw = () => { const f = frameNow(); fill.style.width = ((v.currentTime / (v.duration || frames / fps)) * 100) + '%'; tm.innerHTML = `<b>${tc(f)}</b> / ${tc(frames)} · F${f}`; };
  const toggle = () => { if (v.paused) { if (v.ended) v.currentTime = 0; v.play(); } else v.pause(); };
  for (const e of ['play', 'pause', 'ended']) v.addEventListener(e, label);   // 结束后停在最后一帧
  v.addEventListener('timeupdate', draw); v.addEventListener('seeked', draw); v.addEventListener('loadedmetadata', draw);
  pp.onclick = toggle;
  track.onclick = e => { const r = track.getBoundingClientRect(); seekFrame(Math.floor((e.clientX - r.left) / r.width * frames)); };
  snd.onclick = () => { v.muted = false; snd.style.display = 'none'; if (v.paused) v.play(); };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) v.play().catch(() => { v.muted = true; snd.style.display = 'block'; v.play().catch(() => {}); });
  label(); draw();
  addEventListener('keydown', e => {
    const k = e.key;
    if (e.code === 'Space' || k === 'k' || k === 'K') { e.preventDefault(); toggle(); }
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault(); v.pause(); const f = frameNow(), d = k === 'ArrowRight' ? 1 : -1;
      if (e.shiftKey) { const c = d > 0 ? cuts.find(x => x > f) : [...cuts].reverse().find(x => x < f); seekFrame(c ?? (d > 0 ? frames - 1 : 0)); }
      else seekFrame(f + d);
    }
    else if (k === ',' || k === '.') { v.pause(); seekFrame(frameNow() + (k === '.' ? 1 : -1)); }
    else if (k === 'Home') { v.pause(); seekFrame(0); }
    else if (k === 'End') { v.pause(); seekFrame(frames - 1); }
    else if (k === 'm' || k === 'M') { v.muted = !v.muted; snd.style.display = v.muted ? 'block' : 'none'; }
    else if (k === 'f' || k === 'F') { document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.(); }
    else if (k === 'i' || k === 'I') { info.style.display = info.style.display === 'block' ? 'none' : 'block'; }
  });
  let idle; const wake = () => { stage.classList.remove('hide'); clearTimeout(idle); idle = setTimeout(() => { if (!v.paused) stage.classList.add('hide'); }, 2200); };
  addEventListener('mousemove', wake); addEventListener('keydown', wake); wake();
})();
</script></body></html>
"""

if __name__ == '__main__':
    utf8_stdio()
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        die('收到中断，没有写出播放页', 130)
