/**
 * types.ts — shared types for the campervan alert worker
 */

// ---------------------------------------------------------------------------
// Cloudflare Worker environment bindings
// These match the bindings declared in wrangler.json
// ---------------------------------------------------------------------------

export interface Env {
  DB: D1Database;
}

// ---------------------------------------------------------------------------
// A row returned by the candidate JOIN query
// ---------------------------------------------------------------------------

export interface MatchCandidate {
  alert_id: string;
  user_id: string;
  max_notifications_per_day: number | null;
  listing_id: string;
  from_city: string;
  to_city: string;
  available_date: string;
  price_per_day: number;
  vehicle_type: string | null;
  listing_url: string | null;
  source_site: string;
}

// ---------------------------------------------------------------------------
// Stats returned from a matching engine run
// ---------------------------------------------------------------------------

export interface MatchStats {
  candidates: number;
  skipped_delta: number;
  skipped_cap: number;
  queued: number;
  run_at: string;
}
