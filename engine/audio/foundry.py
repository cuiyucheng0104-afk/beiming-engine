# -*- coding: utf-8 -*-
"""北冥引擎 · L2 声源铸造厂：按需拉起 MOSS-SoundEffect-v2.0 推理子进程，生成 48 kHz / 24 bit 单声道干声，落盘缓存，过 L3 物理取证。

主控（本文件）只用标准库、numpy、soundfile 与 sfx_judge，绝不 import torch；真推理在独立子进程 foundry_worker.py 里，
由 --python（BEIMING_AUDIO_L2_PYTHON）指向的隔离 venv 运行，主仓 .venv 不沾 torch。0C 实测（rog-5090）：峰值显存 15,722 MiB，
进程内卸载后仍残留约 1 GiB，只有子进程退出才全部归还；跨会话同参数不逐字节相同（SNR 37 ~ 59 dB）。由此定下四条设计：

  1. 显存守门：拉起前查 nvidia-smi 的空闲显存，低于 --min-free-gib（默认 18）退出 5，查不到（没有 nvidia-smi、ssh 失败、输出看不懂）
     退出 3；只有显式 --skip-vram-check 才跳过。fail-closed，宁可拒绝也不强拉去挤掉 ComfyUI 或桌面。
  2. 用「退出」卸载：gen 批处理跑完本批就结束子进程；serve 常驻调度器空闲超过 --idle-timeout（默认 300 秒）结束并 wait() 回收，显存与 PID 零残留。
  3. 缓存以规范化请求为键、保存生成产物：<缓存>/<键>.wav + <键>.json。键 = sha256(规范化的 model_id、revision、prompt、negative_prompt、
     duration、steps、cfg、sigma_shift、seed 与输出格式)。重跑不会得到同字节，所以命中就直接用落盘的那一份，不再拉起推理。
     写盘：进程唯一的临时文件 + os.replace，json 最后落地；读时核对 json、WAV 格式与 sha256、有限值，坏了按未命中重生成。
  4. L3 取证：每条新产物过 sfx_judge.judge_wave，verdict（pass / suspect / reject）与关键指标写进旁路 json。默认只标注、照常落盘；
     --strict 只收 pass，其余这条算不通过，整批退出 4（产物仍留在缓存里供查，要重抽换 --seed）。

输出波形不压缩、不归一化；只有原始峰值超过 0.999 满幅时才做一次线性衰减防止 24 bit 截断，衰减量记在 json 的 wav.peakTrimDb。

远端（--ssh）：推理子进程经 `ssh -o BatchMode=yes -- <主机> <命令>` 启动，worker 源码经 `python -I -c` 送过去，WAV 经协议回传，远端不需要装本仓库。
主机名只允许字母数字与 `._@-`、不以 `-` 开头，命令一律列表形式的 subprocess.run / Popen（不经 shell）；
此时 --python / --model-dir / --pkg-dir 都是远端路径，nvidia-smi 也在远端查。

  request_key(params, model_id, revision) → (键, 规范化请求)       params 先过 normalize
  Cache(root).load(key, request) / .store(...)                     读时校验，坏文件 → None
  Foundry(...).run_batch(jobs) → [结果]                            批处理：结束时必然 release()
  Foundry(...).serve(输入行, 输出流)                               常驻：stdin 每行一个 JSON 请求，空闲自动卸载

用法：python -m engine.audio.foundry gen|serve|probe …（npm run audio:foundry）；退出码见 --help 与 docs/CLI.md。
"""
import base64
import datetime
import hashlib
import json
import math
import os
import queue
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import uuid

import numpy as np

from ._cli import EXIT, ROOT, ArgumentParser, CliError, rel, run as run_cli, sha256_file
from ._env import kill_tree

SCHEMA = 'beiming.audio-foundry/1'
MODEL_ID = 'OpenMOSS-Team/MOSS-SoundEffect-v2.0'
MODEL_LICENSE = 'Apache-2.0'
SR = 48000
FORMAT = {'sampleRate': SR, 'subtype': 'PCM_24', 'channels': 1}
UNPINNED = 'unpinned'
PEAK_CEIL = 0.999                                   # 原始峰值超过它才线性衰减，防 24 bit 截断
DEFAULT_MIN_FREE_GIB = 18.0                         # 0C 峰值 15.4 GiB 加余量
DEFAULT_IDLE_S = 300.0
DEFAULT_TIMEOUT_S = 600.0                           # 冷启动首调用含编译约 82 s；每个请求与握手各自的上限
MAX_SECONDS = 30.0                                  # 模型的最长输出
DEFAULT_CACHE = os.path.join(ROOT, '.cache', 'audio-foundry')
HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, 'foundry_worker.py')
HOST_RE = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.@-]*')
NAME_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}')
FIELDS = ('prompt', 'negative_prompt', 'duration', 'steps', 'cfg', 'sigma_shift', 'seed')
DEFAULTS = {'negative_prompt': '', 'duration': 2.0, 'steps': 100, 'cfg': 4.0, 'sigma_shift': 5.0, 'seed': 0}


# ───── 请求规范化与键 ─────

def _number(name, v, lo, hi, integer=False, lo_open=False):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise CliError('usage.bad-value', f'{name} 要是有限的数字，收到 {v!r}')
    if integer:
        if v != int(v):
            raise CliError('usage.bad-value', f'{name} 要是整数，收到 {v!r}')
        v = int(v)
    else:
        v = round(float(v), 6)                      # 6 位小数：键不被浮点尾数的噪声左右
    if (v <= lo if lo_open else v < lo) or v > hi:
        raise CliError('usage.bad-value', f'{name} 要在 {"(" if lo_open else "["}{lo}, {hi}] 内，收到 {v!r}')
    return v


def normalize(job):
    """一条请求 → 规范化的参数字典（缺省值补齐、字符串 NFC 去首尾空白、数字定型）。同一语义的请求必得同一个字典。"""
    unknown = sorted(set(job) - set(FIELDS) - {'name'})
    if unknown:
        raise CliError('usage.unknown-field', f'请求里有不认识的字段：{", ".join(unknown)}', hint=f'允许的字段：{", ".join(FIELDS)}、name')
    j = {**DEFAULTS, **{k: v for k, v in job.items() if k in FIELDS and v is not None}}
    for k in ('prompt', 'negative_prompt'):
        if not isinstance(j.get(k), str):
            raise CliError('usage.bad-value', f'{k} 要是字符串')
        j[k] = unicodedata.normalize('NFC', j[k]).strip()
    if not j['prompt']:
        raise CliError('usage.missing-argument', '缺少 prompt（描述要生成的声音）', hint='--prompt "<描述>"，或 --jobs 文件里每条写 prompt')
    return {'prompt': j['prompt'], 'negative_prompt': j['negative_prompt'],
            'duration': _number('duration', j['duration'], 0.0, MAX_SECONDS, lo_open=True),
            'steps': _number('steps', j['steps'], 1, 500, integer=True),
            'cfg': _number('cfg', j['cfg'], 0.0, 100.0),
            'sigma_shift': _number('sigma_shift', j['sigma_shift'], 0.0, 100.0, lo_open=True),
            'seed': _number('seed', j['seed'], 0, 2 ** 63 - 1, integer=True)}


def request_key(params, model_id=MODEL_ID, revision=UNPINNED):
    """规范化参数 → (sha256 十六进制键, 规范化请求)。键不含 verdict 策略、输出名等不影响生成的东西。"""
    request = {'schema': SCHEMA, 'model': {'id': model_id, 'revision': revision}, 'format': FORMAT, 'params': params}
    blob = json.dumps(request, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(blob).hexdigest(), request


def check_host(host):
    """--ssh 的主机名：不以 - 开头（否则被 ssh 当选项）、不含空白与 shell 元字符。"""
    if not isinstance(host, str) or not HOST_RE.fullmatch(host):
        raise CliError('usage.bad-value', f'--ssh 主机名不合法：{host!r}',
                       hint='应为 ssh 别名或 user@host，只含字母数字与 . _ @ -，且不以 - 开头')
    return host


# ───── 缓存 ─────

def _replace(src, dst, tries=100):
    # Windows NTFS：别的线程正替换或打开同一目标的瞬间，os.replace 抛瞬态 PermissionError
    for attempt in range(tries):
        try:
            return os.replace(src, dst)
        except PermissionError:
            if attempt == tries - 1:
                raise
            time.sleep(min(0.002 * (attempt + 1), 0.02))


def _clean(o):
    """numpy 标量 → Python 标量，非有限数 → None，保证 json 严格合法。"""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.generic):
        o = o.item()
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


class Cache:
    def __init__(self, root):
        self.root = root

    def paths(self, key):
        return os.path.join(self.root, key + '.wav'), os.path.join(self.root, key + '.json')

    def load(self, key, request):
        """命中返回旁路 json（dict），否则 None：缺文件、json 坏、键或请求对不上、sha256 不符、WAV 格式不对、含非有限值，一律算未命中。"""
        wav, js = self.paths(key)
        try:
            with open(js, encoding='utf-8') as f:
                meta = json.load(f)
            w = meta['wav']
            if meta['schema'] != SCHEMA or meta['key'] != key or meta['request'] != request or sha256_file(wav) != w['sha256']:
                return None
            import soundfile as sf
            info = sf.info(wav)
            if (info.samplerate, info.channels, info.subtype, info.frames) != (SR, 1, 'PCM_24', w['frames']) or info.frames < 1:
                return None
            x, _ = sf.read(wav, dtype='float64')
            return meta if np.isfinite(x).all() else None
        except Exception:  # noqa: BLE001 - 0 字节、截断、字段缺失或类型不对：一律按未命中重生成
            return None

    def store(self, key, request, x, meta):
        """x：已定型的 float64 单声道波形。先写进程唯一的临时文件再 os.replace，json 最后落地（它是「这一条完整」的标志）。"""
        import soundfile as sf
        os.makedirs(self.root, exist_ok=True)
        wav, js = self.paths(key)
        tmp = os.path.join(self.root, f'{key}.{uuid.uuid4().hex}.tmp')
        try:
            sf.write(tmp + '.wav', x, SR, subtype='PCM_24', format='WAV')
            meta['wav'].update(sha256=sha256_file(tmp + '.wav'), **FORMAT, frames=int(len(x)))
            _replace(tmp + '.wav', wav)
            with open(tmp + '.json', 'w', encoding='utf-8', newline='\n') as f:
                json.dump(_clean(meta), f, ensure_ascii=False, indent=1, sort_keys=True, allow_nan=False)
                f.write('\n')
            _replace(tmp + '.json', js)
            # shortcut: 同键并发写出不同字节时，wav 与 json 的 sha256 可能错配，下次读按未命中重生成（自愈，不会读到错的）；要彻底避免时加按键的文件锁
        finally:
            for ext in ('.wav', '.json'):
                try:
                    os.remove(tmp + ext)
                except OSError:
                    pass
        return meta


# ───── 显存守门 ─────

def query_free_mib(gpu=0, ssh=None, timeout=20.0):
    """nvidia-smi 查指定 GPU 的空闲显存（MiB）。任何一步查不到都抛 env.gpu-unverified（fail-closed）。"""
    cmd = ['nvidia-smi', f'--id={int(gpu)}', '--query-gpu=memory.free', '--format=csv,noheader,nounits']
    if ssh is not None:                              # 空串也要过 check_host 被拒，不能悄悄当成本机
        cmd = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', check_host(ssh), shlex.join(cmd)]
    hint = '确认 nvidia-smi（--ssh 时含免密登录）可用；明知无冲突时才加 --skip-vram-check'
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        raise CliError('env.gpu-unverified', f'查不到空闲显存（{type(e).__name__}），拒绝拉起推理', hint=hint) from e
    m = re.fullmatch(r'\s*(\d+)\s*', r.stdout or '')
    if r.returncode != 0 or not m:
        raise CliError('env.gpu-unverified', f'nvidia-smi 没给出可读的空闲显存（退出码 {r.returncode}），拒绝拉起推理', hint=hint)
    return int(m.group(1))


# ───── 推理子进程 ─────

class Worker:
    """一个推理子进程：stdin / stdout 行协议，后台线程把 stdout 的行泵进队列，这样每次等待都能带超时。"""

    def __init__(self, argv, env=None, grace=15.0):
        self.grace = grace
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)   # stderr 直通：模型日志不进协议
        self.q = queue.Queue()
        self.pump = threading.Thread(target=self._pump, daemon=True)
        self.pump.start()

    def _pump(self):
        try:
            for line in iter(self.proc.stdout.readline, b''):
                self.q.put(line)
        except (OSError, ValueError):
            pass
        self.q.put(None)

    def alive(self):
        return self.proc.poll() is None

    def send(self, obj):
        try:
            self.proc.stdin.write((json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8'))
            self.proc.stdin.flush()
        except OSError as e:
            raise CliError('failure.worker-died', f'推理子进程已经退出（退出码 {self.proc.poll()}）', hint='看上面它打印到 stderr 的原因') from e

    def recv(self, timeout):
        try:
            line = self.q.get(timeout=timeout)
        except queue.Empty:
            self.close()
            raise CliError('timeout.worker', f'推理子进程 {timeout:.0f} 秒没有回应，已结束', hint='调大 --timeout；首次调用含编译，约 80 秒') from None
        if line is None:
            self.proc.wait()
            raise CliError('failure.worker-died', f'推理子进程中途退出（退出码 {self.proc.returncode}）', hint='看上面它打印到 stderr 的原因')
        try:
            msg = json.loads(line)
        except ValueError as e:
            self.close()
            raise CliError('failure.worker-protocol', f'推理子进程输出了看不懂的行：{line[:80]!r}') from e
        return msg

    def close(self):
        """让子进程自己卸载退出；宽限期内没退就整棵进程树结束。返回时它一定已被 wait() 回收。"""
        p = self.proc
        try:
            if p.poll() is None:
                try:
                    p.stdin.write(b'{"op":"quit"}\n')
                    p.stdin.flush()
                except (OSError, ValueError):
                    pass
            try:
                p.stdin.close()
            except (OSError, ValueError):
                pass
            try:
                p.wait(timeout=self.grace)
            except subprocess.TimeoutExpired:
                kill_tree(p)
        finally:
            p.wait()
            try:
                p.stdout.close()
            except (OSError, ValueError):
                pass


# ───── 铸造厂 ─────

class Foundry:
    def __init__(self, *, cache=DEFAULT_CACHE, model_dir=None, python=None, pkg_dir=None, ssh=None, gpu=0,
                 model_id=MODEL_ID, revision=UNPINNED, min_free_gib=DEFAULT_MIN_FREE_GIB, skip_vram_check=False,
                 idle_timeout=DEFAULT_IDLE_S, timeout=DEFAULT_TIMEOUT_S, archetype='auto', strict=False,
                 worker_script=WORKER, vram_probe=None, grace=15.0, log=None):
        self.cache = cache if isinstance(cache, Cache) else Cache(cache)
        self.model_dir, self.python, self.pkg_dir, self.gpu = model_dir, python, pkg_dir, int(gpu)
        self.ssh = check_host(ssh) if ssh is not None else None
        self.model_id, self.revision = model_id, revision
        self.min_free_mib, self.skip_vram_check = float(min_free_gib) * 1024, skip_vram_check
        self.idle_timeout, self.timeout, self.grace = float(idle_timeout), float(timeout), grace
        self.archetype, self.strict = archetype, strict
        self.worker_script, self.vram_probe = worker_script, vram_probe or query_free_mib
        self.log = log or (lambda msg: None)
        self._worker = None
        self._last_used = 0.0
        self.spawns = 0                              # 拉起过几次推理子进程（缓存命中应为 0）
        self.worker_info = None

    # —— 子进程生命周期 ——

    def _check_config(self):
        if not self.python or not self.model_dir:
            raise CliError('env.worker-config', '缺新生成所需的推理环境：没有给 --python 或 --model-dir',
                           hint='设 BEIMING_AUDIO_L2_PYTHON（隔离 venv 的解释器）与 BEIMING_AUDIO_L2_MODEL_DIR（权重目录），或传 --python / --model-dir')
        if not self.ssh:                             # 远端路径在本机查不了，留给远端的 worker 报错
            if not os.path.isfile(self.python):
                raise CliError('env.worker-config', f'--python 指向的解释器不存在：{rel(self.python)}')
            if not os.path.isdir(self.model_dir):
                raise CliError('env.worker-config', f'--model-dir 指向的目录不存在：{rel(self.model_dir)}')

    def guard(self):
        """拉起前的显存守门。返回查到的空闲 MiB（跳过检查时为 None）。"""
        if self.skip_vram_check:
            return None
        free = self.vram_probe(self.gpu, self.ssh)
        if free < self.min_free_mib:
            raise CliError('busy.gpu-memory', f'空闲显存 {free / 1024:.1f} GiB，低于 {self.min_free_mib / 1024:.1f} GiB，拒绝拉起推理（会挤掉别的进程）',
                           hint='等 ComfyUI 等占用方释放，或调低 --min-free-gib（0C 实测峰值 15.4 GiB）；明知无冲突才加 --skip-vram-check')
        self.log(f'显存守门通过：空闲 {free / 1024:.1f} GiB ≥ {self.min_free_mib / 1024:.1f} GiB')
        return free

    def _argv(self):
        args = ['--model-dir', self.model_dir, '--gpu', str(self.gpu)] + (['--pkg-dir', self.pkg_dir] if self.pkg_dir else [])
        if not self.ssh:
            return [self.python, '-I', self.worker_script] + args
        if not shutil.which('ssh'):
            raise CliError('env.ssh', 'PATH 里找不到 ssh 客户端', hint='安装 OpenSSH 客户端，或去掉 --ssh 在本机跑')
        with open(self.worker_script, 'rb') as f:
            boot = f"import base64;exec(compile(base64.b64decode('{base64.b64encode(f.read()).decode('ascii')}'),'foundry_worker.py','exec'))"
        return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', self.ssh, shlex.join([self.python, '-I', '-c', boot] + args)]

    def _ensure(self):
        if self._worker is not None and self._worker.alive():
            return self._worker
        self._worker = None
        self._check_config()
        self.guard()
        w = Worker(self._argv(), grace=self.grace)
        self.spawns += 1
        try:
            msg = w.recv(self.timeout)
            if msg.get('event') != 'ready':
                w.close()
                kind = 'env' if msg.get('kind') == 'env' else 'failure'
                raise CliError(f'{kind}.worker-start', str(msg.get('message') or msg), hint='用 --python 指向装好 torch 与上游 moss_soundeffect_v2 的隔离 venv；--pkg-dir 指向上游克隆')
        except BaseException:
            w.close()
            raise
        self._worker, self.worker_info = w, msg['info']
        self._last_used = time.monotonic()
        self.log(f'推理子进程就绪（第 {self.spawns} 次拉起）')
        return w

    def release(self):
        """结束推理子进程并 wait() 回收（显存与 PID 一并归还）。没有子进程时什么都不做。"""
        w, self._worker = self._worker, None
        if w is not None:
            w.close()
            self.log('推理子进程已退出')

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.release()

    # —— 生成 ——

    def _generate(self, key, request, params):
        from . import sfx_judge
        w = self._ensure()
        t0 = time.monotonic()
        try:
            w.send({'op': 'gen', 'params': params})
            r = w.recv(self.timeout)
        except BaseException:
            self.release()                           # 超时、协议错、被打断：状态不明，不留着
            raise
        self._last_used = time.monotonic()
        if not r.get('ok'):
            self.release()
            raise CliError('failure.worker-job', f'推理失败：{r.get("error")}', hint='显存不足或参数不被模型接受；看上面子进程打印的日志')
        try:
            x = np.frombuffer(base64.b64decode(r['pcm']), dtype='<f4').astype(np.float64)
            bad = r.get('sr') != SR or len(x) != r.get('frames') or len(x) == 0
        except (KeyError, ValueError, TypeError):
            bad = True
        if bad:
            raise CliError('contract.worker-output', f'子进程交回的音频不合格（采样率、长度或编码不对）：sr={r.get("sr")}')
        if not np.isfinite(x).all():
            raise CliError('contract.worker-output', '子进程交回的音频含 NaN / Inf，不保存也不交付', hint='换 --seed 重抽；反复出现请带日志报告')
        peak = float(np.abs(x).max())
        trim_db = 0.0
        if peak > PEAK_CEIL:                         # 只做一次线性衰减防截断，不压缩、不归一化
            x *= PEAK_CEIL / peak
            trim_db = 20 * math.log10(PEAK_CEIL / peak)
        j = sfx_judge.judge_wave(x, SR, archetype=params['prompt'] if self.archetype == 'auto' else self.archetype)
        meta = {'schema': SCHEMA, 'key': key, 'request': request, 'aigc': True,
                'model': {'id': self.model_id, 'revision': self.revision, 'license': MODEL_LICENSE, 'worker': self.worker_info},
                'license': {'model': MODEL_LICENSE, 'note': 'AI 生成内容：入作品要按 docs/rights/aigc.md 标识并登记来源'},
                'generation': {'inferS': r.get('inferS'), 'wallS': round(time.monotonic() - t0, 3), 'host': 'ssh' if self.ssh else 'local',
                               'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},
                'verdict': j['status'],
                'judge': {'status': j['status'], 'score': j['score'], 'archetype': j['archetype'], 'reasons': j['reasons'],
                          'physicsHardFail': j['physics_hard_fail'], 'flippable': j['flippable'],
                          'bandwidth95Hz': j['metrics'].get('bandwidth_95_hz'), 'metrics': j['metrics'], 'forensics': j['forensics']},
                'wav': {'peakTrimDb': round(trim_db, 3)}}
        return self.cache.store(key, request, x, meta)

    def run_job(self, job):
        """一条请求 → 结果字典。命中缓存不拉起子进程。--strict 下 verdict 不是 pass 的结果 accepted 为 False（产物仍在缓存里）。"""
        params = normalize(job)
        key, request = request_key(params, self.model_id, self.revision)
        meta = self.cache.load(key, request)
        status = 'hit'
        if meta is None:
            status = 'generated'
            meta = self._generate(key, request, params)
        accepted = meta['verdict'] == 'pass' or not self.strict
        res = {'name': job.get('name') or key[:12], 'key': key, 'status': status, 'verdict': meta['verdict'], 'accepted': accepted,
               'path': rel(self.cache.paths(key)[0]), 'sha256': meta['wav']['sha256'], 'bandwidth95Hz': meta['judge'].get('bandwidth95Hz'),
               'inferS': meta['generation'].get('inferS')}
        if not accepted:
            res['error'] = {'code': 'contract.l3-verdict', 'message': f'L3 取证 {meta["verdict"]}：{"；".join(meta["judge"]["reasons"]) or "未达 pass"}',
                            'hint': '--strict 只收 pass；换 --seed 重抽，或去掉 --strict 只标注'}
        return res

    def run_batch(self, jobs):
        """批处理：逐条跑，契约类失败（NaN、L3 严格拒收）记在这一条上继续；环境、超时、子进程崩溃直接抛。结束时必然卸载子进程。"""
        out = []
        try:
            for job in jobs:
                try:
                    out.append(self.run_job(job))
                except CliError as e:
                    if e.exit_code != EXIT.CONTRACT:
                        raise
                    out.append({'name': job.get('name'), 'status': 'failed', 'accepted': False, 'error': e.to_json()})
        finally:
            self.release()
        return out

    # —— 常驻服务 ——

    def serve(self, lines, out):
        """lines：每行一个 JSON 请求的可迭代对象（通常是 stdin）；out：写回应的文本流。单个推理子进程，空闲 idle_timeout 秒后结束并回收，
        下一个新生成请求再按需拉起（重新过显存守门）。请求：{"op":"gen","id":…,<prompt 等字段>}、{"op":"status"}、{"op":"shutdown"}；
        lines 结束（EOF）也退出。命中缓存的请求不会拉起子进程。"""
        q = queue.Queue()

        def read():
            for line in lines:
                q.put(line)
            q.put(None)
        threading.Thread(target=read, daemon=True).start()

        def reply(obj):
            out.write(json.dumps(_clean(obj), ensure_ascii=False) + '\n')
            out.flush()

        try:
            while True:
                wait = None
                if self._worker is not None:
                    wait = max(0.0, self._last_used + self.idle_timeout - time.monotonic())
                try:
                    line = q.get(timeout=wait)
                except queue.Empty:
                    self.release()
                    reply({'event': 'idle-release', 'idleTimeoutS': self.idle_timeout})
                    continue
                if line is None:
                    return
                if not line.strip():
                    continue
                rid = None
                try:
                    msg = json.loads(line)
                    if not isinstance(msg, dict):
                        raise ValueError('请求要是 JSON 对象')
                    rid, op = msg.get('id'), msg.get('op', 'gen')
                    if op == 'shutdown':
                        self.release()
                        reply({'id': rid, 'ok': True, 'event': 'shutdown'})
                        return
                    if op == 'status':
                        reply({'id': rid, 'ok': True, 'workerAlive': self._worker is not None and self._worker.alive(), 'spawns': self.spawns})
                    elif op == 'gen':
                        res = self.run_job({k: v for k, v in msg.items() if k in FIELDS or k == 'name'})
                        reply({'id': rid, 'ok': res['accepted'], 'result': res})
                    else:
                        raise CliError('usage.bad-value', f'不认识的 op：{op!r}', hint='gen / status / shutdown')
                except CliError as e:
                    if self._worker is not None and not self._worker.alive():
                        self.release()               # 子进程已死：收掉登记，下个请求重新拉起
                    reply({'id': rid, 'ok': False, 'error': e.to_json()})
                except ValueError as e:
                    reply({'id': rid, 'ok': False, 'error': {'code': 'usage.bad-json', 'message': f'请求不是合法 JSON：{e}', 'hint': None}})
        finally:
            self.release()


# ───── 命令行 ─────

def _env(value, name, default=None):
    return value if value is not None else (os.environ.get(name) or default)


def make_parser():
    p = ArgumentParser(prog='python -m engine.audio.foundry',
                       description='L2 声源铸造厂：按需拉起 MOSS-SoundEffect-v2.0 子进程生成 48 kHz / 24 bit 干声，SHA256 缓存，过 L3 取证；'
                                   '退出码 0 成功、1 运行失败、2 用法错误、3 环境缺失或显存查不到、4 取证或契约不过、5 空闲显存不足、124 超时')
    p.add_argument('action', choices=('gen', 'serve', 'probe'), help='gen 批处理（跑完本批就退出子进程）；serve 常驻调度器（stdin 每行一个 JSON，空闲自动卸载）；probe 只查显存守门与配置')
    g = p.add_argument_group('请求（gen；--jobs 文件里每条可覆盖这里的默认）')
    g.add_argument('--prompt', help='要生成的声音的描述（中英文都行）')
    g.add_argument('--negative-prompt', default=None, help='反向描述（默认空）')
    g.add_argument('--duration', type=float, default=None, help=f'时长（秒，默认 {DEFAULTS["duration"]}，最长 {MAX_SECONDS:g}）')
    g.add_argument('--steps', type=int, default=None, help=f'去噪步数（默认 {DEFAULTS["steps"]}；50 步约快一倍，质量曲线见规格书 §6.4）')
    g.add_argument('--cfg', type=float, default=None, help=f'CFG 引导系数（默认 {DEFAULTS["cfg"]}）')
    g.add_argument('--sigma-shift', type=float, default=None, help=f'sigma shift（默认 {DEFAULTS["sigma_shift"]}）')
    g.add_argument('--seed', type=int, default=None, help='种子（默认 0）。同一种子跨会话也不逐字节相同，所以要靠缓存复用')
    g.add_argument('--name', help='单条请求的输出名（--out 时写 <名>.wav；默认键的前 12 位）')
    g.add_argument('--jobs', help='批量请求文件：JSON 数组，或 {"jobs": […]}；每条字段同上（prompt、negative_prompt、duration、steps、cfg、sigma_shift、seed、name）')
    g.add_argument('--out', help='把产物另存一份到这个目录（<名>.wav）；缓存里的那份始终保留')
    g = p.add_argument_group('缓存与策略')
    g.add_argument('--cache', help='缓存目录（BEIMING_AUDIO_L2_CACHE；默认 .cache/audio-foundry）')
    g.add_argument('--strict', action='store_true', help='L3 取证只收 pass：suspect 与 reject 这条算不通过，整批退出 4；默认只标注 verdict、照常落盘')
    g.add_argument('--archetype', default='auto', help='L3 的物理原型（默认 auto：按 prompt 推断；可给 foley_snap、generic 等 sfx_judge.ARCHETYPES 里的名字）')
    g.add_argument('--dry-run', action='store_true', help='只报告每条的键与命中与否，不拉起子进程、不写盘')
    g = p.add_argument_group('推理环境（仅真生成时需要；--ssh 时都是远端路径）')
    g.add_argument('--python', help='隔离 venv 的解释器（BEIMING_AUDIO_L2_PYTHON），要装 torch 与上游 moss_soundeffect_v2；不要用主仓 .venv')
    g.add_argument('--model-dir', help='MOSS-SoundEffect-v2.0 权重目录（BEIMING_AUDIO_L2_MODEL_DIR）')
    g.add_argument('--pkg-dir', help='上游 MOSS-TTS 克隆目录（含 moss_soundeffect_v2 包；BEIMING_AUDIO_L2_PKG）')
    g.add_argument('--model-id', default=MODEL_ID, help=f'写进键与元数据的模型标识（默认 {MODEL_ID}）')
    g.add_argument('--revision', default=UNPINNED, help='写进键与元数据的模型版本（默认 unpinned；要让缓存跟着权重版本走就给 HF 的 commit）')
    g.add_argument('--ssh', help='免密 SSH 主机别名：在远端拉起推理子进程（不能以 - 开头）')
    g.add_argument('--gpu', type=int, default=0, help='GPU 序号（默认 0）')
    g = p.add_argument_group('守门、卸载与超时')
    g.add_argument('--min-free-gib', type=float, default=DEFAULT_MIN_FREE_GIB, help=f'拉起前要求的空闲显存 GiB（默认 {DEFAULT_MIN_FREE_GIB:g}；0C 实测峰值 15.4）')
    g.add_argument('--skip-vram-check', action='store_true', help='明确跳过显存守门（默认查不到或不足就拒绝）')
    g.add_argument('--idle-timeout', type=float, default=DEFAULT_IDLE_S, help=f'serve 的子进程空闲多少秒后退出（默认 {DEFAULT_IDLE_S:g}）')
    g.add_argument('--timeout', type=float, default=DEFAULT_TIMEOUT_S, help=f'子进程握手与每条请求的等待上限秒数（默认 {DEFAULT_TIMEOUT_S:g}；冷启动含编译约 80 秒）')
    return p


def _load_jobs(args):
    base = {k: v for k, v in dict(prompt=args.prompt, negative_prompt=args.negative_prompt, duration=args.duration, steps=args.steps,
                                  cfg=args.cfg, sigma_shift=args.sigma_shift, seed=args.seed, name=args.name).items() if v is not None}
    if args.jobs:
        try:
            with open(args.jobs, encoding='utf-8') as f:
                doc = json.load(f)
        except OSError as e:
            raise CliError('env.input-missing', f'读不了 --jobs 文件：{rel(args.jobs)}（{e.strerror}）') from e
        except ValueError as e:
            raise CliError('usage.bad-json', f'--jobs 文件不是合法 JSON：{e}') from e
        items = doc.get('jobs') if isinstance(doc, dict) else doc
        if not isinstance(items, list) or not items or not all(isinstance(i, dict) for i in items):
            raise CliError('usage.bad-value', '--jobs 要是非空的对象数组（或 {"jobs": […]}）')
        jobs = [{**{k: v for k, v in base.items() if k != 'name'}, **i} for i in items]
    elif 'prompt' in base:
        jobs = [base]
    else:
        raise CliError('usage.missing-argument', 'gen 需要 --prompt 或 --jobs', hint='例：--prompt "宣纸被剪刀干脆地裁断" --duration 2')
    for j in jobs:
        normalize(j)                                 # 全部请求先校验完，再碰显卡
        if j.get('name') is not None and not NAME_RE.fullmatch(str(j['name'])):
            raise CliError('usage.bad-value', f'name 不合法：{j["name"]!r}', hint='字母数字开头，只含字母数字与 . _ -，最长 80')
    names = [j['name'] for j in jobs if j.get('name')]
    if args.out and len(names) != len(set(names)):
        raise CliError('usage.bad-value', '--out 时各条请求的 name 不能重名')
    return jobs


def _foundry(args, ctx):
    if args.archetype != 'auto':
        from . import sfx_judge
        if args.archetype not in sfx_judge.ARCHETYPES:
            raise CliError('usage.bad-value', f'--archetype 不认识：{args.archetype}', hint=f'可选 auto、{"、".join(sfx_judge.ARCHETYPES)}')
    if args.idle_timeout <= 0 or args.timeout <= 0 or args.min_free_gib < 0:
        raise CliError('usage.bad-value', '--idle-timeout、--timeout 要大于 0，--min-free-gib 不能为负')
    return Foundry(cache=_env(args.cache, 'BEIMING_AUDIO_L2_CACHE', DEFAULT_CACHE), model_dir=_env(args.model_dir, 'BEIMING_AUDIO_L2_MODEL_DIR'),
                   python=_env(args.python, 'BEIMING_AUDIO_L2_PYTHON'), pkg_dir=_env(args.pkg_dir, 'BEIMING_AUDIO_L2_PKG'),
                   ssh=args.ssh, gpu=args.gpu, model_id=args.model_id, revision=args.revision, min_free_gib=args.min_free_gib,
                   skip_vram_check=args.skip_vram_check, idle_timeout=args.idle_timeout, timeout=args.timeout, archetype=args.archetype,
                   strict=args.strict, worker_script=os.environ.get('BEIMING_AUDIO_L2_WORKER') or WORKER, log=ctx.log)


def _copy_out(src, name, out_dir):
    """把缓存里的 WAV 另存一份到 out_dir/<name>.wav（同样先写临时文件再 os.replace）。"""
    dst = os.path.join(out_dir, name + '.wav')
    tmp = f'{dst}.{uuid.uuid4().hex}.tmp'
    os.makedirs(out_dir, exist_ok=True)
    try:
        shutil.copyfile(src, tmp)
        _replace(tmp, dst)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return dst


def main_cli(args, ctx):
    f = _foundry(args, ctx)
    if args.skip_vram_check:
        ctx.warn('foundry.vram-check-skipped', '已跳过显存守门：推理峰值约 15.4 GiB，与满载 ComfyUI 共存会 OOM')
    if args.action == 'serve':
        if ctx.json:
            raise CliError('usage.conflict', 'serve 的 stdout 是协议流（每行一个 JSON），不接受 --json')
        ctx.log(f'铸造厂常驻调度器就绪：空闲 {f.idle_timeout:g} 秒后卸载推理子进程；stdin 关闭或收到 shutdown 退出')
        f.serve(sys.stdin, sys.stdout)
        return None
    if args.action == 'probe':
        free = f.guard() if not args.skip_vram_check else None
        py_ok = bool(f.python and f.model_dir and (f.ssh or (os.path.isfile(f.python) and os.path.isdir(f.model_dir))))
        ctx.out(f'显存守门：{"跳过" if free is None else f"空闲 {free / 1024:.1f} GiB ≥ {f.min_free_mib / 1024:.1f} GiB，通过"}；推理环境配置：{"齐" if py_ok else "不全（只影响新生成）"}')
        return {'data': {'freeMiB': free, 'minFreeMiB': f.min_free_mib, 'workerConfigured': py_ok, 'remote': bool(f.ssh)}}

    jobs = _load_jobs(args)
    if args.dry_run:
        plan = []
        for j in jobs:
            key, request = request_key(normalize(j), f.model_id, f.revision)
            plan.append({'name': j.get('name') or key[:12], 'key': key, 'status': 'hit' if f.cache.load(key, request) else 'miss'})
        miss = sum(p['status'] == 'miss' for p in plan)
        for p in plan:
            ctx.out(f'{p["name"]}  {p["status"]}  {p["key"][:16]}')
        ctx.out(f'共 {len(plan)} 条，{miss} 条需要拉起推理子进程' if miss else f'共 {len(plan)} 条，全部命中缓存，不会拉起推理子进程')
        return {'data': {'dryRun': True, 'jobs': plan, 'wouldSpawn': miss > 0}}

    results = f.run_batch(jobs)
    outputs = []
    for r in results:
        if r.get('status') == 'failed' or not r['accepted']:
            continue
        if r['verdict'] != 'pass':
            ctx.warn('foundry.l3-' + r['verdict'], f'{r["name"]}：L3 取证 {r["verdict"]}（已落盘并标注）', hint='听一遍再决定用不用；要严格拒收加 --strict')
        path = f.cache.paths(r['key'])[0]
        if args.out:
            path = _copy_out(path, r['name'], args.out)
        outputs.append({'path': rel(path), 'sha256': sha256_file(path), 'kind': 'wav'})
        ctx.out(f'{r["name"]}  {r["status"]}  {r["verdict"]}  bw95={r["bandwidth95Hz"]} Hz  → {rel(path)}')
    data = {'spawns': f.spawns, 'results': results, 'cache': rel(f.cache.root)}
    bad = [r for r in results if r.get('status') == 'failed' or not r['accepted']]
    if bad:
        first = bad[0]['error']
        raise CliError('contract.foundry-rejected', f'{len(bad)}/{len(results)} 条未通过：{first["message"]}', hint=first.get('hint'), data=data)
    return {'data': data, 'outputs': outputs}


def main(argv=None):
    return run_cli(main_cli, make_parser(), argv=argv, command='audio:foundry')


if __name__ == '__main__':
    sys.exit(main())
