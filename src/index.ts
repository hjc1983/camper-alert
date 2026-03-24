/**
 * Campervan Alert — Matching Engine
 * Cloudflare Worker (TypeScript) + D1
 *
 * Handlers:
 *   GET /run-matching   → manual trigger for testing
 *   scheduled           → cron trigger (every hour)
 */

import { Env, MatchCandidate, MatchStats } from "./types";

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export default {
  /**
   * HTTP handler — manual trigger for testing in browser or curl.
   * Example: curl https://camper-alert.<your-subdomain>.workers.dev/run-matching
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run-matching") {
      const stats = await runMatchingEngine(env);
      return Response.json({ ok: true, ...stats });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, ts: new Date().toISOString() });
    }

    return Response.json({ ok: true, message: "Campervan alert worker running" });
  },

  /**
   * Cron handler — Cloudflare calls this on the schedule in wrangler.json.
   * Errors are caught and logged so a bad run doesn't silence future crons.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runMatchingEngine(env).catch((err) => {
        console.error("Matching engine error:", err);
      })
    );
  },
};

// ---------------------------------------------------------------------------
// Core matching engine
// ---------------------------------------------------------------------------

async function runMatchingEngine(env: Env): Promise<MatchStats> {
  const stats: MatchStats = {
    candidates: 0,
    skipped_delta: 0,
    skipped_cap: 0,
    queued: 0,
    run_at: new Date().toISOString(),
  };

  // Step 1 — Single JOIN query: route + date + price + freshness + active status.
  // Pulls only listings first_seen in the last 2 hours (matches cron frequency).
  // Returns every alert that could match — delta + cap checks happen in TS below.
  const candidates = await fetchCandidates(env);
  stats.candidates = candidates.length;

  if (candidates.length === 0) {
    console.log("No new listings matched any active alerts");
    return stats;
  }

  // Step 2 — For each candidate: delta check → cap check → queue
  for (const row of candidates) {
    // Delta check: has this exact listing already triggered this exact alert?
    const alreadyNotified = await checkAlreadyNotified(env, row.alert_id, row.listing_id);
    if (alreadyNotified) {
      stats.skipped_delta++;
      continue;
    }

    // Daily cap check: how many notifications sent today for this alert?
    const todaysCount = await getTodaysNotificationCount(env, row.alert_id);
    const dailyCap = row.max_notifications_per_day ?? 3;
    if (todaysCount >= dailyCap) {
      stats.skipped_cap++;
      continue;
    }

    // All checks passed — write pending notification to D1
    await queueNotification(env, row);
    stats.queued++;
  }

  console.log("Matching engine complete:", stats);
  return stats;
}

// ---------------------------------------------------------------------------
// Step 1 — Candidate query (single D1 JOIN)
// ---------------------------------------------------------------------------

async function fetchCandidates(env: Env): Promise<MatchCandidate[]> {
  const query = `
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
  `;

  const result = await env.DB.prepare(query).all<MatchCandidate>();
  return result.results ?? [];
}

// ---------------------------------------------------------------------------
// Step 2a — Delta check
// ---------------------------------------------------------------------------

async function checkAlreadyNotified(
  env: Env,
  alertId: string,
  listingId: string
): Promise<boolean> {
  const result = await env.DB.prepare(`
    SELECT COUNT(*) AS cnt
    FROM notifications
    WHERE alert_id   = ?
      AND listing_id = ?
  `)
    .bind(alertId, listingId)
    .first<{ cnt: number }>();

  return (result?.cnt ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Step 2b — Daily cap check
// ---------------------------------------------------------------------------

async function getTodaysNotificationCount(env: Env, alertId: string): Promise<number> {
  const result = await env.DB.prepare(`
    SELECT COUNT(*) AS cnt
    FROM notifications
    WHERE alert_id   = ?
      AND date(sent_at) = date('now')
      AND status        = 'sent'
  `)
    .bind(alertId)
    .first<{ cnt: number }>();

  return result?.cnt ?? 0;
}

// ---------------------------------------------------------------------------
// Step 2c — Queue notification
// ---------------------------------------------------------------------------

async function queueNotification(env: Env, row: MatchCandidate): Promise<void> {
  const message = buildMessage(row);

  // Write to D1 BEFORE dispatching — guarantees delta check catches it
  // even if dispatch crashes, preventing double-sends on retry.
  await env.DB.prepare(`
    INSERT INTO notifications (
      id, alert_id, listing_id,
      channel, payload, status, sent_at
    ) VALUES (
      lower(hex(randomblob(16))),
      ?, ?,
      'pending', ?, 'pending', datetime('now')
    )
  `)
    .bind(row.alert_id, row.listing_id, JSON.stringify({ message, row }))
    .run();

  console.log(`Queued notification: alert=${row.alert_id} listing=${row.listing_id}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMessage(row: MatchCandidate): string {
  return (
    `New deal: ${row.from_city} → ${row.to_city} ` +
    `on ${row.available_date} ` +
    `for $${row.price_per_day}/day ` +
    `via ${row.source_site}`
  );
}
