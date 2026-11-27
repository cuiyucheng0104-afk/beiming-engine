#!/usr/bin/env python3
"""Linux CI 的 FFmpeg / FFprobe 计时入口。媒体数据沿用原来的标准输入输出。"""
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import time


def record(event, **fields):
    row = dict(event=event, wrapper=os.getpid(), monotonicNs=str(time.monotonic_ns()), **fields)
    with open(os.environ['BEIMING_B20_TRACE'], 'a', encoding='utf-8') as log:
        log.write(json.dumps(row, ensure_ascii=False) + '\n')


def main():
    tool = Path(sys.argv[0]).name
    env = os.environ.copy()
    # 测试只在 PATH 首位临时插入此脚本所在目录。
    _, env['PATH'] = env['PATH'].split(os.pathsep, 1)
    command = [tool, *sys.argv[1:]]
    record('media-start', tool=tool, args=sys.argv[1:])
    try:
        pid = os.posix_spawn(shutil.which(tool, path=env['PATH']) or tool, command, env, setsigdef=(signal.SIGPIPE,))
    except OSError as error:
        record('media-error', errno=error.errno, error=str(error))
        raise
    # 单独取消媒体操作时，将发给计时入口的信号传给实际子进程。
    def forward(signum, _frame):
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, forward)
    _, status, usage = os.wait4(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    record('media-end', pid=pid, exit=code, userSec=usage.ru_utime,
           systemSec=usage.ru_stime, maxRssKiB=usage.ru_maxrss)
    if code < 0:
        sig = -code
        if sig not in (signal.SIGKILL, signal.SIGSTOP):
            signal.signal(sig, signal.SIG_DFL)
        os.kill(os.getpid(), sig)
    return code


if __name__ == '__main__':
    sys.exit(main())
