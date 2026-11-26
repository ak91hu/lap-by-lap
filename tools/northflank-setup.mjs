// Egyszeri (újrafuttatható) Northflank-beállítás: projekt, szolgáltatás, tartós volume, futtatási
// környezeti változók, és a GitHub Actions secret/változók az automatikus deployhoz.
//
// Használat:  node tools/northflank-setup.mjs
// A .env-ből olvassa: NORTHFLANK_TOKEN, STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET (és opcionálisan
// NF_PLAN, NF_REGION, NF_VOLUME_MB). A titkos értékeket nem írja ki.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

try {
  process.loadEnvFile('.env');
} catch { /* környezeti változókból */ }

const API = 'https://api.northflank.com/v1';
const TOKEN = process.env.NORTHFLANK_TOKEN;
const REPO = 'ak91hu/lap-by-lap';
const IMAGE = `ghcr.io/${REPO}:latest`;
const PROJECT = 'lap-by-lap';
const SERVICE = 'lap-by-lap';
const VOLUME = 'lap-by-lap-data';
const VOLUME_MB = Number(process.env.NF_VOLUME_MB || 5120);

if (!TOKEN) throw new Error('NORTHFLANK_TOKEN missing (.env)');
for (const k of ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET']) if (!process.env[k]) throw new Error(`${k} missing (.env)`);

async function nf(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data.error || data).slice(0, 600)}`);
    err.status = res.status;
    throw err;
  }
  return data.data ?? data;
}

const log = (...a) => console.log('•', ...a);

// 1) Projekt
const projects = (await nf('GET', '/projects')).projects || [];
let project = projects.find((p) => p.id === PROJECT || p.name === PROJECT);
if (!project) {
  const regions = (await nf('GET', '/regions')).regions || [];
  const region = process.env.NF_REGION || (regions.find((r) => r.id === 'europe-west') || regions[0])?.id;
  project = await nf('POST', '/projects', { name: PROJECT, description: 'Lap by Lap – Strava photo books', region });
  log(`project created (${region})`);
} else log('project exists');
const P = project.id;

// 2) Szolgáltatás (külső image a GHCR-ből, nyilvános HTTP-port)
const baseEnv = {
  STRAVA_CLIENT_ID: process.env.STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
  DATA_DIR: '/data',
  TRUST_PROXY: 'true',
  NODE_ENV: 'production',
};
let service = await nf('GET', `/projects/${P}/services/${SERVICE}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
if (!service) {
  const plans = process.env.NF_PLAN ? [process.env.NF_PLAN] : ['nf-compute-50', 'nf-compute-20', 'nf-compute-10'];
  let lastErr;
  for (const plan of plans) {
    try {
      service = await nf('POST', `/projects/${P}/services/deployment`, {
        name: SERVICE,
        billing: { deploymentPlan: plan },
        deployment: { instances: 1, external: { imagePath: IMAGE } },
        ports: [{ name: 'p01', internalPort: 3000, public: true, protocol: 'HTTP' }],
        runtimeEnvironment: { ...baseEnv, SESSION_SECRET: crypto.randomBytes(32).toString('hex') },
      });
      log(`service created (${plan})`);
      break;
    } catch (e) {
      lastErr = e;
      log(`plan ${plan} rejected: ${e.message.slice(0, 200)}`);
    }
  }
  if (!service) throw lastErr;
  service = await nf('GET', `/projects/${P}/services/${SERVICE}`);
} else log('service exists');
const S = service.id;

// 3) Tartós volume a /data-ra
const volumes = (await nf('GET', `/projects/${P}/volumes`)).volumes || [];
if (!volumes.some((v) => v.id === VOLUME || v.name === VOLUME)) {
  await nf('POST', `/projects/${P}/volumes`, {
    name: VOLUME,
    mounts: [{ containerMountPath: '/data' }],
    spec: { storageSize: VOLUME_MB, accessMode: 'ReadWriteOnce' },
    attachedObjects: [{ id: S, type: 'service' }],
  });
  log(`volume created (${VOLUME_MB} MB → /data)`);
} else log('volume exists');

// 4) Nyilvános cím → BASE_URL; a meglévő SESSION_SECRET megmarad
const fresh = await nf('GET', `/projects/${P}/services/${S}`);
const dns = (fresh.ports || []).find((p) => p.public && p.dns)?.dns;
if (!dns) throw new Error('No public DNS on the service yet – run the script again in a minute.');
const env = (await nf('GET', `/projects/${P}/services/${S}/runtime-environment`).catch(() => null))?.runtimeEnvironment || {};
await nf('PATCH', `/projects/${P}/services/deployment/${S}`, {
  runtimeEnvironment: { ...env, ...baseEnv, SESSION_SECRET: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), BASE_URL: `https://${dns}` },
});
log(`runtime environment set (BASE_URL=https://${dns})`);

// 5) GitHub: secret + változók az automatikus deployhoz (a token stdinen megy, nem parancssorban)
execFileSync('gh', ['secret', 'set', 'NORTHFLANK_TOKEN', '-R', REPO], { input: TOKEN, stdio: ['pipe', 'ignore', 'inherit'] });
execFileSync('gh', ['variable', 'set', 'NORTHFLANK_PROJECT', '-R', REPO, '--body', P], { stdio: 'inherit' });
execFileSync('gh', ['variable', 'set', 'NORTHFLANK_SERVICE', '-R', REPO, '--body', S], { stdio: 'inherit' });
log('GitHub secret NORTHFLANK_TOKEN + variables NORTHFLANK_PROJECT/SERVICE set');

console.log(`\nURL: https://${dns}\nStrava → Authorization Callback Domain: ${dns}\n`);
