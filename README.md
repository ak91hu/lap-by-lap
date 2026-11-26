<div align="center">

# 📕 Lap by Lap

***Every lap, a page.***

**Print-ready photo books from your real Strava activities and photos.**

![Node.js](https://img.shields.io/badge/node-%E2%89%A522.12-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/express-5.3-000000?logo=express&logoColor=white)
![PDFKit](https://img.shields.io/badge/pdfkit-0.21-CC2927)
![sharp](https://img.shields.io/badge/sharp-0.35-99CC00)
![Garmin FIT SDK](https://img.shields.io/badge/FIT%20SDK-21.222-007CC3)
![Strava API](https://img.shields.io/badge/Strava%20API-v3-FC5200?logo=strava&logoColor=white)
![i18n](https://img.shields.io/badge/i18n-EN%20%7C%20HU-1D6787)
![Print](https://img.shields.io/badge/PDF-300%20DPI%20%C2%B7%20bleed%20%C2%B7%20cover%20spread-2E6B4E)
![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

**Live:** <https://p01--lap-by-lap--dmg6gnvmmd7s.code.run>

</div>

---

## Contents

- [What it is](#what-it-is)
- [Features](#features)
- [How it works](#how-it-works)
- [Quick start (local)](#quick-start-local)
- [Getting your data in](#getting-your-data-in)
- [Making a book](#making-a-book)
- [Downloading your photos](#downloading-your-photos)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Performance](#performance)
- [Capacity and concurrent users](#capacity-and-concurrent-users)
- [Storing finished books](#storing-finished-books)
- [Privacy and data storage](#privacy-and-data-storage)
- [Security](#security)
- [HTTP API](#http-api)
- [Project structure](#project-structure)
- [Development](#development)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [License and credits](#license-and-credits)

---

## What it is

Lap by Lap is a self-hosted web app for endurance athletes. You sign in with Strava, and it turns your activities, descriptions, routes and photos into a carefully laid-out **PDF photo book that a print shop can print as is**: right colour profile, bleed, crop marks, spine width and all.

It works **only with your real data**. There is no demo mode and no made-up content in your books. The flip-through sample on the landing page uses a fictional, clearly labelled athlete and exists only as a teaser.

The name is a bilingual pun: in Hungarian a *lap* is a page, in English it is a lap you run or ride. The book is built page by page, lap by lap. The UI and the books are available in **English and Hungarian**.

## Features

### 🪄 Effortless by default

- **Quick book:** pick a year (or all of them) and click **Create book**. Sensible defaults do the rest; the detailed settings stay folded away under **More settings** until you want them.
- **Everything is remembered:** every choice (filters, design, stats, favourites, left-out photos, cover) is saved automatically on the server, so a reload or another device picks up exactly where you left off.
- **Live estimate:** activities, photos and page count update as you change anything.
- **Notifications:** long jobs show their progress in the browser tab title, and a system notification tells you when the book, sync, archive import or photo download is done while you are elsewhere.

### ⚡ Minutes, not days

The Strava API allows only about 1,000 requests a day, which can make a photo book of a big history take days. Lap by Lap solves this with the **Strava archive import**: upload the ZIP that Strava emails you, and every activity, description, GPS file and **original full-resolution photo** comes in at once, with **zero API calls per activity**. Even 1,000+ activities are ready in minutes.

In API-only mode the app respects both the 15-minute and the daily rate limits, waits and resumes automatically, caches everything it downloads, and keeps tokens across restarts. You can skip the wait at any time (**Build now with the data already downloaded**) and build the book from what is already cached.

### 📍 Photos on the map

- Numbered photo markers on the route map and on the elevation profile.
- A photo is placed by its GPS position (EXIF or Strava) or, if it has none, by its capture time matched to the GPS track.
- Photos follow the order of the route, so the page tells the story of the day.

### 📖 A real photo-book layout

- Spread-aware: year openers always start on a right-hand page, with the photo of the year on the left.
- Hero and classic activity templates alternate, and the best moments get sparing full-bleed pages.
- Captions sit under the photos, never on top of them.
- Justified-row photo layout with smart cropping.
- Three layouts: **magazine**, **gallery** and **journal**.

### 🌦️ Weather and QR codes on every activity

- **Weather at the start** of each photo activity (temperature and sky, e.g. *4 °C · fog*) from the free [Open-Meteo](https://open-meteo.com/) historical API. Only the start point rounded to about 10 km and the date are sent, results are cached per activity, and indoor/virtual activities are skipped.
- **QR code next to each activity title** that opens the activity on Strava: scan the printed page to get back to the map, the kudos and the video.

### 🗓️ Year in review

Training calendar heatmap, monthly distance chart, records (longest distance, most elevation, longest streak …), proportional sport bars by moving time, and an **"Every route"** poster page with all your routes of the year.

### 🖨️ Actually print-ready

- PDF 1.7 with an sRGB OutputIntent and embedded fonts.
- Images resampled to exactly 300 DPI at their placed size (or 150 DPI for screen quality).
- 3 mm bleed with proper TrimBox / BleedBox, optional crop marks, binding gutter.
- Page count padded to a multiple of 4.
- **Separate cover spread with spine.** The spine width is estimated from paper type and page count, or set by hand.
- Optional split into **one volume per year**.
- A **preflight report** with every book: image DPI, smallest font size, safe margin, bleed, page count.

### 📚 Easy to read

Table of contents with exact page numbers (two-pass layout), classic running heads (book title on the left page, chapter on the right), print-sized type (9.8 pt body text, 1.5 line spacing), and clearly divided stat bands.

### 🎨 Make it yours

| | |
|---|---|
| **Look** | 3 layouts · 3 paper tones (white, cream, night) · 4 typefaces (classic, modern, sporty, elegant) · 5 colour themes plus your own club colour · 5 page sizes (A4 portrait/landscape, 21 cm and 30 cm square, A5) |
| **Structure** | Chapters by year, season, month or sport (or none) · chronological or reverse order · table of contents · year pages · route poster |
| **Content** | Pick the stats to show (distance, time, elevation, pace, weather, heart rate, power, calories, highest point, kudos) · ★ favourites get the hero treatment · max photos per activity · leave single photos out · captions and descriptions on/off · maps and elevation on/off · weather and QR codes on/off |
| **Cover** | Any of your own Strava photos with one click, an uploaded image, or a route-art cover · title position · subtitle |
| **Extras** | Dedication, afterword, blank notes pages |
| **Filters** | Date range, sports, exclude private, commute or indoor/virtual activities, minimum distance, hand-pick single activities |

### 📥 Download your photos

The photos fetched for your book can be downloaded again: **all of them in one ZIP**, **a selection**, or **one at a time**. See [Downloading your photos](#downloading-your-photos).

### 🔒 Private by design

Your data stays on your own machine or server. Privacy zones hide the start and finish of your routes, all data can be deleted with one click, and the Strava access can be revoked from the app.

### 🌍 Bilingual

English and Hungarian UI and books. The language is picked from your IP country (Hungary → Hungarian, otherwise English) and can be switched by hand. Units follow your Strava preference (km or miles).

## How it works

```
                ┌───────────────┐      OAuth       ┌──────────────┐
  Browser  ───▶ │  Express app  │ ◀──────────────▶ │  Strava API  │
  (no build,    │  src/server.js│                  └──────────────┘
   ES modules)  │               │  ZIP upload      ┌──────────────┐
                │  background   │ ◀─────────────── │Strava archive│
                │  jobs         │                  └──────────────┘
                │      │        │
                │      ▼        │   file store (DATA_DIR)
                │  sync/archive ├──▶ activities, photo lists, images,
                │      │        │    GPS streams, details, tokens
                │      ▼        │
                │  PDF layout   ├──▶ books/*.pdf  (+ cover spread)
                └───────────────┘
```

1. **Sign in** with Strava (OAuth, scope `read,activity:read_all`).
2. **Load activities.** The activity list comes from the API (about 5 calls per 1,000 activities).
3. **Get the details**, either from the **Strava archive** (recommended: originals, GPS files, captions, no API calls) or from the API, in priority order: photo lists → images → descriptions → elevation streams.
4. **Lay out the book.** PDFKit streams the PDF to disk page by page, and images are freed right after they are embedded, so memory stays flat no matter how big the book is.
5. **Download** the PDF (and the cover spread), preview it in the browser, or download the photos.

Long-running work (sync, archive import, book build, photo fetch) runs as a **background job**. The UI polls its progress, and only one job per athlete runs at a time, so the API quota is never used twice.

## Quick start (local)

**Requirements:** Node.js ≥ 22.12 (tested on Node 24 and 26).

```bash
git clone https://github.com/ak91hu/lap-by-lap.git
cd lap-by-lap
npm install
cp .env.example .env          # Windows: copy .env.example .env
npm start                     # → http://localhost:3000
```

### Create a Strava API application

1. Go to <https://www.strava.com/settings/api> and create an application.
2. Set **Authorization Callback Domain** to `localhost` for local use, or to your server's domain (`localhost` and `127.0.0.1` always stay allowed by Strava).
3. Copy the **Client ID** and **Client Secret** into `.env`:

   ```ini
   STRAVA_CLIENT_ID=123456
   STRAVA_CLIENT_SECRET=your-client-secret
   ```

4. Restart the app and open <http://localhost:3000>.

> **Athlete capacity.** New Strava API apps start in *Single Player* mode: only the owner can connect. You can raise it yourself to 10 athletes in the API settings; more needs Strava's *Extended Access* review.

## Getting your data in

### Option A: Strava archive (recommended)

1. In Strava open **Settings → My Account → Download or Delete Your Account → Request your archive**. This does **not** delete your account.
2. Strava emails you a download link, usually within a few hours.
3. In Lap by Lap, open the **Fast mode: Strava archive** box, click **Choose ZIP** and pick the file. Multi-GB archives are fine: the upload is streamed straight to disk, and only the needed entries are read from the ZIP.

The archive brings in activities (CSV), GPS files (FIT, GPX, TCX), **original photos** with EXIF (GPS position and capture time) and captions. Videos are skipped, and HEIC files are skipped if the system has no codec for them.

### Option B: Strava API only

Click **Load activities**. Photos, descriptions and elevation profiles are fetched when you build a book or fetch photos. Expect about 1–3 API calls per activity with photos:

| Source | API calls per photo activity | 1,000 activities (~250 with photos) |
|---|---|---|
| Strava archive | **0** | **a few minutes** (import + layout) |
| API only, default settings | 1–3 | 2–8 hours; with lots of photo activities, possibly several days because of the daily limit |

The side panel shows an estimate before you start. Activities older than your archive import need no API calls.

## Making a book

For most people the **Quick book** card is enough: pick a year and click **Create book**. Open **More settings** for full control:

1. **Select:** pick years or a date range, sports and filters, or hand-pick activities in the list. Star ★ the activities you want highlighted.
2. **Design:** title, subtitle, page size, layout, paper tone, typeface, theme or club colour, cover photo or route-art cover.
3. **Content:** stats to show, chapters, order, maps, elevation profiles, descriptions, captions, privacy zone, dedication, afterword, notes pages.
4. **Print:** print or screen quality, bleed and crop marks, binding gutter, multiple of 4 pages, one volume per year, cover spread with paper type and spine width.
5. Click **Preview** for a quick book of your three latest photo activities, or **Create book** for the full PDF.

Every finished book comes with a preflight summary and print tips. Earlier books are listed in the side panel for download or deletion.

## Downloading your photos

The **Download your photos** card serves exactly the local files the book is made from (`DATA_DIR/athletes/<id>/images/…`). Nothing is fetched again from Strava. It is also where you curate the book:

- **⊘ Leave out of the book / ↺ put back:** per photo, or for all selected photos at once. Left-out photos are greyed out and skipped when the book is laid out; the estimate updates immediately.
- **▣ Use as cover:** makes any of your photos the book cover, no upload needed.

- **Download all as ZIP:** one folder per activity, named `YYYY-MM-DD Activity name/01.jpg`, in route/time order. The ZIP is **stored, not compressed** (JPEGs don't compress), and **streamed** to the browser through a normal form POST, so even multi-GB archives use almost no server or browser memory.
- **Browse and select:** a thumbnail grid grouped by activity. Tick single photos or a whole activity, then **Download selected**. One photo downloads as a single file, several as a ZIP.
- **One at a time:** every thumbnail has a ↓ button that downloads that photo as `YYYY-MM-DD Activity name 03.jpg`.
- **Fetch missing photos:** if fewer photos are on disk than Strava reports, this downloads the missing ones without making a book (the same cache the book uses).

Thumbnails (360 px) are generated on first view and cached in `DATA_DIR/athletes/<id>/thumbs/`.

## Configuration

All settings are environment variables, read from `.env` when present.

| Variable | Default | Description |
|---|---|---|
| `STRAVA_CLIENT_ID` | – | **Required.** Strava API application ID. |
| `STRAVA_CLIENT_SECRET` | – | **Required.** Strava API application secret. |
| `PORT` | `3000` | HTTP port. |
| `BASE_URL` | `http://localhost:PORT` | Public URL, used for the OAuth callback. An `https://` URL turns on secure cookies. Falls back to `RENDER_EXTERNAL_URL` when present. |
| `DATA_DIR` | `data` | Cache, tokens, photos and books. Put it on persistent storage. |
| `SESSION_SECRET` | generated | Signs the session cookie. If empty, one is generated and stored in `DATA_DIR/.session-secret`. Set it explicitly on servers. |
| `TRUST_PROXY` | `loopback` | Express `trust proxy`: a hop count, `true`, `false` or an address list. Use the **exact number of proxies** in front of the app (Northflank: `1`, measured), never `true` on a public host: with `true` a client can fake its IP via `X-Forwarded-For`. |
| `TOKEN_KEY` | from `SESSION_SECRET` | Key for encrypting Strava tokens at rest (AES-256-GCM, via HKDF). If neither is set, a session secret is generated in `DATA_DIR`. Changing it means everyone signs in again. |
| `RATE_LIMIT_PER_MIN` | `3000` | Requests per minute per client IP for `/api` and `/auth` (sign-in start: 60, uploads: 20). |
| `GEOIP` | on | `off` disables the IP-country lookup for language detection (falls back to the browser language). |
| `GEOIP_URL` | `https://api.country.is/` | Country lookup service. Answers are cached for 24 hours. |
| `DEFAULT_LANG` | `en` | Fallback language (`en` or `hu`). |
| `MAP_TILE_URL` | – | Optional basemap tiles for route maps, e.g. `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`. Without it, routes are drawn as clean vector maps. Respect the provider's terms. |
| `MAP_ATTRIBUTION` | `© OpenStreetMap contributors` | Attribution printed with basemap tiles. |
| `WEATHER` | on | `off` disables the weather lookup (Open-Meteo). |
| `MAX_HEAVY_JOBS` | from memory | How many memory-heavy jobs (book, preview, archive import) run at once; the rest wait in a queue. Default: `(container memory − 200 MB) / 450 MB`, at least 1, at most the CPU count. |
| `THUMB_CONCURRENCY` | `2` | Parallel thumbnail generations. |
| `ARCHIVE_MAX_GB` | `10` | Largest accepted Strava archive upload. Uploads are also refused when the disk would drop below 512 MB free. |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_PREFIX` | – | Optional S3-compatible storage for finished books (Backblaze B2, Cloudflare R2, MinIO …). See [Storing finished books](#storing-finished-books). |
| `BOOKS_KEEP` | `5` | Finished books kept per athlete (volumes and cover spreads of one build count as one book). |
| `BOOKS_TTL_DAYS` | `0` (never) | Delete finished books after this many days. |
| `PREVIEW_TTL_HOURS` | `24` | Previews are deleted after this many hours. |

## Deployment

The app needs a **persistent disk** (tokens, cache, photos, books), **about 0.5–1 GB RAM** (the layout peaks around 370 MB), large uploads, and background jobs that can run for hours. Free tiers that sleep or have an ephemeral disk lose all data on restart, so they are a poor fit.

| Option | Cost | Notes |
|---|---|---|
| **Northflank Sandbox** | free | **The live instance runs here.** Always on, persistent volume, builds from this repo on every push. The free allowance fits a 0.2 vCPU / 512 MB instance, so large books lay out slowly. |
| **Your own machine** | free | Best for privacy. `npm start`, done. |
| **Any VPS / Oracle Cloud Always Free** | free–cheap | Most headroom (Oracle's free Ampere A1 VM has 2 OCPU / 12 GB RAM). Run it with Docker or Node behind Caddy. |
| Render / Koyeb free tiers | free | Not recommended: ephemeral disk, sleeps when idle, 512 MB RAM. |

### Docker

```bash
docker build -t lap-by-lap .
docker run -d --name lap-by-lap -p 3000:3000 \
  -e STRAVA_CLIENT_ID=... -e STRAVA_CLIENT_SECRET=... \
  -e BASE_URL=https://lapbylap.example.com -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e TRUST_PROXY=1 \
  -v lap-by-lap-data:/data \
  lap-by-lap
```

The image is based on `node:24-bookworm-slim`, installs only production dependencies, and stores everything under the `/data` volume.

### Northflank (how the live instance is set up)

- A **combined service** `lap-by-lap` builds the `Dockerfile` from this public repository and redeploys on every push to `main`.
- A **6 GB persistent volume** (`lap-by-lap-data`, NVMe, the smallest size Northflank allows) is mounted at `/data`.
- Plan `nf-compute-20` (0.2 vCPU / 512 MB), the largest that fits the free allowance.
- **Secrets live only in the service's runtime variables:** `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` and `SESSION_SECRET`, plus `BASE_URL`, `DATA_DIR=/data`, `TRUST_PROXY=1` (exactly one proxy in front of the app, so client IPs cannot be faked). None of them are in the repository.
- The Strava *Authorization Callback Domain* is set to the service's `*.code.run` domain.

To set it up again in your own Northflank account:

```bash
npm i -g @northflank/cli
northflank login -n lap-by-lap      # approve in the browser
node tools/northflank-setup.mjs     # reads the Strava keys from .env
```

The script is idempotent. It creates the service and the volume if they are missing, sets the runtime variables (keeping an existing `SESSION_SECRET`, so nobody gets signed out), starts one instance, and prints the URL to enter as the Strava callback domain. Push-triggered builds need the Northflank GitHub App to have access to the repository.

### Behind a reverse proxy (VPS)

```caddyfile
# /etc/caddy/Caddyfile — automatic HTTPS
lapbylap.example.com {
  reverse_proxy localhost:3000
}
```

```ini
# .env
BASE_URL=https://lapbylap.example.com
SESSION_SECRET=<long random string>
TRUST_PROXY=loopback
DATA_DIR=/srv/lap-by-lap/data
```

`sharp` ships prebuilt binaries for Linux x64 and ARM64, so no native build is needed.

## Performance

Measured with 1,000 activities and 1,386 photos: a **388-page A4 PDF** in **74 s** layout time, **~370 MB** peak memory (bounded, it does not grow with the book), 39 MB file at 300 DPI.

- **Placement-exact images:** every photo is resampled to exactly the pixels needed for its printed size (libjpeg-turbo, in parallel per row). The PDF is written as a stream, and images are released after embedding.
- **Lean storage:** only the fields needed are kept from activity lists and details. GPS streams are thinned to about 600 points, stored in separate files, and loaded only while drawing.
- **Streamed archive:** the ZIP is streamed to disk, then only the needed entries are read from its central directory (yauzl). Strava JPEGs are stored without re-encoding when they are already sRGB and upright.
- **Prioritised API sync:** photo lists → images → descriptions → streams, with bounded concurrency and a shared rate-limit handler.
- **Light sessions:** signed-cookie sessions with no server-side session store, and one running job per athlete.

## Capacity and concurrent users

Built and measured for **20–30 people using the app at the same time** (`npm run loadtest`):

- **Memory-safe queue.** Laying out a book peaks around 300–370 MB, so the number of books (and archive imports) made at the same time is limited to what fits the container's memory (`MAX_HEAVY_JOBS`, 1 on a 512 MB instance). Everyone else sees their position (*In the queue, position 3*) and the job starts automatically. Light requests (browsing, photos, settings) never wait in this queue.
- **One shared Strava quota.** Strava's rate limit (100 requests / 15 min, 1,000 / day) applies to the whole app, not per user. When one user's request hits the limit, every other sync pauses too instead of collecting 429 errors, and each user's progress shows the wait.
- **One job per athlete**, bounded thumbnail generation (`THUMB_CONCURRENCY`, de-duplicated per image), streamed ZIP and PDF downloads, and a disk-space check before archive uploads.
- **Health endpoint:** `GET /healthz` returns uptime, memory and the job queue (no personal data).

Load test with 30 simultaneous users for 60 s (each browsing, opening the photo grid, saving settings and downloading ZIPs), while 15 of them requested a book or preview, with `MAX_HEAVY_JOBS=1` and a 384 MB heap to mimic the free Northflank instance:

| Request | p50 | p95 | Notes |
|---|---|---|---|
| Status / settings save | 3–4 ms | 60–140 ms | during PDF layout |
| Thumbnail | 2 ms | ~1.1 s | p95 is the first generation; cached afterwards |
| ZIP of 3 photos | 19 ms | ~0.5 s | streamed |

Result: **no errors**, all 15 books done within 44 s of being requested (queue included), server memory peak **280–297 MB**. The test machine is faster than a 0.2 vCPU instance, so on the free tier expect the same behaviour with longer book times; for 20–30 *active* book makers a larger instance (e.g. `nf-compute-50`, 0.5 vCPU / 1 GB) is recommended.

> **Strava athlete capacity.** A Strava API app can connect up to **10 athletes** after self-upgrading in the API settings. For 20–30 users, apply for Strava's *Extended Access* review.

## Storing finished books

Finished PDFs are large (about 40 MB for 400 pages at 300 DPI), so they are managed on purpose:

- **Retention, always on:** previews are deleted after 24 hours (`PREVIEW_TTL_HOURS`); each athlete keeps their **5 latest books** (`BOOKS_KEEP`; the volumes and cover spreads of one build count as one book), optionally with an age limit (`BOOKS_TTL_DAYS`). Cleanup runs after every build and hourly.
- **Optional S3-compatible storage:** set the `S3_*` variables and every finished book (not previews) is uploaded right after it is made, and the local copy is deleted, so the server's disk only holds photos and the cache. Downloads and the in-browser viewer stream the file from the bucket through the app (with HTTP Range support), so the bucket stays private and no public links exist. Deleting a book or all your data deletes the stored objects too.

Free options (both S3-compatible, 10 GB free):

| Service | Free | Notes |
|---|---|---|
| **Backblaze B2** | 10 GB storage, egress free up to 3× the stored amount | No credit card needed to sign up. Endpoint like `https://s3.eu-central-003.backblazeb2.com`, region `eu-central-003`. |
| **Cloudflare R2** | 10 GB-month storage, no egress fees | May ask for a payment method. Endpoint `https://<account-id>.r2.cloudflarestorage.com`, region `auto`. |

```ini
S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
S3_REGION=eu-central-003
S3_BUCKET=lap-by-lap-books          # a private bucket
S3_ACCESS_KEY_ID=<keyID>            # an application key limited to this bucket
S3_SECRET_ACCESS_KEY=<applicationKey>
```

Book metadata (`<name>.pdf.json`: size, pages, build, where it is stored) stays next to the local books folder.

## Privacy and data storage

- Everything is stored as files in `DATA_DIR`, written atomically (temp file + rename):

  ```
  DATA_DIR/
    .session-secret              (only if SESSION_SECRET is not set)
    athletes/<athleteId>/
      tokens.json                Strava OAuth tokens (mode 600)
      athlete.json               profile basics
      activities.json            trimmed activity list
      photos/<activityId>.json   photo list (order, captions, GPS)
      images/<activityId>/       photos used in the book + index.json (size, EXIF)
      thumbs/<activityId>/       360 px thumbnails for the photo browser
      details/  streams/         descriptions, elevation/GPS streams
      uploads/                   your cover photo
      weather/<activityId>.json  cached weather at the start
      settings.json              your saved book settings
    books/<athleteId>/*.pdf      finished books and cover spreads (only metadata when stored in S3)
    books/<athleteId>/*.pdf.json book metadata: size, pages, build, local or S3
    tiles/                       basemap tile cache (only with MAP_TILE_URL)
  ```

- **Privacy zones** cut 0, 200, 500 or 1,000 m off the start and end of every route on maps.
- **Delete my data** removes everything stored for you and revokes the app's Strava access.
- No analytics, no third-party scripts. The only outside calls are Strava, the optional basemap tiles, the optional IP-country lookup for the UI language, and the optional weather lookup (start point rounded to ~10 km plus the date).
- Strict security headers: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS.

## Security

Threat model: a public, multi-user web app that holds Strava tokens, private activity data and photos. What is in place (and covered by `test/security.test.mjs` and `test/server.test.mjs`):

| Area | Protection |
|---|---|
| **Sessions** | HMAC-SHA256-signed cookie with an issue time; expires after 30 days, constant-time signature check. `HttpOnly`, `SameSite=Lax`, `Secure` and the **`__Host-` prefix** on HTTPS, so sibling subdomains cannot overwrite it ("cookie tossing"). OAuth `state` is bound to the cookie. |
| **CSRF** | Every state-changing request (`POST`/`PUT`/`DELETE`) must come from the app's own origin (`Origin` / `Sec-Fetch-Site` check). This matters because `*.code.run` is **not on the Public Suffix List**: other apps there count as "same-site", so `SameSite=Lax` alone would not stop them. |
| **Tokens at rest** | Strava access and refresh tokens are stored AES-256-GCM-encrypted (`TOKEN_KEY` / HKDF of `SESSION_SECRET`), file mode 600; old plain files are re-encrypted on first use. A leaked volume snapshot alone does not give access to anyone's Strava data. |
| **Authorization** | Every file is resolved inside the signed-in athlete's own folder; activity, photo, book and cover names are validated against strict patterns (no path traversal); jobs are only visible to their owner. Deleting the token file ends the session immediately. |
| **XSS / injection** | Strict CSP (`script-src 'self'`, no inline scripts, `object-src 'none'`, `frame-ancestors 'self'`), the UI writes user data only with `textContent`; uploads are re-encoded images served as `image/jpeg` with `nosniff`. |
| **Headers** | HSTS (on HTTPS), `X-Content-Type-Options`, `Referrer-Policy: same-origin`, `X-Frame-Options`, `Cross-Origin-Opener-Policy` and `-Resource-Policy: same-origin`, a restrictive `Permissions-Policy`, no `X-Powered-By`. |
| **Abuse / DoS** | Per-IP rate limits; bounded uploads (archive size, free-disk check, 30 MB cover, 1 MB settings); ZIP entry count, entry size and gzip output limits (no zip/gzip bombs); linear-time GPX/TCX parsing; image pixel limits; one job per athlete and a memory-bounded queue for heavy jobs; malformed cookies are ignored instead of failing requests. |
| **Outbound calls** | Only Strava, its photo CDN, Open-Meteo (start point rounded to ~10 km), the optional tile server, and the IP-country lookup. The country lookup only runs for valid IP addresses, is de-duplicated and cached in a bounded cache, and only accepts 2-letter country codes. |
| **Secrets & supply chain** | No secrets in the repository or its history (checked); `npm audit`: 0 known vulnerabilities; tests never read `.env` and never call the real Strava API. |

Known limits: signing out clears the cookie on that device but does not revoke other devices' cookies before they expire (30 days); use **Delete my data** to end all sessions. For the strongest cookie isolation, serve the app on your own domain (or a domain on the Public Suffix List, e.g. `*.northflank.app`) instead of `*.code.run`.

## HTTP API

The UI is a thin client over these endpoints. All `/api/*` routes except `status` and `lang` require a signed-in session.

| Method & path | Purpose |
|---|---|
| `GET /auth/login` · `GET /auth/callback` · `POST /auth/logout` | Strava OAuth flow and sign-out |
| `GET /api/status` | Language, sign-in state, summary, books, running job, archive info |
| `POST /api/lang` | Set the UI language |
| `GET /api/activities` | Compact activity list for the picker |
| `POST /api/sync` | Job: load the activity list from Strava |
| `POST /api/archive` | Upload a Strava archive ZIP (raw body) and import it as a job |
| `POST /api/cover` | Upload a cover image (raw body) |
| `POST /api/cover/photo` · `GET /api/cover/:id` | Use one of your photos as the cover (`{"ref":"<activity>/<photo>"}`) · fetch the prepared cover |
| `GET /api/settings` · `PUT /api/settings` | Load / save the book settings (JSON) |
| `POST /api/book` | Job: build a book or a preview with the given options |
| `GET /api/jobs/:id` · `POST /api/jobs/:id/skip` | Job progress · skip the API wait and use cached data |
| `GET /api/books` · `GET /api/books/:name` · `DELETE /api/books/:name` | List, download (`?inline` to view), delete books |
| `GET /api/photos` | Downloaded photos grouped by activity, with counts |
| `GET /api/photos/:activity/:photo` | A photo (`?thumb` for a thumbnail, `?download` as an attachment) |
| `POST /api/photos/zip` | Streamed ZIP (`application/x-www-form-urlencoded`: `all=1` or `ids=<activity>/<photo>` lines) |
| `POST /api/photos/fetch` | Job: download missing photos without making a book |
| `POST /api/forget` | Delete all data (including books in S3) and revoke Strava access |
| `GET /healthz` | Uptime, memory, job queue (public, no personal data) |

## Project structure

```
src/
  server.js       Express 5: OAuth, signed session, jobs, uploads, downloads, security headers
  config.js       Environment, session secret, proxy settings
  strava.js       Strava API client: token refresh, 15-minute and daily limits, cancellable waits
  sync.js         Prioritised, parallel, cached download of activities, photos, details, streams
  archive.js      Strava archive import: CSV, FIT/GPX/TCX, EXIF (GPS + time), streamed ZIP
  photos.js       Photo listing, thumbnails, single and ZIP downloads (yazl, streamed)
  storage.js      Finished-book storage: local or S3-compatible (aws4fetch), retention, streamed downloads
  options.js      Validation and defaults of the book options
  weather.js      Weather at the activity start (Open-Meteo), cached per activity
  jobs.js         In-memory background jobs with progress and a memory-safe queue for heavy jobs
  store.js        File store (atomic writes), tokens, books
  geo.js          IP → country → language
  i18n.js         Server and PDF strings (en/hu), sport names
  format.js       Locale- and unit-aware formatting
  pdf/
    book.js       Layout: cover, overview, route poster, year openers, activity templates, journal, cover spread
    layout.js     Justified-rows photo layout
    collage.js    Photo-page composition engine (guillotine cell layout)
    images.js     Placement-exact resampling, smart crop
    maps.js       Optional tiled basemaps
    track.js      Routes, privacy cut, photo placement on the track
    polyline.js   Encoded polyline decoding, Mercator projection
public/           Build-free UI (ES modules): app.js, i18n.js, flipbook.js, style.css
public/sample/    Pre-rendered pages of the landing-page sample book (en/hu)
tools/
  build-sample.mjs      Renders the sample book (fictional athlete) to WebP pages
  northflank-setup.mjs  One-time Northflank setup
  loadtest.mjs          Load test: N simultaneous users with fictional data and a mock Strava
test/             node:test suites (unit, modules, PDF layout, server integration, storage, static UI)
Dockerfile        Production image (Node 24, DATA_DIR=/data)
```

## Development

```bash
npm run dev       # restart on file changes (node --watch)
npm run check     # syntax check of the server and the client
npm run sample    # re-render the landing-page sample book (needs the dev dependency mupdf)
npm test          # the full test suite (about a minute)
npm run loadtest  # 30 simultaneous users for 60 s (USERS, DURATION, BOOKS, MAX_HEAVY_JOBS, HEAP_MB)
```

The UI has no build step: edit `public/*.js` and `public/style.css` and reload. UI strings are in `public/i18n.js`, book and server strings in `src/i18n.js`, always in both languages.

The sample book (`tools/build-sample.mjs`) uses procedurally drawn landscapes and a fictional athlete. Re-render it after layout changes. User books are always made from real Strava data.

**Dependencies:** `express` 5.3, `pdfkit` 0.21, `sharp` 0.35, `@garmin/fitsdk` 21.222, `yauzl` 3.4, `yazl` 3.3, `qrcode` 1.5, `aws4fetch` 1.0, `exif-reader` 2.0, and the Inter, Fraunces, Oswald and Playfair Display fonts.

## Tests

`npm test` runs 96 tests with Node's built-in test runner. No extra test framework is needed; PDFs are checked with the `mupdf` dev dependency. All tests use **fictional athletes in temporary folders**, a **mock Strava server** (OAuth, API v3, photo CDN) and a **mock S3 server**. They never touch your `data/` folder, never read your `.env` (`LAPBYLAP_NO_DOTENV=1`) and never call the real Strava API (`STRAVA_API_URL` / `STRAVA_OAUTH_URL` point to the mock or to an unreachable local address; these two variables exist only for tests).

| Suite | What it covers |
|---|---|
| `unit` | CSV parsing, formatting and units, polylines, stream thinning, weather codes, input validation, proxy settings, queue sizing, Strava client (shared rate-limit pause, token refresh on 401, errors) |
| `modules` | Photo listing, ZIP (all, selection, missing files), concurrent thumbnails, weather lookup and caching, the heavy-job queue, Strava archive import (CSV, captions, videos, GPX, re-import, broken ZIP) |
| `book` | 26 PDF builds: every layout × paper tone, every page size, bleed and crop marks, chapters, order, extras, English/imperial, weather and QR, left-out photos, max photos, yearly volumes and cover spread, books without photos |
| `server` | The full journey through the real server: OAuth (state, scope, denial), sync, photo fetch, books from API data, photo grid/ZIP, settings, covers, preview and full books, yearly volumes, deletion, archive upload (size limit, broken ZIP), revoked Strava access, logout and data deletion; plus security headers, caching rules, 401s, forged cookies, path traversal and other users' data |
| `storage` | Retention rules, legacy files, S3 upload with signed requests, local copy removal, streamed and ranged downloads, previews kept local, retention and deletion in S3, data deletion |
| `security` | Session signing and expiry, token encryption and migration, CSRF from foreign and sibling (`*.code.run`) origins, malformed cookies, rate limits, `__Host-` cookie and HSTS on HTTPS, security headers, gzip bomb and unclosed GPX points, IP validation and de-duplication in the country lookup |
| `ui-static` | Every element the UI script uses exists, no duplicate ids, Hungarian and English strings match (keys and placeholders), every server job step and job kind has a label, no `innerHTML` with user data |

## Troubleshooting

| Problem | Fix |
|---|---|
| Strava says *redirect_uri invalid* | The *Authorization Callback Domain* in your Strava API settings must match the host of `BASE_URL` (no `https://`, no path). |
| The start page shows *One-time setup: Strava API key* instead of the Strava button | `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` are missing. Set them and restart. |
| Only you can sign in | The Strava app is in *Single Player* mode. Raise the athlete capacity in the Strava API settings. |
| Book build waits for a long time | The Strava rate limit was hit. Wait (the job resumes by itself), click **Build now with the data already downloaded**, or import your Strava archive. |
| Signed out after every restart | Set a fixed `SESSION_SECRET`, or keep `DATA_DIR` on persistent storage. |
| Photos missing in the book | Some photos failed to download or are videos/HEIC. Use **Fetch missing photos**, or import the archive for originals. |
| Out of memory on a small instance | Keep `MAX_HEAVY_JOBS=1`, use screen quality, split the book into yearly volumes, or give the app more RAM. |
| "In the queue" for a long time | Other users' books are being made; the job starts automatically. Raise `MAX_HEAVY_JOBS` only if the instance has the memory for it. |
| Raw text keys like `con.weather` after a deploy | An old cached script; reload once with Ctrl+F5. Since this release UI files are revalidated on every load. |

## License and credits

[MIT](LICENSE) © 2026 Lap by Lap contributors.

Lap by Lap is not affiliated with or endorsed by Strava. Powered by Strava. Fonts: Inter, Fraunces, Oswald and Playfair Display (SIL Open Font License).
