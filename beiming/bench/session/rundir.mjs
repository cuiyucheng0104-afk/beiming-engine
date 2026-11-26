export function newRunId(commit, attempt = 1, now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${String(commit).slice(0, 7)}-a${attempt}`;
}
