<div align="center">

# 📕 Lap by Lap

***Lapról lapra* · *Every lap, a page.***

**Nyomdakész fotókönyv a valódi Strava-aktivitásaidból és -fotóidból.**
**Print-ready photo books from your real Strava activities and photos.**

![Node.js](https://img.shields.io/badge/node-%E2%89%A522.12-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/express-5.3-000000?logo=express&logoColor=white)
![PDFKit](https://img.shields.io/badge/pdfkit-0.21-CC2927)
![sharp](https://img.shields.io/badge/sharp-0.35-99CC00)
![Garmin FIT SDK](https://img.shields.io/badge/FIT%20SDK-21.222-007CC3)
![Strava API](https://img.shields.io/badge/Strava%20API-v3-FC5200?logo=strava&logoColor=white)
![i18n](https://img.shields.io/badge/i18n-HU%20%7C%20EN-1D6787)
![Print](https://img.shields.io/badge/PDF-300%20DPI%20%C2%B7%20bleed%20%C2%B7%20cover%20spread-2E6B4E)
![Privacy](https://img.shields.io/badge/data-self--hosted-2B2B2E)
![License](https://img.shields.io/badge/license-MIT-blue)

[Magyar](#magyar) · [English](#english)

</div>

---

## Magyar

A Lap by Lap saját gépen vagy saját szerveren futó webalkalmazás. A neve kétnyelvű szójáték: magyarul a *lap* a könyv oldala, angolul a *lap* egy megtett kör, és a könyvet is lapról lapra, körről körre rakja össze. Strava-bejelentkezés után az aktivitásaidból, leírásaidból, útvonalaidból és fotóidból szépen tördelt, nyomdakész PDF fotókönyvet készít. Csak valós adatokkal dolgozik: nincs demó, nincs kitalált tartalom.

### Mitől más?

| | |
|---|---|
| ⚡ **Percek, nem napok** | A Strava API naponta legfeljebb 1000 kérést enged. A **Strava-archívum** feltöltésével minden adat és minden **eredeti, teljes felbontású** fotó egyszerre bekerül, aktivitásonként nulla API-hívással. 1000+ aktivitás is percek alatt kész. |
| 📍 **Fotók a térképen** | Számozott jelölők az útvonalon és a magassági profilon, a fotó GPS-koordinátája (EXIF / Strava) vagy készítési ideje alapján. A képek az útvonal sorrendjében követik egymást. |
| 📖 **Valódi fotókönyv-tördelés** | Oldalpárokban gondolkodik: az évek jobb oldalon nyílnak, bal oldalon az év fotójával. Hős-fotós és klasszikus oldalak váltakoznak, a kiemelt pillanatok egész oldalas kifutó képet kapnak, a fotókon nincs szöveg (a képaláírás alattuk áll). |
| 🗓️ **Évösszegzők** | Edzésnaptár hőtérképpel, havi diagram, rekordok (leghosszabb táv, legtöbb szint, leghosszabb sorozat…), „Minden útvonal” poszteroldal. |
| 🖨️ **Tényleg nyomdakész** | PDF 1.7 sRGB OutputIntenttel, beágyazott betűkkel; 300 DPI-re méretezett képek; 3 mm kifutó (TrimBox/BleedBox); vágójelek; kötési margó; 4-gyel osztható oldalszám; **külön borító-terítő gerinccel** (a gerinc a papír és az oldalszám alapján becsülve vagy megadva); évenkénti kötetekre bontás. Minden könyvhöz **nyomdai előellenőrzési jelentés** készül (DPI, legkisebb betűméret, biztonsági margó, kifutó). |
| 📚 **Könnyen olvasható** | Tartalomjegyzék pontos oldalszámokkal (kétmenetes tördelés), klasszikus élőfej (bal oldalon a cím, jobb oldalon a fejezet), nyomtatáshoz méretezett betűk (törzsszöveg 9,8 pt, másfeles sorköz), tagolt statisztikasávok, a sportágak mozgásidejéből arányos sávok. |
| 🔒 **Adatvédelem** | Minden nálad marad, a saját gépeden vagy szervereden. Adatvédelmi zóna (rajt és cél környéke rejtve), egy kattintással törölhető minden adat, és visszavonható a Strava-hozzáférés. |
| 🎨 **Személyre szabható** | 3 elrendezés (magazin / galéria / napló), 3 papírtónus (fehér / krém / éjszakai), 4 betűstílus (klasszikus, modern, sportos, elegáns), 5 színtéma + saját klubszín, 5 formátum, fejezetbontás évre / évszakra / hónapra / sportágra, időrendi vagy fordított sorrend, választható mutatók (táv, idő, szint, tempó, pulzus, teljesítmény, kalória, csúcspont, kudos), ★ kedvencek kézi kiemeléssel, borító-címpozíció, ajánlás, utószó, extra jegyzetoldalak. Szűrők: privát, ingázás, beltéri/virtuális edzések, minimális táv. |
| 📥 **Fotók letöltése** | A könyvhöz letöltött fotóidat vissza is kaphatod: mindet egy ZIP-ben (aktivitásonként dátum + név szerinti mappákba rendezve), kijelölve, vagy egyenként. A ZIP streamelve készül, így több GB-nál sem telik meg a memória. A hiányzó fotók könyvkészítés nélkül is letölthetők. |
| 📖 **Lapozható mintakönyv** | A kezdőoldalon egy illusztrált mintakönyv lapozható 3D lapfordítással (kedvcsináló, kitalált sportolóval, egyértelműen mintaként jelölve). |
| 🌍 **Kétnyelvű** | Magyar és angol felület és könyv. A nyelvet az IP-cím országa alapján választja (HU → magyar, egyébként angol), kézzel átállítható. A mértékegység a Strava-beállításodat követi (km vagy mi). |

### Gyors kezdés

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm start                   # → http://localhost:3000
```

1. **Strava API-kulcs:** a <https://www.strava.com/settings/api> oldalon hozz létre egy alkalmazást. Az *Authorization Callback Domain* értéke legyen `localhost`. A **Client ID** és a **Client Secret** kerüljön a `.env` fájlba.
2. Nyisd meg a <http://localhost:3000> címet, jelentkezz be a Stravával, és töltsd be az aktivitásaidat (1000 aktivitás ≈ 5 API-hívás).
3. **Gyors mód (ajánlott):** a Stravában válaszd a *Beállítások → Fiókod → Fiókod letöltése vagy törlése → Archívum kérése* lehetőséget (ez nem törli a fiókot). A ZIP-et, amelynek linkjét e-mailben kapod, töltsd fel az alkalmazásba.
4. Válogass, állítsd be a kinézetet, nézd meg az **Előnézetet**, és töltsd le a PDF-et.

### Mennyi ideig tart?

| Forrás | API-hívás / fotós aktivitás | 1000 aktivitás (≈250 fotós) |
|---|---|---|
| Strava-archívum | **0** | **pár perc** (import + tördelés) |
| Csak API, alapbeállítás | 1–3 | 2–8 óra; nagyon sok fotós aktivitásnál a napi keret miatt több nap is lehet |

Mért eredmény (1000 aktivitás, 1386 fotó): 388 oldalas A4-es PDF, **74 mp** tördelés, **~370 MB** csúcs-memória (korlátos, nem nő a könyvvel), 39 MB fájl (300 DPI).

API-módban az alkalmazás kezeli a 15 perces és a napi keretet, és automatikusan folytatja a letöltést. Minden letöltött adat gyorsítótárba kerül, és a tokenek megmaradnak az újraindítás után is. A **„Elkészítés most”** gombbal bármikor elkészítheted a könyvet a már meglévő adatokból.

### Teljesítmény és memória

- **Elhelyezés-pontos képek:** minden fotó pontosan a nyomtatott méretéhez szükséges pixelszámra kerül (300 vagy 150 DPI), libjpeg-turbóval, soronként párhuzamosan. A PDF folyamatosan íródik ki, a képek a beágyazás után felszabadulnak.
- **Takarékos tárolás:** az aktivitáslistából és a részletekből csak a szükséges mezők maradnak meg. Az útvonal-adatsorok ~600 pontra ritkítva, külön fájlban vannak, és csak rajzoláskor töltődnek be.
- **Streamelt archívum:** a több GB-os ZIP-et a szerver közvetlenül lemezre streameli, majd a központi könyvtárból csak a szükséges elemeket olvassa (yauzl). A Strava JPEG-jei újrakódolás nélkül kerülnek tárolásra.
- **Prioritásos letöltés** API-módban: fotólisták → képek → leírások → profilok, korlátozott párhuzamossággal és közös keretkezeléssel.
- **Kis munkamenet-terhelés:** aláírt sütis munkamenet szerveroldali tár nélkül, felhasználónként egy futó feladat.

### Beállítások (`.env`)

| Változó | Leírás |
|---|---|
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | Kötelező. |
| `PORT`, `BASE_URL` | Alapértelmezés: `3000`, `http://localhost:3000`. |
| `DATA_DIR` | Gyorsítótár és könyvek helye (`data/`). |
| `GEOIP=off`, `GEOIP_URL`, `DEFAULT_LANG` | IP-alapú nyelvválasztás. Helyi futtatásnál a gép nyilvános IP-jének országát kérdezi le (`api.country.is`), a választ 24 óráig gyorsítótárazza. |
| `MAP_TILE_URL`, `MAP_ATTRIBUTION` | Opcionális térképháttér-csempék (tartsd be a szolgáltató feltételeit). Nélküle letisztult vektoros útvonalrajz készül. |
| `TRUST_PROXY` | Reverse proxy mögötti futtatáshoz (`loopback`, `true`, ugrásszám vagy címlista). Renderen magától `true`. |

### Üzemeltetés (ingyenes lehetőségek)

Az alkalmazásnak **tartós lemez** kell (tokenek, gyorsítótár, könyvek), **~0,5–1 GB RAM** (a tördelés csúcsa ~370 MB), több GB-os ZIP-feltöltés, és órákig futó háttérletöltés. Ezért a „elalvó”, ideiglenes lemezes ingyenes PaaS-csomagok nem alkalmasak rá.

| Lehetőség | Költség | Mikor jó? |
|---|---|---|
| **Saját gép** (`npm start`) | 0 Ft | Saját használatra. Ez a legjobb adatvédelmi szempontból. |
| **Oracle Cloud Always Free** – Ampere A1 VM (ARM) | 0 Ft (bankkártyás azonosítás kell) | **Ajánlott**, ha mindig elérhető, nyilvános címre van szükség. 2 OCPU / 12 GB RAM és tartós blokktároló, nem alszik el. Népszerű régiókban gyakran nincs szabad A1-kapacitás. |
| **Render ingyenes csomag** (`render.yaml`, automatikus deploy) | 0 Ft | Bemutatóhoz, kipróbáláshoz. Korlátok: a lemez ideiglenes (újraindításkor, deploykor és elalváskor a letöltött adatok és a bejelentkezés elvesznek), 15 perc tétlenség után elalszik (megszakad a hosszú letöltés), és 512 MB RAM-ot ad. |

**Szerveres beállítás** (pl. Oracle VM, Caddy reverse proxyval ugyanazon a gépen, saját domainnel vagy ingyenes aldomainnel, pl. DuckDNS):

```bash
# .env
BASE_URL=https://lapbylap.example.com   # https → biztonságos sütik
SESSION_SECRET=<hosszú véletlen szöveg>
TRUST_PROXY=loopback                    # a proxy ugyanazon a gépen fut
DATA_DIR=/srv/lapbylap/data             # tartós lemezen
```

```caddyfile
# /etc/caddy/Caddyfile – automatikus HTTPS
lapbylap.example.com {
  reverse_proxy localhost:3000
  request_body { max_size 20GB }
}
```

A Strava API-beállításoknál az *Authorization Callback Domain* legyen a szerver domainje (pl. `lapbylap.example.com`). A sharp az ARM64 Linuxot is támogatja, így nincs szükség külön buildre.

#### Render (automatikus deploy a GitHubról)

A repó gyökerében lévő `render.yaml` (Blueprint) leírja a szolgáltatást, és minden `main` ágra érkező push után automatikusan új deployt indít.

1. A Render felületén: **New → Blueprint**, majd válaszd ki a GitHub-repót.
2. A Render elkéri a titkos értékeket: `STRAVA_CLIENT_ID` és `STRAVA_CLIENT_SECRET` (ezek **soha nem kerülnek a repóba**). A `SESSION_SECRET`-et a Render generálja, a `BASE_URL`-t pedig az alkalmazás a `RENDER_EXTERNAL_URL`-ből veszi.
3. A Strava API-beállításoknál az *Authorization Callback Domain* legyen a Render-domain (pl. `lap-by-lap.onrender.com`). A `localhost` mindig engedélyezett, így a helyi fejlesztés is működik tovább.

> **Strava-korlát:** az új API-alkalmazások *Single Player* módban indulnak, ilyenkor csak a saját fiókod csatlakozhat. Az API-beállításokban önállóan bővítheted 10 sportolóig. Ennél többhöz a Strava *Extended Access* felülvizsgálata kell, ami hetekig is tarthat.

### Mintakönyv újragenerálása

A kezdőoldal lapozható mintakönyvének oldalképei a `public/sample/{hu,en}` mappában vannak. A tördelés változása után így generálhatók újra (fejlesztői függőség: `mupdf`):

```bash
npm run sample
```

A szkript (`tools/build-sample.mjs`) procedurálisan rajzolt tájképekkel és egy kitalált sportoló („Kata Példa”) évével dolgozik. Kizárólag a bemutatóhoz kell; a felhasználói könyvek mindig a valós Strava-adatokból készülnek.

### Felépítés

```
src/
  server.js     Express 5: OAuth, aláírt munkamenet, feladatok, feltöltések, letöltés, biztonsági fejlécek
  strava.js     Strava API-kliens: token-frissítés, 15 perces és napi keret, megszakítható várakozás
  archive.js    Strava-archívum import: CSV, FIT/GPX/TCX, EXIF (GPS + idő), streamelt ZIP
  photos.js     Letöltött fotók listája, bélyegképek, egyenkénti és ZIP-letöltés (yazl, streamelve)
  sync.js       Prioritásos, párhuzamos, gyorsítótárazott letöltés
  store.js      Fájlalapú tár (atomikus írás), tokenek, könyvek
  geo.js        IP → ország → nyelv
  i18n.js       Szerver- és PDF-szövegek (hu/en), sportágnevek
  format.js     Nyelv- és mértékegység-érzékeny formázás
  pdf/
    book.js     Tördelés: borító, áttekintés, útvonal-poszter, évnyitók, aktivitás-sablonok, napló, borító-terítő
    layout.js   Justified-rows fotóelrendezés
    images.js   Elhelyezés-pontos képméretezés, intelligens kivágás
    maps.js     Opcionális csempés térképháttér
    track.js    Útvonal, adatvédelmi vágás, fotók elhelyezése
public/         Felület build nélkül (ES-modulok), kétnyelvű
```

---

## English

Lap by Lap is a web app you run on your own machine or server. The name is a bilingual pun: in Hungarian a *lap* is a page, in English it is a lap you ride or run, and the book is built page by page, lap by lap. Sign in with Strava, and it turns your activities, descriptions, routes and photos into a beautifully laid-out, **print-ready PDF photo book**. It works only with real data: no demo, no made-up content.

### Highlights

- ⚡ **Minutes, not days.** The Strava API allows only 1,000 requests a day. Upload your **Strava archive** and every activity, description, GPS file and **original full-resolution photo** comes in at once, with zero API calls per activity.
- 📍 **Photos on the map.** Numbered markers on the route and the elevation profile, placed by GPS (EXIF/Strava) or by capture time. Photos follow the order of the route.
- 📖 **Real photo-book layout.** Spread-aware year openers (right-hand page, photo on the left), alternating hero and classic templates, sparing full-bleed highlights, and captions under the photos instead of on them.
- 🗓️ **Year in review.** Training calendar heatmap, monthly chart, records and streaks, plus an “Every route” poster page.
- 🖨️ **Print-ready.** PDF 1.7 with an sRGB OutputIntent and embedded fonts, 300 DPI placement-exact images, 3 mm bleed with TrimBox/BleedBox, crop marks, binding gutter, page count divisible by 4, **separate cover spread with spine**, one volume per year, and a **preflight report** for every book.
- 📚 **Easy to read.** Table of contents with exact page numbers (two-pass layout), classic running heads, print-sized type (9.8 pt body, 1.5 leading), clearly divided stat bands.
- 🔒 **Private by design.** Everything stays with you, on your own machine or server. Privacy zones, one-click data deletion and Strava access revocation.
- 🎨 **Make it yours.** Magazine, gallery or journal layout; white, cream or night paper; classic, modern, sporty or elegant type; five themes plus your club colour; chapters by year, season, month or sport; pick the stats to show; ★ favourites; cover title position; dedication, afterword and notes pages; filters for private, commute and indoor activities.
- 📥 **Download your photos.** Get back the photos fetched for your book: all in one ZIP (one folder per activity, named by date and title), a selection, or one at a time. The ZIP is streamed, so even multi-GB downloads stay light on memory. Missing photos can be fetched without making a book.
- 📖 **Flip-through sample.** The landing page has an illustrated sample book with 3D page turns (fictional athlete, clearly labelled as a sample).
- 🌍 **Bilingual.** Hungarian and English UI and books, picked by IP country (HU → Hungarian, otherwise English), switchable by hand. Units follow your Strava preference.

### Quick start

```bash
npm install
cp .env.example .env
npm start          # → http://localhost:3000
```

Create a Strava API application at <https://www.strava.com/settings/api> (callback domain `localhost`) and put the Client ID and Client Secret into `.env`. For large books, request your archive in Strava (*Settings → My Account → Download or Delete Your Account → Request your archive*; this does not delete your account) and upload the ZIP you receive by email.

### Hosting (free options)

The app needs a **persistent disk** (tokens, cache, books), **~0.5–1 GB RAM** (layout peaks at ~370 MB), multi-GB ZIP uploads, and background syncs that can run for hours. Free PaaS tiers that sleep and have an ephemeral disk are not a good fit.

| Option | Cost | Use it when |
|---|---|---|
| **Your own machine** (`npm start`) | free | Personal use. Best for privacy. |
| **Oracle Cloud Always Free**: Ampere A1 VM (ARM) | free (card needed for verification) | **Recommended** when you need an always-on public URL. 2 OCPU / 12 GB RAM, persistent block storage, never sleeps. A1 capacity is often unavailable in popular regions. |
| **Render free tier** (`render.yaml`, auto-deploy) | free | Demos and trying it out. Limits: the disk is ephemeral (downloaded data and sign-ins are lost on every restart, deploy and spin-down), it sleeps after 15 min idle (which kills long syncs), and you get 512 MB RAM. |

On a server, set `BASE_URL=https://your.domain`, a fixed `SESSION_SECRET`, `TRUST_PROXY=loopback` (with Caddy or nginx on the same host) and a `DATA_DIR` on persistent storage. Set the Strava *Authorization Callback Domain* to your domain. The Caddyfile in the Hungarian section above works as is. New Strava API apps start in *Single Player* mode (only you can connect). You can self-upgrade to 10 athletes in the API settings; more needs Strava's *Extended Access* review.

**Render (auto-deploy from GitHub).** The `render.yaml` Blueprint in the repo root defines the service and deploys every push to `main`. In Render choose **New → Blueprint** and pick the repo. Render asks for `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` (never committed), generates `SESSION_SECRET`, and the app takes `BASE_URL` from `RENDER_EXTERNAL_URL`. Set the Strava *Authorization Callback Domain* to your `*.onrender.com` domain; `localhost` always stays allowed for local development.

### Requirements

Node.js ≥ 22.12 (tested on 26 LTS). Every dependency is pinned to its latest release: `express` 5.3, `pdfkit` 0.21, `sharp` 0.35, `@garmin/fitsdk` 21.222, `yauzl` 3.4, `yazl` 3.3, `exif-reader` 2.0, and Inter + Fraunces fonts (OFL).

---

<sub>Lap by Lap is not affiliated with or endorsed by Strava. Powered by Strava. Fonts: Inter & Fraunces (SIL Open Font License).</sub>
