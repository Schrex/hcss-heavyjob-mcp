import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { advanceCursor } from "../src/hcss.ts";
import { TELEMATICS_SCOPE_ERROR, grantedIncludes, withoutTelematicsScope } from "../src/scopes.ts";
import {
  COMPACT_FIELDS,
  buildEquipmentList,
  computeUsage,
  dedupeSnapshots,
  heavyjobIndex,
  isRegisteredQuery,
  mapTelematicsEquipment,
  mapTelematicsEquipmentDetail,
  pageRows,
  toSnapshot,
  type SnapshotRow,
} from "../src/telematics.ts";

/** Sample from the Telematics OpenAPI ApiEquipmentRead example. Both mile and meter odometers are present; miles win. */
const SAMPLE = {
  id: "f3a895ca-a1fe-45d7-96ae-35b74095fa2e",
  code: "CRANE",
  description: "Site crane",
  fuelUom: "Liters",
  lastBearing: 20,
  lastLatitude: 29.74,
  lastLongitude: -95.35,
  lastLocationDateTime: "2021-01-01T11:44:00Z",
  lastHourMeterReadingInSeconds: 36000,
  lastHourMeterReadingInHours: 10,
  lastHourMeterReadingDateTime: "2021-01-01T10:00:00+00:00",
  lastHourMeterReadingSource: "Manual Entry",
  lastOdometerReadingInMeters: 3218.69,
  lastOdometerReadingInMiles: 2.0000012427,
  lastOdometerReadingDateTime: "2021-01-01T11:23:00+00:00",
  lastOdometerReadingSource: "HCSS Telematics Calculation",
  make: "Ford",
  model: "F350",
  isRegistered: false,
  vin: "5B8A1234567891011",
};

function snap(p: Partial<SnapshotRow> & Pick<SnapshotRow, "snapshot_date" | "equipment_code">): SnapshotRow {
  return {
    odometer: null,
    odometer_unit: p.odometer == null ? null : "miles",
    odometer_at: null,
    engine_hours: null,
    engine_hours_at: null,
    captured_at: "2026-10-01T09:00:00.000Z",
    ...p,
  };
}

describe("mapper", () => {
  test("maps the published example and prefers miles over meters", () => {
    const row = mapTelematicsEquipment(SAMPLE, new Map());
    assert.deepEqual(Object.keys(row), [...COMPACT_FIELDS]);
    assert.equal(row.equipment_code, "CRANE");
    assert.equal(row.description, "Site crane");
    assert.equal(row.make, "Ford");
    assert.equal(row.model, "F350");
    assert.equal(row.last_latitude, 29.74);
    assert.equal(row.last_longitude, -95.35);
    assert.equal(row.last_location_at, "2021-01-01T11:44:00Z");
    assert.deepEqual(row.odometer, { value: 2.0000012427, unit: "miles", at: "2021-01-01T11:23:00+00:00" });
    assert.deepEqual(row.engine_hours, { value: 10, at: "2021-01-01T10:00:00+00:00" });
    assert.equal(row.heavyjob_match, false);
    assert.equal(row.heavyjob_equipment_id, null);
    assert.equal(row.meter_fields_found, undefined);
  });

  test("joins HeavyJob by trimmed case-insensitive code and keeps the first id", () => {
    const index = heavyjobIndex([
      { equipmentCode: " crane ", equipmentId: "id-1" },
      { equipmentCode: "CRANE", equipmentId: "id-2" },
      { equipmentCode: "   ", equipmentId: "nope" },
    ]);
    const row = mapTelematicsEquipment({ code: "Crane" }, index);
    assert.equal(row.heavyjob_match, true);
    assert.equal(row.heavyjob_equipment_id, "id-1");
    assert.equal(row.equipment_code, "Crane");
  });

  test("falls back to meters, seconds, and numeric strings; ignores non-records", () => {
    const meters = mapTelematicsEquipment({ code: " T1 ", lastOdometerReadingInMeters: "1609.344", lastHourMeterReadingInSeconds: 5400 }, new Map());
    assert.deepEqual(meters.odometer, { value: 1609.344, unit: "meters", at: null });
    assert.equal(meters.engine_hours.value, 1.5);
    assert.equal(meters.equipment_code, "T1");
    assert.equal(mapTelematicsEquipment({ code: "X", lastOdometerReadingInMiles: "12.5" }, new Map()).odometer.value, 12.5);
    assert.equal(mapTelematicsEquipment(null, new Map()).equipment_code, "");
    assert.equal(mapTelematicsEquipment(["nope"], new Map()).equipment_code, "");
    const hoursWin = mapTelematicsEquipment({ code: "X", lastHourMeterReadingInHours: 10, lastHourMeterReadingInSeconds: 999 }, new Map());
    assert.equal(hoursWin.engine_hours.value, 10);
  });

  test("detail keeps every HCSS field and adds the mapped fields without overwriting", () => {
    const index = heavyjobIndex([{ equipmentCode: "CRANE", equipmentId: "hj-9" }]);
    const raw = { ...SAMPLE, description: " Site crane ", surpriseMeter: 88 };
    const detail = mapTelematicsEquipmentDetail(raw, index);
    assert.equal(detail.vin, "5B8A1234567891011");
    assert.equal(detail.code, "CRANE");
    assert.equal(detail.description, " Site crane ");
    assert.equal(detail.lastOdometerReadingInMiles, 2.0000012427);
    assert.equal(detail.lastHourMeterReadingInHours, 10);
    assert.equal(detail.surpriseMeter, 88);
    assert.equal(detail.make, "Ford");
    assert.equal(detail.equipment_code, "CRANE");
    assert.deepEqual(detail.odometer, { value: 2.0000012427, unit: "miles", at: "2021-01-01T11:23:00+00:00" });
    assert.deepEqual(detail.engine_hours, { value: 10, at: "2021-01-01T10:00:00+00:00" });
    assert.equal(detail.heavyjob_match, true);
    assert.equal(detail.heavyjob_equipment_id, "hj-9");
    assert.equal(detail.meter_fields_found, undefined);
  });

  test("a missing meter lists the real field names instead of a silent null", () => {
    const unknown = mapTelematicsEquipment({ code: "X", description: "Truck", gpsMiles: 10, engineHourMeter: 4 }, new Map());
    assert.equal(unknown.odometer.value, null);
    assert.equal(unknown.engine_hours.value, null);
    assert.deepEqual(unknown.meter_fields_found, ["code", "description", "engineHourMeter", "gpsMiles"]);

    const hoursOnly = mapTelematicsEquipment({ code: "X", lastHourMeterReadingInHours: 3, gpsMiles: 10 }, new Map());
    assert.equal(hoursOnly.engine_hours.value, 3);
    assert.equal(hoursOnly.odometer.value, null);
    assert.deepEqual(hoursOnly.meter_fields_found, ["code", "gpsMiles", "lastHourMeterReadingInHours"]);

    const nullDocumented = mapTelematicsEquipment({ code: "X", lastOdometerReadingInMiles: null, lastHourMeterReadingInHours: 3, make: "Ford" }, new Map());
    assert.equal(nullDocumented.odometer.value, null);
    assert.deepEqual(nullDocumented.meter_fields_found, ["lastHourMeterReadingInHours", "lastOdometerReadingInMiles"]);

    const detail = mapTelematicsEquipmentDetail({ code: "X", gpsMiles: 10 }, new Map());
    assert.equal(detail.code, "X");
    assert.equal(detail.gpsMiles, 10);
    assert.deepEqual(detail.meter_fields_found, ["code", "gpsMiles"]);
    assert.equal((detail.odometer as { value: number | null }).value, null);
  });

  test("snapshot prefers miles and drops a blank code", () => {
    const row = toSnapshot(SAMPLE, "2026-10-27", "2026-10-27T09:00:00.000Z");
    assert.equal(row?.odometer, 2.0000012427);
    assert.equal(row?.odometer_unit, "miles");
    assert.equal(row?.engine_hours, 10);
    assert.equal(toSnapshot({ code: "  " }, "2026-10-27", "2026-10-27T09:00:00.000Z"), null);
  });

  test("isRegistered is true unless unregistered units are requested", () => {
    assert.equal(isRegisteredQuery(false), true);
    assert.equal(isRegisteredQuery(true), undefined);
  });
});

describe("paging", () => {
  test("advanceCursor stops at the end, a repeated cursor, an empty page, and the row cap", () => {
    assert.deepEqual(advanceCursor({ fetched: 5, maxRecords: 10, rowCount: 5, nextCursor: null, prevCursor: "a" }), { done: true, truncated: false });
    assert.deepEqual(advanceCursor({ fetched: 5, maxRecords: 10, rowCount: 5, nextCursor: "", prevCursor: "a" }), { done: true, truncated: false });
    assert.deepEqual(advanceCursor({ fetched: 5, maxRecords: 10, rowCount: 0, nextCursor: "b", prevCursor: "a" }), { done: true, truncated: false });
    assert.deepEqual(advanceCursor({ fetched: 5, maxRecords: 10, rowCount: 5, nextCursor: "a", prevCursor: "a" }), { done: true, truncated: false });
    assert.deepEqual(advanceCursor({ fetched: 10, maxRecords: 10, rowCount: 5, nextCursor: "b", prevCursor: "a" }), { done: true, truncated: true, hcssCursor: "b" });
    assert.deepEqual(advanceCursor({ fetched: 5, maxRecords: 10, rowCount: 5, nextCursor: "b", prevCursor: "a" }), { done: false, cursor: "b" });
  });

  test("pageRows reports next_skip over the full set", () => {
    const rows = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const first = pageRows(rows, 0, 3);
    assert.equal(first.total_matching, 10);
    assert.deepEqual(first.data, [0, 1, 2]);
    assert.equal(first.next_skip, 3);
    const mid = pageRows(rows, 8, 3);
    assert.deepEqual(mid.data, [8, 9]);
    assert.equal(mid.next_skip, undefined);
    assert.equal(mid.returned, 2);
    const past = pageRows(rows, 10, 3);
    assert.deepEqual(past.data, []);
    assert.equal(past.next_skip, undefined);
    assert.equal(past.total_matching, 10);
  });

  test("equipment list filters code and description, sorts naturally, and totals the full set", () => {
    const index = heavyjobIndex([{ equipmentCode: "T2", equipmentId: "keep" }]);
    const raws = [
      { code: "T10", description: "Haul truck", model: "F350" },
      { code: "T2", description: "Pickup" },
      { code: " crane ", description: "Site crane" },
    ];
    const all = buildEquipmentList(raws, index, { max_records: 1 });
    assert.deepEqual(all.data.map((r) => r.compact.equipment_code), ["crane"]);
    assert.equal(all.total_matching, 3);
    assert.equal(all.next_skip, 1);
    assert.equal(all.totals.equipment, 3);
    assert.equal(all.totals.unmatched_heavyjob, 2);
    assert.equal(all.totals.scope, "all_matching_equipment");
    const filtered = buildEquipmentList(raws, index, { text: "haul" });
    assert.deepEqual(filtered.data.map((r) => r.compact.equipment_code), ["T10"]);
    assert.equal(filtered.totals.unmatched_heavyjob, 1);
    assert.equal(buildEquipmentList(raws, index, { text: "F350" }).total_matching, 0);
    const page2 = buildEquipmentList(raws, index, { skip: 1, max_records: 1 });
    assert.equal(page2.data[0].compact.equipment_code, "T2");
    assert.equal(page2.data[0].compact.heavyjob_match, true);
    assert.equal(page2.data[0].compact.heavyjob_equipment_id, "keep");
    const page3 = buildEquipmentList(raws, index, { skip: 2, max_records: 1 });
    assert.equal(page3.data[0].compact.equipment_code, "T10");
    assert.equal(page3.data[0].compact.heavyjob_match, false);
    assert.equal(buildEquipmentList(raws, index).data.find((r) => r.compact.equipment_code === "T2")?.compact.heavyjob_equipment_id, "keep");
  });
});

describe("usage deltas", () => {
  test("deltas against the previous snapshot, including a baseline before the window", () => {
    const rows = [
      snap({ snapshot_date: "2026-09-30", equipment_code: "T2", odometer: 100, engine_hours: 10, odometer_at: "2026-09-30T09:00:00Z", engine_hours_at: "2026-09-30T09:00:00Z" }),
      snap({ snapshot_date: "2026-10-01", equipment_code: "T2", odometer: 140, engine_hours: 12, odometer_at: "2026-10-01T09:00:00Z", engine_hours_at: "2026-10-01T09:00:00Z" }),
      snap({ snapshot_date: "2026-10-02", equipment_code: "T2", odometer: 155, engine_hours: 13, odometer_at: "2026-10-02T09:00:00Z", engine_hours_at: "2026-10-02T09:00:00Z" }),
    ];
    const usage = computeUsage(rows, { start_date: "2026-10-01", end_date: "2026-10-02", group_by: "equipment" });
    assert.equal(usage.rows.length, 1);
    assert.equal(usage.rows[0].equipment_code, "T2");
    assert.equal(usage.rows[0].days, 2);
    assert.equal(usage.rows[0].miles_driven, 55);
    assert.equal(usage.rows[0].engine_hours, 3);
    assert.deepEqual(usage.rows[0].flags, []);
    assert.equal(usage.totals.miles_driven, 55);
    assert.equal(usage.totals.days, 2);
    assert.equal(usage.totals.flagged_rows, 0);
  });

  test("flags no baseline, gaps, negative resets, stale zeros, and implausible jumps", () => {
    const rows = [
      snap({ snapshot_date: "2026-10-01", equipment_code: "T1", odometer: 100, engine_hours: 5, odometer_at: "t", engine_hours_at: "t" }),
      snap({ snapshot_date: "2026-10-04", equipment_code: "T1", odometer: 50, engine_hours: 8, odometer_at: "t", engine_hours_at: "t2" }),
      snap({ snapshot_date: "2026-10-01", equipment_code: "T9", odometer: 0, engine_hours: 0, odometer_at: "a", engine_hours_at: "a" }),
      snap({ snapshot_date: "2026-10-02", equipment_code: "T9", odometer: 0, engine_hours: 0, odometer_at: "a", engine_hours_at: "a" }),
      snap({ snapshot_date: "2026-10-03", equipment_code: "T9", odometer: 1500, engine_hours: 24, odometer_at: "b", engine_hours_at: "b" }),
      snap({ snapshot_date: "2026-10-04", equipment_code: "T9", odometer: 2500, engine_hours: 48.1, odometer_at: "c", engine_hours_at: "c" }),
    ];
    const byEquip = computeUsage(rows, { start_date: "2026-10-01", end_date: "2026-10-04", group_by: "equipment" });
    const t1 = byEquip.rows.find((r) => r.equipment_code === "T1");
    assert.ok(t1);
    assert.deepEqual(t1.flags, ["no_baseline", "gap", "negative_delta"]);
    assert.equal(t1.miles_driven, null);
    assert.equal(t1.engine_hours, 3);
    assert.equal(t1.uncounted_miles, -50);
    const t9 = byEquip.rows.find((r) => r.equipment_code === "T9");
    assert.ok(t9);
    // Oct 4 is exactly 1000 miles, which is counted. Oct 3's 1500 is the implausible mile jump.
    assert.equal(t9.miles_driven, 1000);
    assert.equal(t9.engine_hours, 24);
    assert.equal(t9.uncounted_miles, 1500);
    assert.equal(t9.uncounted_engine_hours, 24.1);
    assert.ok(t9.flags.includes("zero_jump"));
    assert.ok(t9.flags.includes("implausible_jump"));
    assert.ok(t9.flags.includes("no_baseline"));
    assert.equal(byEquip.totals.negative_deltas, 1);
    assert.equal(byEquip.totals.implausible_jumps, 2);
    assert.equal(byEquip.totals.zero_jumps, 1);
    assert.equal(byEquip.totals.gaps, 1);
    assert.equal(byEquip.totals.no_baseline, 2);
    assert.equal(byEquip.totals.miles_driven, 1000);
    assert.equal(byEquip.totals.engine_hours, 27);

    const byDate = computeUsage(rows, { start_date: "2026-10-01", end_date: "2026-10-04", group_by: "date" });
    assert.deepEqual(byDate.totals, byEquip.totals);
    assert.deepEqual(byDate.rows.map((r) => r.date), ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    assert.equal(byDate.rows[0].equipment, 2);
    assert.equal(byDate.rows[1].miles_driven, 0);
    assert.deepEqual(byDate.rows[1].flags, ["zero_jump"]);
  });

  test("a fresh zero reading is not a zero-jump, and thresholds are per day spanned", () => {
    const parked = computeUsage([
      snap({ snapshot_date: "2026-10-01", equipment_code: "P", odometer: 10, odometer_at: "2026-10-01T09:00:00Z" }),
      snap({ snapshot_date: "2026-10-02", equipment_code: "P", odometer: 10, odometer_at: "2026-10-02T09:00:00Z" }),
    ], { start_date: "2026-10-01", end_date: "2026-10-02", group_by: "equipment" });
    assert.deepEqual(parked.rows[0].flags, ["no_baseline"]);
    assert.equal(parked.rows[0].miles_driven, 0);

    const exact = computeUsage([
      snap({ snapshot_date: "2026-09-30", equipment_code: "P", odometer: 0, engine_hours: 0 }),
      snap({ snapshot_date: "2026-10-01", equipment_code: "P", odometer: 1000, engine_hours: 24 }),
    ], { start_date: "2026-10-01", end_date: "2026-10-01", group_by: "equipment" });
    assert.deepEqual(exact.rows[0].flags, []);
    assert.equal(exact.rows[0].miles_driven, 1000);
    assert.equal(exact.rows[0].engine_hours, 24);

    const overGap = computeUsage([
      snap({ snapshot_date: "2026-10-01", equipment_code: "P", odometer: 0, engine_hours: 0 }),
      snap({ snapshot_date: "2026-10-03", equipment_code: "P", odometer: 2000, engine_hours: 48 }),
    ], { start_date: "2026-10-01", end_date: "2026-10-03", group_by: "equipment" });
    assert.deepEqual(overGap.rows[0].flags, ["no_baseline", "gap"]);
    assert.equal(overGap.rows[0].miles_driven, 2000);

    const tooFar = computeUsage([
      snap({ snapshot_date: "2026-10-01", equipment_code: "P", odometer: 0 }),
      snap({ snapshot_date: "2026-10-03", equipment_code: "P", odometer: 2000.1 }),
    ], { start_date: "2026-10-01", end_date: "2026-10-03", group_by: "equipment" });
    assert.ok(tooFar.rows[0].flags.includes("implausible_jump"));
    assert.equal(tooFar.rows[0].miles_driven, null);
    assert.equal(tooFar.rows[0].uncounted_miles, 2000.1);

    const noise = computeUsage([
      snap({ snapshot_date: "2026-09-30", equipment_code: "P", odometer: 10 }),
      snap({ snapshot_date: "2026-10-01", equipment_code: "P", odometer: 9.99999 }),
    ], { start_date: "2026-10-01", end_date: "2026-10-01", group_by: "equipment" });
    assert.deepEqual(noise.rows[0].flags, []);
    assert.equal(noise.rows[0].miles_driven, 0);
  });

  test("converts meters, flags a unit change, and filters by equipment code", () => {
    const rows = [
      snap({ snapshot_date: "2026-09-30", equipment_code: "M", odometer: 0, odometer_unit: "meters" }),
      snap({ snapshot_date: "2026-10-01", equipment_code: "M", odometer: 3218.688, odometer_unit: "meters" }),
      snap({ snapshot_date: "2026-10-02", equipment_code: "M", odometer: 3, odometer_unit: "miles" }),
      snap({ snapshot_date: "2026-10-01", equipment_code: "Other", odometer: 999, odometer_unit: "km" }),
      snap({ snapshot_date: "2026-10-02", equipment_code: "Other", odometer: 1000, odometer_unit: "km" }),
    ];
    const one = computeUsage(rows, { start_date: "2026-10-01", end_date: "2026-10-02", equipment_code: " m ", group_by: "equipment" });
    assert.equal(one.rows.length, 1);
    assert.equal(one.rows[0].miles_driven, 3);
    assert.deepEqual(one.rows[0].flags, ["unit_change"]);
    assert.equal(one.totals.equipment, 1);
    const unknown = computeUsage(rows, { start_date: "2026-10-01", end_date: "2026-10-02", equipment_code: "other", group_by: "date" });
    assert.equal(unknown.rows.length, 2);
    assert.ok(unknown.rows[1].flags.includes("unknown_unit"));
    assert.equal(unknown.totals.miles_driven, null);
  });

  test("dedupes a repeated code on the same day", () => {
    const rows = dedupeSnapshots([
      snap({ snapshot_date: "2026-10-01", equipment_code: " Ab ", odometer: 1 }),
      snap({ snapshot_date: "2026-10-01", equipment_code: "ab", odometer: 2 }),
      snap({ snapshot_date: "2026-10-02", equipment_code: "ab", odometer: 4 }),
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.snapshot_date === "2026-10-01")?.odometer, 2);
    assert.equal(rows.find((r) => r.snapshot_date === "2026-10-01")?.equipment_code, "ab");
  });
});

describe("scope", () => {
  test("the telematics failure string is exact, and HeavyJob can drop only telematics:read", () => {
    assert.equal(TELEMATICS_SCOPE_ERROR, "The HCSS Client ID needs the telematics:read scope enabled in HCSS Credentials.");
    assert.equal(withoutTelematicsScope("heavyjob:read timecards:read telematics:read"), "heavyjob:read timecards:read");
    assert.equal(withoutTelematicsScope("heavyjob:read timecards:read"), "heavyjob:read timecards:read");
    assert.equal(grantedIncludes(undefined, "telematics:read"), true);
    assert.equal(grantedIncludes("", "telematics:read"), false);
    assert.equal(grantedIncludes("heavyjob:read timecards:read", "telematics:read"), false);
    assert.equal(grantedIncludes("heavyjob:read telematics:read timecards:read", "telematics:read"), true);
  });
});
