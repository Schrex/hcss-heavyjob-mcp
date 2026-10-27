import { codeCompare, normCode } from "./hcss.js";

/**
 * Compact mapping for GET https://api.hcssapps.com/telematics/api/v1/equipment.
 * Field names are the Telematics OpenAPI schema ApiEquipmentRead
 * (https://developer.hcssapps.com/hcss/reference/get_api-v1-equipment-1), not a live response.
 * All reads go through this function so a schema mismatch is fixed in one place.
 */
export const TELEMATICS_SOURCE_FIELDS = [
  "code",
  "description",
  "make",
  "model",
  "lastLatitude",
  "lastLongitude",
  "lastLocationDateTime",
  "lastOdometerReadingInMiles",
  "lastOdometerReadingInMeters",
  "lastOdometerReadingDateTime",
  "lastHourMeterReadingInHours",
  "lastHourMeterReadingInSeconds",
  "lastHourMeterReadingDateTime",
] as const;

export const COMPACT_FIELDS = [
  "equipment_code",
  "description",
  "make",
  "model",
  "last_latitude",
  "last_longitude",
  "last_location_at",
  "odometer",
  "engine_hours",
  "heavyjob_match",
  "heavyjob_equipment_id",
] as const;

/** Miles in one day above this are flagged implausible_jump and left out of totals. Scaled by the number of days since the previous snapshot. */
export const MAX_MILES_PER_DAY = 1000;
/** Engine hours in one day above this are flagged the same way. A full day (24) is allowed. */
export const MAX_ENGINE_HOURS_PER_DAY = 24;
/** Meter noise smaller than this is treated as zero so float conversion is not a "reset". */
const MILES_EPSILON = 0.0001;
const HOURS_EPSILON = 0.0001;
const METERS_PER_MILE = 1609.344;

export const USAGE_FLAGS = [
  "no_baseline",
  "gap",
  "negative_delta",
  "zero_jump",
  "implausible_jump",
  "unit_change",
  "unknown_unit",
] as const;
export type UsageFlag = (typeof USAGE_FLAGS)[number];

type Rec = Record<string, unknown>;

export interface OdometerReading {
  value: number | null;
  /** "miles" when lastOdometerReadingInMiles is present, otherwise "meters", otherwise null. */
  unit: "miles" | "meters" | null;
  at: string | null;
}
export interface EngineHoursReading {
  value: number | null;
  at: string | null;
}
export interface TelematicsCompact {
  equipment_code: string;
  description: string | null;
  make: string | null;
  model: string | null;
  last_latitude: number | null;
  last_longitude: number | null;
  last_location_at: string | null;
  odometer: OdometerReading;
  engine_hours: EngineHoursReading;
  heavyjob_match: boolean;
  heavyjob_equipment_id: string | null;
  /**
   * Present only when odometer.value or engine_hours.value is null.
   * Names of the fields on that HCSS record, so a live response shows the real schema
   * instead of a silent null. When the documented meter names are absent, this is every key.
   */
  meter_fields_found?: string[];
}

const ODOMETER_VALUE_FIELDS = ["lastOdometerReadingInMiles", "lastOdometerReadingInMeters"] as const;
const HOUR_VALUE_FIELDS = ["lastHourMeterReadingInHours", "lastHourMeterReadingInSeconds"] as const;

/** Keys to attach when a meter value could not be read. Documented names that are present narrow the list to meter-like keys; otherwise every key is returned. */
export function meterFieldsFound(raw: Rec, odometerMissing: boolean, hoursMissing: boolean): string[] | undefined {
  if (!odometerMissing && !hoursMissing) return undefined;
  const keys = Object.keys(raw).sort();
  const expected = [
    ...(odometerMissing ? ODOMETER_VALUE_FIELDS : []),
    ...(hoursMissing ? HOUR_VALUE_FIELDS : []),
  ];
  const documentedNamePresent = expected.some((k) => Object.hasOwn(raw, k));
  if (!documentedNamePresent) return keys;
  const meterish = keys.filter((k) => /odo|mile|km|meter|hour|engine|hobbs/i.test(k));
  return meterish.length ? meterish : keys;
}

export interface SnapshotRow {
  snapshot_date: string;
  equipment_code: string;
  odometer: number | null;
  odometer_unit: string | null;
  odometer_at: string | null;
  engine_hours: number | null;
  engine_hours_at: string | null;
  captured_at: string;
}

export interface UsageRow {
  equipment_code?: string;
  date?: string;
  /** Counted miles (negative and implausible jumps omitted). Null when nothing countable exists. */
  miles_driven: number | null;
  /** Counted engine-hour delta, same exclusion rules. */
  engine_hours: number | null;
  /** Signed miles that were flagged and excluded from miles_driven. */
  uncounted_miles: number | null;
  /** Signed engine hours that were flagged and excluded from engine_hours. */
  uncounted_engine_hours: number | null;
  flags: UsageFlag[];
  days?: number;
  equipment?: number;
}

export interface UsageTotals {
  scope: "snapshots_in_range";
  start_date: string;
  end_date: string;
  equipment: number;
  days: number;
  miles_driven: number | null;
  engine_hours: number | null;
  uncounted_miles: number | null;
  uncounted_engine_hours: number | null;
  flagged_rows: number;
  negative_deltas: number;
  zero_jumps: number;
  gaps: number;
  implausible_jumps: number;
  no_baseline: number;
}

export function finiteOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function textOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}
function asRec(raw: unknown): Rec | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Rec;
}
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
function squash(n: number, eps: number): number {
  return Math.abs(n) < eps ? 0 : n;
}
function orderFlags(flags: Iterable<string>): UsageFlag[] {
  const have = new Set(flags);
  return USAGE_FLAGS.filter((f) => have.has(f));
}

/** First HeavyJob id per trimmed, case-insensitive equipment code. */
export function heavyjobIndex(rows: readonly Rec[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of rows) {
    const key = normCode(e.equipmentCode).toLowerCase();
    const id = e.equipmentId;
    if (!key || m.has(key) || (typeof id !== "string" && typeof id !== "number")) continue;
    m.set(key, String(id));
  }
  return m;
}

/** true = registered only (isRegistered=true). includeUnregistered omits the query param so HCSS returns all. */
export function isRegisteredQuery(includeUnregistered: boolean): true | undefined {
  return includeUnregistered ? undefined : true;
}

export function mapTelematicsEquipment(raw: unknown, heavyjobByCode: ReadonlyMap<string, string>): TelematicsCompact {
  const r = asRec(raw) ?? {};
  const code = normCode(r.code);
  const miles = finiteOrNull(r.lastOdometerReadingInMiles);
  const meters = finiteOrNull(r.lastOdometerReadingInMeters);
  const odometer: OdometerReading = miles != null
    ? { value: miles, unit: "miles", at: textOrNull(r.lastOdometerReadingDateTime) }
    : meters != null
      ? { value: meters, unit: "meters", at: textOrNull(r.lastOdometerReadingDateTime) }
      : { value: null, unit: null, at: textOrNull(r.lastOdometerReadingDateTime) };
  const hours = finiteOrNull(r.lastHourMeterReadingInHours);
  const seconds = finiteOrNull(r.lastHourMeterReadingInSeconds);
  const engine_hours: EngineHoursReading = {
    value: hours != null ? hours : seconds != null ? seconds / 3600 : null,
    at: textOrNull(r.lastHourMeterReadingDateTime),
  };
  const hj = code ? heavyjobByCode.get(code.toLowerCase()) : undefined;
  const meter_fields_found = meterFieldsFound(r, odometer.value == null, engine_hours.value == null);
  return {
    equipment_code: code,
    description: textOrNull(r.description),
    make: textOrNull(r.make),
    model: textOrNull(r.model),
    last_latitude: finiteOrNull(r.lastLatitude),
    last_longitude: finiteOrNull(r.lastLongitude),
    last_location_at: textOrNull(r.lastLocationDateTime),
    odometer,
    engine_hours,
    heavyjob_match: Boolean(hj),
    heavyjob_equipment_id: hj ?? null,
    ...(meter_fields_found !== undefined ? { meter_fields_found } : {}),
  };
}

/**
 * Untouched HCSS record plus mapped fields. Existing HCSS keys are not overwritten
 * (description, make, and model stay as HCSS sent them).
 */
export function mapTelematicsEquipmentDetail(raw: unknown, heavyjobByCode: ReadonlyMap<string, string>): Rec {
  const compact = mapTelematicsEquipment(raw, heavyjobByCode);
  const base = asRec(raw) ? { ...(raw as Rec) } : {};
  const mapped: Rec = {
    equipment_code: compact.equipment_code,
    last_latitude: compact.last_latitude,
    last_longitude: compact.last_longitude,
    last_location_at: compact.last_location_at,
    odometer: compact.odometer,
    engine_hours: compact.engine_hours,
    heavyjob_match: compact.heavyjob_match,
    heavyjob_equipment_id: compact.heavyjob_equipment_id,
  };
  if (compact.meter_fields_found !== undefined) mapped.meter_fields_found = compact.meter_fields_found;
  const added: Rec = {};
  for (const [k, v] of Object.entries(mapped)) {
    if (!Object.hasOwn(base, k)) added[k] = v;
  }
  return { ...base, ...added };
}

export function equipmentMatchesText(row: Pick<TelematicsCompact, "equipment_code" | "description">, text?: string): boolean {
  const t = text?.trim().toLowerCase();
  if (!t) return true;
  return `${row.equipment_code} ${row.description ?? ""}`.toLowerCase().includes(t);
}

export function equipmentTotals(rows: readonly TelematicsCompact[], truncated: boolean) {
  return {
    scope: truncated ? "partial (row cap hit; totals are a lower bound)" : "all_matching_equipment",
    equipment: rows.length,
    unmatched_heavyjob: rows.filter((r) => !r.heavyjob_match).length,
    with_location: rows.filter((r) => r.last_latitude != null && r.last_longitude != null).length,
    with_odometer: rows.filter((r) => r.odometer.value != null).length,
    with_engine_hours: rows.filter((r) => r.engine_hours.value != null).length,
  };
}

export function pageRows<T>(rows: readonly T[], skip = 0, maxRecords = 50) {
  const start = Math.max(0, skip);
  const data = rows.slice(start, start + maxRecords);
  const next = start + data.length;
  return {
    total_matching: rows.length,
    returned: data.length,
    skip: start,
    next_skip: next < rows.length ? next : undefined,
    data: [...data],
  };
}

export function buildEquipmentList(raws: readonly unknown[], heavyjobByCode: ReadonlyMap<string, string>, opts: {
  text?: string;
  skip?: number;
  max_records?: number;
  truncated?: boolean;
} = {}) {
  let rows = raws.map((raw) => ({ raw, compact: mapTelematicsEquipment(raw, heavyjobByCode) }));
  if (opts.text?.trim()) rows = rows.filter((r) => equipmentMatchesText(r.compact, opts.text));
  rows.sort((a, b) => codeCompare(a.compact.equipment_code, b.compact.equipment_code));
  const compacts = rows.map((r) => r.compact);
  const page = pageRows(rows, opts.skip ?? 0, opts.max_records ?? 100);
  return { totals: equipmentTotals(compacts, Boolean(opts.truncated)), ...page };
}

/** One snapshot row per equipment. Blank codes are dropped. Miles are preferred over meters, matching the compact mapper. */
export function toSnapshot(raw: unknown, snapshotDate: string, capturedAt: string): SnapshotRow | null {
  const row = mapTelematicsEquipment(raw, new Map());
  if (!row.equipment_code) return null;
  return {
    snapshot_date: snapshotDate,
    equipment_code: row.equipment_code,
    odometer: row.odometer.value,
    odometer_unit: row.odometer.value == null ? null : row.odometer.unit,
    odometer_at: row.odometer.at,
    engine_hours: row.engine_hours.value,
    engine_hours_at: row.engine_hours.at,
    captured_at: capturedAt,
  };
}

export function dedupeSnapshots(rows: readonly SnapshotRow[]): SnapshotRow[] {
  const m = new Map<string, SnapshotRow>();
  for (const r of rows) {
    const code = normCode(r.equipment_code);
    if (!code) continue;
    m.set(`${r.snapshot_date}\0${code.toLowerCase()}`, { ...r, equipment_code: code });
  }
  return [...m.values()];
}

export function normalizeSnapshot(row: Rec): SnapshotRow | null {
  const equipment_code = normCode(row.equipment_code);
  const snapshot_date = typeof row.snapshot_date === "string" ? row.snapshot_date.slice(0, 10) : "";
  if (!equipment_code || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot_date)) return null;
  return {
    snapshot_date,
    equipment_code,
    odometer: finiteOrNull(row.odometer),
    odometer_unit: typeof row.odometer_unit === "string" && row.odometer_unit.trim() ? row.odometer_unit.trim() : null,
    odometer_at: typeof row.odometer_at === "string" && row.odometer_at.trim() ? row.odometer_at : null,
    engine_hours: finiteOrNull(row.engine_hours),
    engine_hours_at: typeof row.engine_hours_at === "string" && row.engine_hours_at.trim() ? row.engine_hours_at : null,
    captured_at: typeof row.captured_at === "string" ? row.captured_at : "",
  };
}

function daysBetween(earlier: string, later: string): number {
  const ms = Date.parse(later + "T00:00:00Z") - Date.parse(earlier + "T00:00:00Z");
  return Math.round(ms / 86_400_000);
}

/** Convert a stored odometer to miles. Null unit is treated as miles (snapshots we write always set the unit). Unknown units return null. */
export function toMiles(value: number, unit: string | null): number | null {
  if (unit == null || unit === "miles") return value;
  if (unit === "meters") return value / METERS_PER_MILE;
  return null;
}

interface Daily {
  equipment_code: string;
  date: string;
  miles: number | null;
  hours: number | null;
  countMiles: boolean;
  countHours: boolean;
  flags: UsageFlag[];
}

function sumCounted(rows: readonly Daily[], pick: "miles" | "hours"): number | null {
  const countKey = pick === "miles" ? "countMiles" : "countHours";
  let any = false;
  let sum = 0;
  for (const r of rows) {
    const v = r[pick];
    if (v == null || !r[countKey]) continue;
    any = true;
    sum += v;
  }
  return any ? round4(sum) : null;
}
function sumUncounted(rows: readonly Daily[], pick: "miles" | "hours"): number | null {
  const countKey = pick === "miles" ? "countMiles" : "countHours";
  let any = false;
  let sum = 0;
  for (const r of rows) {
    const v = r[pick];
    if (v == null || r[countKey]) continue;
    any = true;
    sum += v;
  }
  return any ? round4(sum) : null;
}
function has(rows: readonly Daily[], flag: UsageFlag): number {
  return rows.filter((r) => r.flags.includes(flag)).length;
}

/**
 * Per equipment per day: miles_driven is the odometer change versus the previous snapshot (baseline before start_date counts),
 * engine_hours is the hour-meter change. Negative and implausible deltas are flagged and not counted.
 * group_by rolls those daily rows up; totals always cover every daily row in the window.
 */
export function computeUsage(snapshots: readonly SnapshotRow[], opts: {
  start_date: string;
  end_date: string;
  equipment_code?: string;
  group_by: "equipment" | "date";
}): { rows: UsageRow[]; totals: UsageTotals } {
  const start = opts.start_date;
  const end = opts.end_date;
  const want = opts.equipment_code?.trim();
  const byEquip = new Map<string, { code: string; rows: SnapshotRow[] }>();
  for (const raw of snapshots) {
    const code = normCode(raw.equipment_code);
    if (!code) continue;
    if (want && code.toLowerCase() !== want.toLowerCase()) continue;
    const key = code.toLowerCase();
    const g = byEquip.get(key) ?? { code, rows: [] };
    g.rows.push({ ...raw, equipment_code: code });
    byEquip.set(key, g);
  }

  const daily: Daily[] = [];
  for (const g of byEquip.values()) {
    const list = [...g.rows].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    let prev: SnapshotRow | undefined;
    for (const cur of list) {
      if (cur.snapshot_date > end) continue;
      if (cur.snapshot_date < start) { prev = cur; continue; }
      if (!prev) {
        daily.push({ equipment_code: g.code, date: cur.snapshot_date, miles: null, hours: null, countMiles: false, countHours: false, flags: ["no_baseline"] });
        prev = cur;
        continue;
      }
      const flags: string[] = [];
      const span = Math.max(1, daysBetween(prev.snapshot_date, cur.snapshot_date));
      if (span > 1) flags.push("gap");

      let miles: number | null = null;
      if (prev.odometer != null && cur.odometer != null) {
        if (prev.odometer_unit && cur.odometer_unit && prev.odometer_unit !== cur.odometer_unit) flags.push("unit_change");
        const a = toMiles(prev.odometer, prev.odometer_unit);
        const b = toMiles(cur.odometer, cur.odometer_unit);
        if (a == null || b == null) flags.push("unknown_unit");
        else miles = squash(b - a, MILES_EPSILON);
      }
      let hours: number | null = null;
      if (prev.engine_hours != null && cur.engine_hours != null) hours = squash(cur.engine_hours - prev.engine_hours, HOURS_EPSILON);

      const odoStale = prev.odometer != null && cur.odometer != null && prev.odometer === cur.odometer
        && prev.odometer_at != null && prev.odometer_at === cur.odometer_at;
      const hourStale = prev.engine_hours != null && cur.engine_hours != null && prev.engine_hours === cur.engine_hours
        && prev.engine_hours_at != null && prev.engine_hours_at === cur.engine_hours_at;
      if (odoStale || hourStale) flags.push("zero_jump");

      const milesNegative = miles != null && miles < 0;
      const hoursNegative = hours != null && hours < 0;
      if (milesNegative || hoursNegative) flags.push("negative_delta");
      const milesImplausible = miles != null && miles > MAX_MILES_PER_DAY * span;
      const hoursImplausible = hours != null && hours > MAX_ENGINE_HOURS_PER_DAY * span;
      if (milesImplausible || hoursImplausible) flags.push("implausible_jump");

      daily.push({
        equipment_code: g.code,
        date: cur.snapshot_date,
        miles,
        hours,
        countMiles: miles != null && !milesNegative && !milesImplausible,
        countHours: hours != null && !hoursNegative && !hoursImplausible,
        flags: orderFlags(flags),
      });
      prev = cur;
    }
  }

  const grouped = new Map<string, Daily[]>();
  for (const d of daily) {
    const key = opts.group_by === "date" ? d.date : d.equipment_code.toLowerCase();
    const list = grouped.get(key) ?? [];
    list.push(d);
    grouped.set(key, list);
  }
  let rows: UsageRow[] = [...grouped.entries()].map(([, list]) => {
    const base: UsageRow = {
      miles_driven: sumCounted(list, "miles"),
      engine_hours: sumCounted(list, "hours"),
      uncounted_miles: sumUncounted(list, "miles"),
      uncounted_engine_hours: sumUncounted(list, "hours"),
      flags: orderFlags(list.flatMap((d) => d.flags)),
    };
    if (opts.group_by === "date") return { date: list[0].date, equipment: new Set(list.map((d) => d.equipment_code.toLowerCase())).size, ...base };
    return { equipment_code: list[0].equipment_code, days: list.length, ...base };
  });
  rows.sort((a, b) => opts.group_by === "date"
    ? String(a.date).localeCompare(String(b.date))
    : codeCompare(a.equipment_code, b.equipment_code));

  const equipment = new Set(daily.map((d) => d.equipment_code.toLowerCase())).size;
  const totals: UsageTotals = {
    scope: "snapshots_in_range",
    start_date: start,
    end_date: end,
    equipment,
    days: daily.length,
    miles_driven: sumCounted(daily, "miles"),
    engine_hours: sumCounted(daily, "hours"),
    uncounted_miles: sumUncounted(daily, "miles"),
    uncounted_engine_hours: sumUncounted(daily, "hours"),
    flagged_rows: daily.filter((d) => d.flags.length > 0).length,
    negative_deltas: has(daily, "negative_delta"),
    zero_jumps: has(daily, "zero_jump"),
    gaps: has(daily, "gap"),
    implausible_jumps: has(daily, "implausible_jump"),
    no_baseline: has(daily, "no_baseline"),
  };
  return { rows, totals };
}
