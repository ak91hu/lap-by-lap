// Útvonal-modell: pontok (lat, lng, táv, magasság, idő), adatvédelmi vágás
// és a fotók elhelyezése az útvonalon (GPS-koordináta vagy időbélyeg alapján).
import { decodePolyline } from './polyline.js';

const R = 6371000;
function haversine(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLng = (b[1] - a[1]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** @returns {null | {pts: Array<{ll:[number,number], d:number, alt:number|null, t:number|null}>}} */
export function buildTrack(activity, streams) {
  let pts;
  if (streams?.latlng?.length >= 2) {
    pts = streams.latlng.map((ll, i) => ({
      ll,
      d: streams.distance?.[i] ?? null,
      alt: streams.altitude?.[i] ?? null,
      t: streams.time?.[i] ?? null,
    }));
  } else {
    const poly = decodePolyline(activity.polyline || activity.map?.summary_polyline);
    if (poly.length < 2) return null;
    pts = poly.map((ll) => ({ ll, d: null, alt: null, t: null }));
  }
  // Ha nincs távolság-adatsor, számoljuk.
  if (pts.some((p) => p.d == null)) {
    let d = 0;
    pts.forEach((p, i) => {
      if (i > 0) d += haversine(pts[i - 1].ll, p.ll);
      p.d = d;
    });
  }
  return { pts };
}

/** Adatvédelmi zóna: az útvonal első és utolsó `meters` méterét levágja (pl. otthon környéke). */
export function trimTrack(track, meters) {
  if (!track || !meters) return track;
  const total = track.pts[track.pts.length - 1].d;
  if (total <= meters * 2.5) return track; // túl rövid, inkább nem vágunk el mindent
  const pts = track.pts.filter((p) => p.d >= meters && p.d <= total - meters);
  return pts.length >= 2 ? { pts, trimmed: true } : track;
}

export function hasElevation(track) {
  if (!track) return false;
  const alts = track.pts.map((p) => p.alt).filter((a) => a != null);
  if (alts.length < 10) return false;
  return Math.max(...alts) - Math.min(...alts) >= 8;
}

/**
 * Megkeresi minden fotó helyét az útvonalon. A GPS-koordináta az elsődleges,
 * ha az nincs, akkor a fotó időbélyegét vetjük össze az aktivitás idősorával.
 * @returns {Array<number|null>} pontindex fotónként (null = nem helyezhető el)
 */
export function locatePhotos(track, photos, activity) {
  if (!track) return photos.map(() => null);
  const pts = track.pts;
  const startMs = Date.parse(activity.start_date);
  const hasTime = pts.some((p) => p.t != null);
  const cosLat = Math.cos((pts[0].ll[0] * Math.PI) / 180);

  return photos.map((ph) => {
    if (ph.location) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const dy = pts[i].ll[0] - ph.location[0];
        const dx = (pts[i].ll[1] - ph.location[1]) * cosLat;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      // ~400 m-en belül fogadjuk el (a vágott zónában készült fotók így kiesnek).
      if (best >= 0 && haversine(pts[best].ll, ph.location) < 400) return best;
      return null;
    }
    // Archívum: az EXIF-idő helyi idő → a helyi kezdési időhöz mérjük; API: UTC → UTC-hez.
    const when = ph.createdAtLocal || ph.createdAt;
    const ref = ph.createdAtLocal ? Date.parse(activity.start_date_local) : startMs;
    if (hasTime && when && Number.isFinite(ref)) {
      const t = (Date.parse(when) - ref) / 1000;
      if (!Number.isFinite(t) || t < pts[0].t - 60 || t > pts[pts.length - 1].t + 60) return null;
      let best = 0;
      for (let i = 0; i < pts.length; i++) if (pts[i].t != null && pts[i].t <= t) best = i;
      return best;
    }
    return null;
  });
}
