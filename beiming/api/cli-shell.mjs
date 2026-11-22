// 命令行薄壳：合同 ROUTES 的每个动词一条子命令（名字就是 route.id），经 HTTP 调真实服务，标准输出一行信封。
// 命令表、选项与请求全部由 ROUTES 推出，改合同不用改这里。退出码按冻结错误码表的前缀取（errors 契约 5.1）。
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { artifactName, callRoute, checkArgs, defaultUrl, imageMime, inputsOf, readEnvelope, sha256Hex, unreachable, whyOf } from './client.mjs';
import { ROUTES } from './contract.mjs';
import { exitCodeOf, fail, ok } from './envelope.mjs';

const SHARED = { url: { type: 'string' }, token: { type: 'string' }, help: { type: 'boolean' }, 'list-verbs': { type: 'boolean' } };
const AUTH_NOTE = { account: '账户令牌', workspace: '这部片的工作区令牌', job: '作业所属那部片的工作区令牌' };
const USAGE = [
  '用法：node beiming/api/cli.mjs <动词> [--选项 值…] [--url <服务地址>] [--token <令牌>]',
  '      node beiming/api/cli.mjs --list-verbs | <动词> --help | mcp | serve | issue-token',
  '服务地址默认取 BEIMING_API_URL（没设是 http://127.0.0.1:8080），令牌默认取 BEIMING_API_TOKEN。',
].join('\n');

/** 信封对到的退出码：成功 0；失败只按错误码前缀查冻结表。前缀没登记的一律 1，不用信封自带的 exitCode：退出码不出冻结集合 0 / 1 / 2 / 3 / 4 / 5 / 124 */
export function exitCodeForEnvelope(env) {
  if (env?.ok === true) return 0;
  try {
    return exitCodeOf(String(env?.error?.code ?? ''));
  } catch {
    return 1;
  }
}

/** 纯函数：由路由表生成命令表，和 routes 一一对应。每条命令带选项表 flags（[名, 说明]）、可重复给的选项 many 与帮助文字 */
export function buildCliCommands(routes = ROUTES) {
  return routes.map((route) => {
    const { path, query, body, required } = inputsOf(route);
    const text = body?.type === 'string';
    const fileKey = Object.entries(body?.properties ?? {}).find(([, schema]) => schema?.contentEncoding === 'base64')?.[0];
    const must = (arg) => (required.includes(arg) ? '（必填）' : '');
    const fields = Object.keys(body?.properties ?? {});
    const many = new Set(query.filter(([, name]) => route.query[name].type === 'array').map(([arg]) => arg));
    const flags = [
      ...path.map((name) => [name, `路径参数${must(name)}${route.params[name].description ? `：${route.params[name].description}` : ''}`]),
      ...query.map(([arg, name]) => [arg, `查询参数 ${name}${must(arg)}${many.has(arg) ? '，可重复给' : ''}${route.query[name].enum ? `：${route.query[name].enum.join(' | ')}` : ''}`]),
      ...(body ? [[text ? 'text' : 'json', `请求体${text ? '文本' : ' JSON'}${must('body')}${fields.length ? `，字段：${fields.join('、')}` : ''}`], ['body-file', '从这个文件读请求体']] : []),
      ...(fileKey ? [['file', `读这个文件，按 base64 填进请求体的 ${fileKey}${fields.includes('name') ? '，没给 name 就用文件名' : ''}`]] : []),
      ...(route.binary ? [['out', '文件字节写到这个路径，标准输出只回摘要信封；不给就把字节写到标准输出']] : []),
    ];
    const clash = flags.map(([name]) => name).find((name, i, all) => Object.hasOwn(SHARED, name) || all.indexOf(name) !== i);
    if (clash) throw new Error(`路由 ${route.id} 的参数 ${clash} 和命令行薄壳的选项重名`);
    const help = [
      `node beiming/api/cli.mjs ${route.id}${flags.map(([name]) => (required.includes(name) ? ` --${name} <值>` : ` [--${name} <值>]`)).join('')} [--url <服务地址>] [--token <令牌>]`,
      `${route.method} ${route.path}（${AUTH_NOTE[route.auth] ?? route.auth}）：${route.summary}`,
      ...flags.map(([name, note]) => `  --${name}  ${note}`),
    ].join('\n');
    return { id: route.id, route, flags, fileKey, many, help };
  });
}

/** 跑一次命令行薄壳，交回退出码。标准输出是一行信封（--help、--list-verbs 和不带 --out 的文件字节除外） */
export async function runApiCli(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch, stdout = process.stdout, routes = ROUTES } = {}) {
  const commands = buildCliCommands(routes);
  const print = (envelope) => { stdout.write(`${JSON.stringify(envelope)}\n`); return exitCodeForEnvelope(envelope); };
  const usage = (message, hint = USAGE) => print(fail('usage.bad-argument', message, { hint }));
  // 宽松解析只用来找动词：动词要写在它自己的选项前面。
  const loose = parseArgs({ args: argv, strict: false, allowPositionals: true, options: SHARED });
  const cmd = commands.find((c) => c.id === loose.positionals[0]);
  if (!cmd) {
    if (loose.values['list-verbs']) { stdout.write(`${commands.map((c) => c.id).join('\n')}\n`); return 0; }
    if (loose.values.help && !loose.positionals.length) { stdout.write(`${USAGE}\n`); return 0; }
    return usage(loose.positionals.length ? `不认识的动词：${loose.positionals[0]}（--list-verbs 列出全部）` : '缺少动词');
  }
  let values;
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, options: { ...SHARED, ...Object.fromEntries(cmd.flags.map(([name]) => [name, { type: 'string', multiple: cmd.many.has(name) }])) } });
    if (parsed.positionals.length !== 1) return usage(`多余的参数：${parsed.positionals.filter((p) => p !== cmd.id).join(' ')}`, cmd.help);
    values = parsed.values;
  } catch (e) {
    return usage(e.message, cmd.help);
  }
  if (values.help) { stdout.write(`${cmd.help}\n`); return 0; }

  const { path, query, body: bodySchema } = inputsOf(cmd.route);
  const args = Object.fromEntries([...path, ...query.map(([arg]) => arg)].filter((name) => values[name] !== undefined).map((name) => [name, values[name]]));
  const sources = ['text', 'json', 'body-file'].filter((name) => values[name] !== undefined);
  if (sources.length > 1) return usage(`请求体只能给一个来源：${sources.map((s) => `--${s}`).join('、')}`, cmd.help);
  try {
    const raw = values['body-file'] !== undefined ? readFileSync(values['body-file'], 'utf8') : values.text ?? values.json;
    if (raw !== undefined) args.body = bodySchema.type === 'string' ? raw : JSON.parse(raw);
    if (values.file !== undefined) args.body = { ...(bodySchema.properties.name && { name: basename(values.file) }), ...args.body, [cmd.fileKey]: readFileSync(values.file).toString('base64') };
  } catch (e) {
    return usage(`请求体读不出来：${e.message}`, cmd.help);
  }
  const why = checkArgs(cmd.route, args);
  if (why) return usage(why, cmd.help);
  const token = values.token ?? env.BEIMING_API_TOKEN;
  if (!token) return usage('缺少令牌：用 --token 或环境变量 BEIMING_API_TOKEN');

  const baseUrl = values.url ?? defaultUrl(env);
  let bytes, mimeType;
  try {
    const res = await callRoute(cmd.route, args, { baseUrl, token, fetchImpl });
    if (!(cmd.route.binary && res.ok)) return print(await readEnvelope(res, baseUrl));
    bytes = Buffer.from(await res.arrayBuffer());
    const type = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
    // 认图片看产物名，不看请求地址：地址在产物名后面可能还有固定段。
    mimeType = imageMime(type, artifactName(cmd.route, args)) ?? type;
  } catch (e) {
    return print(unreachable(baseUrl, whyOf(e)));
  }
  if (values.out === undefined) { stdout.write(bytes); return 0; }
  // 先写临时文件再改名：中途失败不留半个文件，也不动原来的文件。
  const tmp = `${values.out}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, values.out);
  } catch (e) {
    rmSync(tmp, { force: true });
    return usage(`--out 写不进去：${e.message}`, cmd.help);
  }
  return print(ok({ data: { out: resolve(values.out), bytes: bytes.length, sha256: sha256Hex(bytes), mimeType } }));
}
