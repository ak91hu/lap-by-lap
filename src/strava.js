// Strava API kliens: OAuth, token-frissítés, közös rate-limit kapu (15 perces és napi keret).

// A címek felülírhatók (csak tesztekhez: ál-Strava szerver), élesben mindig a Strava saját címei.
const API = process.env.STRAVA_API_URL || 'https://www.strava.com/api/v3';
const OAUTH = process.env.STRAVA_OAUTH_URL || 'https://www.strava.com/oauth';
export const SCOPES = 'read,activity:read_all';

export class StravaError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Akkor dobjuk, ha a felhasználó a további letöltés helyett a meglévő adatokból kér könyvet. */
export class SkipApiError extends Error {
  constructor() {
    super('skip-api');
    this.code = 'SKIP_API';
  }
}

export function authorizeUrl({ clientId, redirectUri, state }) {
  const p = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', approval_prompt: 'auto', scope: SCOPES, state,
  });
  return `${OAUTH}/authorize?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${OAUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new StravaError(`Strava token error (${res.status}): ${body.message || res.statusText}`, res.status);
  return body;
}

export async function exchangeCode({ clientId, clientSecret, code }) {
  const t = await tokenRequest({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code' });
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: t.expires_at, athlete: t.athlete };
}

export async function deauthorize(accessToken) {
  try {
    await fetch(`${OAUTH}/deauthorize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* nem kritikus */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A Strava kerete az egész alkalmazásra vonatkozik (nem felhasználónként), ezért a szünetet minden kliens
// közösen tartja: ha egy felhasználó kérése eléri a keretet, a többiek sem küldenek feleslegesen 429-et kiváltó kérést.
const shared = { pauseUntil: 0, kind: null };
export function sharedPause() {
  return { ...shared };
}
export function resetSharedPause() {
  shared.pauseUntil = 0;
  shared.kind = null;
}

/** A 15 perces keret negyedóránként (:00, :15, :30, :45), a napi éjfélkor (UTC) nullázódik. */
export function nextWindow() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(Math.floor(now.getUTCMinutes() / 15) * 15 + 15);
  return next.getTime() + 5000;
}

export function nextUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 1, 0);
}

export class StravaClient {
  /**
   * @param {object} tokens     { accessToken, refreshToken, expiresAt } – frissítéskor helyben módosul
   * @param {object} cfg        { clientId, clientSecret }
   * @param {object} hooks      { onWait(untilMs, kind), onTokens(tokens), shouldSkip() }
   */
  constructor(tokens, cfg, hooks = {}) {
    this.tokens = tokens;
    this.cfg = cfg;
    this.hooks = hooks;
    this.pauseUntil = 0;
    this.pauseKind = null;
    this.refreshing = null;
    this.requests = 0;
  }

  async ensureToken() {
    if (this.tokens.expiresAt && this.tokens.expiresAt - 120 > Date.now() / 1000) return;
    // Párhuzamos kérések esetén csak egy frissítés fusson.
    this.refreshing ??= (async () => {
      const t = await tokenRequest({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
      });
      this.tokens.accessToken = t.access_token;
      this.tokens.refreshToken = t.refresh_token;
      this.tokens.expiresAt = t.expires_at;
      await this.hooks.onTokens?.(this.tokens);
    })().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
  }

  pause(until, kind) {
    if (until > shared.pauseUntil) {
      shared.pauseUntil = until;
      shared.kind = kind;
    }
    if (until > this.pauseUntil) {
      this.pauseUntil = until;
      this.pauseKind = kind;
      this.hooks.onWait?.(until, kind);
    }
  }

  /** Várakozás a keret felszabadulásáig, másodpercenként ellenőrizve a „most készítsd el” kérést. */
  async gate() {
    for (;;) {
      if (this.hooks.shouldSkip?.()) throw new SkipApiError();
      // más felhasználó kérése által elért közös keret: a saját feladatunk is jelezze a várakozást
      if (shared.pauseUntil > this.pauseUntil && shared.pauseUntil > Date.now()) this.pause(shared.pauseUntil, shared.kind);
      const left = this.pauseUntil - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(left, 1000));
    }
  }

  readLimits(res) {
    const limit = res.headers.get('x-readratelimit-limit') || res.headers.get('x-ratelimit-limit');
    const usage = res.headers.get('x-readratelimit-usage') || res.headers.get('x-ratelimit-usage');
    if (!limit || !usage) return;
    const [l15, lDay] = limit.split(',').map(Number);
    const [u15, uDay] = usage.split(',').map(Number);
    this.lastUsage = { u15, l15, uDay, lDay };
    // Párhuzamos kérések miatt kis tartalékot hagyunk.
    if (uDay >= lDay - 3) this.pause(nextUtcMidnight(), 'daily');
    else if (u15 >= l15 - 3) this.pause(nextWindow(), 'window');
  }

  async get(path, query = {}) {
    let authRetried = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await this.gate();
      await this.ensureToken();
      const qs = new URLSearchParams(query).toString();
      let res;
      try {
        res = await fetch(`${API}${path}${qs ? `?${qs}` : ''}`, {
          headers: { Authorization: `Bearer ${this.tokens.accessToken}` },
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        await sleep(1500 * (attempt + 1)); // hálózati hiba / időtúllépés
        continue;
      }
      this.requests++;
      if (res.status === 429) {
        this.readLimits(res);
        if (this.pauseUntil <= Date.now()) this.pause(nextWindow(), 'window');
        continue;
      }
      if (res.status === 401 && !authRetried) {
        authRetried = true;
        this.tokens.expiresAt = 0;
        continue;
      }
      if (res.status >= 500) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new StravaError(`Strava API ${res.status} (${path}): ${body.message || res.statusText}`, res.status);
      }
      this.readLimits(res);
      return res.json();
    }
    throw new StravaError(`Strava API did not respond (${path}).`, 503);
  }

  athlete() {
    return this.get('/athlete');
  }

  async *activities() {
    for (let page = 1; ; page++) {
      const list = await this.get('/athlete/activities', { per_page: 200, page });
      if (!Array.isArray(list) || list.length === 0) return;
      yield list;
      if (list.length < 200) return;
    }
  }

  activity(id) {
    return this.get(`/activities/${id}`, { include_all_efforts: false });
  }

  photos(id) {
    return this.get(`/activities/${id}/photos`, { size: 2048, photo_sources: true });
  }

  streams(id) {
    return this.get(`/activities/${id}/streams`, { keys: 'latlng,altitude,distance,time', key_by_type: true, series_type: 'distance' });
  }
}
