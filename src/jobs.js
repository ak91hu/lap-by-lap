// Memóriában tárolt háttérfeladatok; a felület lekérdezi őket (polling).
// Felhasználónként egyszerre egy feladat fut, hogy ne fogyjon kétszer az API-keret.
// A memóriaigényes feladatok (könyv, előnézet, archívumimport) közös sorban állnak: egyszerre csak annyi fut,
// amennyi a gép memóriájába biztosan belefér; a többi felhasználó a sorban lévő helyét látja.
import crypto from 'node:crypto';
import os from 'node:os';

const jobs = new Map();
const MAX_AGE_MS = 6 * 3600 * 1000;

export const HEAVY_KINDS = new Set(['book', 'preview', 'archive']);
const PER_HEAVY_JOB_MB = 450; // mért csúcs ~370 MB egy 400 oldalas könyvnél + tartalék
const BASE_MB = 200; // a futó Node-folyamat és a gyorsítótárak

/** Hány nehéz feladat futhat egyszerre: MAX_HEAVY_JOBS, vagy a konténer memóriakorlátjából számolva. */
export function heavyLimit(env = process.env, memBytes = memoryLimit(), cpus = os.availableParallelism()) {
  const fixed = Number(env.MAX_HEAVY_JOBS);
  if (Number.isInteger(fixed) && fixed > 0) return fixed;
  const mb = memBytes / 1024 ** 2;
  return Math.max(1, Math.min(cpus, Math.floor((mb - BASE_MB) / PER_HEAVY_JOB_MB)));
}

function memoryLimit() {
  // cgroup-korlát (konténerben ez a valós keret); ha nincs, a gép teljes memóriája
  const c = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  return c > 0 && c < os.totalmem() ? c : os.totalmem();
}

const LIMIT = heavyLimit();
let heavyRunning = 0;
const heavyQueue = [];

function acquireHeavy(job) {
  if (heavyRunning < LIMIT) {
    heavyRunning++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    heavyQueue.push({ job, resolve });
    job.phase = 'phaseQueued';
    renumberQueue();
  });
}

function releaseHeavy() {
  const next = heavyQueue.shift();
  if (next) {
    next.job.queuePos = null; // a helyet közvetlenül átadjuk, a számláló változatlan
    renumberQueue();
    next.resolve();
  } else heavyRunning--;
}

function renumberQueue() {
  heavyQueue.forEach((q, i) => {
    q.job.queuePos = i + 1;
  });
}

export function queueStats() {
  return { limit: LIMIT, running: heavyRunning, queued: heavyQueue.length };
}

export function activeJob(owner) {
  for (const j of jobs.values()) if (j.owner === owner && j.status === 'running') return j;
  return null;
}

export function createJob(owner, kind, run) {
  const job = {
    id: crypto.randomUUID(),
    owner,
    kind,
    status: 'running',
    phase: null,
    queuePos: null,
    done: 0,
    total: 0,
    phases: [],
    waitUntil: null,
    waitKind: null,
    skipApi: false,
    result: null,
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);

  const ctx = {
    job,
    phase(key, total = 0) {
      if (job.phase && job.phase !== 'phaseQueued' && !job.phases.includes(job.phase)) job.phases.push(job.phase);
      job.phase = key;
      job.done = 0;
      job.total = total;
    },
    tick(n = 1) {
      job.done += n;
    },
    wait(until, kind) {
      job.waitUntil = until;
      job.waitKind = kind;
    },
    clearWait() {
      if (job.waitUntil && job.waitUntil <= Date.now()) job.waitUntil = null;
    },
  };

  const heavy = HEAVY_KINDS.has(kind);
  (heavy ? acquireHeavy(job) : Promise.resolve())
    .then(() => {
      if (job.phase === 'phaseQueued') job.phase = null;
      return run(ctx);
    })
    .then((result) => {
      job.status = 'done';
      job.result = result;
    })
    .catch((err) => {
      console.error(`[job ${job.id}]`, err);
      job.status = 'error';
      job.error = err.message || String(err);
    })
    .finally(() => {
      job.waitUntil = null;
      job.finishedAt = Date.now();
      if (heavy) releaseHeavy();
    });

  for (const [id, j] of jobs) if (j.finishedAt && Date.now() - j.finishedAt > MAX_AGE_MS) jobs.delete(id);
  return job;
}

export function getJob(id, owner) {
  const job = jobs.get(id);
  if (!job || job.owner !== owner) return null;
  if (job.waitUntil && job.waitUntil <= Date.now()) job.waitUntil = null;
  return job;
}

export function publicJob(job) {
  const { owner, ...rest } = job;
  return rest;
}
