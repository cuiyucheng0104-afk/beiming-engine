export function claudeCommand(bin) {
  if (/\.(mjs|cjs|js)$/i.test(bin)) return [process.execPath, [bin]];
  return [bin, []];
}
