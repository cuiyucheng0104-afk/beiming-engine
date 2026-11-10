#!/usr/bin/env python3
"""Inspect and restore the deduplicated historical case archive. Never executes builds."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'cases'
PACK_ORIGIN = 'https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/'
CHUNK = 1 << 20
VERIFIED = '.casebook-verified.json'        # pack folder: (size, mtime) of packs already hashed
TOKEN_RE = re.compile(r'@@[A-Za-z0-9_]+@@')
KNOWN_TOKENS = {'@@CASE_ROOT@@', '@@WORKSPACE_ROOT@@', '@@LEMO_ROOT@@', '@@ROG_HOST@@'}
# Restored paths are pasted into shell, JSON, Python and JS source verbatim. Only accept characters that
# are inert in all of them (\w covers letters, digits and CJK); anything else is refused up front.
SAFE_VALUE = re.compile(r'[\w/.:+,=@~-]+')
SAFE_HOST = re.compile(r'[A-Za-z0-9._:-]+')
CRLF_HINT = ('这些文件只差换行：Git 检出时把 LF 改成了 CRLF（Git for Windows 默认 core.autocrlf=true）。'
             '在仓库根目录执行 git config core.autocrlf false，提交或备份未提交的改动后，'
             '再执行 git rm --cached -r -q . 和 git reset --hard 重新检出（这两步会丢弃未提交的改动）；'
             '新克隆可先设置 git config --global core.autocrlf false。')
# Operating-system clutter and per-checkout installs that never belong to a vendored snapshot.
JUNK_FILES = {'.DS_Store', 'Thumbs.db', 'desktop.ini'}
LOCAL_DIRS = {'node_modules', '.venv', '__pycache__', '.git'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    """SHA-256 of a file read in chunks, so multi-hundred-MB packs never sit in memory. Returns (size, hex)."""
    h, size = hashlib.sha256(), 0
    with open(path, 'rb') as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
            size += len(chunk)
    return size, h.hexdigest()


def safe_path(root, name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name:
        raise ValueError(f'Unsafe archive path: {name}')
    result = root.joinpath(*p.parts)
    if not result.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Archive path escapes destination: {name}')
    return result


def read_manifest():
    return json.loads((ARCHIVE / 'catalog.json').read_text(encoding='utf-8'))


def listing(paths, limit=20):
    paths = sorted(paths)
    lines = ''.join(f'\n  - {p}' for p in paths[:limit])
    return lines + (f'\n  …另有 {len(paths) - limit} 项' if len(paths) > limit else '')


def verify_bytes(data, item, label=None):
    if len(data) != item['size'] or digest(data) != item['sha256']:
        raise ValueError(f'Checksum mismatch: {label or item.get("path", item.get("filename", "blob"))}')


def archived_bytes(data, item):
    """The archived bytes behind `data`: unchanged, or with Git's checkout-time LF->CRLF conversion undone
    when that alone restores the recorded checksum. None when neither matches."""
    if len(data) == item['size'] and digest(data) == item['sha256']:
        return data
    if b'\r\n' in data:
        fixed = data.replace(b'\r\n', b'\n')
        if len(fixed) == item['size'] and digest(fixed) == item['sha256']:
            return fixed
    return None


def asset_meta(manifest, case, item):
    """The asset record behind a file entry; a broken reference names the case and path instead of a KeyError."""
    label = f'{case["id"]}/{item.get("path")}'
    if 'asset' not in item:
        raise ValueError(f'File entry has neither source nor asset: {label}')
    meta = manifest['assets'].get(item['asset'])
    if meta is None:
        raise ValueError(f'Unknown asset {item["asset"]} referenced by {label}')
    return meta


# --- .gitignore -----------------------------------------------------------------------------------------

def compile_ignore(line):
    """One .gitignore line -> (regex, negated, directory_only), or None. Implements the documented
    gitignore pattern rules: anchoring, trailing-slash directories, *, ?, [...], **/ and /**."""
    if not line.strip() or line.startswith('#'):
        return None
    line = line.rstrip()
    negate = line.startswith('!')
    if negate:
        line = line[1:]
    elif line.startswith(('\\!', '\\#')):
        line = line[1:]
    dir_only = line.endswith('/')
    line = line.rstrip('/')
    if not line:
        return None
    anchored = '/' in line
    line = line.lstrip('/')
    out, i = [], 0
    while i < len(line):
        if line.startswith('**/', i) and (i == 0 or line[i - 1] == '/'):
            out.append('(?:.*/)?')
            i += 3
        elif line.startswith('/**', i) and i + 3 == len(line):
            out.append('/.*')
            i += 3
        elif line[i] == '*':
            while i < len(line) and line[i] == '*':
                i += 1
            out.append('[^/]*')
        elif line[i] == '?':
            out.append('[^/]')
            i += 1
        elif line[i] == '[' and (j := line.find(']', i + 2)) != -1:
            body = line[i + 1:j]
            body = '^' + body[1:] if body.startswith('!') else body
            out.append('[' + body.replace('\\', '\\\\') + ']')
            i = j + 1
        elif line[i] == '\\' and i + 1 < len(line):
            out.append(re.escape(line[i + 1]))
            i += 2
        else:
            out.append(re.escape(line[i]))
            i += 1
    pattern = ''.join(out)
    return re.compile(pattern if anchored else '(?:.*/)?' + pattern, re.S), negate, dir_only


class GitIgnore:
    """Answers "would git ignore this path?" for files below `top`, reading every .gitignore on the way."""

    def __init__(self, top):
        self.top = top
        self.rules = {}

    def _rules(self, folder):
        if folder not in self.rules:
            f = folder / '.gitignore'
            lines = f.read_text(encoding='utf-8', errors='replace').splitlines() if f.is_file() else []
            self.rules[folder] = [r for r in map(compile_ignore, lines) if r]
        return self.rules[folder]

    def _match(self, parts, is_dir):
        ignored = False
        for depth in range(len(parts)):     # outer .gitignore first; deeper files and later lines win
            sub = '/'.join(parts[depth:])
            for rx, negate, dir_only in self._rules(self.top.joinpath(*parts[:depth])):
                if (is_dir or not dir_only) and rx.fullmatch(sub):
                    ignored = not negate
        return ignored

    def ignored(self, path, is_dir=False):
        parts = path.relative_to(self.top).parts
        # git cannot re-include a file whose parent directory is excluded
        return any(self._match(parts[:i], True) for i in range(1, len(parts))) or self._match(parts, is_dir)


# --- paths written relative to the original home folder ---------------------------------------------------

SHELL_EXT = {'.sh', '.bash', '.zsh', '.command'}
PYTHON_EXT = {'.py'}
JS_EXT = {'.js', '.mjs', '.cjs', '.ts'}
WORD_END = r"""[^\s'"`;|&<>()$\\]*"""
PY_EXPANDUSER = re.compile(r"""(?P<head>expanduser\(\s*)(?P<q>['"])~(?P<rest>/[^'"\n]*)(?P=q)""")
PY_HOME = re.compile(r"""Path\.home\(\)(?P<segs>(?:\s*/\s*(['"])[^'"\n]*\2)+)""")
PY_SEGMENT = re.compile(r"""\s*/\s*(['"])([^'"\n]*)\1""")
SH_HOME = re.compile(r"""\$(?:HOME\b|\{HOME\})(?P<rest>/""" + WORD_END + ')')
SH_TILDE = re.compile(r"""(?:^|(?<=[\s=:;|&(]))~(?P<rest>/""" + WORD_END + ')', re.M)
JS_HOME_CONCAT = re.compile(r"""process\.env\.HOME\s*\+\s*(?P<q>['"])(?P<rest>/[^'"\n]*)(?P=q)""")
JS_HOME_TEMPLATE = re.compile(r"""\$\{\s*process\.env\.HOME\s*\}(?P<rest>/[^`$\n]*)""")
RESIDUAL = {
    'python': [r"""expanduser\(\s*[rRbBuUfF]*['"]~""", r'\bPath\.home\(\)', r'\.expanduser\(\)',
               r"""\bos\.environ\s*\[\s*['"](?:HOME|USERPROFILE)['"]""",
               r"""\b(?:getenv|environ\.get)\(\s*['"](?:HOME|USERPROFILE)['"]"""],
    'shell': [r'\$\{?HOME\b', r'(?:^|(?<=[\s=:;|&(]))~(?=[/\s;|&)]|$)', r'\$\{?USERPROFILE\b'],
    'js': [r'\bhomedir\(\)', r'\bprocess\.env\.(?:HOME|USERPROFILE)\b',
           r"""\bprocess\.env\[\s*['"](?:HOME|USERPROFILE)['"]"""],
}
RESIDUAL = {k: re.compile('|'.join(v), re.M) for k, v in RESIDUAL.items()}
ABSOLUTE_HOME = re.compile(r"""/Users/[^/\s'"`]+/|\b[A-Za-z]:[/\\]+Users[/\\]+[^/\\\s'"`]+|(?<![\w.])/home/[a-z_][a-z0-9_-]*/""")


def code_kind(path, text):
    ext = PurePosixPath(path).suffix.lower()
    if ext in SHELL_EXT:
        return 'shell'
    if ext in PYTHON_EXT:
        return 'python'
    if ext in JS_EXT:
        return 'js'
    if not ext and text.startswith('#!'):
        first = text.split('\n', 1)[0]
        if 'python' in first:
            return 'python'
        if 'node' in first:
            return 'js'
        if re.search(r'\b(?:ba|z|da|k)?sh\b', first):
            return 'shell'
    return None


def line_of(text, pos):
    return text.count('\n', 0, pos) + 1


def in_comment(text, pos):
    start = text.rfind('\n', 0, pos) + 1
    return text[start:pos].lstrip().startswith('#')


class Layout:
    """Where each archived case lands below the restore root, which stands in for the original home folder.
    Catalog data: per-case `legacyRoots` (where a project lived before it was moved to its workspacePath)
    and `homePaths` (the Lemo folder name, dependencies deliberately read from the real home, and known
    projects that were never archived)."""

    def __init__(self, manifest):
        policy = manifest.get('homePaths') or {}
        self.lemo = policy.get('lemo', 'lemo-opuscar')
        self.external = tuple(policy.get('external', ()))
        self.not_archived = tuple(policy.get('notArchived', ()))
        self.cases = {c['id']: c['workspacePath'] for c in manifest['cases']}
        self.legacy = {old: c['workspacePath'] for c in manifest['cases'] for old in c.get('legacyRoots', ())}
        self.ancestors = {str(p) for ws in self.cases.values() for p in PurePosixPath(ws).parents if str(p) != '.'}
        names = '|'.join(re.escape(k) for k in sorted(self.legacy, key=len, reverse=True))
        self.legacy_token = re.compile(r'@@WORKSPACE_ROOT@@/(' + names + r""")(?=/|[\s'"`)\]},;|&<>{]|$)""") if names else None

    @staticmethod
    def under(path, prefixes):
        return any(path == p or path.startswith(p + '/') for p in prefixes)

    def translate(self, rel):
        for old in sorted(self.legacy, key=len, reverse=True):
            if rel == old or rel.startswith(old + '/'):
                return self.legacy[old] + rel[len(old):]
        return rel

    def translate_tokens(self, text):
        return self.legacy_token.sub(lambda m: '@@WORKSPACE_ROOT@@/' + self.legacy[m.group(1)], text) if self.legacy_token else text

    def classify(self, rel):
        """'case' (inside a case), 'shared' (a folder that holds restored cases, or a file written straight
        into one, such as a delivered film), 'not-archived' (acknowledged in homePaths) or 'outside'."""
        clean = rel.rstrip('/')
        for cid, ws in self.cases.items():
            if clean == ws or clean.startswith(ws + '/'):
                return 'case', cid
        name = PurePosixPath(clean)
        if clean in self.ancestors or (str(name.parent) in self.ancestors and name.suffix and not rel.endswith('/')):
            return 'shared', None
        return ('not-archived' if self.under(clean, self.not_archived) else 'outside'), None

    def home(self, rest):
        """Token form of `~` + rest, or None when the reference must stay as written."""
        parts = [p for p in rest.split('/') if p not in ('', '.')]
        if not parts or '..' in parts:
            return None, {'kind': 'residual'}
        rel = '/'.join(parts)
        trail = '/' if rest.endswith('/') else ''
        if self.under(rel, self.external):
            return None, {'kind': 'external', 'path': rel}
        if self.under(rel, [self.lemo]):
            return '@@LEMO_ROOT@@' + rel[len(self.lemo):] + trail, {'kind': 'lemo', 'path': rel}
        moved = self.translate(rel)
        where, cid = self.classify(moved)
        return f'@@WORKSPACE_ROOT@@/{moved}{trail}', {'kind': 'workspace', 'path': moved, 'where': where, 'case': cid}


def tokenize_home(text, kind, layout):
    """Turn paths that the original scripts resolved through the home folder (expanduser('~/..'),
    Path.home()/.., $HOME/.., ~/..) into the archive's restore tokens. Returns (text, events)."""
    events, kept = [], []

    def record(match, original, info, token, shown=None):
        if in_comment(text_now[0], match.start()) or info['kind'] == 'residual':
            return original             # residual forms are reported once, by the scan below
        event = dict(info, line=line_of(text_now[0], match.start()), text=(shown or original).strip())
        if token is None:
            events.append(dict(event, kind=info['kind']))
            if info['kind'] == 'external':          # leave as written; hide it from the residual scan
                kept.append(original)
                return f'\0{len(kept) - 1}\0'
            return original
        events.append(dict(event, token=token))
        return None

    def py_expanduser(m):
        token, info = layout.home(m['rest'])
        out = record(m, m[0], info, token, f'~{m["rest"]}')
        return out if out is not None else f'{m["head"]}{m["q"]}{token}{m["q"]}'

    def py_home(m):
        segs = [s[1] for s in PY_SEGMENT.findall(m['segs'])]
        token, info = layout.home('/'.join(segs))
        out = record(m, m[0], info, token)
        quote = PY_SEGMENT.match(m['segs'])[1]
        return out if out is not None else f'Path({quote}{token}{quote})'

    def sh_path(m):
        token, info = layout.home(m['rest'])
        out = record(m, m[0], info, token)
        return out if out is not None else token

    def js_concat(m):
        token, info = layout.home(m['rest'])
        out = record(m, m[0], info, token)
        return out if out is not None else f'{m["q"]}{token}{m["q"]}'

    text_now = [text]
    passes = [(PY_EXPANDUSER, py_expanduser), (PY_HOME, py_home)] if kind in ('python', 'shell') else []
    if kind == 'shell':
        passes += [(SH_HOME, sh_path), (SH_TILDE, sh_path)]
    if kind == 'js':
        passes += [(JS_HOME_CONCAT, js_concat), (JS_HOME_TEMPLATE, sh_path)]
    for rx, fn in passes:
        text_now[0] = rx.sub(fn, text_now[0])
    result = text_now[0]
    for m in RESIDUAL[kind].finditer(result):
        if not in_comment(result, m.start()):
            start = result.rfind('\n', 0, m.start()) + 1
            end = result.find('\n', m.start())
            snippet = result[start:end if end != -1 else None].strip()
            events.append({'kind': 'residual', 'line': line_of(result, m.start()),
                           'text': re.sub(r'\0(\d+)\0', lambda k: kept[int(k[1])], snippet)})
    result = re.sub(r'\0(\d+)\0', lambda k: kept[int(k[1])], result)
    return result, events


def prepare_text(data, path, templated, layout):
    """Token-form text for a source file that restore must rewrite, else None; plus home-path events."""
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        if templated:
            raise ValueError(f'Templated file is not UTF-8: {path}')
        return None, []
    kind = code_kind(path, text)
    events = []
    changed = bool(templated)
    if kind:
        new, events = tokenize_home(text, kind, layout)
        changed = changed or new != text
        text = new
    return (layout.translate_tokens(text) if changed else None), events


def workspace_refs(text, layout):
    """Targets of @@WORKSPACE_ROOT@@/x tokens (after legacy-root translation) with their line numbers."""
    text = layout.translate_tokens(text)
    for m in re.finditer(r"""@@WORKSPACE_ROOT@@/([^\s'"`)\]},;|&<>{]*)""", text):
        yield line_of(text, m.start()), m[1]


# --- packs ------------------------------------------------------------------------------------------------

def _load_verified(directory):
    try:
        return json.loads((directory / VERIFIED).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def _remember_verified(p, meta):
    cache = _load_verified(p.parent)
    st = p.stat()
    cache[meta['filename']] = {'size': st.st_size, 'mtimeNs': st.st_mtime_ns, 'sha256': meta['sha256']}
    try:
        tmp = p.parent / (VERIFIED + '.tmp')
        tmp.write_text(json.dumps(cache, indent=1, sort_keys=True), encoding='utf-8')
        tmp.replace(p.parent / VERIFIED)
    except OSError:
        pass        # read-only pack folder: the pack was still verified, only the shortcut is lost


def verify_pack(p, meta, reverify=False):
    """Size check from stat, then a streamed SHA-256 unless this exact file (size + mtime) already passed."""
    st = p.stat()
    if st.st_size != meta['size']:
        raise ValueError(f'Checksum mismatch: {meta["filename"]} (size {st.st_size}, expected {meta["size"]})')
    seen = _load_verified(p.parent).get(meta['filename'])
    if not reverify and seen == {'size': st.st_size, 'mtimeNs': st.st_mtime_ns, 'sha256': meta['sha256']}:
        return
    if file_digest(p) != (meta['size'], meta['sha256']):
        raise ValueError(f'Checksum mismatch: {meta["filename"]}')
    _remember_verified(p, meta)


class DownloadInterrupted(ConnectionError):
    """The transfer stopped before the whole pack arrived. <name>.partial is kept; the next run resumes it."""


def _interrupted(meta, part, have, error=None):
    why = f'（{error}）' if error else '（服务器在发完之前关闭了连接）'
    return DownloadInterrupted(f'下载中断{why}：{meta["filename"]} 收到 {have} / {meta["size"]} 字节。'
                               f'已保留 {part}，重新运行同一条命令会从断点续传。')


def _range_start(headers, size):
    """Start offset of a 206 response whose Content-Range runs to the end of this pack, else None."""
    m = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+|\*)', str(headers.get('Content-Range') or '').strip())
    if not m or int(m[2]) != size - 1 or m[3] not in ('*', str(size)):
        return None
    return int(m[1])


def download_pack(meta, p):
    """Stream the pack to <name>.partial while hashing it; resume an interrupted .partial with an HTTP Range
    request. The bytes are hashed exactly once and the file is renamed only after the checksum matches.
    A transfer that stops early keeps the .partial for the next run, whether the connection failed with an
    error or the server simply closed it (http.client then returns b'' instead of raising). The .partial is
    discarded only when the server announces a different size, sends more bytes than the pack has, or the
    complete bytes do not hash to the catalog value."""
    if not meta['url'].startswith(PACK_ORIGIN):
        raise ValueError('Unexpected download origin')
    part = p.with_name(p.name + '.partial')
    h, have = hashlib.sha256(), 0
    if part.exists() and part.stat().st_size <= meta['size']:
        with open(part, 'rb') as f:
            while chunk := f.read(CHUNK):
                h.update(chunk)
                have += len(chunk)
    else:
        part.unlink(missing_ok=True)
    if have < meta['size']:
        request = urllib.request.Request(meta['url'], headers={'Range': f'bytes={have}-'} if have else {})
        try:
            response = urllib.request.urlopen(request, timeout=60)
        except urllib.error.HTTPError as error:
            if error.code != 416 or not have:
                raise
            part.unlink(missing_ok=True)        # the stored prefix is not a prefix of this file: start over
            return download_pack(meta, p)
        with response:
            headers = getattr(response, 'headers', None) or {}
            partial = getattr(response, 'status', 200) == 206
            resumed = bool(have) and partial and _range_start(headers, meta['size']) == have
            if partial and not resumed:         # a range we did not ask for: discard and fetch the whole file
                part.unlink(missing_ok=True)
                if not have:
                    raise ValueError(f'Unexpected partial response for {meta["filename"]}')
                response.close()
                return download_pack(meta, p)
            if not resumed:
                h, have = hashlib.sha256(), 0
            declared = str(headers.get('Content-Length') or '').strip()
            if declared.isdigit() and int(declared) != meta['size'] - have:
                part.unlink(missing_ok=True)    # not this pack (an error page, another version): keep nothing
                raise ValueError(f'{meta["filename"]}: 服务器声明 {declared} 字节，应为 {meta["size"] - have} 字节；'
                                 '这不是目录记录的素材包，未保存')
            with open(part, 'ab' if resumed else 'wb') as out:
                while True:
                    try:
                        chunk = response.read(CHUNK)
                    except (OSError, http.client.HTTPException) as error:   # reset, timeout, broken chunking
                        raise _interrupted(meta, part, have, error) from error
                    if not chunk:
                        break
                    out.write(chunk)
                    h.update(chunk)
                    have += len(chunk)
                    if have > meta['size']:
                        break
    if have > meta['size']:
        part.unlink(missing_ok=True)
        raise ValueError(f'Checksum mismatch: {meta["filename"]} (downloaded more than {meta["size"]} bytes)')
    if have < meta['size']:
        raise _interrupted(meta, part, have)
    if h.hexdigest() != meta['sha256']:
        part.unlink(missing_ok=True)
        raise ValueError(f'Checksum mismatch: {meta["filename"]} (downloaded)')
    part.replace(p)
    _remember_verified(p, meta)


def get_pack(meta, directory, download, reverify=False):
    p = safe_path(directory, meta['filename'])
    if not p.exists():
        if not download:
            raise FileNotFoundError(f'Missing {p}; download from {meta["url"]} or add --download')
        directory.mkdir(parents=True, exist_ok=True)
        download_pack(meta, p)
        return p
    verify_pack(p, meta, reverify)
    return p


# --- check ------------------------------------------------------------------------------------------------

def check_layout(manifest, layout):
    seen = {}
    for case in manifest['cases']:
        for old in case.get('legacyRoots', ()):
            safe_path(ROOT / 'out', old)
            if old in seen:
                raise ValueError(f'legacyRoots {old} listed by both {seen[old]} and {case["id"]}')
            seen[old] = case['id']
            for cid, ws in layout.cases.items():
                if Layout.under(ws, [old]) or Layout.under(old, [ws]):
                    raise ValueError(f'legacyRoots {old} of {case["id"]} overlaps workspacePath {ws} of {cid}')
    for old in seen:
        if any(o != old and Layout.under(o, [old]) for o in seen):
            raise ValueError(f'legacyRoots nest inside each other: {old}')
    for rel in (layout.lemo, *layout.external, *layout.not_archived):
        safe_path(ROOT / 'out', rel)


def scan_source(item, data, layout, problems):
    """Home-folder paths and tokens restore cannot place inside the restored workspace."""
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return
    where = item['source']
    for m in ABSOLUTE_HOME.finditer(text):
        problems.append(f'{where}:{line_of(text, m.start())}: absolute home path {m[0]!r}')
    tokens = set(TOKEN_RE.findall(text))
    if not item.get('templated') and tokens:
        problems.append(f'{where}: restore tokens {sorted(tokens)} in a file not marked templated')
    if tokens - KNOWN_TOKENS:
        problems.append(f'{where}: unknown restore tokens {sorted(tokens - KNOWN_TOKENS)}')
    kind = code_kind(item['path'], text)
    if not kind:
        return
    for event in tokenize_home(text, kind, layout)[1]:
        if event['kind'] == 'residual':
            problems.append(f'{where}:{event["line"]}: home-folder path restore cannot rewrite: {event["text"]}')
        elif event.get('where') == 'outside':
            problems.append(f'{where}:{event["line"]}: home-folder path {event["text"]} is outside every archived case')
    for line, rel in workspace_refs(text, layout):
        if layout.classify(rel)[0] == 'outside':
            problems.append(f'{where}:{line}: @@WORKSPACE_ROOT@@/{rel} is outside every archived case')


def git_file_mode(top):
    """Git's core.fileMode for the checkout holding `top`. git clone sets it to false on file systems that
    cannot store executable bits (WSL's /mnt drives, exFAT/FAT, many SMB shares): every file then reads as
    executable while `git status` stays clean. None when it is unset or Git cannot answer."""
    try:
        run = subprocess.run(['git', '-C', str(top), 'config', '--bool', 'core.fileMode'],
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return {'true': True, 'false': False}.get(run.stdout.strip()) if run.returncode == 0 else None


def check_modes(modes, summary):
    """Executable bits against the lock, for (label, lock mode, executable) of every vendored file with a
    recorded mode. Skipped, with a notice, where the checkout cannot hold executable bits at all."""
    if not modes or os.name == 'nt':
        summary['fileModes'] = 'unsupported' if modes else 'absent'
        return
    if git_file_mode(ARCHIVE) is False:
        summary['fileModes'] = 'skipped'
        summary['notices'].append('Git 的 core.fileMode 为 false（这个文件系统不记录执行位，Git 也不比较执行位），'
                                  '跳过 vendor 执行位核对。')
        return
    if all(executable for _, _, executable in modes) and any(mode != '100755' for _, mode, _ in modes):
        summary['fileModes'] = 'skipped'
        summary['notices'].append(f'vendor 的 {len(modes)} 个文件全部显示为可执行，像是不记录执行位的文件系统'
                                  '（WSL 的 /mnt 盘、exFAT/FAT、部分 SMB 共享），跳过 vendor 执行位核对。')
        return
    wrong = [f'{label}（lock 为 {mode}，实际{"可" if executable else "不可"}执行）'
             for label, mode, executable in modes if executable != (mode == '100755')]
    if wrong:
        raise ValueError(f'Vendor file mode mismatch（{len(wrong)} 个文件）：{listing(wrong)}\n'
                         '复制或解压时可能丢了或多了执行位；Git 检出可用 git checkout -- cases/vendor 按仓库记录恢复'
                         '（会丢弃 vendor 下未提交的改动）。')
    summary['fileModes'] = 'checked'


def check_vendor(lock, crlf, summary):
    modes = []
    for repo in json.loads(lock.read_text(encoding='utf-8'))['repositories']:
        folder = safe_path(ARCHIVE, repo['path'])
        expected = {f['path'] for f in repo['files']}
        keep_dirs = {str(p) for f in expected for p in PurePosixPath(f).parents}
        ignore = GitIgnore(ARCHIVE.parent)
        actual, extra = set(), []
        for dirpath, dirnames, filenames in os.walk(folder):
            here = Path(dirpath)
            rel_dir = here.relative_to(folder).as_posix()
            rel = (lambda n: n if rel_dir == '.' else f'{rel_dir}/{n}')
            dirnames[:] = [d for d in dirnames if rel(d) in keep_dirs or not (
                d in LOCAL_DIRS or ignore.ignored(here / d, True))]
            for name in filenames:
                path = rel(name)
                actual.add(path)
                if path not in expected and name not in JUNK_FILES and not name.startswith('._') \
                        and not ignore.ignored(here / name):
                    extra.append(path)
        missing = expected - actual
        if extra or missing:
            raise ValueError(f'Vendor snapshot inventory changed: {repo["name"]}'
                             + (f'\n未登记的文件（不在 lock.json，也不被 .gitignore 忽略）：{listing(extra)}' if extra else '')
                             + (f'\n缺少的文件：{listing(missing)}' if missing else ''))
        for item in repo['files']:
            p = safe_path(folder, item['path'])
            raw = p.read_bytes()
            data = archived_bytes(raw, item)
            if data is None:
                raise ValueError(f'Checksum mismatch: {repo["name"]}/{item["path"]}')
            if data is not raw:
                crlf.append(f'{repo["path"]}/{item["path"]}')
            blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            if blob != item['gitBlob']:
                raise ValueError(f'Vendor Git blob mismatch: {item["path"]}')
            if 'mode' in item:
                modes.append((f'{repo["path"]}/{item["path"]}', item['mode'], bool(p.stat().st_mode & stat.S_IXUSR)))
    check_modes(modes, summary)


def check_cards(manifest, summary):
    """Case cards (entries/<id>.md) repeat the catalog notes word for word. A card that no longer does is
    reported as a notice: the catalog is authoritative, and the restore report already carries its notes."""
    folder = ARCHIVE / 'entries'
    if not folder.is_dir():
        return
    stale = []
    for case in manifest['cases']:
        card = folder / f'{case["id"]}.md'
        if card.is_file():
            text = card.read_text(encoding='utf-8', errors='replace').replace('\r\n', '\n')
            if any(note not in text for note in case.get('notes', ())):
                stale.append(f'entries/{case["id"]}.md')
    if stale:
        summary['notices'].append(f'{len(stale)} 张案例卡里的说明与 catalog.json 的 notes 不一致（以 catalog 为准，'
                                  f'请把卡片上的说明改成 notes 原文）：{listing(stale)}')


def check(manifest, summary=None):
    """Verify catalog and archive. `summary`, when given, receives 'notices' (worth reading although the
    check passed) and 'fileModes' (checked, skipped, unsupported or absent)."""
    summary = {} if summary is None else summary
    summary.setdefault('notices', [])
    layout = Layout(manifest)
    check_layout(manifest, layout)
    ids = set()
    verified = {}           # source path -> (size, sha256) of the archived bytes
    crlf, problems = [], []
    packs = {p['filename'] for p in manifest['packs']}
    for case in manifest['cases']:
        if case['id'] in ids:
            raise ValueError('Duplicate case ID')
        ids.add(case['id'])
        safe_path(ROOT / 'out', case['workspacePath'])
        paths = set()
        for item in case['files']:
            safe_path(ROOT / 'out', item['path'])
            key = item['path'].casefold()
            if key in paths:
                raise ValueError(f'Duplicate/case-colliding file: {case["id"]}/{item["path"]}')
            paths.add(key)
            if 'source' in item:
                p = safe_path(ARCHIVE, item['source'])
                if p not in verified:
                    raw = p.read_bytes()
                    data = archived_bytes(raw, item)
                    if data is None:
                        raise ValueError(f'Checksum mismatch: {case["id"]}/{item["path"]} (source {item["source"]})')
                    if data is not raw:
                        crlf.append(item['source'])
                    verified[p] = (item['size'], item['sha256'])
                    scan_source(item, data, layout, problems)
                elif verified[p] != (item['size'], item['sha256']):
                    # Every reference must agree, otherwise check passes while restore of this case fails.
                    raise ValueError(f'Checksum mismatch: {case["id"]}/{item["path"]} records a different '
                                     f'size/sha256 for {item["source"]} than an earlier case')
            else:
                asset = asset_meta(manifest, case, item)
                if asset['pack'] not in packs or asset['size'] != item['size'] or item['asset'] != item['sha256']:
                    raise ValueError(f'Invalid asset reference: {case["id"]}/{item["path"]}')
        if any(p not in {f['path'] for f in case['files']} for p in case['entrypoints']):
            raise ValueError(f'Missing entry point: {case["id"]}')
    lock = ARCHIVE / 'vendor/lock.json'
    if lock.exists():
        check_vendor(lock, crlf, summary)
    if crlf:
        raise ValueError(f'Checksum mismatch（换行被改成 CRLF）：{len(crlf)} 个文件{listing(crlf, 10)}\n{CRLF_HINT}')
    if problems:
        raise ValueError(f'Paths restore cannot place inside the workspace ({len(problems)}):{listing(problems, 40)}')
    check_cards(manifest, summary)
    return len(ids), len(verified)


# --- restore ----------------------------------------------------------------------------------------------

def check_value(token, value):
    rule = SAFE_HOST if token == '@@ROG_HOST@@' else SAFE_VALUE
    if not rule.fullmatch(value or '') or '@@' in value:
        bad = ''.join(sorted({ch for ch in value if not rule.fullmatch(ch)})) or value
        raise ValueError(f'{token} 要写入还原后的脚本，但值 {value!r} 含有不安全字符 {bad!r}'
                         '（空白、引号、$、反斜杠、括号、通配符等会让 shell、JSON 或 Python 源码出错）。'
                         '请换一个只含字母、数字、中文和 / . _ - : 的目录作为 --out、--lemo 或仓库位置。')


def restore(manifest, case_id, output, pack_dir, download=False, source_only=False, lemo=None, rog=None,
            reverify=False):
    case = next((c for c in manifest['cases'] if c['id'] == case_id), None)
    if case is None:
        raise ValueError(f'Unknown case: {case_id}')
    target = safe_path(output, case['workspacePath'])
    if target.exists():
        raise FileExistsError(f'Refusing to overwrite existing directory: {target}')
    # Validate all destinations before creating a directory or downloading anything.
    for item in case['files']:
        safe_path(target, item['path'])
    layout = Layout(manifest)
    packs = {p['filename']: p for p in manifest['packs']}
    needed = set() if source_only else {asset_meta(manifest, case, f)['pack'] for f in case['files'] if 'source' not in f}
    if needed - packs.keys():
        raise ValueError(f'{case_id} needs unknown packs: {sorted(needed - packs.keys())}')
    values = {'@@CASE_ROOT@@': target.resolve().as_posix(), '@@WORKSPACE_ROOT@@': output.resolve().as_posix(),
              '@@LEMO_ROOT@@': (lemo or ARCHIVE/'vendor/lemo-opuscar').resolve().as_posix()}
    if rog:
        values['@@ROG_HOST@@'] = rog
    report = {'case': case_id, 'sourceOnly': source_only, 'entries': case['entrypoints'],
              'requirements': case['requirements'], 'notes': case['notes'],
              'warning': 'Historical archive restored; no film was rendered or visually approved by this command.',
              'tokens': {}, 'homeRewrites': [], 'externalHomePaths': [], 'notArchived': [], 'relatedCases': [],
              'unreplacedTokens': [], 'lineEndingsRepaired': []}
    # Read, verify and rewrite every source file in memory (they are small) before touching the disk.
    prepared, used = {}, set()
    for item in case['files']:
        if 'source' not in item:
            continue
        raw = safe_path(ARCHIVE, item['source']).read_bytes()
        data = archived_bytes(raw, item)
        if data is None:
            raise ValueError(f'Checksum mismatch: {case_id}/{item["path"]} (source {item["source"]})')
        if data is not raw:
            report['lineEndingsRepaired'].append(item['path'])
        text, events = prepare_text(data, item['path'], item.get('templated'), layout)
        for e in events:
            ref = {'file': item['path'], 'line': e['line'], 'reference': e['text']}
            if e['kind'] == 'external':
                report['externalHomePaths'].append(ref)
            elif 'token' in e:
                report['homeRewrites'].append(dict(ref, to=e['token'], target=e.get('where', 'lemo')))
                if e.get('where') in ('not-archived', 'outside'):
                    report['notArchived'].append(dict(ref, path=e['path']))
                if e.get('case') and e['case'] != case_id:
                    report['relatedCases'].append(e['case'])
        if text is None:
            prepared[item['path']] = data
            continue
        for _, rel in workspace_refs(text, layout):
            where, cid = layout.classify(rel)
            if cid and cid != case_id:
                report['relatedCases'].append(cid)
        used |= set(TOKEN_RE.findall(text)) & values.keys()
        prepared[item['path']] = text
    for token in sorted(used):
        check_value(token, values[token])
        report['tokens'][token] = values[token]
    for path, text in prepared.items():
        if isinstance(text, str):
            for old, new in values.items():
                text = text.replace(old, new)
            if left := sorted(set(TOKEN_RE.findall(text))):
                report['unreplacedTokens'].append({'file': path, 'tokens': left})
            prepared[path] = text.encode('utf-8')
    for rewrite in report['homeRewrites']:
        for old, new in values.items():
            rewrite['to'] = rewrite['to'].replace(old, new)
    report['relatedCases'] = sorted(set(report['relatedCases']))
    opened = {}
    temp = None
    try:
        for name in sorted(needed):
            opened[name] = zipfile.ZipFile(get_pack(packs[name], pack_dir, download, reverify))
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = Path(tempfile.mkdtemp(prefix='.case-restore-', dir=target.parent))
        for item in case['files']:
            if 'source' not in item and source_only:
                continue
            dest = safe_path(temp, item['path'])
            dest.parent.mkdir(parents=True, exist_ok=True)
            if 'source' in item:
                dest.write_bytes(prepared[item['path']])
            else:
                h, size = hashlib.sha256(), 0
                with opened[asset_meta(manifest, case, item)['pack']].open(item['asset']) as src, open(dest, 'wb') as out:
                    while chunk := src.read(CHUNK):
                        out.write(chunk)
                        h.update(chunk)
                        size += len(chunk)
                if size != item['size'] or h.hexdigest() != item['sha256']:
                    raise ValueError(f'Checksum mismatch: {case_id}/{item["path"]}')
            if item.get('executable'):
                dest.chmod(0o755)
        (temp/'ARCHIVE-RESTORED.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        temp.rename(target)
        temp = None
    finally:
        for z in opened.values():
            z.close()
        if temp:
            shutil.rmtree(temp)
    return target


def restore_warnings(report):
    """Human-readable notes about what restore changed or could not provide."""
    out = []
    if report.get('homeRewrites'):
        out.append(f'{len(report["homeRewrites"])} 处原本经家目录解析的路径已改写到还原目录或 Lemo 库'
                   '（明细见 ARCHIVE-RESTORED.json 的 homeRewrites）。')
    if report.get('relatedCases'):
        out.append('脚本还引用了其他案例的文件，请用同一个 --out 一并还原：' + '、'.join(report['relatedCases']))
    for item in report.get('notArchived', []):
        out.append(f'{item["file"]}:{item["line"]} 引用的 {item["path"]} 没有归档，已改写到还原目录内，需要时自行放入。')
    for item in report.get('externalHomePaths', []):
        out.append(f'{item["file"]}:{item["line"]} 仍读取真实家目录中的外部依赖（凭据或工具），未改写：{item["reference"]}')
    for item in report.get('unreplacedTokens', []):
        hint = '（需要 --rog-host）' if '@@ROG_HOST@@' in item['tokens'] else ''
        out.append(f'{item["file"]} 仍含未替换的标记 {"、".join(item["tokens"])}{hint}')
    if report.get('lineEndingsRepaired'):
        out.append(f'{len(report["lineEndingsRepaired"])} 个文件在仓库里被改成了 CRLF，已按归档的 LF 原样写出。' + CRLF_HINT)
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['list', 'check', 'restore'])
    p.add_argument('case', nargs='?')
    p.add_argument('--group')
    p.add_argument('--out', type=Path, default=ROOT/'out/casebook')
    p.add_argument('--packs', type=Path, default=ROOT/'out/casebook-packs')
    p.add_argument('--download', action='store_true')
    p.add_argument('--source-only', action='store_true')
    p.add_argument('--lemo', type=Path)
    p.add_argument('--rog-host')
    p.add_argument('--reverify', action='store_true', help='hash packs again even if they passed before')
    a = p.parse_args()
    m = read_manifest()
    try:
        if a.command == 'list':
            for c in m['cases']:
                if not a.group or c['group'] == a.group:
                    print(f'{c["id"]:42} {c["status"]:18} {c["title"]}')
        elif a.command == 'check':
            summary = {}
            n, files = check(m, summary)
            modes = {'checked': ', file modes', 'skipped': '; file modes skipped, see note'}.get(summary.get('fileModes'), '')
            print(f'OK: {n} records, {files} unique source files; paths, SHA256, asset references, '
                  f'home-folder paths and vendor snapshots (inventory, bytes, Git blobs{modes}) checked', flush=True)
            for line in summary['notices']:
                print(f'注意：{line}', file=sys.stderr)
        else:
            if not a.case or not any(c['id'] == a.case for c in m['cases']):
                p.error('restore requires a known case ID; run list first')
            target = restore(m, a.case, a.out, a.packs, a.download, a.source_only, a.lemo, a.rog_host, a.reverify)
            print(target)
            report = json.loads((target/'ARCHIVE-RESTORED.json').read_text(encoding='utf-8'))
            for line in restore_warnings(report):
                print(f'注意：{line}', file=sys.stderr)
    except (ValueError, OSError, zipfile.BadZipFile) as error:    # OSError covers network and file errors
        print(f'错误：{error}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
