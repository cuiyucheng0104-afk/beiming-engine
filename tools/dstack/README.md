# 北冥引擎 · dstack 远端 GPU 渲染镜像与启动加速

本目录存放 `tools/dstack-render.mjs` 配套的基础镜像定义，用于彻底消除裸 `nvidia/cuda` 镜像每次启动容器现场安装 `ffmpeg` 与 Chromium Headless Shell 图形依赖的开销。

默认连接与挂载参数保存在仓库外的 `~/.config/beiming/dstack.json`（不提交主机名与本机路径）：

```json
{
  "host": "<gpu-node-ssh-alias>",
  "server": "<dstack-control-ssh-alias>",
  "gpu": "RTX5090:1",
  "workRoot": "/var/tmp/beiming-dstack"
}
```

## 路线一：推送预装基础镜像（推荐机队长期使用，容器冷启 0 秒）

`dstack-server` 提交任务时会向镜像仓库校验 manifest，因此镜像需推送到公开仓库（如 GHCR `public`、Docker Hub）或机队内部私有镜像仓：

```bash
docker build -t ghcr.io/<org>/beiming-dstack:ubuntu24.04 tools/dstack
docker push ghcr.io/<org>/beiming-dstack:ubuntu24.04
```

随后通过 `--image`（或写入 `dstack.json` 的 `"image"` 字段）指定该镜像即可直接渲染：

```bash
node tools/dstack-render.mjs films/beiming-10s \
  --image ghcr.io/<org>/beiming-dstack:ubuntu24.04 \
  --crf 20 --out out/preview.mp4
```

## 路线二：免镜像仓宿主预烘焙层 `runtime-layer.tar`（开箱即用，解包仅 ~0.36 秒）

在尚未部署私有镜像仓、仍使用公共 `nvidia/cuda:13.0.0-base-ubuntu24.04` 裸镜像时，可在目标算力机挂载目录下的 `cache/runtime-layer.tar` 放置未压缩的 `usr + etc` 增量层缓存。

每次 `dstack` 启动新容器时，`tools/dstack-render.mjs` 会直接从宿主 NVMe 顺序流式解包（`tar -xf /work/cache/runtime-layer.tar -C /`），耗时仅 **~0.3–0.4 秒**，无需访问外网 `apt` 源，也无需逐包执行 `dpkg -i`。
