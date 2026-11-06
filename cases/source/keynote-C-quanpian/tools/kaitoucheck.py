"""开头不变性检查：全片 0–20 s 的画面与声音必须与 C-kaitou.mp4 一致。
画面：抽 0.5 / 5 / 10 / 15 / 19.9 s 五帧与原片做 SSIM（ffmpeg ssim 滤镜，全分辨率），要求 ≥ 0.98。
声音：两片解码后的 0–19.9 s 逐采样比对（AAC 编码确定，理论上逐位相同），报告最大差与残差能量（dB，相对原片）。
用法：python tools/kaitoucheck.py [C-quanpian.mp4] [C-kaitou.mp4]"""
import sys, os, subprocess, re
import numpy as np
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'C-quanpian.mp4')
B = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '..', 'C-kaitou', 'C-kaitou.mp4')
bad = 0
for t in (0.5, 5, 10, 15, 19.9):
    f = round(t * 30)   # 取第 f 帧（两片都是 30 fps，从 0 帧起）
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', A, '-i', B, '-filter_complex',
                        f"[0:v]select='eq(n\\,{f})',setpts=N[a];[1:v]select='eq(n\\,{f})',setpts=N[b];[a][b]ssim", '-frames:v', '1', '-f', 'null', '-'],
                       capture_output=True, text=True).stderr
    m = re.search(r'All:([\d.]+)', r); s = float(m.group(1)) if m else -1
    bad += s < .98; print(f'  帧 {t:5.1f}s（#{f}）SSIM {s:.5f} {"ok" if s >= .98 else "FAIL"}')
def pcm(p):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-t', '19.9', '-i', p, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2)
x, y = pcm(A), pcm(B); n = min(len(x), len(y)); d = x[:n] - y[:n]
res = 10 * np.log10((d ** 2).mean() / max((y[:n] ** 2).mean(), 1e-20) + 1e-30)
print(f'  声音 0–19.9 s：{n} 个采样，最大差 {np.abs(d).max():.2e}，残差 {res:.1f} dB')
ok_a = res < -60
bad += not ok_a
print('KAITOUCHECK', 'PASS' if not bad else 'FAIL')
sys.exit(1 if bad else 0)
