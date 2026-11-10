// 路线 C（北冥代码动画风格 · 86 式）规则的共用小工具（以 _ 开头，加载器不把它当规则）。
// 全部只读：读文件一律按 LF（仓库 .gitattributes 要求 LF，万一 CRLF 检出也不误报）。
export const C = 'routes/c-style';
export const TPL = `${C}/template`;

export const readLF = (ctx, rel) => ctx.read(rel).replace(/\r\n/g, '\n');
export const err = (message, file, hint) => ({ level: 'error', message, ...(file ? { file } : {}), ...(hint ? { hint } : {}) });
export const warn = (message, file, hint) => ({ level: 'warn', message, ...(file ? { file } : {}), ...(hint ? { hint } : {}) });
export const ok = message => ({ level: 'info', message });

/** 去掉 // 与 # 开头的整行注释（规则只看代码，注释里提到某个写法不算） */
export const stripLineComments = src => src.replace(/^\s*(\/\/|#).*$/gm, '');

/** 文本里第一次匹配所在的行号（从 1 起），没匹配返回 undefined */
export function lineOf(text, re) {
  const m = re.exec(text);
  return m ? text.slice(0, m.index).split('\n').length : undefined;
}
