// 只散列第一个视频流的编码包。复制视频流重新封装或更换音轨后仍可复用记录。
export async function videoStreamSha256(input, runFfmpeg) {
  const result = await runFfmpeg(['-v', 'error', '-xerror', '-i', input, '-map', '0:v:0', '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-']);
  const match = /^0,v,SHA256=([0-9a-f]{64})$/.exec(String(result.stdout).trim());
  if (result.code !== 0 || !match) throw new Error(`无法读取视频码流 SHA-256（${result.stderr?.trim() || 'streamhash 输出无效'}）`);
  return match[1];
}
