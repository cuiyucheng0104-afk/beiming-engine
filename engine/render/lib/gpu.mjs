// 北冥引擎 · GPU 后端与浏览器：选 ANGLE 后端（按平台校验）、启动无头 Chrome、读实际 GPU、按 --gpu 策略判软件渲染。
// 渲染器（page.mjs）与 GPU 自检（tools/rtx/gpucheck.mjs）用的是同一个 launchBrowser，所以自检结果就是渲染时的结果。
//
//   resolveAngle(value?)        ANGLE 后端：参数 > BEIMING_ANGLE > 平台默认（macOS metal、Windows vulkan、Linux default）。
//                               先转小写去空格，再按平台校验：metal 只用于 macOS，d3d11 / d3d9 只用于 Windows；
//                               不认识或平台不对 → usage.angle（退出码 2）。'default' 表示不传 --use-angle，由 Chrome 自己选
//   chromeArgs(angle)           启动参数（改这里会改变画面：先出基线再比对）
//   chromeExecutable()          BEIMING_CHROME 指定的浏览器；没设用 Playwright 自带的 chromium-headless-shell
//   launchBrowser({ angle })    启动浏览器；Playwright 不接管信号（渲染脚本自己收尾）
//   probeGpu(page)              { renderer, vendor, webgl2 }：页面里新建一个 WebGL2 上下文读 UNMASKED_RENDERER
//   isSoftwareRenderer(name)    SwiftShader、llvmpipe / softpipe、Windows WARP（Microsoft Basic Render Driver）
//   resolveGpuPolicy(value?)    --gpu：required（默认，软件渲染判失败，退出码 3）| any（允许软件渲染，记一条提示）|
//                               software-ok（明确要软件渲染：CI 冒烟、资产烘焙，不提示）；没写参数时读 BEIMING_GPU（同样校验，写错退出码 2）
//   enforceGpu(info, policy)    按策略判定：要硬件却是软件 → env.software-gl、没有 WebGL2 → env.webgl-unavailable（退出码 3），带修复提示
import { RenderError } from './errors.mjs';

// playwright-core 用到时才加载：封装（lib/mux.mjs）、--help、参数校验都不需要装好 npm 依赖
async function chromiumLib() {
  try { return (await import('playwright-core')).chromium; } catch (e) {
    throw new RenderError('env.playwright-missing', `加载不了 playwright-core（${String(e?.message ?? e).split('\n')[0]}）`, { hint: '在仓库根运行 npm ci（或 npm run setup），装好锁定版本的 npm 依赖与 headless shell' });
  }
}

const VALID = {
  darwin: ['metal', 'gl', 'swiftshader', 'default'],
  win32: ['vulkan', 'd3d11', 'd3d9', 'gl', 'swiftshader', 'default'],
  linux: ['vulkan', 'gl', 'gles', 'swiftshader', 'default'],
};
const DEFAULT = { darwin: 'metal', win32: 'vulkan', linux: 'default' };
export const GPU_POLICIES = Object.freeze(['required', 'any', 'software-ok']);

export function validAngles(platform = process.platform) { return VALID[platform] ?? VALID.linux; }
export function platformDefaultAngle(platform = process.platform) { return DEFAULT[platform] ?? 'default'; }

/** 解析并校验 ANGLE 后端；source 记录取值来源（写进 run.json） */
export function resolveAngle(value, { platform = process.platform, env = process.env } = {}) {
  const raw = value ?? env.BEIMING_ANGLE;
  const source = value !== undefined && value !== null ? '--angle' : env.BEIMING_ANGLE !== undefined && env.BEIMING_ANGLE !== '' ? 'BEIMING_ANGLE' : 'platform-default';
  if (raw === undefined || raw === null || String(raw).trim() === '') return { angle: platformDefaultAngle(platform), source: 'platform-default' };
  const angle = String(raw).trim().toLowerCase();
  const valid = validAngles(platform);
  if (!valid.includes(angle)) {
    const where = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform] ?? platform;
    const hint = angle === 'vulkan' && platform === 'darwin' ? 'macOS 上用 metal（vulkan 在 Mac 上会静默落到软件渲染）'
      : angle === 'metal' && platform !== 'darwin' ? 'metal 只有 macOS 有；Windows 的 NVIDIA 显卡用 vulkan'
      : `可用：${valid.join(' / ')}；不确定就运行 node tools/rtx/gpucheck.mjs 看哪个后端落在硬件 GPU 上`;
    throw new RenderError('usage.angle', `${source === '--angle' ? '--angle' : 'BEIMING_ANGLE'}=${raw} 在 ${where} 上不可用`, { hint });
  }
  return { angle, source };
}

/** 兼容旧接口：渲染器实际会用的后端（不合法时也只返回原值，由 resolveAngle 报错） */
export const defaultAngle = () => {
  try { return resolveAngle().angle; } catch { return String(process.env.BEIMING_ANGLE).trim().toLowerCase(); }
};
export const chromeExecutable = () => process.env.BEIMING_CHROME || undefined;
export function chromeArgs(angle = defaultAngle()) {
  return [
    ...(angle === 'default' ? [] : [`--use-angle=${angle}`]),
    '--enable-gpu', '--ignore-gpu-blocklist', '--font-render-hinting=none', '--force-color-profile=srgb',
  ];
}

// 软件光栅：SwiftShader、Mesa llvmpipe / softpipe、Windows 的 WARP（"Microsoft Basic Render Driver"）
export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|\bwarp\b/i;
export const isSoftwareRenderer = name => SOFTWARE_RENDERER.test(String(name || ''));

export function resolveGpuPolicy(value, { env = process.env } = {}) {
  const raw = value ?? (env.BEIMING_GPU || 'required');   // value 是 --gpu（null / undefined 表示没写）
  const p = String(raw).trim().toLowerCase();
  if (!GPU_POLICIES.includes(p)) throw new RenderError('usage.gpu-policy', `${value !== undefined && value !== null ? '--gpu' : 'BEIMING_GPU'}=${raw} 不认识`, { hint: `只能是 ${GPU_POLICIES.join(' | ')}；CI 冒烟与没有 GPU 的机器用 software-ok` });
  return p;
}

/**
 * 启动浏览器。Playwright 默认不接管信号（handleSignals=false）：调用方自己清理；库调用方可以传 true。
 * 浏览器启动失败（没装 headless shell、BEIMING_CHROME 指错）→ env.browser-launch（退出码 3）。
 */
export async function launchBrowser({ angle = defaultAngle(), handleSignals = false, executablePath = chromeExecutable() } = {}) {
  const chromium = await chromiumLib();
  try {
    return await chromium.launch({
      executablePath, args: chromeArgs(angle),
      handleSIGINT: handleSignals, handleSIGTERM: handleSignals, handleSIGHUP: handleSignals,
    });
  } catch (e) {
    const first = String(e?.message ?? e).split('\n').find(l => l.trim()) ?? '';
    const missing = /Executable doesn't exist|ENOENT|not found/i.test(String(e?.message));
    throw new RenderError('env.browser-launch', `无头浏览器起不来：${first}`, {
      hint: missing ? (executablePath ? `BEIMING_CHROME=${executablePath} 指向的文件不存在` : '运行 npm run setup 安装 Playwright 自带的 chromium-headless-shell（版本与 package.json 锁定的 playwright-core 一致）')
        : '检查 BEIMING_CHROME 与显卡驱动；node tools/rtx/gpucheck.mjs 可逐个后端试',
    });
  }
}

/** 在页面里读实际 GPU（新建一个小 WebGL2 画布，不碰页面自己的画布；不调 loseContext，免得触发上下文丢失监测） */
export async function probeGpu(page) {
  return page.evaluate(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2');
    if (!g) return { renderer: '', vendor: '', webgl2: false };
    const e = g.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: e ? String(g.getParameter(e.UNMASKED_RENDERER_WEBGL)) : String(g.getParameter(g.RENDERER)),
      vendor: e ? String(g.getParameter(e.UNMASKED_VENDOR_WEBGL)) : String(g.getParameter(g.VENDOR)),
      webgl2: true,
    };
  });
}

/** 按策略判定 GPU；返回要写进 run.json 的 { software, warnings[] } */
export function enforceGpu({ renderer, webgl2 }, policy, { angle } = {}) {
  const software = isSoftwareRenderer(renderer);
  const fix = `检查 BEIMING_ANGLE（现在是 ${angle}）与显卡驱动，运行 node tools/rtx/gpucheck.mjs 看哪个后端落在硬件 GPU 上；`
    + '确实要用软件渲染（CI 冒烟、没有 GPU 的机器）就加 --gpu software-ok';
  if (!webgl2 && policy !== 'software-ok') {
    throw new RenderError('env.webgl-unavailable', `浏览器建不起 WebGL2 上下文（ANGLE 后端 ${angle}）`, { hint: fix });
  }
  if (software && policy === 'required') {
    throw new RenderError('env.software-gl', `WebGL 落到了软件渲染（${String(renderer).slice(0, 100)}）：慢几十倍，画面也与硬件 GPU 不同`, { hint: fix });
  }
  const warnings = software && policy === 'any' ? [`WebGL 正在用软件渲染（${String(renderer).slice(0, 80)}）：--gpu any 放行，画面与硬件 GPU 不同`] : [];
  return { software, warnings };
}
