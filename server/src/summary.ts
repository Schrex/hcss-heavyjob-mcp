import { codeCompare, normCode, type HcssClient } from "./hcss.js";
import type { Column } from "./xlsx.js";

type Rec = Record<string, unknown>;
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
export const money = (x: number) => Math.round(x * 100) / 100;
export const qty = (x: number) => Math.round(x * 1e4) / 1e4;
const ratio = (a: number, b: number) => (b ? a / b : null);

export const SUMMARY_COLUMNS: Column[] = [
  { key: "cost_code", header: "Cost Code", source: "costCodes.code (trimmed)" },
  { key: "description", header: "Description", source: "costCodes.description" },
  { key: "unit", header: "Unit", source: "costCodes.unitOfMeasure" },
  { key: "status", header: "Status", source: "costCodes.status" },
  { key: "budget_qty", header: "Budget Qty", source: "costCodes.quantity" },
  { key: "actual_qty", header: "Actual Qty", source: "jobCostsToDate totalQuantity / jobCosts quantity (sum)" },
  { key: "pct_complete_qty", header: "% Complete (Qty)", source: "derived: actual_qty / budget_qty x 100" },
  { key: "budget_mh", header: "Budget MH", source: "costCodes.laborHours" },
  { key: "actual_mh", header: "Actual MH", source: "totalLaborHours / laborHours (sum)" },
  { key: "earned_mh", header: "Earned MH", source: "derived: actual_qty / budget_qty x budget_mh" },
  { key: "mh_over_under", header: "MH Over(-)/Under(+)", source: "derived: earned_mh - actual_mh" },
  { key: "budget_mh_per_unit", header: "Budget MH/Unit", source: "derived: budget_mh / budget_qty" },
  { key: "actual_mh_per_unit", header: "Actual MH/Unit", source: "derived: actual_mh / actual_qty" },
  { key: "budget_units_per_mh", header: "Budget Units/MH", source: "derived: budget_qty / budget_mh" },
  { key: "actual_units_per_mh", header: "Actual Units/MH", source: "derived: actual_qty / actual_mh" },
  { key: "budget_eq_hours", header: "Budget Eq Hrs", source: "costCodes.equipmentHours" },
  { key: "actual_eq_hours", header: "Actual Eq Hrs", source: "totalEquipmentHours / equipmentHours (sum)" },
  { key: "budget_labor", header: "Budget Labor $", source: "costCodes.laborDollars" },
  { key: "actual_labor", header: "Actual Labor $", source: "totalLaborCost / laborCost (sum)" },
  { key: "budget_equipment", header: "Budget Equip $", source: "costCodes.equipmentDollars" },
  { key: "actual_equipment", header: "Actual Equip $", source: "totalEquipmentCost / equipmentCost (sum)" },
  { key: "budget_material", header: "Budget Material $", source: "costCodes.materialDollars" },
  { key: "actual_material", header: "Actual Material $", source: "totalMaterialCost / materialCost (sum)" },
  { key: "budget_subcontract", header: "Budget Sub $", source: "costCodes.subcontractDollars" },
  { key: "actual_subcontract", header: "Actual Sub $", source: "totalSubcontractCost / subcontractCost (sum)" },
  { key: "budget_supply", header: "Budget Supply $", source: "costCodes.supplyDollars (no matching actual field in the API)" },
  { key: "actual_trucking", header: "Actual Trucking $", source: "totalTruckingCost / truckingCost (sum; no matching budget field)" },
  { key: "budget_total", header: "Budget Total $", source: "derived: labor+equip+material+sub+supply+custom budgets" },
  { key: "actual_total", header: "Actual Total $", source: "derived: labor+equip+material+sub+trucking actuals (custom cost types not included)" },
  { key: "heavybid_estimate", header: "HB Estimate", source: "costCodes.heavyBidEstimateCode" },
  { key: "heavybid_biditem", header: "HB Biditem", source: "costCodes.historicalBiditem (trimmed)" },
  { key: "heavybid_activity", header: "HB Activity", source: "costCodes.historicalActivityCode (trimmed)" },
];

export interface SummaryResult {
  rows: Rec[];
  totals: Rec;
  truncated: boolean;
  source: string;
  unmatchedActualRows: number;
}

/**
 * Budget (cost code setup) vs actual (time cards + cost entries) per cost code for ONE job.
 * Budget: GET /api/v2/costCodes?jobId=  (cursor-paged)
 * Actual, whole job: POST /api/v1/jobCostsToDate/search {jobIds}  (rows per cost code per foreman; summed here)
 * Actual, date range: POST /api/v1/jobCosts/advancedRequest {jobIds,startDate,endDate}  (rows per cost code per foreman per day; summed)
 */
export async function jobCostSummary(hcss: HcssClient, buId: string, jobId: string, range?: { start?: string; end?: string }): Promise<SummaryResult> {
  const cc = await hcss.cursorAll<Rec>("GET", "/api/v2/costCodes", { jobId, businessUnitId: buId, isDeleted: false }, 20_000);
  const dated = !!(range?.start || range?.end);
  const act = dated
    ? await hcss.cursorAll<Rec>("POST", "/api/v1/jobCosts/advancedRequest", { businessUnitId: buId, jobIds: [jobId], startDate: range?.start, endDate: range?.end }, 40_000)
    : await hcss.cursorAll<Rec>("POST", "/api/v1/jobCostsToDate/search", { businessUnitId: buId, jobIds: [jobId] }, 40_000);

  const actual = new Map<string, { q: number; mh: number; eh: number; lab: number; eq: number; mat: number; sub: number; trk: number }>();
  for (const r of act.records) {
    const id = String(dated ? r.costCodeId ?? "" : (r.costCode as Rec | undefined)?.costCodeId ?? "");
    const a = actual.get(id) ?? { q: 0, mh: 0, eh: 0, lab: 0, eq: 0, mat: 0, sub: 0, trk: 0 };
    if (dated) {
      a.q += n(r.quantity); a.mh += n(r.laborHours); a.eh += n(r.equipmentHours); a.lab += n(r.laborCost);
      a.eq += n(r.equipmentCost); a.mat += n(r.materialCost); a.sub += n(r.subcontractCost); a.trk += n(r.truckingCost);
    } else {
      a.q += n(r.totalQuantity); a.mh += n(r.totalLaborHours); a.eh += n(r.totalEquipmentHours); a.lab += n(r.totalLaborCost);
      a.eq += n(r.totalEquipmentCost); a.mat += n(r.totalMaterialCost); a.sub += n(r.totalSubcontractCost); a.trk += n(r.totalTruckingCost);
    }
    actual.set(id, a);
  }

  const T = { bq: 0, bmh: 0, amh: 0, emh: 0, beh: 0, aeh: 0, blab: 0, alab: 0, beq: 0, aeq: 0, bmat: 0, amat: 0, bsub: 0, asub: 0, bsup: 0, atrk: 0, btot: 0, atot: 0 };
  const seen = new Set<string>();
  const rows: Rec[] = cc.records.map((c) => {
    const id = String(c.id ?? "");
    seen.add(id);
    const a = actual.get(id) ?? { q: 0, mh: 0, eh: 0, lab: 0, eq: 0, mat: 0, sub: 0, trk: 0 };
    const bq = n(c.quantity), bmh = n(c.laborHours);
    const custom = Array.isArray(c.customCostTypeDollars) ? (c.customCostTypeDollars as Rec[]).reduce((s, x) => s + n(x.budgetedCost), 0) : 0;
    const btot = n(c.laborDollars) + n(c.equipmentDollars) + n(c.materialDollars) + n(c.subcontractDollars) + n(c.supplyDollars) + custom;
    const atot = a.lab + a.eq + a.mat + a.sub + a.trk;
    const pct = ratio(a.q, bq);
    const earned = pct === null ? null : pct * bmh;
    T.bq += bq; T.bmh += bmh; T.amh += a.mh; T.emh += earned ?? 0; T.beh += n(c.equipmentHours); T.aeh += a.eh;
    T.blab += n(c.laborDollars); T.alab += a.lab; T.beq += n(c.equipmentDollars); T.aeq += a.eq; T.bmat += n(c.materialDollars); T.amat += a.mat;
    T.bsub += n(c.subcontractDollars); T.asub += a.sub; T.bsup += n(c.supplyDollars); T.atrk += a.trk; T.btot += btot; T.atot += atot;
    const r4 = (x: number | null) => (x === null ? null : qty(x));
    return {
      cost_code_id: id, cost_code: normCode(c.code), description: c.description, unit: normCode(c.unitOfMeasure), status: c.status,
      budget_qty: qty(bq), actual_qty: qty(a.q), pct_complete_qty: pct === null ? null : Math.round(pct * 1000) / 10,
      budget_mh: qty(bmh), actual_mh: qty(a.mh), earned_mh: r4(earned), mh_over_under: earned === null ? null : qty(earned - a.mh),
      budget_mh_per_unit: r4(ratio(bmh, bq)), actual_mh_per_unit: r4(ratio(a.mh, a.q)),
      budget_units_per_mh: r4(ratio(bq, bmh)), actual_units_per_mh: r4(ratio(a.q, a.mh)),
      budget_eq_hours: qty(n(c.equipmentHours)), actual_eq_hours: qty(a.eh),
      budget_labor: money(n(c.laborDollars)), actual_labor: money(a.lab), budget_equipment: money(n(c.equipmentDollars)), actual_equipment: money(a.eq),
      budget_material: money(n(c.materialDollars)), actual_material: money(a.mat), budget_subcontract: money(n(c.subcontractDollars)), actual_subcontract: money(a.sub),
      budget_supply: money(n(c.supplyDollars)), actual_trucking: money(a.trk), budget_total: money(btot), actual_total: money(atot),
      heavybid_estimate: normCode(c.heavyBidEstimateCode) || undefined, heavybid_biditem: normCode(c.historicalBiditem) || undefined,
      heavybid_activity: normCode(c.historicalActivityCode) || undefined,
    };
  });
  rows.sort((x, y) => codeCompare(x.cost_code, y.cost_code));
  let unmatched = 0;
  for (const id of actual.keys()) if (!seen.has(id)) unmatched++;
  const truncated = cc.truncated || act.truncated;
  return {
    rows, truncated, unmatchedActualRows: unmatched,
    source: dated ? "budget: GET /api/v2/costCodes; actual: POST /api/v1/jobCosts/advancedRequest (date range)" : "budget: GET /api/v2/costCodes; actual: POST /api/v1/jobCostsToDate/search (job to date)",
    totals: {
      scope: truncated ? "partial (row cap hit; totals are a lower bound)" : dated ? "full_job_for_date_range" : "full_job_to_date",
      cost_codes: rows.length,
      budget_mh: qty(T.bmh), actual_mh: qty(T.amh), earned_mh: qty(T.emh), mh_over_under: qty(T.emh - T.amh),
      budget_eq_hours: qty(T.beh), actual_eq_hours: qty(T.aeh),
      budget_labor: money(T.blab), actual_labor: money(T.alab), budget_equipment: money(T.beq), actual_equipment: money(T.aeq),
      budget_material: money(T.bmat), actual_material: money(T.amat), budget_subcontract: money(T.bsub), actual_subcontract: money(T.asub),
      budget_supply: money(T.bsup), actual_trucking: money(T.atrk), budget_total: money(T.btot), actual_total: money(T.atot),
      note: "Quantities are not summed across cost codes (mixed units). Earned MH = budget MH x (actual qty / budget qty).",
    },
  };
}
