import Ajv2020 from 'ajv/dist/2020.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// schema 相对于卡清单，不一定与求值入口在同一目录。仅加载已登记的卡内文件。
export function dataValidators(card) {
  const fields = Object.entries(card.params).filter(([, p]) => p.type === 'data');
  if (!fields.length) return [];
  if (!/^[a-z][a-z0-9-]*$/.test(card.kind)) throw new Error('无效的卡类别');
  const kind = path.join(root, card.kind);
  for (const dir of fs.readdirSync(kind, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const base = path.join(kind, dir.name);
    const manifest = path.join(base, 'card.json');
    if (!fs.existsSync(manifest)) continue;
    const registered = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (registered.id !== card.id) continue;
    const ajv = new Ajv2020({ ownProperties: true, addUsedSchema: false });
    return fields.map(([name, field]) => {
      if (typeof field.schema !== 'string' || registered.params[name]?.schema !== field.schema) {
        throw new Error(`参数 ${name} 的 schema 未登记`);
      }
      const file = fs.realpathSync(path.resolve(base, field.schema));
      if (!file.startsWith(base + path.sep)) throw new Error(`参数 ${name} 的 schema 须在卡目录内`);
      return [name, ajv.compile(JSON.parse(fs.readFileSync(file, 'utf8')))];
    });
  }
  throw new Error('找不到数据参数所属的卡目录');
}
