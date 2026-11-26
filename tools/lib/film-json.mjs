// 作品描述的原始文本与 JSON 只在这里读取。各入口在此基础上校验自己的字段。
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export function parseFilmDocument(text, { stripBom = false } = {}) {
  if (stripBom && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { value: JSON.parse(text), text };
}

export function readFilmDocument(file, { stripBom = false } = {}) {
  return parseFilmDocument(readFileSync(file, 'utf8'), { stripBom });
}

export async function readFilmDocumentAsync(file, { stripBom = false } = {}) {
  return parseFilmDocument(await readFile(file, 'utf8'), { stripBom });
}
