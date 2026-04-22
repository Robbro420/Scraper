#!/usr/bin/env node
/**
 * Impressive Leads – Apify-driven lead scraper for Swedish SMEs.
 *
 * Pipeline:
 *  1. Google Maps Scraper (actor nwua9Gu5YkAT85Sp6) – 480 sökningar
 *     (30 orter × 4 branscher × 4 söktermer)
 *  2. Deduplicera unika hemsidor
 *  3. Website Contact Scraper (actor nFiAnXSwprBHCvVco) – plockar e-post
 *  4. CSV: Företag, Stad, Bransch, Hemsida, Epost  →  ~/Desktop/impressive_leads.csv
 */

const { ApifyClient } = require('apify-client');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- Config ----------
const APIFY_TOKEN = process.env.APIFY_TOKEN;
if (!APIFY_TOKEN) {
  console.error('Saknar APIFY_TOKEN i miljön. Kör:\n  APIFY_TOKEN=apify_api_... node index.js');
  process.exit(1);
}

const MAPS_ACTOR = 'nwua9Gu5YkAT85Sp6';     // Google Maps Scraper
const CONTACT_ACTOR = 'nFiAnXSwprBHCvVco';   // Website Contact Scraper

const MAX_RESULTS_PER_SEARCH = 10;
const CONTACT_BATCH_SIZE = 500;              // websites per Contact-scraper run
const OUTPUT_FILENAME = 'impressive_leads.csv';

// Desktop path (falls back to home if no Desktop folder)
const desktopCandidate = path.join(os.homedir(), 'Desktop');
const OUTPUT_DIR = fs.existsSync(desktopCandidate) ? desktopCandidate : os.homedir();
const OUTPUT_PATH = path.join(OUTPUT_DIR, OUTPUT_FILENAME);
const CHECKPOINT_DIR = path.join(__dirname, 'checkpoints');

// ---------- Search space: 30 orter × 4 branscher × 4 termer = 480 ----------
const CITIES = [
  'Stockholm', 'Göteborg', 'Malmö', 'Uppsala', 'Västerås',
  'Örebro', 'Linköping', 'Helsingborg', 'Jönköping', 'Norrköping',
  'Lund', 'Umeå', 'Gävle', 'Borås', 'Eskilstuna',
  'Södertälje', 'Karlstad', 'Halmstad', 'Växjö', 'Sundsvall',
  'Luleå', 'Trollhättan', 'Östersund', 'Kalmar', 'Falun',
  'Visby', 'Karlskrona', 'Kristianstad', 'Skellefteå', 'Uddevalla',
];

const INDUSTRIES = [
  {
    name: 'Camping/Stugby',
    terms: ['camping', 'stugby', 'husbilscamping', 'stuguthyrning'],
  },
  {
    name: 'Restaurang/Krog',
    terms: ['restaurang', 'krog', 'bistro', 'pub'],
  },
  {
    name: 'Aktivitet/Upplevelse',
    terms: ['aktivitet', 'upplevelse', 'äventyr', 'turistaktivitet'],
  },
  {
    name: 'Mäklare',
    terms: ['mäklare', 'fastighetsmäklare', 'bostadsmäklare', 'mäklarbyrå'],
  },
];

// ---------- Helpers ----------
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return /[",;]/.test(s) ? `"${s}"` : s;
}

function normalizeHost(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- Build search queries ----------
function buildSearches() {
  const searches = [];
  for (const city of CITIES) {
    for (const ind of INDUSTRIES) {
      for (const term of ind.terms) {
        searches.push({
          query: `${term} ${city}`,
          city,
          bransch: ind.name,
          term,
        });
      }
    }
  }
  return searches;
}

// ---------- Stage 1: Google Maps ----------
async function runGoogleMaps(client, searches) {
  log(`Stage 1: Google Maps Scraper – ${searches.length} sökningar`);

  const input = {
    searchStringsArray: searches.map((s) => s.query),
    maxCrawledPlacesPerSearch: MAX_RESULTS_PER_SEARCH,
    language: 'sv',
    countryCode: 'se',
    deeperCityScrape: false,
    skipClosedPlaces: true,
    scrapePlaceDetailPage: false,
    scrapeReviewsPersonalData: false,
  };

  log('Startar Apify actor (detta tar en stund – ofta 20-60 min)...');
  const run = await client.actor(MAPS_ACTOR).call(input, {
    waitSecs: 60 * 90, // 90 min hard cap
  });
  log(`Maps-run klar: runId=${run.id}, status=${run.status}`);

  log('Hämtar dataset...');
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  log(`Fick ${items.length} platser totalt`);

  writeJson(path.join(CHECKPOINT_DIR, 'maps_raw.json'), items);
  return items;
}

// ---------- Stage 2: Dedupe & map websites ----------
function dedupeWebsites(items, searches) {
  // Map query -> {city, bransch} för att kunna återfinna metadata
  const queryMeta = new Map(
    searches.map((s) => [s.query.toLowerCase(), { city: s.city, bransch: s.bransch }]),
  );

  // host -> {företag, stad, bransch, hemsida}
  const byHost = new Map();

  for (const it of items) {
    const website = it.website || it.url || null;
    const host = normalizeHost(website);
    if (!host) continue;

    const företag = it.title || it.name || it.placeName || '';

    // Slå upp stad/bransch. Prova olika fält actor:n kan ha.
    const searchString =
      (it.searchString || it.searchQuery || it.searchPageUrl || '').toLowerCase();
    let meta = queryMeta.get(searchString);
    if (!meta) {
      // Fallback: matcha mot city + term i search string
      for (const s of searches) {
        if (searchString.includes(s.query.toLowerCase())) {
          meta = { city: s.city, bransch: s.bransch };
          break;
        }
      }
    }
    if (!meta) {
      // Sista fallback: använd fälten från platsen
      const stad = it.city || '';
      meta = { city: stad, bransch: '' };
    }

    if (!byHost.has(host)) {
      byHost.set(host, {
        host,
        hemsida: website.startsWith('http') ? website : `https://${website}`,
        företag,
        stad: meta.city,
        bransch: meta.bransch,
      });
    }
  }

  const unique = Array.from(byHost.values());
  log(`Unika hemsidor efter dedup: ${unique.length}`);
  writeJson(path.join(CHECKPOINT_DIR, 'websites.json'), unique);
  return unique;
}

// ---------- Stage 3: Website Contact Scraper ----------
async function runContactScraper(client, websites) {
  log(`Stage 3: Website Contact Scraper – ${websites.length} sidor`);

  const batches = chunk(websites, CONTACT_BATCH_SIZE);
  const hostToEmails = new Map();

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    log(`  Batch ${i + 1}/${batches.length} (${batch.length} URL:er)`);

    const input = {
      startUrls: batch.map((w) => ({ url: w.hemsida })),
      maxDepth: 2,
      maxPagesPerStartUrl: 10,
      sameDomain: true,
      considerChildFrames: true,
    };

    const run = await client.actor(CONTACT_ACTOR).call(input, {
      waitSecs: 60 * 60, // 60 min per batch
    });
    log(`  Batch ${i + 1} klar: runId=${run.id}, status=${run.status}`);

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    log(`  Fick ${items.length} kontaktobjekt`);

    for (const it of items) {
      const host = normalizeHost(it.url || it.domain);
      if (!host) continue;
      const emails = Array.isArray(it.emails) ? it.emails : [];
      const existing = hostToEmails.get(host) || new Set();
      for (const e of emails) existing.add(String(e).trim().toLowerCase());
      hostToEmails.set(host, existing);
    }

    writeJson(
      path.join(CHECKPOINT_DIR, `contacts_batch_${i + 1}.json`),
      items,
    );
  }

  return hostToEmails;
}

// ---------- Stage 4: CSV ----------
function writeCsv(websites, hostToEmails, outPath) {
  const header = ['Företag', 'Stad', 'Bransch', 'Hemsida', 'Epost'];
  const rows = [header.join(',')];
  let withEmail = 0;

  for (const w of websites) {
    const emails = hostToEmails.get(w.host);
    const joined = emails && emails.size ? Array.from(emails).join('; ') : '';
    if (joined) withEmail++;
    rows.push(
      [w.företag, w.stad, w.bransch, w.hemsida, joined].map(csvCell).join(','),
    );
  }

  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, rows.join('\n') + '\n', 'utf8');
  log(`CSV skriven: ${outPath}`);
  log(`Rader: ${websites.length}, med e-post: ${withEmail}`);
}

// ---------- Main ----------
(async () => {
  try {
    ensureDir(CHECKPOINT_DIR);
    const client = new ApifyClient({ token: APIFY_TOKEN });

    const searches = buildSearches();
    log(`Totalt ${searches.length} sökningar förberedda (30×4×4=480)`);

    const items = await runGoogleMaps(client, searches);
    const websites = dedupeWebsites(items, searches);

    if (websites.length === 0) {
      log('Inga hemsidor hittade. Avbryter.');
      writeCsv([], new Map(), OUTPUT_PATH);
      return;
    }

    const hostToEmails = await runContactScraper(client, websites);
    writeCsv(websites, hostToEmails, OUTPUT_PATH);

    log('Klart.');
  } catch (err) {
    console.error('\n[FEL]', err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
