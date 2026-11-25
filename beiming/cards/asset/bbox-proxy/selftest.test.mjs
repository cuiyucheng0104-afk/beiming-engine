import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('./proxy.py', import.meta.url));
const SETUP = `
import importlib.util
import json
import math
import sys
from copy import deepcopy
from types import SimpleNamespace

module = importlib.util.spec_from_file_location('proxy', sys.argv[1])
p = importlib.util.module_from_spec(module)
module.loader.exec_module(p)
assert 'bpy' not in sys.modules

spec = {
    'envelope': [-1, -1, -1, 2, 2, 2],
    'parts': [
        {'name': 'body', 'bbox': [0, 0, 0, 0.5, 0.5, 0.5],
         'clearances': [{'against': 'cover', 'minGap': 0.25}]},
        {'name': 'cover', 'size': [0.5, 0.5, 0.5], 'center': [1, 0.25, 0.25]},
        {'name': 'label', 'size': [0.125, 0.125, 0.125], 'required': False},
    ],
}
body = [0, 0, 0, 0.5, 0.5, 0.5]
cover = [0.75, 0, 0, 1.25, 0.5, 0.5]

def rejects(fn, *args):
    try:
        fn(*args)
    except ValueError as exc:
        assert exc.code == 'usage.bad-argument'
    else:
        raise AssertionError('应拒绝非法参数')
`;

function offline(code) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const run = spawnSync(python, ['-B', '-c', SETUP + code, ENTRY], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr || run.stdout);
}

test('包围盒契约有效，必需缺件自动占位，可选件跳过，纯函数确定', () => offline(`
original = deepcopy(spec)
expected = p.validate_bbox_spec(spec)
assert expected['parts'][1]['bbox'] == tuple(cover)
assert p.validate_bbox_spec(expected) == expected
verdict = p.check_bbox_contract(spec, {'body': body})
assert verdict == {'ok': True, 'errors': [], 'missingParts': ['cover', 'label'],
                   'proxiedParts': ['cover'], 'boxes': {'body': tuple(body), 'cover': tuple(cover)}}
strict = p.check_bbox_contract(dict(spec, fallbackMissing=False), {'body': body})
assert not strict['ok'] and strict['errors'] == [{'code': 'missing-part', 'part': 'cover'}]
assert strict['proxiedParts'] == []
assert p.check_bbox_contract(spec, {'cover': cover, 'body': body})['ok']
serialize = lambda: json.dumps(p.check_bbox_contract(spec, {'body': body}), allow_nan=False)
assert serialize() == serialize()
assert spec == original
`));

test('逐轴拦截越界与尺寸偏差，按欧氏 AABB 距离核对让位和容差', () => offline(`
checks = p.check_bbox_contract(spec, {'body': [-1.125, 0, 0, -0.625, 0.25, 0.5]})
assert checks['errors'] == [
    {'code': 'outside-envelope', 'part': 'body', 'axis': 'X', 'overBy': 0.125},
    {'code': 'scale-mismatch', 'part': 'body', 'axis': 'Y', 'expectedSize': 0.5, 'actualSize': 0.25},
]
edge = {'body': body, 'cover': [0.6875, 0, 0, 1.1875, 0.5, 0.5]}
assert p.check_bbox_contract(spec, edge, 0.0625)['ok']
assert p.check_bbox_contract(spec, edge, 0.06249)['errors'] == [
    {'code': 'clearance', 'part': 'body', 'against': 'cover', 'gap': 0.1875, 'minGap': 0.25},
]
diagonal = [0.6875, 0.6875, 0, 1.1875, 1.1875, 0.5]
assert p.check_bbox_contract(spec, {'body': body, 'cover': diagonal}, 0)['ok']
assert p.check_bbox_contract(spec, {'body': body, 'cover': body})['errors'][0]['gap'] == 0
# 检查真件和代理盒之间的让位，也会检查两件均缺失的情形。
proxied = deepcopy(spec)
proxied['parts'][1]['center'][0] = 0.875
assert p.check_bbox_contract(proxied, {})['errors'][0]['code'] == 'clearance'
`));

test('代理网格的八顶点、十二个朝外三角面及轴交换可逆', () => offline(`
g = p.build_proxy_geometry({'bbox': [1, 2, 3, 4, 6, 8]})
assert len(set(g['vertices'])) == 8 and len(set(g['triangles'])) == 12
assert g == p.build_proxy_geometry({'size': [3, 4, 5], 'center': [2.5, 4, 5.5]})
for point in g['vertices']:
    assert p._from_blender(p._to_blender(point)) == point
assert p._to_blender((1, 2, 3)) == (1, -3, 2)
for i, j, k in g['triangles']:
    a, b, c = (g['vertices'][n] for n in (i, j, k))
    u, v = [x-y for x, y in zip(b, a)], [x-y for x, y in zip(c, a)]
    normal = [u[(d+1)%3]*v[(d+2)%3] - u[(d+2)%3]*v[(d+1)%3] for d in range(3)]
    assert sum(n*(x-mid) for n, x, mid in zip(normal, a, [2.5, 4, 5.5])) > 0
`));

test('拒绝非有限数、反转或零宽盒、重名和错误引用以及非法选项', () => offline(`
for part in [
    {'name': 'bad name', 'size': [1, 1, 1]},
    {'name': 'bad', 'bbox': [1, 0, 0, 0, 1, 1]},
    {'name': 'bad', 'bbox': [0, 0, 0, 0, 1, 1]},
    {'name': 'bad', 'bbox': [0, 0, 0, math.nan, 1, 1]},
    {'name': 'bad', 'size': [1, math.inf, 1]},
    {'name': 'bad', 'size': [1, True, 1]},
    {'name': 'bad', 'bbox': body, 'size': [1, 1, 1]},
    {'name': 'bad', 'bbox': body, 'required': 1},
    {'name': 'label', 'bbox': body},
    {'name': 'bad', 'bbox': body, 'clearances': [{'against': 'bad', 'minGap': 0}]},
    {'name': 'bad', 'bbox': body, 'clearances': [{'against': 'typo', 'minGap': 0}]},
    {'name': 'bad', 'bbox': body, 'clearances': [{'against': 'body', 'minGap': -1}]},
]:
    rejects(p.validate_bbox_spec, dict(spec, parts=spec['parts'] + [part]))
rejects(p.validate_bbox_spec, dict(spec, envelope=[]))
rejects(p.validate_bbox_spec, dict(spec, parts=[]))
rejects(p.check_bbox_contract, spec, {'typo': body})
rejects(p.check_bbox_contract, spec, {'body': None})
rejects(p.check_bbox_contract, spec, {}, -0.001)
rejects(p.create, SimpleNamespace(), {'spec': spec, 'envelopeScale': 0})
rejects(p.create, SimpleNamespace(), {'spec': spec, 'fallbackMissing': 1})
`));
