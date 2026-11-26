export const FFMPEG = () => (process.env.FFMPEG || '').trim() || 'ffmpeg';
export const FFPROBE = () => (process.env.FFPROBE || '').trim() || 'ffprobe';
