// JSON Schema 子集校验器（评测题库与结果文件用；不引入第三方依赖）。
//
// 支持的关键字：type（含类型数组）、enum、const、required、properties、additionalProperties
// （布尔或子模式）、items、minItems、maxItems、uniqueItems、minLength、maxLength、pattern、
// minimum、maximum、anyOf、oneOf、$ref（只支持本文件内的 "#/$defs/<名>"）。
// evals/agent/schema/*.json 只用这些关键字；新增关键字前先在这里实现并补测试。
// 接口：validate(schema, value) → [{ path, message }]（空数组表示通过）

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function matchesType(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === type;
}

function resolveRef(root, ref) {
  const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  if (!m || !root.$defs?.[m[1]]) throw new Error(`不支持或找不到的 $ref：${ref}`);
  return root.$defs[m[1]];
}

function check(root, schema, value, path, errors) {
  if (schema === true) return;
  if (schema === false) { errors.push({ path, message: '此处不允许出现值' }); return; }
  if (schema.$ref) { check(root, resolveRef(root, schema.$ref), value, path, errors); return; }
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some(t => matchesType(value, t))) {
      errors.push({ path, message: `类型应为 ${types.join(' 或 ')}，实际是 ${typeOf(value)}` });
      return;
    }
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push({ path, message: `应等于 ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({ path, message: `只能是 ${schema.enum.map(e => JSON.stringify(e)).join(' / ')}` });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push({ path, message: `长度至少 ${schema.minLength}` });
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push({ path, message: `长度至多 ${schema.maxLength}` });
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push({ path, message: `不符合格式 ${schema.pattern}` });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `不能小于 ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `不能大于 ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: `至少 ${schema.minItems} 项` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `至多 ${schema.maxItems} 项` });
    if (schema.uniqueItems) {
      const seen = new Set();
      value.forEach((item, i) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) errors.push({ path: `${path}[${i}]`, message: '与前面的项重复' });
        seen.add(key);
      });
    }
    if (schema.items) value.forEach((item, i) => check(root, schema.items, item, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push({ path: path ? `${path}.${key}` : key, message: '缺少必填字段' });
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (Object.hasOwn(props, key)) check(root, props[key], sub, childPath, errors);
      else if (schema.additionalProperties === false) errors.push({ path: childPath, message: '未知字段' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(root, schema.additionalProperties, sub, childPath, errors);
    }
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some(s => { const e = []; check(root, s, value, path, e); return e.length === 0; });
    if (!ok) errors.push({ path, message: '不满足 anyOf 中的任何一种写法' });
  }
  if (schema.oneOf) {
    const n = schema.oneOf.filter(s => { const e = []; check(root, s, value, path, e); return e.length === 0; }).length;
    if (n !== 1) errors.push({ path, message: `应恰好满足 oneOf 中的一种写法（实际满足 ${n} 种）` });
  }
}

/** 校验 value 是否符合 schema，返回错误列表。 */
export function validate(schema, value) {
  const errors = [];
  check(schema, schema, value, '', errors);
  return errors;
}
