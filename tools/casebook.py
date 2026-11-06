#!/usr/bin/env python3
"""Inspect and restore the deduplicated historical case archive. Never executes builds."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'cases'


def digest(data):
    return hashlib.sha256(data).hexdigest()


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


def verify_bytes(data, item):
    if len(data) != item['size'] or digest(data) != item['sha256']:
        raise ValueError(f'Checksum mismatch: {item.get("path", item.get("filename", "blob"))}')


def check(manifest):
    ids = set()
    checked = set()
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
                if p not in checked:
                    verify_bytes(p.read_bytes(), item)
                    checked.add(p)
            else:
                asset = manifest['assets'][item['asset']]
                if asset['pack'] not in packs or asset['size'] != item['size'] or item['asset'] != item['sha256']:
                    raise ValueError(f'Invalid asset reference: {item["path"]}')
        if any(p not in {f['path'] for f in case['files']} for p in case['entrypoints']):
            raise ValueError(f'Missing entry point: {case["id"]}')
    lock = ARCHIVE / 'vendor/lock.json'
    if lock.exists():
        for repo in json.loads(lock.read_text(encoding='utf-8'))['repositories']:
            folder = safe_path(ARCHIVE, repo['path'])
            expected = {f['path'] for f in repo['files']}
            actual = {p.relative_to(folder).as_posix() for p in folder.rglob('*')
                      if p.is_file() and not any(x in p.relative_to(folder).parts
                      for x in ['node_modules', '.venv', '__pycache__'])}
            if actual != expected:
                raise ValueError(f'Vendor snapshot inventory changed: {repo["name"]}')
            for item in repo['files']:
                data = safe_path(folder, item['path']).read_bytes()
                verify_bytes(data, item)
                blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
                if blob != item['gitBlob']:
                    raise ValueError(f'Vendor Git blob mismatch: {item["path"]}')
    return len(ids), len(checked)


def get_pack(meta, directory, download):
    p = safe_path(directory, meta['filename'])
    if not p.exists():
        if not download:
            raise FileNotFoundError(f'Missing {p}; download from {meta["url"]} or add --download')
        if not meta['url'].startswith('https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/'):
            raise ValueError('Unexpected download origin')
        directory.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, suffix='.partial')
        try:
            with os.fdopen(fd, 'wb') as out, urllib.request.urlopen(meta['url'], timeout=60) as response:
                shutil.copyfileobj(response, out)
            verify_bytes(Path(tmp).read_bytes(), meta)
            Path(tmp).replace(p)
        finally:
            Path(tmp).unlink(missing_ok=True)
    verify_bytes(p.read_bytes(), meta)
    return p


def restore(manifest, case_id, output, pack_dir, download=False, source_only=False, lemo=None, rog=None):
    case = next(c for c in manifest['cases'] if c['id'] == case_id)
    target = safe_path(output, case['workspacePath'])
    if target.exists():
        raise FileExistsError(f'Refusing to overwrite existing directory: {target}')
    # Validate all destinations before creating a directory or downloading anything.
    for item in case['files']:
        safe_path(target, item['path'])
    packs = {p['filename']: p for p in manifest['packs']}
    needed = {manifest['assets'][f['asset']]['pack'] for f in case['files'] if 'asset' in f} if not source_only else set()
    opened = {}
    temp = None
    try:
        for name in sorted(needed):
            opened[name] = zipfile.ZipFile(get_pack(packs[name], pack_dir, download))
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = Path(tempfile.mkdtemp(prefix='.case-restore-', dir=target.parent))
        tokens = {'@@CASE_ROOT@@': target.resolve().as_posix(), '@@WORKSPACE_ROOT@@': output.resolve().as_posix(),
                  '@@LEMO_ROOT@@': (lemo or ARCHIVE/'vendor/lemo-opuscar').resolve().as_posix()}
        if rog:
            tokens['@@ROG_HOST@@'] = rog
        for item in case['files']:
            if 'source' in item:
                data = safe_path(ARCHIVE, item['source']).read_bytes()
            elif source_only:
                continue
            else:
                data = opened[manifest['assets'][item['asset']]['pack']].read(item['asset'])
            verify_bytes(data, item)
            if item.get('templated'):
                text = data.decode('utf-8')
                # JSON/string literal paths use forward slashes, valid on Windows and POSIX.
                for old, new in tokens.items():
                    text = text.replace(old, new)
                data = text.encode('utf-8')
            dest = safe_path(temp, item['path'])
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            if item.get('executable'):
                dest.chmod(0o755)
        report = {'case': case_id, 'sourceOnly': source_only, 'entries': case['entrypoints'],
                  'requirements': case['requirements'], 'notes': case['notes'],
                  'warning': 'Historical archive restored; no film was rendered or visually approved by this command.'}
        (temp/'ARCHIVE-RESTORED.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        temp.rename(target)
        temp = None
    finally:
        for z in opened.values():
            z.close()
        if temp:
            shutil.rmtree(temp)
    return target


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
    a = p.parse_args()
    m = read_manifest()
    if a.command == 'list':
        for c in m['cases']:
            if not a.group or c['group'] == a.group:
                print(f'{c["id"]:42} {c["status"]:18} {c["title"]}')
    elif a.command == 'check':
        n, files = check(m)
        print(f'OK: {n} records, {files} unique source files; paths, SHA256 and asset references checked')
    else:
        if not a.case or not any(c['id'] == a.case for c in m['cases']):
            p.error('restore requires a known case ID; run list first')
        print(restore(m, a.case, a.out, a.packs, a.download, a.source_only, a.lemo, a.rog_host))


if __name__ == '__main__':
    main()
