# 北冥（C 路线 · 北冥代码动画风格）

- 改节奏与打点：`timeline.js`（SECS、CUES、事件）；改画面：`film.js`；改声音：`mix.py`；时长、尺寸、海报时刻：`film.json`（与 `timeline.js` 的 DUR 保持一致）。
- 出片（在仓库根目录）：`BEIMING_PY=<带 numpy/scipy/numba/soundfile 的 python> node engine/render/build.mjs films/p15-t1` → `films/p15-t1/out/p15-t1.mp4` 与 `out/poster.jpg`。
- 只看几帧：`node engine/render/still.mjs films/p15-t1 0.5 1.5 2.75 --size 1920x1080 --out films/p15-t1/out/stills`。
- 片名的字若不在 `fonts/NotoSansSC-var.woff2` 子集里，会回落到系统无衬线；需要固定字形时按 `fonts/fetch_fonts.sh` 的做法做子集。
- 换风格：先在 `routes/c-style/STYLES.md` 找方法参考；第三方示例只读不搬，搬代码要保留许可与署名（`THIRD-PARTY.md`）。
