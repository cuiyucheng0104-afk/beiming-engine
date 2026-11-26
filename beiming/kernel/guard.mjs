import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const newRoot = 'beiming';
const legacyRoots = ['engine', 'tools', 'routes', 'films', 'site', 'cases'];
const archives = new Set(['cases/vendor', 'cases/source']);
const extensions = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py']);
// 核心线当前冻结。仅保留现有工具的精确“调用文件 → 导入拼写”；拆仓检查忽略这张表。
const pendingCoreImports = new Map([
  ['beiming/sources/core/chassis/freeze.mjs', '../../../../tools/lib/cli.mjs'],
  ['beiming/sources/core/chassis/imaging.mjs', '../../../../tools/lib/cli.mjs'],
  ['beiming/sources/core/chassis/level2.mjs', '../../../../tools/lib/cli.mjs'],
  ['beiming/sources/core/chassis/regress.mjs', '../../../../tools/lib/cli.mjs'],
  ['beiming/sources/core/fncheck/run.mjs', '../../../../tools/lib/cli.mjs'],
  ['beiming/sources/core/fncheck/gpu.mjs', '../../../../engine/render/lib/gpu.mjs'],
]);
const evalRoot = 'beiming/kernel/eval';
const evalForbiddenPaths = ['beiming/sources', 'beiming/host', 'engine/render'];
const evalForbiddenPackages = /^(?:three(?:-stdlib)?|@react-three\/[^/]+|(?:@playwright\/[^/]+|playwright(?:-core)?)|puppeteer(?:-core)?|bpy|@babylonjs\/[^/]+|babylonjs|pixi\.js|@pixi\/[^/]+|@webgpu\/[^/]+|gl|moderngl|opengl)(?:\/|$)/i;
const evalForbiddenFields = /material|shader|lightintensity|roughness|metalness/i;
// CommonJS 和 Node 对无扩展名路径、目录入口的补全顺序。
const jsExtensions = ['.js', '.mjs', '.cjs', '.json', '.node'];
const jsIndexes = jsExtensions.map((extension) => `index${extension}`);

// 用 Python 自带的 ast 模块解析 .py 源码，输出导入记录和含禁用词的名字与写入键。
const pythonScanner = String.raw`
import ast, json, re, sys
pattern = re.compile(sys.argv[1], re.I)
paths = json.loads(sys.stdin.buffer.read().decode('utf-8'))
NAMES = ('id', 'attr', 'name', 'arg', 'asname', 'module', 'rest')
LISTS = ('names', 'kwd_attrs')

def text(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts = []
        for item in node.values:
            piece = (
                text(item.value)
                if isinstance(item, ast.FormattedValue) and item.conversion == -1 and item.format_spec is None
                else text(item)
            )
            if piece is None:
                return None
            parts.append(piece)
        return ''.join(parts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = text(node.left), text(node.right)
        if left is not None and right is not None:
            return left + right
    if type(node).__name__ == 'Index':
        return text(getattr(node, 'value', None))
    return None

def scan(file):
    try:
        with open(file, 'rb') as handle:
            tree = ast.parse(handle.read(), file)
    except (SyntaxError, ValueError, UnicodeDecodeError, RecursionError, MemoryError) as error:
        return {'error': type(error).__name__}
    imports, fields = [], set()
    def name(value):
        for part in value.split('.'):
            if pattern.search(part):
                fields.add(part)
    def key(value):
        if value and pattern.search(value):
            fields.add(value)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend({'module': alias.name, 'names': None, 'level': 0} for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imports.append({'module': node.module or '', 'names': [alias.name for alias in node.names], 'level': node.level or 0})
        elif isinstance(node, ast.Call) and node.args:
            func = node.func
            loader = (isinstance(func, ast.Name) and func.id in ('import_module', '__import__')) or (
                isinstance(func, ast.Attribute) and func.attr == 'import_module'
                and isinstance(func.value, ast.Name) and func.value.id == 'importlib')
            module = text(node.args[0])
            if loader and module and not module.startswith('.'):
                imports.append({'module': module, 'names': None, 'level': 0})
        elif isinstance(node, ast.Dict):
            for item in node.keys:
                key(item is not None and text(item))
        elif isinstance(node, ast.Subscript) and not isinstance(node.ctx, ast.Load):
            key(text(node.slice))
        for field in NAMES:
            value = getattr(node, field, None)
            if isinstance(value, str):
                name(value)
        for field in LISTS:
            values = getattr(node, field, None)
            if isinstance(values, list):
                for value in values:
                    if isinstance(value, str):
                        name(value)
    return {'imports': imports, 'fields': sorted(fields)}

builtin = set(sys.builtin_module_names)
stdlib = set(getattr(sys, 'stdlib_module_names', ())) | builtin
print(json.dumps({'builtin': sorted(builtin), 'stdlib': sorted(stdlib), 'files': [scan(file) for file in paths]}))
`;

function directoryEntries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

function directoryNames(directory) {
  return directoryEntries(directory).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function* sourceFiles(repoRoot, directory) {
  for (const entry of directoryEntries(path.join(repoRoot, directory))) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !archives.has(file)) yield* sourceFiles(repoRoot, file);
    if (entry.isFile() && extensions.has(path.extname(file))) yield file;
  }
}

function isWithin(file, directory) {
  return file === directory || file.startsWith(`${directory}/`);
}

function pathKind(repoRoot, relative) {
  try {
    const stat = statSync(path.join(repoRoot, relative));
    return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
}

function checkOwnership(repoRoot, addProblem) {
  const tableFile = 'beiming/kernel/contracts/ownership/ownership.json';
  const root = path.join(repoRoot, newRoot);
  let table;
  try {
    table = JSON.parse(readFileSync(path.join(repoRoot, tableFile), 'utf8'));
  } catch (error) {
    addProblem('ownership-dirs', tableFile, `无法读取目录归属表（${error.code ?? error.name}）`);
    return;
  }
  if (!Array.isArray(table?.entries) || table.entries.some((entry) => typeof entry?.path !== 'string')) {
    addProblem('ownership-dirs', tableFile, '目录归属表缺少有效的 entries 路径列表');
    return;
  }
  const actual = new Set(directoryNames(root));
  for (const parent of ['kernel', 'sources']) {
    for (const name of directoryNames(path.join(root, parent))) actual.add(`${parent}/${name}`);
  }
  const registered = new Set(table.entries.map((entry) => entry.path).filter((entry) => (
    entry !== '.' && (!entry.includes('/') || /^(?:kernel|sources)\/[^/]+$/.test(entry))
  )));
  for (const entry of actual) {
    if (!registered.has(entry)) addProblem('ownership-dirs', `${newRoot}/${entry}`, '目录未登记归属');
  }
  for (const entry of registered) {
    if (!actual.has(entry)) addProblem('ownership-dirs', `${newRoot}/${entry}`, '已登记的目录不存在');
  }
}

const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0' };

function decodeLiteral(text) {
  return text.replace(/\\(?:u\{([\da-f]{1,6})\}|u([\da-f]{4})|U([\da-f]{8})|x([\da-f]{2})|(\r?\n|[^]))/gi,
    (escape, braced, unicode, longUnicode, hex, character) => {
      const digits = braced ?? unicode ?? longUnicode ?? hex;
      if (digits) {
        const codepoint = Number.parseInt(digits, 16);
        return codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : escape;
      }
      if (character.endsWith('\n')) return '';
      return Object.hasOwn(escapes, character) ? escapes[character] : character;
    });
}

// 这些关键字之后的 / 开始正则字面量；控制语句的右括号之后同理（of 仅在 for 头部是上下文关键字）。
const regexAfterWords = new Set(['return', 'throw', 'case', 'yield', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'await', 'do', 'else', 'extends']);
const controlWords = new Set(['if', 'while', 'for', 'with']);

function isToken(token, kind, value) {
  return token?.kind === kind && token.value === value;
}

function regexAllowed(tokens, parens) {
  const previous = tokens.at(-1);
  if (!previous || previous.kind === 'template-head' || previous.kind === 'template-middle') return true;
  if (previous.kind === 'word') {
    if (isToken(tokens.at(-2), 'symbol', '.')) return false;
    if (previous.value === 'of') return parens.at(-1) === 'for';
    return regexAfterWords.has(previous.value);
  }
  if (previous.kind !== 'symbol') return false;
  if (previous.value === ')') return previous.control === true;
  if (previous.value === '+' || previous.value === '-') return !isToken(tokens.at(-2), 'symbol', previous.value);
  return /^[=(:,;{}[!~?&|<>*%^]$/.test(previous.value);
}

function opensControl(tokens) {
  const previous = tokens.at(-1);
  if (previous?.kind !== 'word' || isToken(tokens.at(-2), 'symbol', '.')) return false;
  if (previous.value === 'for' || (previous.value === 'await' && isToken(tokens.at(-2), 'word', 'for'))) return 'for';
  return controlWords.has(previous.value) ? 'control' : false;
}

function tokenize(source, python) {
  const tokenPattern = python
    ? /(?<skip>\s+|#[^\n]*|\\\r?\n)|(?<string>'''(?:\\[^]|(?!''')[^])*'''|"""(?:\\[^]|(?!""")[^])*"""|'(?:\\[^]|[^'\\\r\n])*'|"(?:\\[^]|[^"\\\r\n])*")|(?<word>[\p{ID_Start}_][\p{ID_Continue}_]*)|(?<symbol>[^])/uy
    : /(?<skip>\s+|#![^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<string>'(?:\\[^]|[^'\\\r\n])*'|"(?:\\[^]|[^"\\\r\n])*")|(?<number>(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)n?)|(?<word>(?:[\p{ID_Start}$_]|\\u(?:\{[\da-fA-F]+\}|[\da-fA-F]{4}))(?:[\p{ID_Continue}$‌‍]|\\u(?:\{[\da-fA-F]+\}|[\da-fA-F]{4}))*)|(?<symbol>[^])/uy;
  const regexLiteral = /\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[a-z]*/y;
  const templatePart = /((?:\\[^]|[^`\\$]|\$(?!\{))*)(`|\$\{)/y;
  const tokens = [];
  // 每层未闭合模板插值内部尚未闭合的花括号数。
  const templates = [];
  // 每个未闭合的圆括号类型：'for'、'control' 或 false。
  const parens = [];
  let offset = 0;
  const readTemplatePart = () => {
    templatePart.lastIndex = offset;
    const match = templatePart.exec(source);
    if (!match) return;
    offset = templatePart.lastIndex;
    return match;
  };
  while (offset < source.length) {
    tokenPattern.lastIndex = offset;
    const { groups } = tokenPattern.exec(source);
    const { skip, string, number, word, symbol } = groups;
    const start = offset;
    offset = tokenPattern.lastIndex;
    if (skip) continue;
    if (string) {
      const quotes = python && (string.startsWith("'''") || string.startsWith('"""')) ? 3 : 1;
      tokens.push({ kind: 'string', value: decodeLiteral(string.slice(quotes, -quotes)) });
    } else if (number) {
      tokens.push({ kind: 'number', value: number });
    } else if (word) {
      tokens.push({ kind: 'word', value: decodeLiteral(word) });
    } else if (!python && symbol === '`') {
      const part = readTemplatePart();
      if (!part) {
        tokens.push({ kind: 'invalid', value: '' });
      } else if (part[2] === '`') {
        tokens.push({ kind: 'string', value: decodeLiteral(part[1]) });
      } else {
        tokens.push({ kind: 'template-head', value: decodeLiteral(part[1]) });
        templates.push(0);
      }
    } else {
      if (!python && symbol === '/' && regexAllowed(tokens, parens)) {
        // 正则字面量的内容是匹配文本，不参与引用和字段检查。
        regexLiteral.lastIndex = start;
        if (regexLiteral.exec(source)) {
          offset = regexLiteral.lastIndex;
          tokens.push({ kind: 'regex', value: '' });
          continue;
        }
      }
      if (templates.length && symbol === '{') templates[templates.length - 1]++;
      if (templates.length && symbol === '}') {
        if (templates.at(-1) === 0) {
          const part = readTemplatePart();
          if (part?.[2] === '${') {
            tokens.push({ kind: 'template-middle', value: decodeLiteral(part[1]) });
          } else {
            templates.pop();
            tokens.push(part ? { kind: 'template-tail', value: decodeLiteral(part[1]) } : { kind: 'invalid', value: '' });
          }
          continue;
        }
        templates[templates.length - 1]--;
      }
      const token = { kind: 'symbol', value: symbol };
      if (!python && symbol === ';' && parens.at(-1) === 'for') parens[parens.length - 1] = 'control';
      if (!python && symbol === '(') parens.push(opensControl(tokens));
      if (!python && symbol === ')') token.control = Boolean(parens.pop());
      tokens.push(token);
    }
  }
  return tokens;
}

function parseNumberToken(raw) {
  const clean = raw.replaceAll('_', '');
  if (clean.endsWith('n')) {
    try {
      return { value: String(BigInt(clean.slice(0, -1))), numeric: null };
    } catch {
      return;
    }
  }
  const numeric = Number(clean);
  if (Number.isNaN(numeric)) return;
  return { value: String(numeric), numeric };
}

// 求由字符串、字面量原始值、括号、只含常量插值的模板和 + 拼接组成的字符串常量表达式。
function constantString(tokens, start) {
  const primary = (index) => {
    const token = tokens[index];
    if (token?.kind === 'string') return { kind: 'string', value: token.value, end: index + 1 };
    if (token?.kind === 'number') {
      const parsed = parseNumberToken(token.value);
      return parsed && { kind: 'number', value: parsed.value, numeric: parsed.numeric, end: index + 1 };
    }
    if (token?.kind === 'word' && ['true', 'false', 'null', 'undefined'].includes(token.value)) {
      return { kind: 'primitive', value: token.value, end: index + 1 };
    }
    if (isToken(token, 'symbol', '(')) {
      const inner = expression(index + 1);
      if (inner && isToken(tokens[inner.end], 'symbol', ')')) return { ...inner, end: inner.end + 1 };
      return;
    }
    if (token?.kind !== 'template-head') return;
    let value = token.value;
    let cursor = index + 1;
    for (;;) {
      const inner = expression(cursor);
      if (!inner) return;
      const part = tokens[inner.end];
      value += inner.value + (part?.value ?? '');
      if (part?.kind === 'template-tail') return { kind: 'string', value, end: inner.end + 1 };
      if (part?.kind !== 'template-middle') return;
      cursor = inner.end + 1;
    }
  };
  const expression = (index) => {
    let left = primary(index);
    while (left && isToken(tokens[left.end], 'symbol', '+')
      && !isToken(tokens[left.end + 1], 'symbol', '+') && !isToken(tokens[left.end + 1], 'symbol', '=')) {
      const right = primary(left.end + 1);
      if (!right) return;
      if (left.kind === 'string' || right.kind === 'string') {
        left = { kind: 'string', value: left.value + right.value, end: right.end };
      } else if (left.kind === 'number' && right.kind === 'number' && left.numeric !== null && right.numeric !== null) {
        const sum = left.numeric + right.numeric;
        left = { kind: 'number', value: String(sum), numeric: sum, end: right.end };
      } else {
        return;
      }
    }
    return left;
  };
  const result = expression(start);
  return result?.kind === 'string' ? { value: result.value, end: result.end } : undefined;
}

function jsModuleSource(tokens, index) {
  const keyword = tokens[index].value;
  const next = tokens[index + 1];
  if (keyword === 'require' || keyword === 'import') {
    const parenIndex = isToken(next, 'symbol', '(')
      ? index + 1
      : (keyword === 'require' && isToken(next, 'symbol', '?') && isToken(tokens[index + 2], 'symbol', '.') && isToken(tokens[index + 3], 'symbol', '(')
        ? index + 3
        : -1);
    if (parenIndex !== -1) {
      const start = parenIndex + 1;
      if (keyword === 'import' && isToken(tokens[start], 'word', 'new')
        && isToken(tokens[start + 1], 'word', 'URL') && isToken(tokens[start + 2], 'symbol', '(')) {
        const relative = constantString(tokens, start + 3);
        const base = [',', 'import', '.', 'meta', '.', 'url', ')'];
        if (relative && base.every((value, offset) => tokens[relative.end + offset]?.value === value)) {
          let cursor = relative.end + base.length;
          if (isToken(tokens[cursor], 'symbol', '.') && isToken(tokens[cursor + 1], 'word', 'href')) cursor += 2;
          if (isToken(tokens[cursor], 'symbol', ')') || isToken(tokens[cursor], 'symbol', ',')) return relative.value;
        }
      }
      const argument = constantString(tokens, parenIndex + 1);
      const end = argument && tokens[argument.end];
      if (end?.kind === 'symbol' && (end.value === ')' || end.value === ',')) return argument.value;
      return;
    }
    if (keyword === 'import' && next?.kind === 'string') return next.value;
  }
  if (keyword === 'require') return;
  let cursor = index + 1;
  if (isToken(tokens[cursor], 'word', 'type') && !isToken(tokens[cursor + 1], 'word', 'from')) cursor++;
  if (keyword === 'import' && tokens[cursor]?.kind === 'word') {
    cursor++;
    if (isToken(tokens[cursor], 'symbol', ',')) cursor++;
  }
  if (isToken(tokens[cursor], 'symbol', '{')) {
    cursor++;
    while (cursor < tokens.length && !isToken(tokens[cursor], 'symbol', '}')) cursor++;
    cursor++;
  } else if (isToken(tokens[cursor], 'symbol', '*')) {
    cursor++;
    if (isToken(tokens[cursor], 'word', 'as') && tokens[cursor + 1]?.kind === 'word') cursor += 2;
  } else if (keyword === 'export') {
    return;
  }
  if (isToken(tokens[cursor], 'word', 'from') && tokens[cursor + 1]?.kind === 'string') {
    return tokens[cursor + 1].value;
  }
}

function* jsReferences(tokens) {
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== 'word' || !['import', 'require', 'export'].includes(token.value)) continue;
    // 对象成员上的同名方法不加载模块；module.require 与 module?.require 是唯一例外。
    if (isToken(tokens[index - 1], 'symbol', '.')) {
      const optionalChain = isToken(tokens[index - 2], 'symbol', '?');
      const receiverIndex = optionalChain ? index - 3 : index - 2;
      const moduleRequire = token.value === 'require' && isToken(tokens[receiverIndex], 'word', 'module')
        && !isToken(tokens[receiverIndex - 1], 'symbol', '.');
      if (!moduleRequire) continue;
    }
    const source = jsModuleSource(tokens, index);
    if (source) yield source;
  }
}

function pythonModule(tokens, start) {
  const names = [];
  let end = start;
  while (tokens[end]?.kind === 'word') {
    names.push(tokens[end++].value);
    if (!isToken(tokens[end], 'symbol', '.')) break;
    end++;
  }
  return { name: names.join('.'), end };
}

// 没有可用的 Python 或源码无法按当前 Python 语法解析时，按词法识别导入语句。
function* pythonTokenImports(tokens) {
  for (let index = 0; index < tokens.length; index++) {
    if (isToken(tokens[index], 'word', 'from')) {
      let start = index + 1;
      while (isToken(tokens[start], 'symbol', '.')) start++;
      const level = start - index - 1;
      const mod = isToken(tokens[start], 'word', 'import') ? { name: '', end: start } : pythonModule(tokens, start);
      if (!isToken(tokens[mod.end], 'word', 'import') || (!level && !mod.name)) continue;
      index = mod.end;
      let cursor = index + 1;
      if (isToken(tokens[cursor], 'symbol', '(')) cursor++;
      const names = [];
      if (isToken(tokens[cursor], 'symbol', '*')) names.push('*');
      while (tokens[cursor]?.kind === 'word') {
        names.push(tokens[cursor++].value);
        if (isToken(tokens[cursor], 'word', 'as')) cursor += 2;
        if (!isToken(tokens[cursor], 'symbol', ',')) break;
        cursor++;
      }
      yield { module: mod.name, names, level };
    } else if (['import_module', '__import__'].includes(tokens[index].value) && tokens[index].kind === 'word'
      && isToken(tokens[index + 1], 'symbol', '(') && tokens[index + 2]?.kind === 'string'
      && (isToken(tokens[index + 3], 'symbol', ')') || isToken(tokens[index + 3], 'symbol', ','))
      && !tokens[index + 2].value.startsWith('.')
      && (!isToken(tokens[index - 1], 'symbol', '.') || isToken(tokens[index - 2], 'word', 'importlib'))) {
      yield { module: tokens[index + 2].value, names: null, level: 0 };
    } else if (isToken(tokens[index], 'word', 'import')) {
      let cursor = index + 1;
      while (tokens[cursor]?.kind === 'word') {
        const mod = pythonModule(tokens, cursor);
        yield { module: mod.name, names: null, level: 0 };
        cursor = mod.end;
        if (isToken(tokens[cursor], 'word', 'as')) cursor += 2;
        if (!isToken(tokens[cursor], 'symbol', ',')) break;
        cursor++;
      }
    }
  }
}

function isAssignment(tokens, index) {
  let operator = '';
  for (let cursor = index; cursor < index + 4 && tokens[cursor]?.kind === 'symbol'; cursor++) operator += tokens[cursor].value;
  return /^(?:\*\*|<<|>>>?|&&|\|\||\?\?|\/\/|[-+*/%&|^@])?=(?!=)/.test(operator);
}

function forbiddenFields(tokens) {
  const fields = new Set();
  const keyStart = (token) => token?.kind === 'symbol' && ['{', ',', '*'].includes(token.value);
  const keyEnd = (token) => isToken(token, 'symbol', ':') || isToken(token, 'symbol', '(');
  const valueEnd = (token) => token?.kind === 'word' || token?.kind === 'string' || token?.kind === 'template-tail'
    || isToken(token, 'symbol', ')') || isToken(token, 'symbol', ']');
  for (const [index, token] of tokens.entries()) {
    if (token.kind === 'word' && evalForbiddenFields.test(token.value)) fields.add(token.value);
    if (token.kind === 'string' && keyStart(tokens[index - 1]) && keyEnd(tokens[index + 1])
      && evalForbiddenFields.test(token.value)) fields.add(token.value);
    if (!isToken(token, 'symbol', '[')) continue;
    // 计算键 { ['键']: 值 } 与下标写入 对象['键'] = 值 都定义了字段。
    const key = constantString(tokens, index + 1);
    if (!key || !isToken(tokens[key.end], 'symbol', ']') || !evalForbiddenFields.test(key.value)) continue;
    const computedKey = keyStart(tokens[index - 1]) && keyEnd(tokens[key.end + 1]);
    const subscriptWrite = valueEnd(tokens[index - 1]) && isAssignment(tokens, key.end + 1);
    if (computedKey || subscriptWrite) fields.add(key.value);
  }
  return fields;
}

function toPosix(relative) {
  return relative.split(path.sep).join('/');
}

// 按 Node 的补全顺序解析无扩展名路径和目录入口（先文件与扩展名补全，再目录入口；显式以 / 结尾则只按目录）。
function resolveJsFile(repoRoot, relative, directoryOnly = false) {
  const kind = pathKind(repoRoot, relative);
  if (!directoryOnly) {
    if (kind === 'file') return { target: relative };
    const extension = jsExtensions.find((candidate) => pathKind(repoRoot, `${relative}${candidate}`) === 'file');
    if (extension) return { target: `${relative}${extension}` };
  }
  if (kind !== 'directory') return { target: relative };
  const join = (name) => path.posix.normalize(relative ? `${relative}/${name}` : name);
  let main;
  try {
    main = JSON.parse(readFileSync(path.join(repoRoot, relative, 'package.json'), 'utf8')).main;
  } catch {
    main = undefined;
  }
  if (typeof main === 'string' && main) {
    const entry = join(main);
    const candidates = [entry, ...jsExtensions.map((extension) => `${entry}${extension}`), ...jsIndexes.map((index) => `${entry}/${index}`)];
    const found = isWithin(entry, '..') ? undefined : candidates.find((candidate) => pathKind(repoRoot, candidate) === 'file');
    if (found) return { target: found };
  }
  const index = jsIndexes.map(join).find((candidate) => pathKind(repoRoot, candidate) === 'file');
  return index ? { target: index } : { target: relative, directory: true };
}

// 只有相对路径、站点根单斜杠路径和 file: 网址指向仓库；协议相对 //、裸包名、node: 等协议都由包或网络解析决定。
function jsReference(repoRoot, file, specifier) {
  let target;
  const local = specifier.split(/[?#]/, 1)[0];
  if (local.startsWith('//')) return { specifier };
  const directoryOnly = local === '.' || local === '..' || local.endsWith('/');
  if (/^file:/i.test(specifier)) {
    try {
      target = fileURLToPath(specifier);
    } catch {
      return { specifier };
    }
  } else if (local === '.' || local === '..' || local.startsWith('./') || local.startsWith('../')) {
    target = path.resolve(repoRoot, path.dirname(file), local);
  } else if (local && path.isAbsolute(local)) {
    target = local;
  } else {
    return { specifier };
  }
  let relative = toPosix(path.relative(repoRoot, target));
  if (isWithin(relative, '..') || path.isAbsolute(relative)) {
    // 浏览器模块也可以从站点根路径引用仓库内的目录。
    if (!local.startsWith('/')) return { specifier };
    relative = path.posix.normalize(local).slice(1);
  }
  return { specifier, ...resolveJsFile(repoRoot, relative, directoryOnly) };
}

// Python 解析顺序：含 __init__.py 的常规包优先于同名 .py 模块，同名 .py 模块优先于命名空间目录。
function pythonModulePath(repoRoot, relative) {
  if (pathKind(repoRoot, `${relative}/__init__.py`) === 'file') return { target: `${relative}/__init__.py` };
  if (pathKind(repoRoot, `${relative}.py`) === 'file') return { target: `${relative}.py` };
  if (pathKind(repoRoot, relative) === 'directory') return { target: relative, directory: true };
}

// 绝对导入：内置模块不可被覆盖；标准库模块仅在仓库根存在同名常规包或同名 .py 时被仓库覆盖（仅命名空间目录时仍走标准库）。
function* pythonReferences(repoRoot, file, record, rootNames, pythonInfo) {
  const modulePath = record.module.split('.').filter(Boolean).join('/');
  let base;
  let specifier;
  if (record.level) {
    base = path.posix.join(path.posix.dirname(file), '../'.repeat(record.level - 1));
    specifier = `./${'../'.repeat(record.level - 1)}${modulePath}`;
  } else {
    specifier = modulePath;
    const top = modulePath.split('/', 1)[0];
    const repoRegular = pathKind(repoRoot, `${top}/__init__.py`) === 'file' || pathKind(repoRoot, `${top}.py`) === 'file';
    if ((!rootNames.has(top) && !repoRegular) || pythonInfo.builtin.has(top) || (pythonInfo.stdlib.has(top) && !repoRegular)) {
      yield { specifier };
      return;
    }
    base = '.';
  }
  const normalized = path.posix.normalize(path.posix.join(base, modulePath)).replace(/\/$/, '');
  const local = normalized === '.' ? '' : normalized;
  if (isWithin(local, '..')) {
    yield { specifier };
    return;
  }
  const moduleReference = { specifier, ...(pythonModulePath(repoRoot, local) ?? { target: local }) };
  if (!record.names || record.names.includes('*')) {
    yield moduleReference;
    return;
  }
  let fromModule = false;
  for (const name of record.names) {
    const found = pythonModulePath(repoRoot, local ? `${local}/${name}` : name);
    if (found) yield { specifier: `${specifier}${!specifier || specifier.endsWith('/') ? '' : '/'}${name}`, ...found };
    else fromModule = true;
  }
  if (fromModule) yield moduleReference;
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// 裸包名直接比对；网址（含协议相对 //）逐段比对包名（去掉 @版本 和模块文件扩展名）；路径只比对 node_modules 之后的包名。
function isForbiddenPackage(specifier, python) {
  if (python) return evalForbiddenPackages.test(specifier);
  const text = specifier.replace(/^npm:/i, '');
  const protocolRelative = text.startsWith('//');
  const url = (protocolRelative || /^[a-z][a-z\d+.-]*:\/\//i.test(text)) && !/^file:/i.test(text);
  const local = text.split(/[?#]/, 1)[0];
  const pathLike = !protocolRelative && (local.startsWith('.') || local.startsWith('/') || path.isAbsolute(local) || /^file:/i.test(text));
  if (!url && !pathLike) return evalForbiddenPackages.test(text);
  let segments;
  if (url) {
    try {
      segments = new URL(protocolRelative ? `https:${text}` : text).pathname.split('/');
    } catch {
      return false;
    }
  } else {
    segments = local.split(/[\\/]/);
  }
  segments = segments.filter(Boolean).map(safeDecode);
  const packageName = (index) => (segments[index].startsWith('@') && segments[index + 1]
    ? `${segments[index]}/${segments[index + 1]}` : segments[index]).replace(/(?<=.)@[^/@]*$/, '');
  const matches = (name) => evalForbiddenPackages.test(name)
    || evalForbiddenPackages.test(name.replace(/(?:\.(?:module|esm|min|bundle|cjs|development|production))*\.[cm]?js$/i, ''));
  if (!url) {
    const start = segments.lastIndexOf('node_modules') + 1;
    return start > 0 && start < segments.length && matches(packageName(start));
  }
  return segments.some((_, index) => matches(packageName(index)));
}

function isEvalSource(file) {
  const relative = file.slice(evalRoot.length + 1);
  return isWithin(file, evalRoot) && !/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:^|\/)(?:test[._-]|conftest\.py$)|(?:[._-](?:test|spec))\.[^.]+$/i.test(relative);
}

function pythonCandidates(options) {
  if (typeof options.python === 'string') return [[options.python, []]];
  const fromEnvironment = ['BEIMING_PYTHON', 'BEIMING_PY', 'PYTHON'].map((name) => process.env[name]).filter(Boolean);
  return [
    ...fromEnvironment.map((command) => [command, []]),
    ['python3', []],
    ['python', []],
    ...(process.platform === 'win32' ? [['py', ['-3']]] : []),
  ];
}

// 一次调用解析全部 .py 文件；返回内置模块名、标准库模块名和每个文件的解析结果，解析失败的文件不在结果中。
function scanPython(repoRoot, files, options) {
  const empty = { builtin: new Set(), stdlib: new Set(), files: new Map() };
  if (!files.length || options.python === false) return empty;
  const input = JSON.stringify(files.map((file) => path.join(repoRoot, file)));
  for (const [command, prefix] of pythonCandidates(options)) {
    const run = spawnSync(command, [...prefix, '-I', '-c', pythonScanner, evalForbiddenFields.source], {
      input, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
    });
    if (run.status !== 0) continue;
    let output;
    try {
      output = JSON.parse(run.stdout);
    } catch {
      continue;
    }
    if (!Array.isArray(output?.files) || output.files.length !== files.length || !Array.isArray(output.stdlib)) continue;
    const parsed = new Map();
    output.files.forEach((result, index) => {
      if (Array.isArray(result?.imports) && Array.isArray(result.fields)) parsed.set(files[index], result);
    });
    return { builtin: new Set(output.builtin ?? []), stdlib: new Set(output.stdlib), files: parsed };
  }
  return empty;
}

export function checkArchitecture(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const problems = [];
  const addProblem = (rule, file, message) => problems.push({ rule, file, message });
  checkOwnership(root, addProblem);
  const rootNames = new Set([...directoryNames(root), ...legacyRoots, newRoot]);
  const files = [];
  for (const directory of [...legacyRoots, newRoot]) {
    for (const file of [...sourceFiles(root, directory)].sort()) files.push({ directory, file });
  }
  const python = scanPython(root, files.filter(({ file }) => file.endsWith('.py')).map(({ file }) => file), options ?? {});
  for (const { directory, file } of files) {
    const isPython = file.endsWith('.py');
    const evalSource = isEvalSource(file);
    let parsed = isPython ? python.files.get(file) : undefined;
    if (!parsed) {
      const tokens = tokenize(readFileSync(path.join(root, file), 'utf8'), isPython);
      parsed = {
        imports: isPython ? [...pythonTokenImports(tokens)] : [...jsReferences(tokens)],
        fields: evalSource ? [...forbiddenFields(tokens)] : [],
      };
    }
    const references = new Map();
    for (const record of parsed.imports) {
      const resolved = isPython
        ? [...pythonReferences(root, file, record, rootNames, python)]
        : [jsReference(root, file, record)];
      for (const reference of resolved) references.set(`${reference.specifier}\0${reference.target}`, reference);
    }
    for (const reference of references.values()) {
      const { specifier, target } = reference;
      if (directory !== newRoot && target !== undefined && isWithin(target, newRoot)) {
        addProblem('no-reverse-import', file, `旧目录引用了 ${target}（${specifier}）`);
      }
      if (directory === newRoot && target !== undefined && !isWithin(target, newRoot)
        && (options?.standalone || pendingCoreImports.get(file) !== specifier)) {
        addProblem('no-legacy-import', file, `新目录引用了目录外的仓库模块（${target || '.'}）`);
      }
      if (evalSource && (isForbiddenPackage(specifier, isPython)
        || (target !== undefined && evalForbiddenPaths.some((forbidden) => isWithin(target, forbidden))))) {
        addProblem('eval-pure', file, `求值核引用了渲染器、宿主或图形库（${specifier}）`);
      }
    }
    if (evalSource) {
      for (const field of new Set(parsed.fields)) addProblem('eval-pure', file, `求值核使用了材质或灯光字段（${field}）`);
    }
  }
  return { ok: problems.length === 0, problems, scannedFiles: files.length };
}

function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' }, json: { type: 'boolean' }, standalone: { type: 'boolean' } } });
  const result = checkArchitecture(values.root ?? fileURLToPath(new URL('../../', import.meta.url)), { standalone: values.standalone });
  const lines = values.json
    ? [JSON.stringify(result, null, 2)]
    : [
      ...result.problems.map(({ rule, file, message }) => `[${rule}] ${file} ${message}`),
      `扫描 ${result.scannedFiles} 个文件，发现 ${result.problems.length} 个问题。`,
    ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
