# 云海浮标（北冥原生 · BNE）

- 准备素材（仓库根目录；PYTHON 指向装好 numpy / scipy / soundfile / numba 的解释器）：`PYTHON=<python> node engine/native/prepare.mjs films/p14-tpl`
- 先看几帧（RAEA_BIN 是原生运行时可执行文件）：`RAEA_BIN=<raea> node engine/render/native.mjs films/p14-tpl --at 0,40,107`，PNG 在 `films/p14-tpl/out/<run-id>/stills/f<帧号>.png`。
- 出片：`RAEA_BIN=<raea> node engine/render/native.mjs films/p14-tpl` → `films/p14-tpl/out/<run-id>/` 里的 `master.mp4`（原生母版）、`web.mp4`（交付网页版）、`run.json`、`check.json`、`contact.jpg`；`out/latest` 写着最近一次的 run-id。
- 改画面：`film.tsx`（编排）与 `layout.js`（机位、主体、片名框、云海面片）；改颜色 `palette.json`；改道具 `prop.js`；改声音 `sound.py`；片长、尺寸、素材清单、片名落定的帧号（`events`）在 `film.json`。改了 `layout.js` 就跑一遍投影核对（片名不压主体、云海两端在画外）：`node --test tests/native/layout.test.mjs`
- 加一段别的作品当贴图：在 `film.json` 的 `sequences` 里写 `{ "to": "screen.png", "page": "../..", "from": 0, "until": 2, "fps": 12, "size": [960, 520], "cell": [480, 260] }`，在 `film.tsx` 里用 `<SequencePlane>`，见 `routes/b-native/README.md`。
