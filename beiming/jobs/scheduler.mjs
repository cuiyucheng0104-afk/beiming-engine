const priorities = { final: 3, preview: 2, verify: 1, draft: 0 };

function isLight(kind) {
  return kind === 'preview' || kind === 'verify';
}

function blockedBy(rank, watermark) {
  return watermark >= 0 && (rank < watermark || (watermark >= priorities.preview && rank <= watermark));
}

function checkBudget(mb, min, max) {
  if (!Number.isSafeInteger(mb) || mb < min || mb > max) {
    throw new RangeError('显存预算（MB）超出可用范围。');
  }
  return mb;
}

export class Scheduler {
  #totalMB;
  #previewReserveMB;
  #mainMB;
  #budgets;
  #pending = [];
  #running = new Set();
  #draining = false;
  #dirty = false;

  // 一个设备使用一个调度器实例。终渲和草稿只能占主预算。
  constructor({ totalMB = 8192, previewReserveMB = Math.floor(totalMB / 8), budgetsMB = {} } = {}) {
    this.#totalMB = checkBudget(totalMB, 1, Number.MAX_SAFE_INTEGER);
    this.#previewReserveMB = checkBudget(previewReserveMB, 0, totalMB - 1);
    this.#mainMB = totalMB - this.#previewReserveMB;
    const lightMB = Math.max(1, this.#previewReserveMB);
    const defaults = { final: this.#mainMB, draft: Math.ceil(this.#mainMB / 2), preview: lightMB, verify: lightMB };
    this.#budgets = { ...defaults, ...budgetsMB };
    for (const [kind, mb] of Object.entries(this.#budgets)) this.request({ kind, vramMB: mb });
  }

  request({ kind, vramMB, priority } = {}) {
    if (typeof kind !== 'string' || !Object.hasOwn(priorities, kind)) throw new TypeError('作业类别无效。');
    if (priority !== undefined && (kind !== 'preview' || !['normal', 'high'].includes(priority))) {
      throw new TypeError('只允许为预览指定 normal 或 high 优先级。');
    }
    const light = isLight(kind);
    const mb = checkBudget(vramMB === undefined ? this.#budgets[kind] : vramMB, 1, light ? this.#totalMB : this.#mainMB);
    return { kind, vramMB: mb, ...(kind === 'preview' && { priority: priority ?? 'high' }) };
  }

  acquire(spec, { signal } = {}) {
    const request = this.request(spec);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const release = () => {
        if (!this.#running.delete(entry)) return;
        signal?.removeEventListener('abort', abort);
        this.#drain();
      };
      const abort = () => {
        const index = this.#pending.indexOf(entry);
        if (index >= 0) {
          this.#pending.splice(index, 1);
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
          this.#drain();
        } else {
          controller.abort(signal.reason);
        }
      };
      const entry = {
        ...request, controller,
        rank: request.priority === 'normal' ? priorities.verify : priorities[request.kind],
        grant: () => resolve(Object.freeze({ ...request, signal: controller.signal, release })),
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.#pending.push(entry);
      this.#drain();
    });
  }

  #schedule(entry, { reserveOnly = false } = {}) {
    let usedMB = 0;
    let mainUsedMB = 0;
    let lightUsedMB = 0;
    const drafts = [];
    for (const running of this.#running) {
      if (entry.kind === 'final' && running.kind === 'final') return false;
      usedMB += running.vramMB;
      if (isLight(running.kind)) lightUsedMB += running.vramMB;
      else mainUsedMB += running.vramMB;
      if (running.kind === 'draft') drafts.push(running);
    }
    const fits = () => entry.vramMB <= this.#totalMB - usedMB &&
      (reserveOnly
        ? entry.vramMB <= this.#previewReserveMB - lightUsedMB
        : (isLight(entry.kind) || entry.vramMB <= this.#mainMB - mainUsedMB));
    if (fits()) {
      this.#pending.splice(this.#pending.indexOf(entry), 1);
      this.#running.add(entry);
      entry.grant();
      return true;
    }
    if (!reserveOnly && (entry.kind === 'final' || entry.priority === 'high')) {
      const victims = [];
      // 先计算已经收到中止信号的草稿，显存仍保留到租约释放。
      for (const draft of drafts.filter(draft => draft.controller.signal.aborted)) {
        usedMB -= draft.vramMB;
        mainUsedMB -= draft.vramMB;
      }
      for (const draft of drafts.reverse()) {
        if (fits()) break;
        if (draft.controller.signal.aborted) continue;
        usedMB -= draft.vramMB;
        mainUsedMB -= draft.vramMB;
        victims.push(draft);
      }
      if (fits()) for (const draft of victims) draft.controller.abort('preempted');
    }
    return false;
  }

  #drain() {
    this.#dirty = true;
    if (this.#draining) return;
    this.#draining = true;
    try {
      do {
        this.#dirty = false;
        const ordered = [...this.#pending].sort((a, b) => b.rank - a.rank);
        const firstFinal = ordered.find(entry => entry.kind === 'final');
        let finalRunningMB = 0;
        for (const running of this.#running) {
          if (running.kind === 'final') finalRunningMB += running.vramMB;
        }
        let blockedRank = -1;
        let reserveBlockedRank = -1;
        for (const entry of ordered) {
          if (this.#dirty) break;
          if (entry.kind === 'final') {
            if (entry === firstFinal) {
              if (!this.#schedule(entry, { reserveOnly: false })) blockedRank = Math.max(blockedRank, entry.rank);
            } else {
              blockedRank = Math.max(blockedRank, entry.rank);
            }
            continue;
          }
          const finalPending = this.#pending.some(item => item.kind === 'final');
          const useReserveOnly = finalPending || (isLight(entry.kind) && blockedBy(entry.rank, blockedRank));
          if (useReserveOnly) {
            if (!isLight(entry.kind) || entry.vramMB > this.#previewReserveMB) continue;
            if (blockedBy(entry.rank, reserveBlockedRank)) continue;
            if (!this.#schedule(entry, { reserveOnly: true })) {
              reserveBlockedRank = Math.max(reserveBlockedRank, entry.rank);
            }
            continue;
          }
          if (blockedBy(entry.rank, blockedRank)) continue;
          if (isLight(entry.kind) && entry.vramMB <= this.#previewReserveMB && blockedBy(entry.rank, reserveBlockedRank)) {
            continue;
          }
          if (!this.#schedule(entry, { reserveOnly: false })) {
            blockedRank = Math.max(blockedRank, entry.rank);
            if (isLight(entry.kind) && entry.vramMB <= this.#totalMB - finalRunningMB) {
              reserveBlockedRank = Math.max(reserveBlockedRank, entry.rank);
            }
          }
        }
      } while (this.#dirty);
    } finally {
      this.#draining = false;
    }
  }
}

// 默认设备由进程内的各个工作区共享。
export const defaultScheduler = new Scheduler();
