# {{TITLE}}

北冥风格路线 · WebGL 三渲二的作品，由 `routes/a-webgl/template` 复制而来。路线手册：[routes/a-webgl/README.md](../../routes/a-webgl/README.md)。

- 改哪里：`film.json`（片名、时长、帧率、画幅）；`main.js`（色板 `C`、造型、着色参数、底板、镜头运动、后期参数 `lookAt`、片名 `drawTitle`）；`sound.py`（声音）。
- 出片：在仓库根目录跑 `sh films/{{NAME}}/build.sh`，成片在 `films/{{NAME}}/out/film.mp4`。
- 只看画面：`node engine/render/still.mjs films/{{NAME}} 0 1.5 2.9 --out films/{{NAME}}/out/stills`。
- 只出无声视频：`node engine/render/video.mjs films/{{NAME}} --out films/{{NAME}}/out/video.mp4`。
- `out/` 不提交；声音需要装了 `requirements.txt` 的 Python（`PYTHON=... sh films/{{NAME}}/build.sh`）。
