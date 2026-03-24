/**
 * scraper/index.ts
 * Playwright scraper for Transfercar and Imoova (AU).
 * Runs in GitHub Actions on a schedule, POSTs results to Cloudflare Worker.
 *
 * Usage:
 *   WORKER_URL=https://camper-alert.xxx.workers.dev \
 *   INGEST_SECRET=your-secret \
 *   npx ts-node scraper/index.ts
 */

import { chromium, Browser, Page } from "playwright";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Listing {
  source_site: string;
  from_city: string;
  to_city: string;
  available_date: string;
  vehicle_type: string | null;
  price_per_day: number;
  listing_url: string | null;
}

// ---------------------------------------------------------------------------
// Config — read from environment variables (set in GitHub Actions secrets)
// ---------------------------------------------------------------------------

const WORKER_URL = process.env.WORKER_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

if (!WORKER_URL || !INGEST_SECRET) {
  console.error("Missing WORKER_URL or INGEST_SECRET environment variables");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"], // required in GitHub Actions
  });

  const allListings: Listing[] = [];

  try {
    console.log("Scraping Transfercar...");
    const transfercarListings = await scrapeTransfercar(browser);
    console.log(`  Found ${transfercarListings.length} listings`);
    allListings.push(...transfercarListings);

    console.log("Scraping Imoova...");
    const imoovaListings = await scrapeImoova(browser);
    console.log(`  Found ${imoovaListings.length} listings`);
    allListings.push(...imoovaListings);
  } finally {
    await browser.close();
  }

  if (allListings.length === 0) {
    console.log("No listings found — nothing to ingest");
    return;
  }

  console.log(`Ingesting ${allListings.length} total listings...`);
  await ingest(allListings);
}

// ---------------------------------------------------------------------------
// Transfercar scraper
// URL: https://www.transfercar.com.au/relocations
// The page loads results via XHR after a short delay — we wait for the
// listing cards to appear before parsing.
// ---------------------------------------------------------------------------

async function scrapeTransfercar(browser: Browser): Promise<Listing[]> {
  const page = await browser.newPage();
  const listings: Listing[] = [];

  try {
    await page.setExtraHTTPHeaders({
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });

    await page.goto("https://www.transfercar.com.au/relocations", {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    // Wait for listing cards to render
    await page.waitForSelector('[data-testid="relocation-card"], .relocation-card, .listing-card', {
      timeout: 15_000,
    }).catch(() => {
      // Selector may vary — fall back to waiting for any price element
      return page.waitForSelector('[class*="price"], [class*="Price"]', { timeout: 10_000 });
    });

    // Extract all listing cards
    const cards = await page.$$eval(
      '[data-testid="relocation-card"], .relocation-card, .listing-card, [class*="RelocationCard"]',
      (elements) =>
        elements.map((el) => {
          const text = (sel: string) => el.querySelector(sel)?.textContent?.trim() ?? "";
          const attr = (sel: string, attr: string) =>
            (el.querySelector(sel) as HTMLElement)?.getAttribute(attr) ?? "";

          return {
            from: text('[class*="from"], [data-testid="from-city"]'),
            to: text('[class*="to"], [data-testid="to-city"]'),
            date: text('[class*="date"], [data-testid="available-date"]'),
            price: text('[class*="price"], [data-testid="price"]'),
            type: text('[class*="vehicle"], [class*="type"]'),
            url: attr("a", "href"),
          };
        })
    );

    for (const card of cards) {
      const parsed = parseTransfercarCard(card);
      if (parsed) listings.push(parsed);
    }
  } catch (err) {
    console.error("Transfercar scrape error:", err);
  } finally {
    await page.close();
  }

  return listings;
}

function parseTransfercarCard(card: {
  from: string;
  to: string;
  date: string;
  price: string;
  type: string;
  url: string;
}): Listing | null {
  if (!card.from || !card.to || !card.date || !card.price) return null;

  // Parse price — strips "$", "/day", commas. e.g. "$1/day" → 1, "$0" → 0
  const priceMatch = card.price.replace(/,/g, "").match(/[\d.]+/);
  if (!priceMatch) return null;
  const price = parseFloat(priceMatch[0]);

  // Parse date — handles "15 Apr 2026", "Apr 15, 2026", "2026-04-15"
  const date = parseDate(card.date);
  if (!date) return null;

  return {
    source_site: "transfercar",
    from_city: normaliseCity(card.from),
    to_city: normaliseCity(card.to),
    available_date: date,
    vehicle_type: normaliseVehicleType(card.type),
    price_per_day: price,
    listing_url: card.url
      ? card.url.startsWith("http")
        ? card.url
        : `https://www.transfercar.com.au${card.url}`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Imoova scraper (formerly iMOVE)
// URL: https://www.imoova.com/en/searches?country=AU
// ---------------------------------------------------------------------------

async function scrapeImoova(browser: Browser): Promise<Listing[]> {
  const page = await browser.newPage();
  const listings: Listing[] = [];

  try {
    await page.setExtraHTTPHeaders({
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });

    await page.goto("https://www.imoova.com/en/searches?country=AU", {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    await page.waitForSelector(
      '[class*="vehicle-card"], [class*="VehicleCard"], .search-result',
      { timeout: 15_000 }
    ).catch(() =>
      page.waitForSelector('[class*="price"]', { timeout: 10_000 })
    );

    const cards = await page.$$eval(
      '[class*="vehicle-card"], [class*="VehicleCard"], .search-result',
      (elements) =>
        elements.map((el) => {
          const text = (sel: string) => el.querySelector(sel)?.textContent?.trim() ?? "";
          const attr = (sel: string, a: string) =>
            (el.querySelector(sel) as HTMLElement)?.getAttribute(a) ?? "";

          return {
            from: text('[class*="from"], [class*="pickup"]'),
            to: text('[class*="to"], [class*="dropoff"]'),
            date: text('[class*="date"], [class*="available"]'),
            price: text('[class*="price"]'),
            type: text('[class*="vehicle-type"], [class*="type"]'),
            url: attr("a", "href"),
          };
        })
    );

    for (const card of cards) {
      const parsed = parseImoovaCard(card);
      if (parsed) listings.push(parsed);
    }
  } catch (err) {
    console.error("Imoova scrape error:", err);
  } finally {
    await page.close();
  }

  return listings;
}

function parseImoovaCard(card: {
  from: string;
  to: string;
  date: string;
  price: string;
  type: string;
  url: string;
}): Listing | null {
  if (!card.from || !card.to || !card.date || !card.price) return null;

  const priceMatch = card.price.replace(/,/g, "").match(/[\d.]+/);
  if (!priceMatch) return null;
  const price = parseFloat(priceMatch[0]);

  const date = parseDate(card.date);
  if (!date) return null;

  return {
    source_site: "imoova",
    from_city: normaliseCity(card.from),
    to_city: normaliseCity(card.to),
    available_date: date,
    vehicle_type: normaliseVehicleType(card.type),
    price_per_day: price,
    listing_url: card.url
      ? card.url.startsWith("http")
        ? card.url
        : `https://www.imoova.com${card.url}`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a date string into ISO format YYYY-MM-DD */
function parseDate(raw: string): string | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;

  // Already ISO: "2026-04-15"
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  // Try native Date parsing — handles "Apr 15, 2026", "15 April 2026" etc.
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split("T")[0];
  }

  return null;
}

/** Normalise city names to consistent title case */
function normaliseCity(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Normalise vehicle type to lowercase standard values */
function normaliseVehicleType(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  if (!lower) return null;
  if (lower.includes("camper") || lower.includes("motorhome") || lower.includes("rv")) {
    return "campervan";
  }
  if (lower.includes("car") || lower.includes("sedan") || lower.includes("suv")) {
    return "car";
  }
  if (lower.includes("van") || lower.includes("minivan")) {
    return "van";
  }
  return lower;
}

// ---------------------------------------------------------------------------
// POST listings to Cloudflare Worker /ingest
// ---------------------------------------------------------------------------

async function ingest(listings: Listing[]): Promise<void> {
  const response = await fetch(`${WORKER_URL}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: INGEST_SECRET, listings }),
  });

  const result = await response.json() as { ok: boolean; inserted?: number; updated?: number; error?: string };

  if (!result.ok) {
    throw new Error(`Ingest failed: ${result.error ?? "unknown error"}`);
  }

  console.log(`Ingest result: inserted=${result.inserted} updated=${result.updated}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Scraper failed:", err);
  process.exit(1);
});
