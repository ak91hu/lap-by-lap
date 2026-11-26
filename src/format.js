// Nyelv- és mértékegység-érzékeny formázás (hu/en, metrikus/angolszász).
import { t, sportName } from './i18n.js';

const PACE_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'Walk', 'Hike', 'Snowshoe']);
const SWIM_TYPES = new Set(['Swim']);
const MI = 1609.344;
const FT = 0.3048;

export function activityType(a) {
  return a.sport_type || a.type || 'Workout';
}

/** A Strava `start_date_local` mezője helyi időt tartalmaz "Z" végződéssel → UTC-ként formázzuk. */
export function localDate(a) {
  return new Date(a.start_date_local || a.start_date);
}

export function year(a) {
  return Number((a.start_date_local || a.start_date || '').slice(0, 4));
}

export class Fmt {
  /**
   * @param {'hu'|'en'} lang
   * @param {'metric'|'imperial'} units
   */
  constructor(lang = 'hu', units = 'metric') {
    this.lang = lang;
    this.imperial = units === 'imperial';
    this.locale = lang === 'hu' ? 'hu-HU' : 'en-GB';
    const nf = (min, max) => new Intl.NumberFormat(this.locale, { minimumFractionDigits: min, maximumFractionDigits: max });
    this._n0 = nf(0, 0);
    this._n1 = nf(1, 1);
    this._n2 = nf(2, 2);
    const df = (o) => new Intl.DateTimeFormat(this.locale, { timeZone: 'UTC', ...o });
    this._long = df({ year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    this._time = df({ hour: '2-digit', minute: '2-digit', hour12: false });
    this._short = df({ year: 'numeric', month: '2-digit', day: '2-digit' });
    this._dayMonth = df({ month: 'short', day: 'numeric' });
    this._today = new Intl.DateTimeFormat(this.locale, { year: 'numeric', month: 'long', day: 'numeric' });
    this._monthYear = df({ year: 'numeric', month: 'long' });
    this.months = Array.from({ length: 12 }, (_, m) =>
      df({ month: 'short' }).format(new Date(Date.UTC(2024, m, 15))).replace(/\.$/, ''));
    this.weekdays = Array.from({ length: 7 }, (_, i) =>
      df({ weekday: 'narrow' }).format(new Date(Date.UTC(2024, 0, 1 + i)))); // 2024-01-01 hétfő
  }

  t(key, vars) {
    return t(this.lang, key, vars);
  }

  sport(type) {
    return sportName(this.lang, type);
  }

  n0(n) {
    return this._n0.format(n);
  }

  n1(n) {
    return this._n1.format(n);
  }

  distance(m) {
    if (!m) return null;
    if (this.imperial) {
      const mi = m / MI;
      return mi < 0.2 ? `${this._n0.format(m / FT)} ft` : `${(mi >= 100 ? this._n1 : this._n2).format(mi)} mi`;
    }
    if (m < 1000) return `${this._n0.format(m)} m`;
    return `${(m >= 100000 ? this._n1 : this._n2).format(m / 1000)} km`;
  }

  bigDistance(m) {
    return this.imperial ? `${this._n0.format(Math.round((m || 0) / MI))} mi` : `${this._n0.format(Math.round((m || 0) / 1000))} km`;
  }

  /** Havi diagramhoz: km vagy mérföld számként. */
  distanceValue(m) {
    return this.imperial ? m / MI : m / 1000;
  }

  elevation(m) {
    if (m == null) return null;
    return this.imperial ? `${this._n0.format(Math.round(m / FT))} ft` : `${this._n0.format(Math.round(m))} m`;
  }

  duration(sec) {
    if (sec == null) return null;
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  hours(sec) {
    const h = Math.floor((sec || 0) / 3600);
    const m = Math.round(((sec || 0) % 3600) / 60);
    const hu = this.t('hoursUnit');
    const mu = this.t('minutesUnit');
    return h > 0 ? `${this._n0.format(h)} ${hu} ${m} ${mu}` : `${m} ${mu}`;
  }

  /** Sebesség vagy tempó a sportágtól függően: { label, value } vagy null. */
  speedOrPace(a) {
    const v = a.average_speed;
    if (!v || v <= 0 || !a.distance) return null;
    const type = activityType(a);
    if (PACE_TYPES.has(type)) {
      const per = this.imperial ? MI : 1000;
      return { label: this.t('statPace'), value: `${this.duration(per / v)} /${this.imperial ? 'mi' : 'km'}` };
    }
    if (SWIM_TYPES.has(type)) {
      const per = this.imperial ? 100 * 0.9144 : 100;
      return { label: this.t('statPace'), value: `${this.duration(per / v)} /100 ${this.imperial ? 'yd' : 'm'}` };
    }
    return { label: this.t('statSpeed'), value: this.imperial ? `${this._n1.format(v * 2.236936)} mph` : `${this._n1.format(v * 3.6)} km/h` };
  }

  longDate(a) {
    const d = localDate(a);
    return `${this._long.format(d)}, ${this._time.format(d)}`;
  }

  shortDate(d) {
    return this._short.format(d instanceof Date ? d : new Date(d));
  }

  dayMonth(d) {
    return this._dayMonth.format(d instanceof Date ? d : new Date(d));
  }

  monthYear(d) {
    const s = this._monthYear.format(d);
    return s.charAt(0).toLocaleUpperCase(this.locale) + s.slice(1);
  }

  today() {
    return this._today.format(new Date());
  }
}
