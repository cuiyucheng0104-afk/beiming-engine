// deliver.encode 在合成一侧的实现：母版的预设名换成一组写明的编码设置。这张卡自己不编码。
// 合成宿主怎么用 Handle 还没有契约，这里定的用法写在卡文件的 ports.requires 里：合成工具读 Handle.object。

const PRESETS = {
  // H.264，恒定质量系数 14；4:2:0 八位；BT.709 的基色、传递函数和矩阵，有限范围；MP4
  'h264-crf14-bt709': { container: 'mp4', codec: 'h264', crf: 14, pixelFormat: 'yuv420p', primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited' },
};

/** ctx 用到 size（[宽, 高]，像素）、fps（"分子/分母"，帧每秒）。params.master 是预设名 */
export function create(ctx, params) {
  const preset = PRESETS[params.master];
  if (!preset) throw new Error(`deliver.encode 不认得预设 ${params.master}，这一版只有 ${Object.keys(PRESETS).join('、')}`);
  const [width, height] = ctx.size;
  if (preset.pixelFormat === 'yuv420p' && (width % 2 || height % 2)) throw new RangeError(`4:2:0 的画面宽高都要是偶数，给的是 ${width} × ${height}`);
  return { object: Object.freeze({ ...preset, size: [width, height], fps: ctx.fps }), dispose() {} };
}
