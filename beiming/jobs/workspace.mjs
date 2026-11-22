import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const inputExcluded = new Set(['rev', 'snapshots', 'intermediate', 'deliver', 'jobs', 'cache']);
const keepPolicies = new Set(['none', 'failed-only', 'all']);
const filmIdPattern = /^[a-z][a-z0-9_-]*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const regularRead = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

function codedError(code, message, details) {
  return Object.assign(new Error(message), { code }, details);
}

export function checkJobId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id) || /[^a-z0-9-]/.test(id)) {
    throw codedError('contract.bad-path', '作业标识只能使用小写字母、数字和连字符。');
  }
  return id;
}

export function checkKeep(keep) {
  if (!keepPolicies.has(keep)) throw new RangeError('中间产物保留策略无效。');
}

function checkRev(rev) {
  if (!Number.isSafeInteger(rev) || rev < 0) throw new RangeError('修订号必须是非负安全整数。');
}

function hasControlChar(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

// 领取文件与账本锁都靠它判断留下记录的进程还在不在。
export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('作业执行进程记录损坏。');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export function safePath(root, relative) {
  if (typeof relative !== 'string' || hasControlChar(relative) || /[\\:<>"|?*]/.test(relative)) {
    throw codedError('contract.bad-path', '工作区路径必须是相对路径。');
  }
  let file = root;
  for (const segment of relative.split('/')) {
    if (!segment || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) {
      throw codedError('contract.bad-path', '工作区路径含有非法段。');
    }
    file = path.join(file, segment);
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw codedError('contract.bad-path', '工作区路径不得经过符号链接。');
    }
  }
  return file;
}

export function makeDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function openRegular(file) {
  const fd = fs.openSync(file, regularRead);
  if (fs.fstatSync(fd).isFile()) return fd;
  fs.closeSync(fd);
  throw codedError('contract.bad-path', '工作区输入必须是普通文件。');
}

export function readText(file) {
  const fd = openRegular(file);
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

// Windows 上另一个进程正在读、改时间或替换同一路径时，rename / open / unlink 会短暂报共享冲突（EPERM、EACCES、EBUSY），退避重试即可。
// 父目录不可写是永久错误，不空等；重试用完仍失败就把原错误抛给调用方。
// 只读操作传 mode = R_OK：只要求文件本身可读，只读目录里的帧照样退避；文件在退避期间被删就让下一次尝试自己报 ENOENT。
export function retrySharing(file, run, retries = 16, mode = fs.constants.W_OK) {
  const reading = mode === fs.constants.R_OK;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return run();
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= retries) throw error;
      try {
        fs.accessSync(reading ? file : path.dirname(file), mode);
      } catch (denied) {
        // 探测自己撞上 EBUSY 也是瞬态冲突，不算「永久不可写」，接着退避
        if (denied.code !== 'EBUSY' && !(reading && denied.code === 'ENOENT')) throw error;
      }
      Atomics.wait(sleeper, 0, 0, Math.min(25, 2 + attempt * 2));
    }
  }
}

// aroundPublish 只包住最后的发布一步：写盘和刷盘在它外面做完，调用方要加锁时临界区才短。
export function atomicWrite(file, text, { stagingParent = path.dirname(file), create = false, aroundPublish = publish => publish() } = {}) {
  const staging = fs.mkdtempSync(path.join(stagingParent, '.write-'));
  try {
    const pending = path.join(staging, 'pending');
    fs.writeFileSync(pending, text, { flag: 'wx', flush: true });
    aroundPublish(() => {
      if (create) fs.linkSync(pending, file);
      else retrySharing(file, () => fs.renameSync(pending, file));
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
  }
}

function fileDigest(source, buffer, destination) {
  const sourceFd = openRegular(source);
  const hash = createHash('sha256');
  let targetFd;
  try {
    const before = fs.fstatSync(sourceFd, { bigint: true });
    if (destination) targetFd = fs.openSync(destination, 'wx');
    for (let length = fs.readSync(sourceFd, buffer); length > 0; length = fs.readSync(sourceFd, buffer)) {
      hash.update(buffer.subarray(0, length));
      if (targetFd !== undefined) {
        let offset = 0;
        while (offset < length) offset += fs.writeSync(targetFd, buffer, offset, length - offset);
      }
    }
    const after = fs.fstatSync(sourceFd, { bigint: true });
    const current = fs.lstatSync(source, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        after.dev !== current.dev || after.ino !== current.ino) {
      throw new Error('捕获快照期间输入文件发生变化。');
    }
    if (targetFd !== undefined) fs.fsyncSync(targetFd);
    return hash.digest('hex');
  } finally {
    fs.closeSync(sourceFd);
    if (targetFd !== undefined) fs.closeSync(targetFd);
  }
}

function scanFiles(root, destination, excluded = new Set()) {
  const files = [];
  const buffer = Buffer.alloc(64 * 1024); // 字节
  function visit(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!prefix && excluded.has(entry.name.toLowerCase())) continue;
      const relative = `${prefix}${entry.name}`;
      const source = safePath(root, relative);
      const target = destination && safePath(destination, relative);
      if (entry.isDirectory()) {
        if (target) fs.mkdirSync(target);
        visit(source, `${relative}/`);
      } else {
        files.push({ path: relative, sha256: fileDigest(source, buffer, target) });
      }
    }
  }
  visit(root, '');
  return files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

function snapshotName({ rev, uncommitted, sha256 } = {}) {
  if (typeof sha256 !== 'string' || sha256.length !== 64 || !sha256Pattern.test(sha256)) {
    throw new RangeError('快照 SHA-256 格式无效。');
  }
  if (uncommitted === true && rev === undefined) return `work-${sha256}`;
  if (uncommitted !== false) throw new TypeError('快照必须明确标识是否为未提交版本。');
  checkRev(rev);
  return `rev-${rev}`;
}

function manifestFor(revision, files) {
  const body = { ...revision, files };
  const sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { ...body, sha256 };
}

function snapshotRef({ rev, uncommitted, sha256 }) {
  return uncommitted ? { uncommitted, sha256 } : { rev, uncommitted, sha256 };
}

// 工作区写入者先更新片子与输入文件，再在同一个写入临界区内发布修订。
export function openWorkspace(dir) {
  const root = makeDirectory(dir);
  const resolve = relative => safePath(root, relative);
  for (const name of ['shots', 'assets', 'snapshots', 'intermediate', 'deliver', 'jobs']) {
    fs.mkdirSync(resolve(name), { recursive: true });
  }

  function readRevision() {
    const file = resolve('rev');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) return undefined;
    const text = readText(file).trim();
    if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error('工作区修订元数据损坏。');
    const rev = Number(text);
    checkRev(rev);
    return rev;
  }

  function readSnapshot(name, expected) {
    const relative = `snapshots/${name}`;
    const stored = JSON.parse(readText(resolve(`${relative}/manifest.json`)));
    const dir = resolve(`${relative}/files`);
    const revision = stored.uncommitted === true ? { uncommitted: true } : { rev: stored.rev, uncommitted: false };
    const manifest = manifestFor(revision, scanFiles(dir));
    if (JSON.stringify(manifest) !== JSON.stringify(stored) || snapshotName(manifest) !== name ||
        (expected && expected.sha256 !== manifest.sha256)) {
      throw new Error('快照清单与保存的输入字节不一致。');
    }
    return { dir, manifest };
  }

  function capture(revision) {
    const staging = fs.mkdtempSync(path.join(resolve('snapshots'), '.capture-'));
    try {
      const dir = path.join(staging, 'files');
      fs.mkdirSync(dir);
      const files = scanFiles(root, dir, inputExcluded);
      const film = JSON.parse(readText(safePath(dir, 'film.json')));
      if (film?.format !== 'film/3.0' || typeof film.id !== 'string' || !filmIdPattern.test(film.id) ||
          !Array.isArray(film.shots) || film.shots.length < 1 ||
          film.shots.some(shot => !shot || typeof shot !== 'object' || Array.isArray(shot))) {
        throw codedError('contract.bad-value', '工作区缺少有效的片子描述。');
      }
      for (const shot of film.shots) {
        if (shot.entry !== undefined) safePath(dir, shot.entry);
        if (shot.renderer?.entry !== undefined) safePath(dir, shot.renderer.entry);
      }
      if (!revision.uncommitted && files.some(file => file.path === 'film.lock')) {
        const lock = JSON.parse(readText(safePath(dir, 'film.lock')));
        if (lock?.format !== 'lock/1.0' || lock.issuer !== 'server' || lock.rev !== revision.rev || lock.film !== film.id) {
          throw codedError('contract.bad-value', '正式锁与片子或修订号不匹配。');
        }
      }
      const manifest = manifestFor(revision, files);
      fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flush: true });
      const name = snapshotName(manifest);
      try {
        fs.renameSync(staging, resolve(`snapshots/${name}`));
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        const existing = readSnapshot(name);
        if (existing.manifest.sha256 !== manifest.sha256) {
          throw codedError('contract.bad-value', '同一修订号已经绑定了不同的输入。');
        }
      }
      return snapshotRef(manifest);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  function commitRevision(rev) {
    checkRev(rev);
    const current = readRevision();
    if (current !== undefined && rev < current) {
      throw codedError('busy.rev-conflict', '工作区已有更新的修订。', { latestRev: current });
    }
    const snapshot = capture({ rev, uncommitted: false });
    if (rev !== current) atomicWrite(resolve('rev'), `${rev}\n`, { stagingParent: resolve('snapshots') });
    return snapshot;
  }

  function snapshot({ rev, uncommitted = false } = {}) {
    if (uncommitted === true && rev === undefined) return capture({ uncommitted: true });
    if (uncommitted !== false) throw new TypeError('临时快照不能绑定修订号。');
    checkRev(rev);
    return snapshotRef(readSnapshot(`rev-${rev}`).manifest);
  }

  function intermediateDir(id, attempt) {
    const relative = `intermediate/${checkJobId(id)}`;
    if (attempt === undefined) return resolve(relative);
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('运行轮次无效。');
    return resolve(`${relative}/attempt-${attempt}`);
  }

  function cleanupIntermediate(id, { keep, status, attempt }) {
    checkKeep(keep);
    const dir = intermediateDir(id, attempt);
    if (keep === 'all' || (keep === 'failed-only' && status === 'failed')) return;
    fs.rmSync(dir, { recursive: true, force: true });
    if (attempt !== undefined) {
      try {
        fs.rmdirSync(intermediateDir(id));
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
  }

  return Object.freeze({
    root, resolve, readRevision, commitRevision, snapshot, intermediateDir, cleanupIntermediate,
    openSnapshot: ref => readSnapshot(snapshotName(ref), ref),
  });
}
