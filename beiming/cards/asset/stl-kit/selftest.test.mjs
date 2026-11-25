import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('./stl_kit.py', import.meta.url));
const SETUP = `
import base64
import hashlib
import importlib.util
import itertools
import json
import math
import struct
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

module = importlib.util.spec_from_file_location('stl_kit', sys.argv[1])
s = importlib.util.module_from_spec(module)
module.loader.exec_module(s)
assert 'bpy' not in sys.modules

a = (0, 0, 0)
b = (1000, 0, 0)
c = (0, 2000, 3000)
facet = struct.pack('<12fH', 0, 0, 1, *a, *b, *c, 0)
header = b'solid binary header'.ljust(80, b' ')
binary = header + struct.pack('<I', 1) + facet
ascii_stl = b'''solid example
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex +1e3 0 0
    vertex 0 2000. 3000
  endloop
endfacet
endsolid example
'''

def rejects(fn, *args, contains=None):
    try:
        fn(*args)
    except ValueError as exc:
        assert exc.code == 'usage.bad-argument'
        if contains is not None:
            assert contains in str(exc), str(exc)
    else:
        raise AssertionError('应拒绝非法输入')
`;

function offline(code) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const run = spawnSync(python, ['-B', '-c', SETUP + code, ENTRY], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr || run.stdout);
}

test('精确识别二进制 STL 和 ASCII STL，毫米转米与 Z 转 +Y', () => offline(`
for data, kind in [(binary, 'binary'), (ascii_stl, 'ascii'), (ascii_stl.replace(b'\\n', b'\\r\\n'), 'ascii')]:
    parsed = s.parse_stl_bytes(data)
    assert parsed['format'] == kind
    vertices = [(0, 0, 0), (1, 0, 0), (0, 3, -2)]
    assert parsed['vertices'] == vertices
    assert parsed['triangles'] == [(0, 1, 2)] and parsed['triangleCount'] == 1
    assert parsed['bbox'] == (0, 0, -2, 1, 3, 0)
    assert parsed['sha256'] == hashlib.sha256(struct.pack('<9d', *vertices[0], *vertices[1], *vertices[2])).hexdigest()
    y = s.parse_stl_bytes(data, 0.002, 'Y')
    assert y['vertices'] == [(0, 0, 0), (2, 0, 0), (0, 4, 6)]
    assert y['bbox'] == (0, 0, 0, 2, 4, 6)
    assert y['sha256'] != parsed['sha256']
mesh = s.parse_stl_bytes(header + struct.pack('<I', 2) + facet * 2)
assert mesh['vertices'] == [(0, 0, 0), (1, 0, 0), (0, 3, -2)]
assert mesh['triangles'] == [(0, 1, 2), (0, 1, 2)]
assert mesh['sha256'] != s.parse_stl_bytes(binary)['sha256']
`));

test('严格拒绝 STL 截断、溢出计数、额外字节、坏文法和 NaN/Inf', () => offline(`
for value in [-math.inf, math.inf, math.nan]:
    damaged = bytearray(binary)
    struct.pack_into('<f', damaged, 96, value)
    rejects(s.parse_stl_bytes, damaged)
for data in [b'', b'\\xff', binary[:83], binary[:-1], binary + b'\\0',
             header + struct.pack('<I', 0), header + struct.pack('<I', 0xffffffff) + facet,
             ascii_stl.replace(b'outer loop', b'loop'), ascii_stl.replace(b'0 2000. 3000', b'0 nan 3000'),
             ascii_stl.replace(b'2000.', b'1_000'), ascii_stl.replace(b'2000.', b'1e999'),
             ascii_stl.replace(b'endsolid example', b'endsolid other'),
             ascii_stl.replace(b'endsolid example', b''), ascii_stl + b'junk',
             ascii_stl.replace(b'endloop', b'vertex 0 1 2 endloop'),
             ascii_stl.replace(b'facet normal', b'facet\\0normal')]:
    rejects(s.parse_stl_bytes, data)
rejects(s.parse_stl_bytes, ascii_stl, True, 'Z')
rejects(s.parse_stl_bytes, ascii_stl, 1, 'X')
rejects(s.parse_stl_bytes, ascii_stl.replace(b'2000.', b'1e308'), 1000)
`));

test('读取文件或内联字节，缺件代理与 error 模式明确分流', () => offline(`
with TemporaryDirectory() as root:
    path = Path(root) / 'body.stl'
    path.write_bytes(binary)
    missing = Path(root) / 'absent.stl'
    kit = {'parts': [
        {'name': 'body', 'path': str(path)},
        {'name': 'trim', 'bytes': base64.b64encode(ascii_stl).decode('ascii')},
        {'name': 'cover', 'path': str(missing), 'fallbackBbox': [2, 1, -3, 3, 2, -2]},
        {'name': 'pin', 'center': [1, 0, 0], 'size': [0.5, 0.5, 0.5]},
    ]}
    loaded = s.load_stl_kit(kit, {})
    assert [p['source'] for p in loaded['parts']] == ['stl', 'stl', 'proxy', 'proxy']
    assert [p['triangleCount'] for p in loaded['parts']] == [1, 1, 12, 12]
    assert loaded['parts'][2]['bbox'] == (2, 1, -3, 3, 2, -2)
    assert loaded['parts'][3]['bbox'] == (0.75, -0.25, -0.25, 1.25, 0.25, 0.25)
    assert len(loaded['parts'][2]['vertices']) == 8
    rejects(s.load_stl_kit, kit, {'missingPolicy': 'error'}, contains='cover')
    rejects(s.load_stl_kit, {'parts': [{'name': 'none', 'path': str(missing)}]}, {}, contains='代理尺寸')
    path.write_bytes(binary[:-1])
    rejects(s.load_stl_kit, {'parts': [{'name': 'bad', 'path': str(path), 'size': [1, 1, 1]}]}, {})
    rejects(s.load_stl_kit, {'parts': [{'name': 'dir', 'path': root, 'size': [1, 1, 1]}]}, {}, contains='不可读')
for opts in [{'unitScale': 0}, {'upAxis': 'z'}, {'missingPolicy': 'skip'}, {'inventoryViews': 1}]:
    rejects(s.load_stl_kit, kit, opts)
for part in [{'name': 'bad', 'bytes': '!!!='}, {'name': 'bad', 'bytes': [True]},
             {'name': 'bad', 'bytes': [256]}, {'name': 'bad', 'bytes': [], 'size': [1, 1, 1]},
             {'name': 'bad', 'path': 'file.stl', 'bytes': list(binary)},
             {'name': 'bad', 'size': [1, 1, 1], 'fallbackBbox': [0, 0, 0, 1, 1, 1]}]:
    rejects(s.load_stl_kit, {'parts': [part]}, {})
`));

test('四视图包含偏心合并盒的每个角点，完整盘点两遍逐字节相同', () => offline(`
kit = {'parts': [{'name': 'real', 'bytes': list(binary)},
                 {'name': 'placeholder', 'fallbackBbox': [10, -1, -3, 12, 0, -2]}]}
loaded = s.load_stl_kit(kit, {})
assert json.dumps(loaded, allow_nan=False) == json.dumps(s.load_stl_kit(kit, {}), allow_nan=False)
inv, views = loaded['inventory'], loaded['views']
assert [inv[k] for k in ['partCount', 'loadedCount', 'proxiedCount', 'totalTriangles']] == [2, 1, 1, 13]
assert inv['bounds'] == (0, -1, -3, 12, 3, 0)
assert [p['name'] for p in inv['parts']] == ['real', 'placeholder']
assert set(inv['parts'][0]) == {'name', 'source', 'triangleCount', 'bbox', 'sha256'}
assert list(views) == ['front', 'side', 'top', 'iso']
assert s.build_inventory_four_views(inv['parts']) == {'inventory': inv, 'views': views}
assert s.load_stl_kit(kit, {'inventoryViews': False})['inventory'] == inv
assert s.load_stl_kit(kit, {'inventoryViews': False})['views'] == {}
assert s.build_inventory_four_views(inv['parts'], 20)['views']['front']['distance'] > views['front']['distance']
for view in views.values():
    eye, target, up = (view[k] for k in ('eye', 'target', 'up'))
    d = view['distance']
    assert target == (6, 1, -1.5) and view['bbox'] == inv['bounds']
    forward = [(t-e)/d for t, e in zip(target, eye)]
    right = [forward[(i+1)%3]*up[(i+2)%3] - forward[(i+2)%3]*up[(i+1)%3] for i in range(3)]
    assert math.isclose(math.hypot(*forward), 1) and math.isclose(math.hypot(*right), 1)
    for corner in itertools.product(*zip(inv['bounds'][:3], inv['bounds'][3:])):
        v = [c-e for c, e in zip(corner, eye)]
        dot = lambda u: sum(a*b for a, b in zip(v, u))
        depth = dot(forward)
        assert depth > 0 and max(abs(dot(up)), abs(dot(right))) < depth*math.tan(math.radians(17.5))
for fov in [0, 180, -1, math.nan]:
    rejects(s.build_inventory_four_views, inv['parts'], fov)
`));
