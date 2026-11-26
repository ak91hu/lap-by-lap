// Memóriában tárolt háttérfeladatok; a felület lekérdezi őket (polling).
// Felhasználónként egyszerre egy feladat fut, hogy ne fogyjon kétszer az API-keret.
import crypto from 'node:crypto';

const jobs = new Map();
const MAX_AGE_MS = 6 * 3600 * 1000;

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
      if (job.phase && !job.phases.includes(job.phase)) job.phases.push(job.phase);
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

  Promise.resolve()
    .then(() => run(ctx))
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
