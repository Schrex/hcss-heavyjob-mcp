-- Daily telematics meter readings. One row per equipment per UTC date.
-- get_telematics_usage only sees days that have a row here. Nothing accrues before the first successful cron.

CREATE TABLE IF NOT EXISTS meter_snapshots (
  snapshot_date TEXT NOT NULL,
  equipment_code TEXT NOT NULL,
  odometer REAL,
  odometer_unit TEXT,
  odometer_at TEXT,
  engine_hours REAL,
  engine_hours_at TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE (snapshot_date, equipment_code)
);

CREATE INDEX IF NOT EXISTS idx_meter_snapshots_code_date
  ON meter_snapshots (equipment_code, snapshot_date);
