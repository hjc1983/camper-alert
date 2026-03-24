/**
 * types.ts — shared types for the campervan alert worker
 */

// ---------------------------------------------------------------------------
// Cloudflare Worker environment bindings
// These match the bindings declared in wrangler.json
// ---------------------------------------------------------------------------

export interface Env {
  DB: D1Database;
  INGEST_SECRET: string;
}

// ---------------------------------------------------------------------------
// A listing as received from the scraper via POST /ingest
// ---------------------------------------------------------------------------

export interface Listing {
  source_site: string;       // 'transfercar' | 'imoova'
  from_city: string;
  to_city: string;
  available_date: string;    // ISO date: '2026-04-15'
  vehicle_type?: string;     // 'campervan' | 'car' | null
  price_per_day: number;
  listing_url?: string;
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
