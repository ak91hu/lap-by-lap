// Egyszeri (újrafuttatható) Northflank-beállítás: szolgáltatás a nyilvános GitHub-repóból (a Northflank maga
// építi a Dockerfile-ból minden push után), tartós volume a /data-ra, futtatási környezeti változók.
//
// Előtte:     npm i -g @northflank/cli && northflank login -n lap-by-lap   (böngészős jóváhagyás)
// Használat:  node tools/northflank-setup.mjs
// A Northflank-tokent a CLI bejelentkezéséből (~/.northflank/config.json) vagy a NORTHFLANK_TOKEN-ből veszi,
// a Strava-kulcsokat a .env-ből. A titkos értékeket nem írja ki.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

try {
  process.loadEnvFile('.env');
} catch { /* környezeti változókból */ }

const API = 'https://api.northflank.com/v1';
const PROJECT = process.env.NF_PROJECT || 'default'; // az ingyenes csomagban egy projekt van
const SERVICE = 'lap-by-lap';
const VOLUME = 'lap-by-lap-data';
const PLAN = process.env.NF_PLAN || 'nf-compute-20'; // az ingyenes keretbe férő legnagyobb (0,2 vCPU / 512 MB)
const VOLUME_MB = Number(process.env.NF_VOLUME_MB || 6144); // az nvme tárolóosztály minimuma

function token() {
  if (process.env.NORTHFLANK_TOKEN) return process.env.NORTHFLANK_TOKEN;
  try {
    const cfg = JSON.parse(fs.readFileSync(`${os.homedir()}/.northflank/config.json`, 'utf8'));
    return (cfg.contexts.find((c) => c.name === 'lap-by-lap') || cfg.contexts.find((c) => c.name === cfg.current))?.token;
  } catch {
    return null;
  }
}
const TOKEN = token();
if (!TOKEN) throw new Error('No Northflank login: run `northflank login -n lap-by-lap` or set NORTHFLANK_TOKEN');
for (const k of ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET']) if (!process.env[k]) throw new Error(`${k} missing (.env)`);

async function nf(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${data.error?.message || ''}`);
    err.status = res.status;
    throw err;
  }
  return data.data ?? data;
}
const log = (...a) => console.log('•', ...a);
const P = PROJECT;

// 1) Szolgáltatás: build a nyilvános repóból (Dockerfile), nyilvános HTTP-port
let service = await nf('GET', `/projects/${P}/services/${SERVICE}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
if (!service) {
  await nf('POST', `/projects/${P}/services/combined`, {
    name: SERVICE,
    description: 'Lap by Lap - Strava photo books',
    billing: { deploymentPlan: PLAN },
    deployment: { instances: 0 }, // a volume és a változók után indítjuk
    ports: [{ name: 'p01', internalPort: 3000, public: true, protocol: 'HTTP' }],
    vcsData: { projectUrl: 'https://github.com/ak91hu/lap-by-lap', projectType: 'github', projectBranch: 'main' },
    buildSettings: { dockerfile: { buildEngine: 'kaniko', dockerFilePath: '/Dockerfile', dockerWorkDir: '/' } },
  });
  log(`service created (${PLAN})`);
  service = await nf('GET', `/projects/${P}/services/${SERVICE}`);
} else log('service exists');

// 2) Tartós volume a /data-ra
const volumes = (await nf('GET', `/projects/${P}/volumes`)).volumes || [];
if (!volumes.some((v) => v.id === VOLUME)) {
  await nf('POST', `/projects/${P}/volumes`, {
    name: VOLUME,
    mounts: [{ containerMountPath: '/data' }],
    spec: { storageSize: VOLUME_MB, accessMode: 'ReadWriteOnce' },
    attachedObjects: [{ id: SERVICE, type: 'service' }],
  });
  log(`volume created (${VOLUME_MB} MB → /data)`);
} else log('volume exists');

// 3) Futtatási környezet; a meglévő SESSION_SECRET megmarad (különben mindenki kijelentkezne)
const dns = (service.ports || []).find((p) => p.public && p.dns)?.dns;
if (!dns) throw new Error('No public DNS on the service yet – run again in a minute.');
const current = (await nf('GET', `/projects/${P}/services/${SERVICE}/runtime-environment`).catch(() => null))?.runtimeEnvironment || {};
await nf('PATCH', `/projects/${P}/services/combined/${SERVICE}`, {
  runtimeEnvironment: {
    ...current,
    STRAVA_CLIENT_ID: process.env.STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
    SESSION_SECRET: current.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    BASE_URL: `https://${dns}`,
    DATA_DIR: '/data',
    TRUST_PROXY: '1', // a Northflank előtt pontosan egy proxy áll (mérve): így a kliens IP-je nem hamisítható
    NODE_ENV: 'production',
  },
  deployment: { instances: 1 },
});
log('runtime environment set, 1 instance');

console.log(`\nURL: https://${dns}\nStrava → Authorization Callback Domain: ${dns}\n`);
