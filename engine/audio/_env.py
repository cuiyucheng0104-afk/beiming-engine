# -*- coding: utf-8 -*-
"""北冥引擎 · 声音工具找外部程序：与 tools/env（docs/ENVIRONMENT.md）同一口径，三个平台写法一样。

  ffmpeg() / ffprobe() → 可执行文件名或完整路径：先看环境变量 FFMPEG / FFPROBE（完整路径），否则用 PATH 里的名字
                         （同 tools/env/lib/ffmpeg.mjs 的 ffmpegBins）
  find_sh() → (路径或 None, 说明)：BEIMING_SH（显式指定，文件不存在就当找不到，不悄悄换）→ PATH 里的 sh →
              （仅 Windows）Git for Windows 的 Git\\bin\\sh.exe（由 PATH 里的 git.exe 反推，再看 Program Files、LOCALAPPDATA\\Programs）
              同 tools/env/lib/sh.mjs 的 findSh；只认 bin\\sh.exe（启动器会把 MSYS 的 sed、awk 放进 PATH），不认 usr\\bin\\sh.exe
  sh_fix() → 一句可执行的修复建议
  utf8_stdio() → stdout / stderr 改成 UTF-8（Windows 的 GBK 控制台与管道里打印中文不抛 UnicodeEncodeError）
  run(cmd, timeout=None, input=None, capture_output=False, **Popen 参数) → CompletedProcess
      subprocess.run 的替身：子进程自成一个进程组（POSIX 新会话 / Windows 新进程组），stdin 默认接空设备；超时
      （抛 subprocess.TimeoutExpired）、Ctrl+C、SIGTERM（由 exit_on_sigterm 或 cli.run 转成异常）或任何异常时，连同它起的
      孙进程（sh → ffmpeg）一起结束再把异常抛上去，不留孤儿进程
  kill_tree(popen, grace=5) → 结束一个进程组：先 SIGTERM（Windows：taskkill /T），grace 秒后还在就强制
  exit_on_sigterm() → 没走 cli.run 的脚本（audio/mix.py、audio/check.py）：SIGTERM 变成 SystemExit(143)，finally 照常执行
      （临时目录删掉、run 起的子进程一并结束），退出码 143（附录 C1）
"""
import os
import shutil
import signal
import subprocess
import sys


def _pick(name, default):
    v = (os.environ.get(name) or '').strip()
    return v or default


def ffmpeg():
    return _pick('FFMPEG', 'ffmpeg')


def ffprobe():
    return _pick('FFPROBE', 'ffprobe')


def find_sh():
    explicit = (os.environ.get('BEIMING_SH') or '').strip()
    if explicit:
        if os.path.isfile(explicit):
            return explicit, 'BEIMING_SH'
        return None, f'BEIMING_SH={explicit} 不存在'
    p = shutil.which('sh')
    if p:
        return p, 'PATH'
    if os.name != 'nt':
        return None, 'PATH 里没有 sh'
    roots = []
    git = shutil.which('git')
    if git:
        roots.append(os.path.normpath(os.path.join(os.path.dirname(git), '..')))     # …\Git\cmd\git.exe → …\Git
    for base in (os.environ.get('ProgramFiles'), os.environ.get('ProgramFiles(x86)'), os.environ.get('ProgramW6432'),
                 os.path.join(os.environ['LOCALAPPDATA'], 'Programs') if os.environ.get('LOCALAPPDATA') else None):
        if base:
            roots.append(os.path.join(base, 'Git'))
    tried = []
    for r in dict.fromkeys(roots):
        cand = os.path.join(r, 'bin', 'sh.exe')
        if os.path.isfile(cand):
            return cand, f'Git for Windows（{r}）'
        tried.append(cand)
    return None, 'PATH 里没有 sh，也没找到 Git for Windows 的 bin\\sh.exe' + (f'（找过 {"、".join(tried)}）' if tried else '')


def sh_fix():
    if os.name == 'nt':
        return ("安装 Git for Windows：winget install --id Git.Git -e（会自动找到 Git\\bin\\sh.exe，不用改 PATH）；"
                "装在别处时设 $env:BEIMING_SH = '<Git 目录>\\bin\\sh.exe'")
    if sys.platform == 'darwin':
        return 'macOS 自带 /bin/sh：检查 PATH 是否被改坏（echo $PATH）'
    return '安装 dash 或 bash（例：sudo apt-get install dash），或设 BEIMING_SH 指向 sh'


def utf8_stdio():
    for s in (sys.stdout, sys.stderr):
        try:
            if (s.encoding or '').lower().replace('-', '') != 'utf8':
                s.reconfigure(encoding='utf-8', errors='backslashreplace')
        except (AttributeError, ValueError):
            pass


def run(cmd, timeout=None, input=None, capture_output=False, **kw):
    if capture_output:
        kw['stdout'] = kw['stderr'] = subprocess.PIPE
    kw.setdefault('stdin', subprocess.PIPE if input is not None else subprocess.DEVNULL)
    if os.name == 'nt':
        kw['creationflags'] = kw.get('creationflags', 0) | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw['start_new_session'] = True
    with subprocess.Popen(cmd, **kw) as p:
        try:
            out, err = p.communicate(input, timeout=timeout)
        except BaseException:
            kill_tree(p)
            raise
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)


def kill_tree(p, grace=5.0):
    if os.name == 'nt':
        if p.poll() is None:
            subprocess.run(['taskkill', '/T', '/F', '/PID', str(p.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        p.wait()
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(p.pid, sig)               # run 起的子进程是组长：组号 = 它的 pid，孙进程在同一组里
        except (ProcessLookupError, PermissionError):
            break                               # 组里已经没人了
        try:
            p.wait(grace)
        except subprocess.TimeoutExpired:
            continue
        try:
            os.killpg(p.pid, signal.SIGKILL)    # 组长退了，孙进程可能还在（例如 sh 先退、ffmpeg 还在写）
        except (ProcessLookupError, PermissionError):
            pass
        break
    p.wait()


def exit_on_sigterm():
    def _raise(signum, frame):
        raise SystemExit(143)
    try:
        signal.signal(signal.SIGTERM, _raise)
    except (ValueError, OSError):               # 非主线程，或平台没有 SIGTERM
        pass
