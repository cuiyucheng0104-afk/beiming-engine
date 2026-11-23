# -*- coding: utf-8 -*-
"""tests/audio 的共用件：engine/audio/foundry_worker.py 的替身，协议相同、不碰 torch 与 GPU，供 test_audio_foundry.py 起子进程用。

波形由请求参数决定（种子取参数的 sha256），同参数同字节。FOUNDRY_MOCK_MODE 选行为：
  ok（默认）衰减噪声；silent 全零（L3 判 reject）；loud 峰值 1.5（超满幅，测防截断）；nan 含 NaN；badsr 采样率错
  crash 收到第一条请求就退出；hang 收到请求后不回应也不理 quit；fatal_env 启动就报缺依赖
"""
import base64
import hashlib
import json
import os
import sys
import time

import numpy as np

mode = os.environ.get('FOUNDRY_MOCK_MODE', 'ok')
proto = sys.stdout


def send(obj):
    proto.write(json.dumps(obj, ensure_ascii=False) + '\n')
    proto.flush()


if mode == 'fatal_env':
    send({'event': 'fatal', 'kind': 'env', 'message': '推理环境不完整：模拟缺 torch'})
    sys.exit(3)
send({'event': 'ready', 'info': {'torch': 'mock', 'gpu': 'mock', 'pid': os.getpid(), 'modelFingerprint': 'mock'}})
for line in sys.stdin:
    req = json.loads(line)
    if req.get('op') == 'quit':
        break
    if mode == 'crash':
        sys.exit(7)
    if mode == 'hang':
        time.sleep(3600)
    p = req['params']
    seed = int.from_bytes(hashlib.sha256(json.dumps(p, sort_keys=True).encode()).digest()[:4], 'big')
    n = int(round(p['duration'] * 48000))
    t = np.arange(n) / 48000.0
    x = np.random.default_rng(seed).standard_normal(n) * np.exp(-t / 0.05)
    x *= (1.5 if mode == 'loud' else 0.5) / np.abs(x).max()
    if mode == 'silent':
        x[:] = 0.0
    if mode == 'nan':
        x[n // 2] = np.nan
    send({'ok': True, 'sr': 44100 if mode == 'badsr' else 48000, 'frames': n, 'inferS': 0.01,
          'pcm': base64.b64encode(x.astype('<f4').tobytes()).decode('ascii')})
