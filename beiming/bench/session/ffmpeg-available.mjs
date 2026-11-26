import { spawnSync } from 'node:child_process';

const ok = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true }); return !r.error && r.status === 0; };
export const hasFfmpeg = () => ok(process.env.FFMPEG || 'ffmpeg', ['-version']) && ok(process.env.FFPROBE || 'ffprobe', ['-version']);
