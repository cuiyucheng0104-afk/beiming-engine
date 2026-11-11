# -*- coding: utf-8 -*-
"""北冥引擎 · 配音 · 缓存：同样的服务、模型、音色、参数和原话只合成一次（付费服务不重复计费），离线模式只读缓存。

  key(identity, text) → sha256(稳定 JSON：服务、模型、音色、参数、原话)
  Cache(root)
    .get(k) → (audio 48 kHz 单声道, meta) 或 None
    .put(k, result, meta) → 条目目录
    .path(k)
条目：<root>/<k 前两位>/<k>/audio.wav（PCM_24，48 kHz 单声道）+ meta.json（服务、参数、原话、时长、逐字时间、去掉签名地址的原始响应）。
缓存目录默认 <作品>/out/cache/voice（附录 C4）；付费合成的长片建议用 --cache 指到仓库外的固定目录，换检出不用重付。
"""
import datetime
import hashlib
import json
import os
import shutil

import numpy as np

from ..dsp import SR


def key(identity, text):
    blob = json.dumps({'identity': identity, 'text': text}, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()


class Cache:
    def __init__(self, root):
        self.root = os.path.abspath(root)

    def path(self, k):
        return os.path.join(self.root, k[:2], k)

    def get(self, k):
        d = self.path(k)
        a, m = os.path.join(d, 'audio.wav'), os.path.join(d, 'meta.json')
        if not (os.path.exists(a) and os.path.exists(m)):
            return None
        import soundfile as sf
        try:
            with open(m, encoding='utf-8') as f:
                meta = json.load(f)
            x, sr = sf.read(a, dtype='float64')
        except (OSError, ValueError, RuntimeError):
            return None                                   # 坏条目当作没有（会重新合成；离线时报缺）
        if sr != SR or meta.get('key') != k:
            return None
        if meta.get('storedGain'):                       # 存盘时为了不削波压过的，读回来还原
            x = x / float(meta['storedGain'])
        return x, meta

    def put(self, k, audio, meta):
        import soundfile as sf
        d = self.path(k)
        tmp = d + '.tmp'
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp, exist_ok=True)
        x = np.asarray(audio, dtype=np.float64)
        pk = float(np.abs(x).max()) if len(x) else 0.0
        if pk > 0.999:                                    # 整数 PCM 存不下超满幅：等比压回（记在 meta 里）
            x = x * (0.999 / pk)
            meta = dict(meta, storedGain=round(0.999 / pk, 6))
        sf.write(os.path.join(tmp, 'audio.wav'), x, SR, subtype='PCM_24')
        meta = dict(meta, key=k, sampleRate=SR, seconds=round(len(x) / SR, 4),
                    createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'))
        with open(os.path.join(tmp, 'meta.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(meta, f, ensure_ascii=False, indent=1)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        os.replace(tmp, d)
        return d
