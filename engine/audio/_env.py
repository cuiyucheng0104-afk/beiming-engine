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
      subprocess.run 的替身：子进程留在调用方的进程组里（对整组发的 Ctrl+C、SIGHUP、SIGKILL 一起收到，不会被系统收养后
      接着跑），stdin 默认接空设备；超时（抛 subprocess.TimeoutExpired）、Ctrl+C、SIGTERM（由 exit_on_sigterm 或 cli.run
      转成异常）或任何异常时，连同它起的孙进程（sh → ffmpeg）一起结束再把异常抛上去，不留孤儿进程
  kill_tree(popen, grace=5) → 结束 popen 和它的全部子孙：先按父子关系取下整棵树（Linux 读 /proc，其余用 ps；要在中间一层
      退出、孙进程被系统收养之前取），逐个 SIGTERM，grace 秒后还在的 SIGKILL（同 tools/film/lib/proc.mjs 的 treeOf）；
      Windows：taskkill /T /F
  exit_on_sigterm() → 没走 cli.run 的脚本（audio/mix.py、audio/check.py）：SIGTERM / SIGINT 变成 SystemExit(143 / 130)，
      finally 照常执行（临时目录删掉、run 起的子进程一并结束），不打印 KeyboardInterrupt 堆栈，退出码按附录 C1
"""
import os
import shutil
import signal
import subprocess
import sys
import time


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
    with subprocess.Popen(cmd, **kw) as p:
        try:
            out, err = p.communicate(input, timeout=timeout)
        except BaseException:
            kill_tree(p)
            raise
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)


def _children():
    """{父 pid: [子 pid…]}：Linux 读 /proc（精简容器可能没装 ps），其余 POSIX 用 ps"""
    rows = []
    if os.path.isdir('/proc/self/task'):
        for d in os.listdir('/proc'):
            if d.isdigit():
                try:
                    with open(f'/proc/{d}/stat', 'rb') as f:
                        st = f.read()
                    rows.append((int(d), int(st[st.rindex(b')') + 2:].split()[1])))   # "pid (名字) 状态 ppid …"，名字里可能有空格和括号
                except (OSError, ValueError, IndexError):
                    pass                                                             # 读的时候进程退出了
    else:
        try:
            out = subprocess.run(['ps', '-A', '-o', 'pid=,ppid='], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            out = ''
        rows = [tuple(map(int, f)) for f in (ln.split() for ln in out.splitlines()) if len(f) == 2 and f[0].isdigit() and f[1].isdigit()]
    kids = {}
    for pid, ppid in rows:
        kids.setdefault(ppid, []).append(pid)
    return kids


def _descendants(root):
    kids, found, todo = _children(), [], [root]
    while todo:
        for c in kids.get(todo.pop(), ()):
            if c not in found and c != os.getpid():
                found.append(c)
                todo.append(c)
    return found


def kill_tree(p, grace=5.0):
    if os.name == 'nt':
        if p.poll() is None:
            subprocess.run(['taskkill', '/T', '/F', '/PID', str(p.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        p.wait()
        return
    # shortcut: 直接子进程已先退出、孙进程已被系统收养时按父子关系找不到它；它仍在调用方的进程组里，整组信号照样收到。
    # 要彻底兜住时改用 Linux 的 PR_SET_CHILD_SUBREAPER 或给子进程单独的作业对象
    tree = [p.pid] + _descendants(p.pid) if p.returncode is None else []    # 已回收的 pid 可能被别人重用：不碰

    def alive(pid):
        if pid == p.pid:
            return p.poll() is None             # 直接子进程用 poll（顺带收尸），不对已回收的 pid 发信号
        try:
            os.kill(pid, 0)
            return True
        except OSError:                         # 已退出（或 pid 已归别的用户）
            return False
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in tree:
            if alive(pid):
                try:
                    os.kill(pid, sig)
                except OSError:
                    pass
        until = time.monotonic() + grace
        while time.monotonic() < until and any(alive(x) for x in tree):
            time.sleep(0.05)
        if not any(alive(x) for x in tree):
            break
    p.wait()


def exit_on_sigterm():
    def _raise(signum, frame):
        raise SystemExit(130 if signum == signal.SIGINT else 143)
    for sig in (signal.SIGTERM, signal.SIGINT):     # 终端 Ctrl+C 现在也直接到子进程：照常清理，不打 KeyboardInterrupt 堆栈
        try:
            signal.signal(sig, _raise)
        except (ValueError, OSError):               # 非主线程，或平台没有这个信号
            pass
