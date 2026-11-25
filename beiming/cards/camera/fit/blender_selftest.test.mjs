import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { findBlender } from '../../../sources/blender/host.mjs';
import { evaluate } from './evaluate.mjs';

const ENTRY = fileURLToPath(new URL('./index.py', import.meta.url));
const setup = `
import importlib.util, json, sys, types
sys.dont_write_bytecode = True
entry, params = sys.argv[-2:]
params = json.loads(params)
spec = importlib.util.spec_from_file_location('card_fit', entry)
card = importlib.util.module_from_spec(spec)
spec.loader.exec_module(card)
`;
const probe = `
handle = card.create(ctx, params)
cam = handle['object']
rows = []
for f in (2, 0, 1, 2, -1, 3):
    pose = handle['sample'](f, 0.5)
    handle['apply'](f, 0.5)
    assert handle['meta'](f)['readings']['distance'] == pose['distance']
    rows.append(dict(pose=pose, location=list(cam.location), rotation=list(cam.rotation_quaternion),
                     fov=cam.data.angle_y, near=cam.data.clip_start))
assert cam.type == 'CAMERA' and cam.data.sensor_fit == 'VERTICAL'
name, data_name = cam.name, cam.data.name
handle['dispose']()
handle['dispose']()
assert name not in ctx.bpy.data.objects and data_name not in ctx.bpy.data.cameras
print('FIT_RESULT:' + json.dumps(rows))
`;
const fake = `
class Data(dict):
    def new(self, name, data=None):
        self[name] = value = types.SimpleNamespace(name=name)
        if data is not None:
            value.data = data
            value.type = 'CAMERA'
        return value
    def remove(self, value, **kwargs):
        del self[value.name]
bpy = types.SimpleNamespace(data=types.SimpleNamespace(cameras=Data(), objects=Data()))
scene = types.SimpleNamespace(collection=types.SimpleNamespace(objects=types.SimpleNamespace(link=lambda obj: None)))
ctx = types.SimpleNamespace(bpy=bpy, hostScene=scene, size=[320, 200])
`;
const fixture = {
  bboxes: [{ min: [-0.2, 0, -0.1], max: [0.3, 0.1, 0.2] }, { min: [-2, 0, -1], max: [1, 2, 3] }, { min: [0, -1, 0], max: [1, 0, 2] }],
  aspect: 1.6, azimuthDeg: 47, elevationDeg: -12, fovYDeg: 60, nearClipM: 0.03,
  groundY: 0, groundClearanceM: 0.1, windowFrames: 2, smoothAlpha: 0.5,
};

function run(command, args, params) {
  const result = spawnSync(command, [...args, ENTRY, JSON.stringify(params)], {
    encoding: 'utf8', timeout: 45000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith('FIT_RESULT:')).slice('FIT_RESULT:'.length));
}
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);
function check(rows, params, eps) {
  [2, 0, 1, 2, -1, 3].forEach((f, i) => {
    const { pose, location, rotation, fov, near: clip } = rows[i];
    const ref = evaluate({}, params, f, 0.5);
    near(pose.distance, ref.distance, 1e-12);
    for (const [observed, expected] of [[pose.position, ref.camera.pos], [pose.target, ref.target], [pose.quaternion, ref.camera.quat]]) {
      observed.forEach((x, j) => near(x, expected[j], 1e-12));
    }
    const [x, y, z] = pose.position;
    location.forEach((v, j) => near(v, [x, -z, y][j], eps));
    const [a, b, c, d] = pose.quaternion, h = Math.SQRT1_2;
    rotation.forEach((v, j) => near(v, [h * (d - a), h * (d + a), h * (b - c), h * (b + c)][j], eps));
    near(fov, ref.camera.fovDeg * Math.PI / 180, eps);
    near(clip, params.nearClipM ?? 0.05, eps);
  });
  assert.deepEqual(rows[0], rows[3]);
}

const PYTHON = fileURLToPath(new URL('../../../../tools/env/py.mjs', import.meta.url));
test('camera.fit Blender：独立进程中动态轨道与 JS 对拍，静态整圈回退及相机释放', () => {
  for (const params of [fixture, { ...fixture, view: 'orbit', elevationDeg: 15 }, { view: 'orbit', azimuthDeg: -60, elevationDeg: -20 }]) {
    check(run(process.execPath, [PYTHON, '-I', '-B', '-c', setup + fake + probe], params), params, 1e-12);
  }
});

const blender = findBlender();
test('camera.fit Blender：真实相机姿态、竖直视场角、近裁剪面和释放', { skip: !blender }, () => {
  const context = `\nimport bpy\nctx = types.SimpleNamespace(bpy=bpy, hostScene=bpy.context.scene, size=[320, 200])\n`;
  check(run(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '--python-expr', setup + context + probe, '--'], fixture), fixture, 5e-6);
});
