# -*- coding: utf-8 -*-
"""北冥引擎 · 配音 · 凭据：只从环境变量或系统钥匙串读；不写死任何文件路径，不打印、不写进缓存与日志。

  get_secret(service, env=(), account='api-key') → str 或 None
     顺序：环境变量（按 env 给的顺序）→ 系统钥匙串：
       macOS    security find-generic-password -s <service> -a <account> -w
       Linux    secret-tool lookup service <service> account <account>（libsecret）
       Windows  凭据管理器的「普通凭据」，目标名 <service>（CredReadW；用 cmdkey /generic:<service> /user:<account> /pass 存）
     → 装了 keyring 包时最后试 keyring.get_password(service, account)
  how_to_set(service, env, account) → 一段说明：三个平台各怎么存（给报错的 hint 用，不含任何值）
"""
import os
import shutil
import subprocess
import sys


def _macos(service, account):
    if sys.platform != 'darwin' or not shutil.which('security'):
        return None
    r = subprocess.run(['security', 'find-generic-password', '-s', service, '-a', account, '-w'], capture_output=True, text=True)
    return r.stdout.strip() or None if r.returncode == 0 else None


def _linux(service, account):
    if not sys.platform.startswith('linux') or not shutil.which('secret-tool'):
        return None
    r = subprocess.run(['secret-tool', 'lookup', 'service', service, 'account', account], capture_output=True, text=True)
    return r.stdout.strip() or None if r.returncode == 0 else None


def _windows(service):
    if os.name != 'nt':
        return None
    import ctypes
    from ctypes import wintypes as wt

    class CREDENTIAL(ctypes.Structure):
        _fields_ = [('Flags', wt.DWORD), ('Type', wt.DWORD), ('TargetName', wt.LPWSTR), ('Comment', wt.LPWSTR),
                    ('LastWritten', wt.FILETIME), ('CredentialBlobSize', wt.DWORD), ('CredentialBlob', ctypes.POINTER(ctypes.c_ubyte)),
                    ('Persist', wt.DWORD), ('AttributeCount', wt.DWORD), ('Attributes', ctypes.c_void_p),
                    ('TargetAlias', wt.LPWSTR), ('UserName', wt.LPWSTR)]
    adv = ctypes.WinDLL('advapi32', use_last_error=True)
    adv.CredReadW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.POINTER(ctypes.POINTER(CREDENTIAL))]
    adv.CredReadW.restype = wt.BOOL
    adv.CredFree.argtypes = [ctypes.c_void_p]
    p = ctypes.POINTER(CREDENTIAL)()
    if not adv.CredReadW(service, 1, 0, ctypes.byref(p)):        # 1 = CRED_TYPE_GENERIC
        return None
    try:
        blob = ctypes.string_at(p.contents.CredentialBlob, p.contents.CredentialBlobSize)
    finally:
        adv.CredFree(p)
    for enc in ('utf-16-le', 'utf-8'):
        try:
            v = blob.decode(enc).strip('\x00').strip()
            if v:
                return v
        except UnicodeDecodeError:
            continue
    return None


def _keyring(service, account):
    try:
        import keyring
    except ImportError:
        return None
    try:
        return keyring.get_password(service, account) or None
    except Exception:  # 后端不可用时当作没有
        return None


def get_secret(service, env=(), account='api-key'):
    for name in env:
        v = os.environ.get(name, '').strip()
        if v:
            return v
    for fn in (lambda: _macos(service, account), lambda: _linux(service, account), lambda: _windows(service),
               lambda: _keyring(service, account)):
        try:
            v = fn()
        except (OSError, ValueError):
            v = None
        if v:
            return v
    return None


def how_to_set(service, env=(), account='api-key'):
    e = env[0] if env else 'API_KEY'
    return (f'设环境变量 {e}，或存进系统钥匙串：macOS  security add-generic-password -s {service} -a {account} -w；'
            f'Linux  secret-tool store --label={service} service {service} account {account}；'
            f'Windows  cmdkey /generic:{service} /user:{account} /pass（回车后输入）。仓库不读任何密钥文件')
