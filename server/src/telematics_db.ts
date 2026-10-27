import { loadConfig, type Env } from "./config.js";
import { BudgetError, HcssClient } from "./hcss.js";
import { TELEMATICS_SCOPE_ERROR } from "./scopes.js";
import { dedupeSnapshots, normalizeSnapshot, toSnapshot, type SnapshotRow } from "./telematics.js";

const INSERT_SQL = `INSERT INTO meter_snapshots (
  snapshot_date, equipment_code, odometer, odometer_unit, odometer_at, engine_hours, engine_hours_at, captured_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT(snapshot_date, equipment_code) DO UPDATE SET
  odometer = excluded.odometer,
  odometer_unit = excluded.odometer_unit,
  odometer_at = excluded.odometer_at,
  engine_hours = excluded.engine_hours,
  engine_hours_at = excluded.engine_hours_at,
  captured_at = excluded.captured_at`;

const CAP = 20_000;
const BATCH = 40;

export async function upsertSnapshots(db: D1Database, rows: readonly SnapshotRow[]): Promise<number> {
  const unique = dedupeSnapshots(rows);
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    await db.batch(chunk.map((r) => db.prepare(INSERT_SQL).bind(
      r.snapshot_date, r.equipment_code, r.odometer, r.odometer_unit, r.odometer_at,
      r.engine_hours, r.engine_hours_at, r.captured_at,
    )));
  }
  return unique.length;
}

/** Snapshots inside the inclusive date window, plus each unit's latest snapshot before start_date (the delta baseline). */
export async function loadSnapshots(db: D1Database, start: string, end: string, equipmentCode?: string): Promise<SnapshotRow[]> {
  const code = equipmentCode?.trim() || null;
  const cols = "snapshot_date, equipment_code, odometer, odometer_unit, odometer_at, engine_hours, engine_hours_at, captured_at";
  const inRange = await db.prepare(
    `SELECT ${cols} FROM meter_snapshots
     WHERE snapshot_date >= ?1 AND snapshot_date <= ?2
       AND (?3 IS NULL OR lower(equipment_code) = lower(?3))`,
  ).bind(start, end, code).all<Record<string, unknown>>();
  const prior = await db.prepare(
    `SELECT s.snapshot_date, s.equipment_code, s.odometer, s.odometer_unit, s.odometer_at, s.engine_hours, s.engine_hours_at, s.captured_at
     FROM meter_snapshots s
     INNER JOIN (
       SELECT equipment_code, MAX(snapshot_date) AS snapshot_date
       FROM meter_snapshots
       WHERE snapshot_date < ?1
         AND (?2 IS NULL OR lower(equipment_code) = lower(?2))
       GROUP BY equipment_code
     ) p ON p.equipment_code = s.equipment_code AND p.snapshot_date = s.snapshot_date`,
  ).bind(start, code).all<Record<string, unknown>>();
  const out: SnapshotRow[] = [];
  for (const row of [...(prior.results ?? []), ...(inRange.results ?? [])]) {
    const n = normalizeSnapshot(row);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Cron body: every telematics unit (registered and unregistered), one row per equipment for the UTC date.
 * A missing telematics:read scope is logged and swallowed so Cloudflare does not retry it all day.
 * Transient HCSS errors are rethrown so the platform retries. Pages that fit before the subrequest cap are still saved.
 */
export async function captureTelematicsSnapshot(env: Env, when = new Date()): Promise<{ upserted: number; truncated: boolean }> {
  const cfg = loadConfig(env);
  if (!env.TELEMATICS_DB) throw new Error("TELEMATICS_DB binding is not configured.");
  const hcss = new HcssClient(cfg);
  const snapshotDate = when.toISOString().slice(0, 10);
  const capturedAt = when.toISOString();
  let pulled;
  try {
    pulled = await hcss.fetchTelematicsEquipment(CAP);
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    if (e instanceof Error && e.message === TELEMATICS_SCOPE_ERROR) {
      console.error(JSON.stringify({ evt: "telematics_snapshot_scope" }));
      return { upserted: 0, truncated: false };
    }
    throw e;
  }
  const rows: SnapshotRow[] = [];
  for (const raw of pulled.records) {
    const row = toSnapshot(raw, snapshotDate, capturedAt);
    if (row) rows.push(row);
  }
  const upserted = rows.length ? await upsertSnapshots(env.TELEMATICS_DB, rows) : 0;
  console.log(JSON.stringify({ evt: "telematics_snapshot", date: snapshotDate, upserted, truncated: pulled.truncated, hcss_calls: hcss.used }));
  return { upserted, truncated: pulled.truncated };
}
