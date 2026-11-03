# 生成单文件 HTML：MP4 以 base64 内嵌，页面载入时解码成 Blob 播放。
# 播放器：先有声自动播放，被浏览器拦下就转静音播放并显示「开启声音」；空格 / K 暂停，M 静音，F 全屏；
# 结束后停在最后一帧（片名）；系统开了「减少动态效果」时不自动播放。颗粒已烤进画面（显示层之下），这里不再叠。
# 用法：python tools/make_html.py <输入.mp4> <输出.html>
import base64, sys, pathlib

src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
b64 = base64.b64encode(src.read_bytes()).decode('ascii')

HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>北冥 · 概念样片</title>
<style>
:root{--bg:#0d0e1c;--fg:#EAF6FF;--dim:rgba(234,246,255,.62);--accent:#9FE8FF}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:"PingFang SC","Noto Sans SC",system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:center;overflow:hidden}
.stage{position:relative;width:min(100vw,calc(100vh*1920/1040));aspect-ratio:1920/1040}
video{width:100%;height:100%;display:block;background:#000}
.ui{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:12px;padding:14px 16px;
  background:linear-gradient(transparent,rgba(13,14,28,.72));transition:opacity .4s}
.ui.hide{opacity:0}
button{font:inherit;font-size:13px;color:var(--fg);background:rgba(234,246,255,.12);border:1px solid rgba(234,246,255,.28);
  border-radius:999px;padding:6px 14px;cursor:pointer}
button:hover{background:rgba(234,246,255,.22)}
.bar{flex:1;height:4px;border-radius:2px;background:rgba(234,246,255,.2);cursor:pointer;position:relative}
.bar i{position:absolute;left:0;top:0;bottom:0;background:var(--accent);border-radius:2px;width:0}
.t{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums;min-width:74px;text-align:right}
#sound{position:absolute;top:16px;right:16px;display:none}
</style></head><body>
<div class="stage" id="stage">
  <video id="v" playsinline preload="auto"></video>
  <button id="sound">开启声音</button>
  <div class="ui" id="ui"><button id="pp">暂停</button><div class="bar" id="bar"><i id="fill"></i></div><span class="t" id="tm">0.0 / 10.0</span></div>
</div>
<script id="reel" type="application/octet-stream">__B64__</script>
<script>
(() => {
  const v = document.getElementById('v'), pp = document.getElementById('pp'), snd = document.getElementById('sound');
  const ui = document.getElementById('ui'), bar = document.getElementById('bar'), fill = document.getElementById('fill'), tm = document.getElementById('tm');
  const s = atob(document.getElementById('reel').textContent.trim()), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  v.src = URL.createObjectURL(new Blob([u8], { type: 'video/mp4' }));
  const label = () => { pp.textContent = v.paused ? (v.ended ? '重播' : '播放') : '暂停'; };
  const toggle = () => { if (v.paused) { if (v.ended) v.currentTime = 0; v.play(); } else v.pause(); };
  v.addEventListener('play', label); v.addEventListener('pause', label); v.addEventListener('ended', label);   // 结束后停在最后一帧（片名）
  v.addEventListener('timeupdate', () => { const d = v.duration || 10; fill.style.width = (v.currentTime / d * 100) + '%'; tm.textContent = v.currentTime.toFixed(1) + ' / ' + d.toFixed(1); });
  pp.onclick = toggle;
  bar.onclick = e => { const r = bar.getBoundingClientRect(); v.currentTime = (e.clientX - r.left) / r.width * (v.duration || 10); };
  snd.onclick = () => { v.muted = false; snd.style.display = 'none'; if (v.paused) v.play(); };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) v.play().catch(() => { v.muted = true; snd.style.display = 'block'; v.play().catch(() => {}); });
  label();
  addEventListener('keydown', e => {
    if (e.code === 'Space' || e.key === 'k' || e.key === 'K') { e.preventDefault(); toggle(); }
    else if (e.key === 'm' || e.key === 'M') { v.muted = !v.muted; snd.style.display = v.muted ? 'block' : 'none'; }
    else if (e.key === 'f' || e.key === 'F') { document.fullscreenElement ? document.exitFullscreen() : document.getElementById('stage').requestFullscreen?.(); }
  });
  let idle; const wake = () => { ui.classList.remove('hide'); clearTimeout(idle); idle = setTimeout(() => { if (!v.paused) ui.classList.add('hide'); }, 2200); };
  addEventListener('mousemove', wake); wake();
})();
</script></body></html>
"""
dst.write_text(HTML.replace('__B64__', b64), encoding='utf-8')
print(dst, f'{dst.stat().st_size / 1e6:.1f} MB')
