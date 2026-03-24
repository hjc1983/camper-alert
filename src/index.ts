/**
 * Campervan Alert — Worker
 * Cloudflare Worker (TypeScript) + D1
 *
 * Routes:
 *   GET  /health         → liveness check
 *   GET  /run-matching   → manual trigger for matching engine
 *   POST /ingest         → receives scraped listings, writes to D1
 *
 * Scheduled:
 *   cron "0 * * * *"    → runs matching engine every hour
 */

import { Env, Listing, MatchCandidate, MatchStats } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ingest") {
      return handleIngest(request, env);
    }
    if (url.pathname === "/run-matching") {
      const stats = await runMatchingEngine(env);
      return Response.json({ ok: true, ...stats });
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, ts: new Date().toISOString() });
    }
    return Response.json({ ok: true, message: "Campervan alert worker running" });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runMatchingEngine(env).catch((err) => {
        console.error("Matching engine error:", err);
      })
    );
  },
};

// ---------------------------------------------------------------------------
// POST /ingest
// Receives an array of listings from the scraper and upserts into D1.
//
// Request body:
//   {
//     "secret": "your-ingest-secret",
//     "listings": [
//       {
//         "source_site": "transfercar",
//         "from_city": "Sydney",
//         "to_city": "Melbourne",
//         "available_date": "2026-04-15",
//         "vehicle_type": "campervan",
//         "price_per_day": 1.00,
//         "listing_url": "https://..."
//       }
//     ]
//   }
// ---------------------------------------------------------------------------

async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  let body: { secret?: string; listings?: Listing[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (!env.INGEST_SECRET || body.secret !== env.INGEST_SECRET) {
    return Response.json({ ok: false, error: "Unauthorised" }, { status: 401 });
  }

  const listings = body.listings;
  if (!Array.isArray(listings) || listings.length === 0) {
    return Response.json({ ok: false, error: "No listings provided" }, { status: 400 });
  }

  const required: (keyof Listing)[] = ["source_site", "from_city", "to_city", "available_date", "price_per_day"];
  for (const listing of listings) {
    for (const field of required) {
      if (listing[field] === undefined || listing[field] === null) {
        return Response.json({ ok: false, error: `Missing required field: ${field}` }, { status: 400 });
      }
    }
  }

  const results = await upsertListings(env, listings);
  console.log(`Ingest complete: ${results.inserted} inserted, ${results.updated} updated`);
  return Response.json({ ok: true, ...results });
}

async function upsertListings(
  env: Env,
  listings: Listing[]
): Promise<{ inserted: number; updated: number; total: number }> {
  const statements = listings.map((l) =>
    env.DB.prepare(`
      INSERT INTO listings (
        id, source_site, from_city, to_city,
        available_date, vehicle_type, price_per_day,
        listing_url, first_seen_at, last_seen_at, is_active
      ) VALUES (
        lower(hex(randomblob(16))), ?, ?, ?,
        ?, ?, ?, ?, datetime('now'), datetime('now'), 1
      )
      ON CONFLICT (source_site, from_city, to_city, available_date)
      DO UPDATE SET
        price_per_day = excluded.price_per_day,
        listing_url   = excluded.listing_url,
        last_seen_at  = datetime('now'),
        is_active     = 1
    `).bind(
      l.source_site, l.from_city, l.to_city,
      l.available_date, l.vehicle_type ?? null,
      l.price_per_day, l.listing_url ?? null
    )
  );

  const batchResults = await env.DB.batch(statements);
  let inserted = 0;
  for (const result of batchResults) {
    if ((result.meta?.changes ?? 0) >= 1) inserted++;
  }
  return { inserted, updated: batchResults.length - inserted, total: listings.length };
}

// ---------------------------------------------------------------------------
// Matching engine
// ---------------------------------------------------------------------------

async function runMatchingEngine(env: Env): Promise<MatchStats> {
  const stats: MatchStats = {
    candidates: 0,
    skipped_delta: 0,
    skipped_cap: 0,
    queued: 0,
    run_at: new Date().toISOString(),
  };

  const candidates = await fetchCandidates(env);
  stats.candidates = candidates.length;

  if (candidates.length === 0) {
    console.log("No new listings matched any active alerts");
    return stats;
  }

  for (const row of candidates) {
    const alreadyNotified = await checkAlreadyNotified(env, row.alert_id, row.listing_id);
    if (alreadyNotified) { stats.skipped_delta++; continue; }

    const todaysCount = await getTodaysNotificationCount(env, row.alert_id);
    if (todaysCount >= (row.max_notifications_per_day ?? 3)) { stats.skipped_cap++; continue; }

    await queueNotification(env, row);
    stats.queued++;
  }

  console.log("Matching engine complete:", stats);
  return stats;
}

async function fetchCandidates(env: Env): Promise<MatchCandidate[]> {
  const result = await env.DB.prepare(`
    SELECT
      a.id                        AS alert_id,
      a.user_id                   AS user_id,
      a.max_notifications_per_day AS max_notifications_per_day,
      l.id                        AS listing_id,
      l.from_city                 AS from_city,
      l.to_city                   AS to_city,
      l.available_date            AS available_date,
      l.price_per_day             AS price_per_day,
      l.vehicle_type              AS vehicle_type,
      l.listing_url               AS listing_url,
      l.source_site               AS source_site
    FROM alerts a
    JOIN listings l
      ON  l.from_city      = a.from_city
      AND l.to_city        = a.to_city
      AND l.available_date BETWEEN a.travel_date_start AND a.travel_date_end
      AND l.is_active      = 1
      AND (a.max_price_per_day IS NULL OR l.price_per_day <= a.max_price_per_day)
      AND (a.vehicle_type  IS NULL OR l.vehicle_type = a.vehicle_type)
    WHERE a.status     = 'active'
      AND a.expires_at > datetime('now')
      AND l.first_seen_at > datetime('now', '-2 hours')
    ORDER BY a.id, l.price_per_day ASC
  `).all<MatchCandidate>();
  return result.results ?? [];
}

async function checkAlreadyNotified(env: Env, alertId: string, listingId: string): Promise<boolean> {
  const result = await env.DB.prepare(`
    SELECT COUNT(*) AS cnt FROM notifications
    WHERE alert_id = ? AND listing_id = ?
  `).bind(alertId, listingId).first<{ cnt: number }>();
  return (result?.cnt ?? 0) > 0;
}

async function getTodaysNotificationCount(env: Env, alertId: string): Promise<number> {
  const result = await env.DB.prepare(`
    SELECT COUNT(*) AS cnt FROM notifications
    WHERE alert_id = ? AND date(sent_at) = date('now') AND status = 'sent'
  `).bind(alertId).first<{ cnt: number }>();
  return result?.cnt ?? 0;
}

async function queueNotification(env: Env, row: MatchCandidate): Promise<void> {
  const message =
    `New deal: ${row.from_city} → ${row.to_city} ` +
    `on ${row.available_date} for $${row.price_per_day}/day via ${row.source_site}`;

  await env.DB.prepare(`
    INSERT INTO notifications (id, alert_id, listing_id, channel, payload, status, sent_at)
    VALUES (lower(hex(randomblob(16))), ?, ?, 'pending', ?, 'pending', datetime('now'))
  `).bind(row.alert_id, row.listing_id, JSON.stringify({ message, row })).run();

  console.log(`Queued: alert=${row.alert_id} listing=${row.listing_id}`);
}
