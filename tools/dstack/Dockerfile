# 北冥引擎 · dstack 远端 GPU 渲染基础镜像
# 预装 Node.js 22 LTS + FFmpeg + Chromium Headless Shell 图形/Vulkan 依赖 + 中文字体
# 推到公开或机队私有镜像仓后，dstack 容器冷启动 0 秒解包：
#   docker build -t ghcr.io/<your-org>/beiming-dstack:ubuntu24.04 tools/dstack
#   docker push ghcr.io/<your-org>/beiming-dstack:ubuntu24.04
#   node tools/dstack-render.mjs films/qingfengxing --image ghcr.io/<your-org>/beiming-dstack:ubuntu24.04

FROM nvidia/cuda:13.0.0-base-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=all \
    BEIMING_ANGLE=vulkan \
    NODE_OPTIONS="--max-old-space-size=16384" \
    PLAYWRIGHT_BROWSERS_PATH="/work/ms-playwright"

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      ca-certificates curl xz-utils ffmpeg fonts-noto-cjk \
      libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
      libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 \
      libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libpango-1.0-0 libcairo2 libasound2t64 libvulkan1 \
      libgl1 libegl1 libx11-xcb1 libxcb1 && \
    echo "/usr/lib" > /etc/ld.so.conf.d/nvidia-host.conf && \
    ARCH="$(uname -m)" && \
    NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "x64") && \
    curl -fsSL "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-${NODE_ARCH}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 && \
    ldconfig && \
    apt-get purge -y --auto-remove curl xz-utils && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /tmp/*

WORKDIR /work/repo
