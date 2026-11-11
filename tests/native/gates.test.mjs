// B 路线出片入口的两道闸（engine/render/native.mjs，审查要求的回归）：用假的原生运行时（sh 脚本，BNE_ALLOW_VERSION 放行）在临时 git 仓库里跑
//   · GPU 守卫：ComfyUI 队列有任务时，草图帧（--at）也 exit 5（busy.comfy），而且不建运行目录
//   · 运行时自带的成片检查：check 写出 P1 问题 → exit 4（contract.raea-check），run.json 的 checks.raeaCheck.ok = false
//   · 运行目录建好之后的失败：--json 信封照样给出 runJson 与已经产出的文件（编排器据此找 run.json、成片与日志）
// 假运行时的 render 用 FFmpeg 造一段 1 秒的纯色 H.264（BT.709 有限范围），check 按环境变量写出结果；不启动 GPU、不需要真的运行时。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { specHash } from '../../engine/native/prepare.mjs';

const ENTRY = fileURLToPath(new URL('../../engine/render/native.mjs', import.meta.url));
const ff = process.env.FFMPEG || 'ffmpeg';
const hasFFmpeg = spawnSync(ff, ['-hide_banner', '-version'], { timeout: 10000 }).status === 0 && /libx264/.test(spawnSync(ff, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000 }).stdout);
const skip = (!hasFFmpeg && '本机没有带 libx264 的 FFmpeg') || (process.platform === 'win32' && '假运行时是 sh 脚本');
const sha = buf => createHash('sha256').update(buf).digest('hex');

// 假运行时：render 按 -o 写一段 1920×1080、24 帧的纯色视频（BNE_TEST_RENDER_FAIL 时报 ERROR 并 exit 1）；check 写 BNE_TEST_CHECK 给的 JSON
const FAKE = `#!/bin/sh
cmd="$1"; shift
out=""; man=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; --manifest) man="$2"; shift 2;; *) shift;; esac; done
case "$cmd" in
  render)
    if [ -n "$BNE_TEST_RENDER_FAIL" ]; then echo "ERROR shader: 测试用的编译失败" >&2; exit 1; fi
    "$BNE_TEST_FFMPEG" -hide_banner -loglevel error -nostdin -y -f lavfi -i "color=c=0x334455:s=1920x1080:r=24" -frames:v 24 -c:v libx264 -preset ultrafast \\
      -pix_fmt yuv420p -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv "$out" || exit 1
    [ -n "$man" ] && echo '{}' > "$man"
    exit 0;;
  check) printf '%s' "$BNE_TEST_CHECK" > "$out"; exit 0;;
  *) echo usage;;
esac
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bne-gates-'));
  const rt = join(root, 'rt', 'raea');
  mkdirSync(join(rt, 'bin'), { recursive: true });
  mkdirSync(join(rt, 'share', 'raea'), { recursive: true });
  const exe = join(rt, 'bin', 'raea');
  writeFileSync(exe, FAKE);
  chmodSync(exe, 0o755);
  writeFileSync(join(rt, 'share', 'raea', 'VERSION'), '9.9.9-test\n');
  const film = join(root, 'films', 'gate');
  mkdirSync(join(film, 'media'), { recursive: true });
  const native = { entry: 'film.tsx', images: [{ to: 'sky.png', from: 'sky-src.png' }] };
  writeFileSync(join(film, 'film.json'), JSON.stringify({ route: 'b', title: '闸门', dur: 1, fps: 24, size: [1920, 1080], native }));
  writeFileSync(join(film, 'film.tsx'), "import { staticFile } from 'raea';\nexport const sky = staticFile('sky.png');\n");
  writeFileSync(join(film, 'media', 'sky.png'), 'not really a png');
  const specs = Object.fromEntries(['images', 'models', 'sequences', 'audio'].map(k => [k, specHash(native, k)]));
  writeFileSync(join(film, 'media', 'prepared.json'), JSON.stringify({ schemaVersion: 1, assets: { 'sky.png': sha(Buffer.from('not really a png')) }, specs }));
  spawnSync('git', ['init', '-q'], { cwd: root, timeout: 30000 });
  // COMFY_URL 指向关着的端口：开发机上真有 ComfyUI 在跑时也不受影响（查不到队列只记录）
  const env = { ...process.env, RAEA_BIN: exe, BNE_ALLOW_VERSION: '9.9.9-test', BNE_TEST_FFMPEG: ff, COMFY_URL: 'http://127.0.0.1:9' };
  return { root, film, env };
}

// 异步跑入口（同一进程里起了 HTTP 服务时不能用 spawnSync：会把事件循环卡住）
function runEntry(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [ENTRY, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

test('GPU 守卫：ComfyUI 队列有任务时草图帧（--at）也 exit 5（busy.comfy），不建运行目录', { skip }, async () => {
  const s = setup();
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/queue' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ queue_running: [[1, 'job']], queue_pending: [] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await runEntry([s.film, '--at', '0,1', '--json'], { ...s.env, COMFY_URL: `http://127.0.0.1:${server.address().port}` });
    assert.equal(r.code, 5, r.err);
    const e = JSON.parse(r.out);
    assert.equal(e.error.code, 'busy.comfy');
    assert.match(e.error.hint, /从不终止别人的任务/);
    assert.equal(e.runJson, null);
    assert.equal(existsSync(join(s.film, 'out')), false, '守卫拦下时不建运行目录');
  } finally {
    await new Promise(r => server.close(r));
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('成片检查有 P1 问题：exit 4，run.json 记 checks.raeaCheck.ok = false；信封给出 runJson 与已产出的成片', { skip }, async () => {
  const s = setup();
  try {
    const check = { passed: ['响度'], issues: [{ p: 'P1', says: '字幕被裁切（测试）', at: 0.5 }] };
    const r = await runEntry([s.film, '--run-id', 'p1', '--json'], { ...s.env, BNE_TEST_CHECK: JSON.stringify(check) });
    assert.equal(r.code, 4, r.err);
    const e = JSON.parse(r.out);
    assert.equal(e.error.code, 'contract.raea-check');
    const runJson = join(s.film, 'out', 'p1', 'run.json');
    assert.equal(e.runJson, runJson, '运行目录在仓库外时信封写绝对路径');
    const record = JSON.parse(readFileSync(runJson, 'utf8'));
    assert.equal(record.status, 'failed');
    assert.equal(record.error.code, 'contract.raea-check');
    assert.equal(record.checks.raeaCheck.ok, false);
    assert.deepEqual(record.checks.raeaCheck.issues, check.issues);
    const kinds = e.outputs.map(o => o.kind);
    for (const k of ['master', 'web', 'run-json', 'raea-check', 'contact-sheet', 'player', 'log']) assert.ok(kinds.includes(k), `信封 outputs 缺 ${k}：${kinds.join('、')}`);
    assert.equal(e.outputs.find(o => o.kind === 'master').sha256, record.outputs.master.sha256);
    assert.equal(existsSync(join(s.film, 'out', 'latest')), false, '失败的运行不更新 out/latest');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('原生渲染失败（运行时报 ERROR、exit 1）：exit 1，信封仍给出 runJson 与 render.log', { skip }, async () => {
  const s = setup();
  try {
    const r = await runEntry([s.film, '--run-id', 'boom', '--json'], { ...s.env, BNE_TEST_RENDER_FAIL: '1' });
    assert.equal(r.code, 1, r.err);
    const e = JSON.parse(r.out);
    assert.equal(e.error.code, 'failure.native-render');
    assert.match(e.error.message, /测试用的编译失败/);
    assert.equal(e.runJson, join(s.film, 'out', 'boom', 'run.json'));
    assert.deepEqual(e.outputs.map(o => o.kind).sort(), ['log', 'run-json']);
    assert.equal(JSON.parse(readFileSync(e.runJson, 'utf8')).status, 'failed');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
