# -*- coding: utf-8 -*-
"""北冥引擎 · L2 声源铸造厂的推理子进程（MOSS-SoundEffect-v2.0）：只在隔离 venv 里跑，主仓 .venv 不装 torch。

自包含：只依赖标准库、numpy、torch 与上游 moss_soundeffect_v2 包，不 import 仓库里的任何模块，
所以既能本机 `python -I foundry_worker.py ...` 起，也能被主控整个文本送到远端 `python -I -c` 执行（--ssh）。

协议（stdin / stdout 各一行一个 JSON，UTF-8）：
  启动后先发   {"event": "ready", "info": {...}}   或   {"event": "fatal", "kind": "env"|"failure", "message": "..."} 后退出
  收   {"op": "gen", "params": {prompt, negative_prompt, duration, steps, cfg, sigma_shift, seed}}
  回   {"ok": true, "sr": 48000, "frames": N, "inferS": 秒, "pcm": base64(float32 小端单声道)}   或   {"ok": false, "error": "..."}
  收   {"op": "quit"} 或 stdin 关闭（主控退出、ssh 断开）→ 卸载模型并退出

进程内卸载后 CUDA 上下文仍残留约 1 GiB（0C 实测），只有进程退出才全部归还，所以主控用「退出」当卸载。
真正的 stdout 在启动时复制成协议通道，fd 1 改指向 stderr：库里的 print 与进度条不会污染协议。
"""
import argparse
import base64
import gc
import hashlib
import json
import os
import sys
import time

SR = 48000


def _fingerprint(model_dir):
    """权重目录的指纹：全部文件的（相对路径，大小）加 config*.json 的内容摘要；不读 11 GB 权重本体，也不含绝对路径。"""
    h = hashlib.sha256()
    for root, _, files in sorted(os.walk(model_dir)):
        for f in sorted(files):
            p = os.path.join(root, f)
            h.update(f'{os.path.relpath(p, model_dir).replace(os.sep, "/")}\0{os.path.getsize(p)}\n'.encode('utf-8'))
            if f.startswith('config') and f.endswith('.json'):
                with open(p, 'rb') as fh:
                    h.update(hashlib.sha256(fh.read()).digest())
    return h.hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--model-dir', required=True)
    ap.add_argument('--pkg-dir', default=None, help='上游 MOSS-TTS 仓库克隆目录（含 moss_soundeffect_v2 包）')
    ap.add_argument('--gpu', default=None, help='可见的 GPU 序号（写进 CUDA_VISIBLE_DEVICES，要在 import torch 之前）')
    args = ap.parse_args(argv)

    proto = os.fdopen(os.dup(sys.stdout.fileno()), 'wb')
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

    def send(obj):
        proto.write((json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8'))
        proto.flush()

    try:
        if args.gpu is not None:
            os.environ['CUDA_VISIBLE_DEVICES'] = str(args.gpu)
        os.environ.setdefault('HF_HUB_OFFLINE', '1')           # 权重在本地目录，不联网
        os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
        if args.pkg_dir:
            sys.path.insert(0, args.pkg_dir)
        import numpy as np
        import torch
        from moss_soundeffect_v2 import MossSoundEffectPipeline
        if not torch.cuda.is_available():
            raise ImportError('torch 看不到 CUDA 设备')
        t0 = time.time()
        pipe = MossSoundEffectPipeline.from_pretrained(args.model_dir, torch_dtype=torch.bfloat16, device='cuda')
        torch.cuda.synchronize()
        if int(pipe.sample_rate) != SR:
            raise RuntimeError(f'模型输出采样率 {pipe.sample_rate}，期望 {SR}')
        info = {'torch': torch.__version__, 'cuda': torch.version.cuda, 'gpu': torch.cuda.get_device_name(0),
                'modelFingerprint': _fingerprint(args.model_dir), 'sampleRate': SR, 'loadS': round(time.time() - t0, 2)}
    except ImportError as e:
        send({'event': 'fatal', 'kind': 'env', 'message': f'推理环境不完整：{e}'})
        return 3
    except Exception as e:  # noqa: BLE001 - 加载失败原样回报给主控
        send({'event': 'fatal', 'kind': 'failure', 'message': f'模型加载失败：{type(e).__name__}: {e}'})
        return 1
    send({'event': 'ready', 'info': info})

    for line in sys.stdin.buffer:                              # stdin 关闭（EOF）就退出
        try:
            req = json.loads(line)
            if req.get('op') == 'quit':
                break
            p = req['params']
            t = time.time()
            audio = pipe(prompt=p['prompt'], seconds=p['duration'], num_inference_steps=p['steps'], cfg_scale=p['cfg'],
                         sigma_shift=p['sigma_shift'], seed=p['seed'], negative_prompt=p['negative_prompt'],
                         progress_bar_cmd=lambda x, **k: x)
            torch.cuda.synchronize()
            x = audio[0].detach().float().cpu().numpy().T      # (T, C)
            if x.ndim != 2 or x.shape[1] != 1:
                raise RuntimeError(f'输出形状 {x.shape}，期望单声道 (T, 1)')
            pcm = np.ascontiguousarray(x[:, 0], dtype='<f4')
            send({'ok': True, 'sr': SR, 'frames': int(len(pcm)), 'inferS': round(time.time() - t, 3),
                  'pcm': base64.b64encode(pcm.tobytes()).decode('ascii')})
        except Exception as e:  # noqa: BLE001 - 单条失败不拖垮进程，错误回报主控
            send({'ok': False, 'error': f'{type(e).__name__}: {e}'})
    del pipe
    gc.collect()
    torch.cuda.empty_cache()
    return 0


if __name__ == '__main__':
    sys.exit(main())
