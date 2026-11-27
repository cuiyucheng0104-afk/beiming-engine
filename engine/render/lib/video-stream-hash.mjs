// 只散列第一个视频流的编码包。复制视频流重新封装或更换音轨后仍可复用记录。
// 兼容 FFmpeg 7 的 streamhash v1（0,v,SHA256=...）与 FFmpeg 9+ 的默认 v2（#version: 2 + 0, <bytes>, <hex>）。
export function parseVideoStreamSha256(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const data = lines.filter(l => !l.startsWith('#'));
  if (data.length !== 1) return null;
  const v1 = /^0,v,SHA256=([0-9a-f]{64})$/.exec(data[0]);
  if (v1) return lines.length === 1 ? v1[1] : null;
  const v2 = /^0,\s*\d+,\s*([0-9a-f]{64})(?:,\s*S=\d+(?:,\s*\d+,\s*[0-9a-f]{64})+)?$/.exec(data[0]);
  return v2 && lines.includes('#hash: SHA256') && lines.includes('#media_type 0: video') ? v2[1] : null;
}

export async function videoStreamSha256(input, runFfmpeg) {
  const result = await runFfmpeg(['-v', 'error', '-xerror', '-i', input, '-map', '0:v:0', '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-']);
  const hash = result.code === 0 ? parseVideoStreamSha256(result.stdout) : null;
  if (!hash) throw new Error(`无法读取视频码流 SHA-256（${result.stderr?.trim() || 'streamhash 输出无效'}）`);
  return hash;
}
