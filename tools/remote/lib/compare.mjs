import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT, usageError } from '../../env/lib/cli.mjs';

const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const RUN_ID = /^\d{8}-\d{6}-[a-f0-9]{7}-[a-f0-9]{4}$/;
const LABEL = /^[a-zA-Z0-9_.-]{1,64}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const CONTROL = /\p{Cc}/u;

function safeRelative(value) {
  return typeof value === 'string' && value.split('/').every(segment =>
    segment && segment !== '.' && segment !== '..' && !/[<>:"\\|?*]/.test(segment) && !CONTROL.test(segment) &&
    segment === segment.trim() && !segment.endsWith('.') && !RESERVED.test(segment));
}

function validFacts(file) {
  return file && typeof file.sha256 === 'string' && DIGEST.test(file.sha256) && Number.isSafeInteger(file.size) && file.size >= 0;
}

function equalFacts(a, b) {
  return a.sha256 === b.sha256 && a.size === b.size;
}

function readArtifact(root, relative) {
  const target = path.join(root, ...relative.split('/'));
  if (fs.realpathSync(target) !== target || !fs.statSync(target).isFile()) throw new Error('bad artifact path');
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  const fd = fs.openSync(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('not a regular file');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    let read;
    while ((read = fs.readSync(fd, buffer)) !== 0) {
      hash.update(buffer.subarray(0, read));
      size += read;
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
}

function runError(code, message) {
  return new CliError(EXIT.CONTRACT, `remote.${code}`, message);
}

function readRun(file, rootOverride, side) {
  const invalid = reason => runError('invalid-run', `${side}运行记录无效：${reason}`);
  const integrity = () => runError('artifact-integrity', `${side}取回目录或产物无法读取，或产物摘要不符`);
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw invalid('无法读取 JSON'); }
  if (record?.schemaVersion !== 1 || typeof record.sha !== 'string' || !COMMIT.test(record.sha) ||
      typeof record.runId !== 'string' || !RUN_ID.test(record.runId) || record.runId.split('-')[2] !== record.sha.slice(0, 7) ||
      !Array.isArray(record.command) ||
      !record.command.length || !record.command[0] || !record.command.every(arg => typeof arg === 'string' && !arg.includes('\0'))) {
    throw invalid('记录版本、运行号、提交或命令不符');
  }
  if (record.exitCode !== 0 || record.error != null || !Array.isArray(record.fetchProblems) || record.fetchProblems.length ||
      (record.envelope != null && (record.envelope.exitCode !== 0 || record.envelope.ok !== true || record.envelope.error != null))) {
    throw invalid('作业或取回失败');
  }
  const { hostname, platform, arch } = record.machine || {};
  if (typeof hostname !== 'string' || !hostname.trim().replace(/\.+$/, '') || /\s/.test(hostname.trim()) || CONTROL.test(hostname) ||
      typeof platform !== 'string' || !LABEL.test(platform) || typeof arch !== 'string' || !LABEL.test(arch) ||
      !['ssh', 'local'].includes(record.transport)) {
    throw invalid('缺少机器指纹或传输类型');
  }
  if (!Array.isArray(record.files) || !record.files.length || !Array.isArray(record.fetched) || record.fetched.length !== record.files.length) {
    throw invalid('产物清单为空或取回项数量不符');
  }
  const artifacts = new Map();
  const names = new Set();
  for (const entry of record.files) {
    if (!validFacts(entry) || !safeRelative(entry.path)) throw invalid('产物路径或摘要不符');
    const name = entry.path.normalize('NFC').toLowerCase();
    if (names.has(name)) throw invalid('产物路径重复或有歧义');
    names.add(name);
    artifacts.set(entry.path, { sha256: entry.sha256, size: entry.size, kind: null });
  }

  const fetched = new Map();
  for (const entry of record.fetched) {
    if (!validFacts(entry) || entry.kind !== 'remote-output' || typeof entry.path !== 'string' ||
        entry.path.includes('\\') || CONTROL.test(entry.path) || entry.path.split('/').some(part => part === '.' || part === '..') ||
        fetched.has(entry.path)) {
      throw invalid('取回路径或摘要不符');
    }
    fetched.set(entry.path, entry);
  }
  const firstPath = record.files[0].path;
  let matchingRoots = 0;
  // fetched.path 只用来核对记录中的逻辑路径和摘要。绝不按记录提供的本机地址读取。
  for (const fetchedPath of fetched.keys()) {
    if (fetchedPath !== firstPath && !fetchedPath.endsWith(`/${firstPath}`)) continue;
    const prefix = fetchedPath.slice(0, -firstPath.length);
    if ([...artifacts].every(([name, facts]) => {
      const got = fetched.get(prefix + name);
      return got && equalFacts(got, facts);
    })) matchingRoots++;
  }
  if (matchingRoots !== 1) throw invalid('声明的清单与取回记录不符');

  const outputs = record.envelope?.outputs;
  if (record.envelope != null && !Array.isArray(outputs)) throw invalid('作业信封缺少 outputs');
  const declared = new Set();
  for (const item of outputs ?? []) {
    const artifact = artifacts.get(item?.path);
    if (!artifact || declared.has(item.path) || (item.kind != null && (typeof item.kind !== 'string' || !LABEL.test(item.kind))) ||
        (item.sha256 != null && item.sha256 !== artifact.sha256)) {
      throw invalid('作业信封列出的产物与取回记录不符');
    }
    declared.add(item.path);
    artifact.kind = item.kind ?? null;
  }

  let root;
  try { root = fs.realpathSync(rootOverride ?? path.join(path.dirname(file), record.runId)); } catch { throw integrity(); }
  for (const [name, artifact] of artifacts) {
    let facts;
    try { facts = readArtifact(root, name); } catch { throw integrity(); }
    if (!equalFacts(artifact, facts)) throw integrity();
  }
  return {
    sha: record.sha, command: record.command, host: hostname.trim().replace(/\.+$/, '').toLowerCase(), artifacts,
    publicRun: { runId: record.runId, platform, arch, transport: record.transport },
  };
}

export function compareRuns(leftPath, rightPath, { leftRoot, rightRoot, mode = 'strict' } = {}) {
  if (mode !== 'strict' && mode !== 'inventory') throw usageError('--mode 只支持 strict 或 inventory');
  if (leftRoot === '' || rightRoot === '') throw usageError('取回目录不能为空');
  const left = readRun(leftPath, leftRoot, '左侧');
  const right = readRun(rightPath, rightRoot, '右侧');
  if (left.sha !== right.sha) throw runError('different-commit', '两份运行记录的提交不同');
  if (JSON.stringify(left.command) !== JSON.stringify(right.command)) throw runError('different-command', '两份运行记录的作业命令不同');
  if (left.host === right.host) throw runError('same-host', '两份运行记录来自同一主机');

  const onlyLeft = [], onlyRight = [], kindDifferences = [], contentDifferences = [], artifacts = [];
  const paths = new Set([...left.artifacts.keys(), ...right.artifacts.keys()]);
  for (const name of [...paths].sort()) {
    const a = left.artifacts.get(name), b = right.artifacts.get(name);
    if (!b) onlyLeft.push(name);
    if (!a) onlyRight.push(name);
    if (a && b) {
      if (a.kind !== b.kind) kindDifferences.push(name);
      if (!equalFacts(a, b)) contentDifferences.push(name);
    }
    artifacts.push({ path: name, kind: a && b && a.kind !== b.kind ? null : (a ?? b).kind, left: a ?? null, right: b ?? null });
  }
  const inventoryMatches = onlyLeft.length + onlyRight.length + kindDifferences.length === 0;
  const byteIdentical = onlyLeft.length + onlyRight.length + contentDifferences.length === 0;
  return {
    ok: inventoryMatches && (mode === 'inventory' || byteIdentical), mode, sha: left.sha,
    left: left.publicRun, right: right.publicRun, inventoryMatches, byteIdentical,
    onlyLeft, onlyRight, kindDifferences, contentDifferences, artifacts,
  };
}
