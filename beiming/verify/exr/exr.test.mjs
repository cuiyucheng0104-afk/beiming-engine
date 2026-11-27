import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeExr, readExr, isPassChannel } from './exr.mjs';

const python = fileURLToPath(new URL('./exr.py', import.meta.url));
function run(tool, args, input) {
  const result = spawnSync(tool, args, { input });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}
const bytes = plane => Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength);
const width = 64, height = 3;
const channels = Object.fromEntries(['normal.X', 'color.R', 'depth.Z', 'motion.Y', 'objectId.coverage'].map((name, c) =>
  [name, Float32Array.from({ length: width * height }, (_, i) => [0, -0, 16.5, 1e-6, -2.25][(i + c) % 5])]));
channels['objectId.id'] = Uint32Array.from({ length: width * height }, (_, i) => 0xffffffff - i);
for (const compression of [0, 2]) {
  test(`压缩方式 ${compression} 的双端逐位往返`, () => {
    const encoded = writeExr({ width, height, channels, compression });
    const returned = run('python3', [python, ...Object.keys(channels)], encoded);
    const decoded = readExr(returned, { requiredChannels: Object.keys(channels) });
    assert.deepEqual([decoded.width, decoded.height, decoded.compression], [width, height, compression]);
    assert.deepEqual(Object.keys(decoded.channels), Object.keys(channels).sort());
    for (const [name, original] of Object.entries(channels)) {
      assert.equal(decoded.channels[name].constructor, original.constructor);
      assert.equal(Buffer.compare(bytes(decoded.channels[name]), bytes(original)), 0, name);
    }
    if (compression === 2) assert.ok(encoded.length < writeExr({ width, height, channels }).length);
  });
}

test('单像素 ZIPS 原行回退与缺失通道', () => {
  const input = Float32Array.of(-0);
  const encoded = writeExr({ width: 1, height: 1, channels: { 'color.R': input }, compression: 2 });
  assert.deepEqual(encoded.subarray(-4), bytes(input));
  const output = run('python3', [python], encoded);
  assert.equal(Buffer.compare(bytes(readExr(output).channels['color.R']), bytes(input)), 0);
  assert.throws(() => readExr(encoded, { requiredChannels: ['depth.Z'] }), /缺少通道 depth\.Z/);
  const rejected = spawnSync('python3', [python, 'depth.Z'], { input: encoded });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr.toString(), /缺少通道 depth\.Z/);
  assert.throws(() => readExr(encoded.subarray(0, -1)), /数据截断/);
});

test('双端通道名与契约分量一致', () => {
  const valid = ['color.A', 'depth.Z', 'objectId.id', 'objectId.coverage', 'normal.Z', 'motion.Y',
    'denoiseAlbedo.B', 'denoiseNormal.X', 'diffuseDirect.R', 'environment.B', 'lightgroup:rim-1.G'];
  const invalid = ['depth.R', 'motion.Z', 'objectId.ID', 'lightgroup:-bad.R', 'color.R.X', 'constructor.R', 'emission.A', 'diffuseDirekt.R'];
  const names = [...valid, ...invalid];
  const expected = names.map(n => valid.includes(n));
  assert.deepEqual(names.map(isPassChannel), expected);
  const check = 'import sys,runpy,json; f=runpy.run_path(sys.argv[1])["is_pass_channel"]; print(json.dumps([f(n) for n in sys.argv[2:]]))';
  assert.deepEqual(JSON.parse(run('python3', ['-B', '-c', check, python, ...names])), expected);
});

test('与 FFmpeg 独立编解码器双向核对扫描线', t => {
  if (spawnSync('ffmpeg', ['-version']).error?.code === 'ENOENT') return t.skip('环境缺少 ffmpeg');
  const planes = { G: channels['color.R'], B: channels['normal.X'], R: channels['motion.Y'] };
  const raw = Buffer.concat(Object.values(planes).map(bytes));
  const base = ['-hide_banner', '-v', 'error'];
  for (const compression of [0, 2]) {
    const external = run('ffmpeg', [...base, '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', `${width}x${height}`,
      '-i', 'pipe:0', '-vf', 'setsar=1', '-frames:v', '1', '-c:v', 'exr', '-compression', String(compression), '-f', 'image2pipe', 'pipe:1'], raw);
    const decoded = readExr(external);
    for (const [n, p] of Object.entries(planes)) assert.equal(Buffer.compare(bytes(decoded.channels[n]), bytes(p)), 0);
    const encoded = writeExr({ width, height, channels: planes, compression });
    const externalRaw = run('ffmpeg', [...base, '-c:v', 'exr', '-f', 'image2pipe', '-frame_size', String(encoded.length), '-i', 'pipe:0', '-frames:v', '1',
      '-pix_fmt', 'gbrpf32le', '-f', 'rawvideo', 'pipe:1'], encoded);
    assert.equal(Buffer.compare(externalRaw, raw), 0);
  }
});

test('非零数据窗口和逆序存放的扫描线按偏移寻址', () => {
  const original = Float32Array.of(5, 6);
  const file = writeExr({ width: 1, height: 2, channels: { 'depth.Z': original } });
  const box = file.indexOf(Buffer.from('dataWindow\0box2i\0')) + 21;
  for (const [i, bound] of [-3, 7, -3, 8].entries()) file.writeInt32LE(bound, box + i * 4);
  const order = file.indexOf(Buffer.from('lineOrder\0lineOrder\0')) + 24;
  file[order] = 1;
  const table = file.length - 40, first = table + 16, second = first + 12;
  file.writeBigUInt64LE(BigInt(second), table);
  file.writeBigUInt64LE(BigInt(first), table + 8);
  file.writeInt32LE(8, first); file.writeFloatLE(6, first + 8);
  file.writeInt32LE(7, second); file.writeFloatLE(5, second + 8);
  for (const encoded of [file, run('python3', [python], file)]) {
    assert.equal(Buffer.compare(bytes(readExr(encoded).channels['depth.Z']), bytes(original)), 0);
  }
});
