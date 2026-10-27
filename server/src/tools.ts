import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config, Env } from "./config.js";
import { codeCompare, codeEq, normCode, type HcssClient } from "./hcss.js";
import { jobCostSummary, money, qty, SUMMARY_COLUMNS } from "./summary.js";
import { loadSnapshots } from "./telematics_db.js";
import { buildEquipmentList, computeUsage, heavyjobIndex, isRegisteredQuery, mapTelematicsEquipmentDetail, pageRows } from "./telematics.js";
import { toCsv, toXlsx } from "./xlsx.js";

type Rec = Record<string, unknown>;
let autoBu: string | undefined; // isolate-scoped; only set when exactly one real unit exists

export function buildServer(cfg: Config, hcss: HcssClient, env: Env, origin: string): McpServer {
  const server = new McpServer({ name: "schrex-hcss-heavyjob", version: "0.2.0" });

  // ---------- shared helpers ----------
  const guid = z.string().uuid();
  const buArg = { business_unit_id: guid.optional().describe("Defaults to HCSS_BUSINESS_UNIT_ID, or the only real business unit") };
  const pageArgs = {
    max_records: z.number().int().min(1).max(2000).optional().describe("Rows to return in this reply (default 50)"),
    skip: z.number().int().min(0).optional().describe("Paging: rows to skip (use next_skip from the previous reply). Totals always cover the full set."),
  };
  const DATE_HELP = "YYYY-MM-DD, e.g. 2026-10-01";
  const jobArg = z.string().min(1).describe("Job code (e.g. 2614) or job id (GUID). Codes match ignoring case and leading/trailing spaces.");

  const noNoise = (_k: string, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v);
  const reply = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, noNoise, 2) }] });
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
  const isGuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());

  const isoDate = (field: string, v?: string) => {
    if (v === undefined || v === "") return undefined;
    const s = v.trim();
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00Z") : new Date(NaN);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`Invalid ${field}: '${v}'. Expected a date in YYYY-MM-DD format, e.g. 2026-10-01.`);
    return s; // HCSS HeavyJob docs: "in yyyy-MM-dd format"
  };
  const range = (a: { start_date?: string; end_date?: string }) => {
    const start = isoDate("start_date", a.start_date), end = isoDate("end_date", a.end_date);
    if (start && end && start > end) throw new Error(`start_date ${start} is after end_date ${end}.`);
    return { start, end };
  };
  const page = <T>(rows: T[], a: { skip?: number; max_records?: number }, def = 50) => {
    const skip = a.skip ?? 0, cap = a.max_records ?? def;
    const out = rows.slice(skip, skip + cap);
    const more = skip + out.length < rows.length;
    return { total_matching: rows.length, returned: out.length, skip, next_skip: more ? skip + out.length : undefined, data: out };
  };
  const pick = (r: Rec, keys: string[]) => { const o: Rec = {}; for (const k of keys) if (r[k] !== undefined && r[k] !== null && r[k] !== "") o[k] = r[k]; return o; };
  const name = (e?: Rec) => (e ? [e.employeeFirstName ?? e.firstName, e.employeeLastName ?? e.lastName].filter(Boolean).join(" ") : undefined);

  // Drop placeholder units (all-zero GUID / no code) and dedupe by code.
  const realUnits = (rows: Rec[]) => {
    const seen = new Map<string, Rec>();
    for (const u of rows) {
      const id = String(u.id ?? "");
      const code = normCode(u.code ?? u.description).toUpperCase();
      if (!id || /^[0-]+$/.test(id) || !code) continue;
      if (!seen.has(code)) seen.set(code, u);
    }
    return [...seen.values()];
  };
  const listUnits = () => hcss.get<Rec[]>("/api/v1/businessUnits");
  const bu = async (id?: string): Promise<string> => {
    const v = id ?? cfg.businessUnitId ?? autoBu;
    if (v) return v;
    const units = realUnits((await listUnits()) ?? []);
    if (units.length === 1 && typeof units[0].id === "string") return (autoBu = units[0].id);
    throw new Error(`No default business unit (HCSS_BUSINESS_UNIT_ID unset) and ${units.length} real units exist (${units.map((u) => normCode(u.code)).join(", ")}). Call list_business_units and pass business_unit_id.`);
  };

  const jobsFor = async (buId: string) => (await hcss.get<Rec[]>("/api/v1/jobs", { businessUnitId: buId })) ?? [];
  const jobHint = (q: string, jobs: Rec[]) => {
    const close = jobs.filter((j) => `${normCode(j.code)} ${j.description ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);
    return `No job '${q.trim()}' in this business unit (${jobs.length} jobs).` + (close.length ? ` Similar: ${close.map((j) => `${normCode(j.code)} ${j.description ?? ""}`.trim()).join("; ")}.` : " Use search_jobs.");
  };
  /** Resolve a job code or GUID to the job record (1 HCSS call, cached 5 min). */
  const resolveJob = async (buId: string, job: string): Promise<Rec> => {
    const jobs = await jobsFor(buId);
    const hit = isGuid(job) ? jobs.find((j) => String(j.id).toLowerCase() === job.trim().toLowerCase()) : jobs.find((j) => codeEq(j.code, job));
    if (!hit) throw new Error(jobHint(job, jobs));
    return hit;
  };
  const costCodesFor = (buId: string, jobId: string) => hcss.cursorAll<Rec>("GET", "/api/v2/costCodes", { jobId, businessUnitId: buId, isDeleted: false }, 20_000);
  const resolveCostCodes = async (buId: string, jobId: string, codes?: string[]) => {
    const cc = await costCodesFor(buId, jobId);
    const byId = new Map(cc.records.map((c) => [String(c.id), c]));
    if (!codes?.length) return { byId, ids: undefined as string[] | undefined };
    const ids: string[] = [];
    for (const code of codes) {
      const hit = cc.records.find((c) => codeEq(c.code, code));
      if (!hit) {
        const list = cc.records.map((c) => normCode(c.code)).sort(codeCompare);
        throw new Error(`No cost code '${normCode(code)}' on this job; it has ${list.length} cost codes` + (list.length ? ` (e.g. ${list.slice(0, 10).join(", ")}${list.length > 10 ? ", ..." : ""}).` : "."));
      }
      ids.push(String(hit.id));
    }
    return { byId, ids };
  };
  const jobBrief = (j: Rec) => ({ job_id: j.id, job_code: normCode(j.code), job_description: j.description });
  const CAP = 20_000; // max HCSS rows pulled per tool call (cursor pages of HCSS_PAGE_SIZE)

  // ---------- tools ----------
  server.tool("list_business_units", "List HeavyJob business units. default_candidate marks real units (placeholder all-zero ids are ignored; duplicates by code collapsed).", {}, async () => {
    const rows = (await listUnits()) ?? [];
    const real = new Set(realUnits(rows));
    return reply({ count: rows.length, distinct_real_units: real.size, data: rows.map((u) => ({ ...pick(u, ["id", "code", "description"]), default_candidate: real.has(u) })) });
  });

  const JOB_FIELDS = ["id", "code", "description", "status", "createdDate", "city", "state", "relatedEstimateCodes", "isParentJob"];
  const shapeJob = (j: Rec, detail?: boolean) => {
    if (detail) return { ...j, code: normCode(j.code) };
    const o = pick(j, JOB_FIELDS);
    o.code = normCode(j.code);
    const note = typeof j.jobNote === "string" ? j.jobNote : "";
    if (note) o.jobNote = note.length > 200 ? note.slice(0, 200) + "..." : note;
    return o;
  };
  server.tool(
    "search_jobs",
    "List or search HeavyJob jobs (compact by default). text matches job code or description (case-insensitive contains). Sorted by job code (natural order). status: active, completed, discontinued, inactive.",
    { ...buArg, ...pageArgs, text: z.string().optional(), status: z.enum(["active", "completed", "discontinued", "inactive"]).optional(),
      estimate_code: z.string().optional().describe("Only jobs linked to this HeavyBid estimate code (relatedEstimateCodes)"),
      detail: z.boolean().default(false).describe("Full HCSS job records") },
    async (a) => {
      const rows = (await hcss.get<Rec[]>("/api/v1/jobs", { businessUnitId: await bu(a.business_unit_id), jobStatus: a.status })) ?? [];
      const t = a.text?.trim().toLowerCase();
      let out = rows.filter((j) => !j.isDeleted);
      if (t) out = out.filter((j) => `${normCode(j.code)} ${j.description ?? ""}`.toLowerCase().includes(t));
      if (a.estimate_code) out = out.filter((j) => Array.isArray(j.relatedEstimateCodes) && (j.relatedEstimateCodes as unknown[]).some((c) => codeEq(c, a.estimate_code)));
      out.sort((x, y) => codeCompare(x.code, y.code));
      const p = page(out, a);
      return reply({ ...p, data: p.data.map((j) => shapeJob(j, a.detail)) });
    },
  );

  server.tool(
    "get_job",
    "One job's details (status, address, notes, linked HeavyBid estimate codes) plus its cost code count.",
    { ...buArg, job: jobArg },
    async (a) => {
      const buId = await bu(a.business_unit_id);
      const j = await resolveJob(buId, a.job);
      const full = await hcss.post<Rec[]>("/api/v1/jobs/advanced", { jobIds: [j.id], isIncludeHBCodeList: true });
      const cc = await costCodesFor(buId, String(j.id));
      return reply({ data: { ...((full ?? [])[0] ?? j), code: normCode(j.code) }, cost_codes: cc.records.length, cost_codes_truncated: cc.truncated });
    },
  );

  const CC_FIELDS = ["id", "code", "description", "unitOfMeasure", "quantity", "status", "laborHours", "equipmentHours", "laborDollars", "equipmentDollars",
    "materialDollars", "subcontractDollars", "supplyDollars", "isTm", "startDate", "endDate", "heavyBidEstimateCode", "historicalBiditem", "historicalActivityCode"];
  server.tool(
    "get_cost_codes",
    "Cost codes for a job with BUDGET quantity, unit and budget labor/equipment hours and dollars (from HeavyJob cost code setup), sorted by code. Totals (hours, dollars) cover all cost codes.",
    { ...buArg, ...pageArgs, job: jobArg, text: z.string().optional().describe("Filter: code or description contains"),
      status: z.enum(["active", "completed", "discontinued", "inactive"]).optional(),
      detail: z.boolean().default(false), fields: z.array(z.string()).optional().describe("Return only these HCSS fields") },
    async (a) => {
      const buId = await bu(a.business_unit_id);
      const j = await resolveJob(buId, a.job);
      const cc = await costCodesFor(buId, String(j.id));
      let rows = [...cc.records].sort((x, y) => codeCompare(x.code, y.code));
      const t = a.text?.trim().toLowerCase();
      if (t) rows = rows.filter((c) => `${normCode(c.code)} ${c.description ?? ""}`.toLowerCase().includes(t));
      if (a.status) rows = rows.filter((c) => c.status === a.status);
      const sum = (k: string) => rows.reduce((s, c) => s + n(c[k]), 0);
      const totals = {
        scope: cc.truncated ? "partial (row cap hit)" : "all_matching_cost_codes", cost_codes: rows.length,
        budget_labor_hours: qty(sum("laborHours")), budget_equipment_hours: qty(sum("equipmentHours")),
        budget_labor: money(sum("laborDollars")), budget_equipment: money(sum("equipmentDollars")), budget_material: money(sum("materialDollars")),
        budget_subcontract: money(sum("subcontractDollars")), budget_supply: money(sum("supplyDollars")),
      };
      const p = page(rows, a);
      return reply({ job: jobBrief(j), totals, ...p, data: p.data.map((c) => {
        const o = a.detail ? { ...c } : pick(c, a.fields?.length ? a.fields : CC_FIELDS);
        for (const k of ["code", "unitOfMeasure", "historicalBiditem", "historicalActivityCode", "heavyBidEstimateCode"]) if (typeof o[k] === "string") o[k] = normCode(o[k]);
        for (const k of ["laborDollars", "equipmentDollars", "materialDollars", "subcontractDollars", "supplyDollars"]) if (typeof o[k] === "number") o[k] = money(o[k] as number);
        return o;
      }) });
    },
  );

  server.tool(
    "list_time_cards",
    `Time card headers (date, foreman, revision, approved, sent to payroll) for a job and/or foreman/employee and date range (${DATE_HELP}). Needs the timecards:read scope. Use get_time_card for the hours and quantities on one card.`,
    { ...buArg, ...pageArgs, job: jobArg.optional(), foreman_id: guid.optional(), employee_id: guid.optional(),
      start_date: z.string().optional().describe(DATE_HELP), end_date: z.string().optional().describe(DATE_HELP),
      approved_only: z.boolean().optional() },
    async (a) => {
      const r = range(a);
      if (!a.job && !r.start) throw new Error("Give a job or a start_date to keep the request small.");
      const buId = await bu(a.business_unit_id);
      const jobs = await jobsFor(buId);
      const j = a.job ? await resolveJob(buId, a.job) : undefined;
      const tc = await hcss.cursorAll<Rec>("GET", "/api/v1/timeCardInfo", {
        businessUnitId: buId, jobId: j?.id, foremanId: a.foreman_id, employeeId: a.employee_id, startDate: r.start, endDate: r.end,
        isApproved: a.approved_only || undefined,
      }, CAP);
      const jobCode = new Map(jobs.map((x) => [String(x.id), normCode(x.code)]));
      const rows: Rec[] = tc.records.map((t) => ({ ...pick(t, ["id", "date", "foremanId", "jobId", "revision", "shift", "isApproved", "lockedDateTime", "sentToPayrollDateTime", "lastModifiedDateTime"]), job_code: jobCode.get(String(t.jobId)) }))
        .sort((x: Rec, y: Rec) => String(y.date).localeCompare(String(x.date)));
      return reply({ truncated: tc.truncated, ...page(rows, a) });
    },
  );

  server.tool(
    "get_time_card",
    "One time card in full: cost codes with quantities and notes, each employee's regular/OT/double-OT hours per cost code, and equipment hours per cost code. Needs the timecards:read scope.",
    { time_card_id: guid, include_private_notes: z.boolean().default(false) },
    async (a) => {
      const t = await hcss.get<Rec>(`/api/v1/timeCards/${a.time_card_id}`);
      const ccs = (t.costCodes as Rec[] | undefined) ?? [];
      const ccCode = new Map(ccs.map((c) => [String(c.timeCardCostCodeId), normCode(c.costCodeCode)]));
      const sumBy = (entries?: Rec[]) => {
        const m: Record<string, number> = {};
        for (const e of entries ?? []) { const k = ccCode.get(String(e.timeCardCostCodeId)) ?? "?"; m[k] = qty((m[k] ?? 0) + n(e.hours)); }
        return m;
      };
      const tot = (entries?: Rec[]) => qty((entries ?? []).reduce((s, e) => s + n(e.hours), 0));
      const employees = ((t.employees as Rec[] | undefined) ?? []).map((e) => ({
        employee_code: normCode(e.employeeCode), employee: e.employeeDescription, pay_class: normCode(e.payClassCode),
        regular_hours: tot(e.regularHours as Rec[]), overtime_hours: tot(e.overtimeHours as Rec[]), double_overtime_hours: tot(e.doubleOvertimeHours as Rec[]),
        by_cost_code: { regular: sumBy(e.regularHours as Rec[]), overtime: sumBy(e.overtimeHours as Rec[]), double_overtime: sumBy(e.doubleOvertimeHours as Rec[]) },
        cost_adjustments: e.costAdjustments,
      }));
      const equipment = ((t.equipment as Rec[] | undefined) ?? []).map((e) => ({
        equipment_code: normCode(e.equipmentCode), equipment: e.equipmentDescription,
        total_hours: tot(e.totalHours as Rec[]), operating_hours: tot(e.operatingHours as Rec[]), ownership_hours: tot(e.ownershipHours as Rec[]),
        by_cost_code: sumBy(e.totalHours as Rec[]),
      }));
      return reply({
        header: { ...pick(t, ["id", "date", "shift", "revision", "jobId", "jobDescription", "foremanId", "foremanDescription", "isApproved", "isReviewed", "isAccepted", "isRejected", "lockedDateTime", "sentToPayrollDateTime"]), job_code: normCode(t.jobCode), foreman_code: normCode(t.foremanCode) },
        cost_codes: ccs.map((c) => ({ cost_code: normCode(c.costCodeCode), description: c.costCodeDescription, quantity: qty(n(c.quantity)), unit: normCode(c.unitOfMeasure),
          is_tm: c.isTm, is_rework: c.isRework, public_notes: c.publicNotes || undefined, private_notes: a.include_private_notes ? c.privateNotes || undefined : undefined })),
        totals: { scope: "full_time_card", labor_hours: qty(employees.reduce((s, e) => s + e.regular_hours + e.overtime_hours + e.double_overtime_hours, 0)), equipment_hours: qty(equipment.reduce((s, e) => s + e.total_hours, 0)) },
        employees, equipment,
      });
    },
  );

  const groupHelp = "group_by: none (one row per time-card line), employee/equipment, cost_code, date, or foreman.";
  server.tool(
    "get_employee_hours",
    `Employee time card hours (regular, overtime, other) by job and date range (${DATE_HELP}). ${groupHelp} Totals cover the full date range.`,
    { ...buArg, ...pageArgs, job: jobArg.optional(), start_date: z.string().describe(DATE_HELP), end_date: z.string().describe(DATE_HELP),
      employee_id: guid.optional(), foreman_id: guid.optional(), cost_code: z.string().optional().describe("Only this cost code (needs job)"),
      group_by: z.enum(["none", "employee", "cost_code", "date", "foreman"]).default("employee"), approved_only: z.boolean().optional() },
    async (a) => {
      const r = range(a);
      const buId = await bu(a.business_unit_id);
      const j = a.job ? await resolveJob(buId, a.job) : undefined;
      if (a.cost_code && !j) throw new Error("cost_code needs job.");
      const h = await hcss.cursorAll<Rec>("POST", "/api/v1/hours/employees", {
        businessUnitId: buId, jobIds: j ? [j.id] : undefined, startDate: r.start, endDate: r.end,
        employeeIds: a.employee_id ? [a.employee_id] : undefined, foremanIds: a.foreman_id ? [a.foreman_id] : undefined, isApproved: a.approved_only || undefined,
      }, CAP);
      const lines: Rec[] = [];
      for (const row of h.records) for (const d of (row.hoursDetails as Rec[] | undefined) ?? []) {
        const cc = d.costCode as Rec | undefined;
        if (a.cost_code && !codeEq(cc?.costCodeCode, a.cost_code)) continue;
        const emp = row.employee as Rec | undefined, fm = row.foreman as Rec | undefined, job = row.job as Rec | undefined;
        lines.push({
          date: String(row.date ?? "").slice(0, 10), job_code: normCode(job?.jobCode), employee_code: normCode(emp?.employeeCode), employee: name(emp),
          foreman: name(fm), pay_class: normCode((row.payClass as Rec | undefined)?.payClassCode), cost_code: normCode(cc?.costCodeCode), cost_code_description: cc?.costCodeDescription,
          regular_hours: n(d.regularHours), overtime_hours: n(d.overtimeHours), other_hours: n(d.otherHours), hour_tag: normCode((d.hourTag as Rec | undefined)?.hourTagCode) || undefined,
          time_card_id: row.timeCardId,
        });
      }
      const key = a.group_by === "employee" ? (l: Rec) => `${l.employee_code}` : a.group_by === "cost_code" ? (l: Rec) => `${l.job_code}|${l.cost_code}` : a.group_by === "date" ? (l: Rec) => `${l.date}` : a.group_by === "foreman" ? (l: Rec) => `${l.foreman}` : undefined;
      let rows: Rec[] = lines;
      if (key) {
        const m = new Map<string, Rec>();
        for (const l of lines) {
          const k = key(l);
          const g = m.get(k) ?? (a.group_by === "employee" ? { employee_code: l.employee_code, employee: l.employee } : a.group_by === "cost_code" ? { job_code: l.job_code, cost_code: l.cost_code, cost_code_description: l.cost_code_description } : a.group_by === "date" ? { date: l.date } : { foreman: l.foreman });
          g.regular_hours = n(g.regular_hours) + n(l.regular_hours); g.overtime_hours = n(g.overtime_hours) + n(l.overtime_hours); g.other_hours = n(g.other_hours) + n(l.other_hours);
          g.total_hours = n(g.regular_hours) + n(g.overtime_hours) + n(g.other_hours); g.lines = n(g.lines) + 1;
          m.set(k, g);
        }
        rows = [...m.values()];
      }
      const sk = a.group_by === "employee" ? "employee_code" : a.group_by === "cost_code" ? "cost_code" : a.group_by === "foreman" ? "foreman" : "date";
      rows.sort((x, y) => codeCompare(x[sk], y[sk]) || codeCompare(x.employee_code, y.employee_code));
      const s = (k: string) => qty(lines.reduce((t, l) => t + n(l[k]), 0));
      return reply({ job: j ? jobBrief(j) : undefined, truncated: h.truncated,
        totals: { scope: h.truncated ? "partial (row cap hit)" : "full_date_range", start_date: r.start, end_date: r.end, lines: lines.length, regular_hours: s("regular_hours"), overtime_hours: s("overtime_hours"), other_hours: s("other_hours"), total_hours: qty(s("regular_hours") + s("overtime_hours") + s("other_hours")) },
        ...page(rows, a) });
    },
  );

  server.tool(
    "get_equipment_hours",
    `Equipment time card hours (total, operating, ownership) by job and date range (${DATE_HELP}). ${groupHelp} Totals cover the full date range.`,
    { ...buArg, ...pageArgs, job: jobArg.optional(), start_date: z.string().describe(DATE_HELP), end_date: z.string().describe(DATE_HELP),
      equipment_id: guid.optional(), foreman_id: guid.optional(), cost_code: z.string().optional().describe("Only this cost code (needs job)"),
      group_by: z.enum(["none", "equipment", "cost_code", "date", "foreman"]).default("equipment") },
    async (a) => {
      const r = range(a);
      const buId = await bu(a.business_unit_id);
      const j = a.job ? await resolveJob(buId, a.job) : undefined;
      if (a.cost_code && !j) throw new Error("cost_code needs job.");
      const h = await hcss.cursorAll<Rec>("POST", "/api/v1/hours/equipment", {
        businessUnitId: buId, jobIds: j ? [j.id] : undefined, startDate: r.start, endDate: r.end,
        equipmentIds: a.equipment_id ? [a.equipment_id] : undefined, foremanIds: a.foreman_id ? [a.foreman_id] : undefined,
      }, CAP);
      const lines: Rec[] = [];
      for (const row of h.records) for (const d of (row.hoursDetails as Rec[] | undefined) ?? []) {
        const cc = d.costCode as Rec | undefined;
        if (a.cost_code && !codeEq(cc?.costCodeCode, a.cost_code)) continue;
        const eq = row.equipment as Rec | undefined, job = row.job as Rec | undefined;
        lines.push({
          date: String(row.date ?? "").slice(0, 10), job_code: normCode(job?.jobCode), equipment_code: normCode(eq?.equipmentCode), equipment: eq?.equipmentDescription,
          is_rental: eq?.isRental, foreman: name(row.foreman as Rec | undefined), cost_code: normCode(cc?.costCodeCode), cost_code_description: cc?.costCodeDescription,
          total_hours: n(d.totalHours), operating_hours: n(d.operatingHours), ownership_hours: n(d.ownershipHours), time_card_id: row.timeCardId,
        });
      }
      const gb = a.group_by;
      let rows: Rec[] = lines;
      if (gb !== "none") {
        const m = new Map<string, Rec>();
        for (const l of lines) {
          const k = gb === "equipment" ? String(l.equipment_code) : gb === "cost_code" ? `${l.job_code}|${l.cost_code}` : gb === "date" ? String(l.date) : String(l.foreman);
          const g = m.get(k) ?? (gb === "equipment" ? { equipment_code: l.equipment_code, equipment: l.equipment, is_rental: l.is_rental } : gb === "cost_code" ? { job_code: l.job_code, cost_code: l.cost_code, cost_code_description: l.cost_code_description } : gb === "date" ? { date: l.date } : { foreman: l.foreman });
          g.total_hours = n(g.total_hours) + n(l.total_hours); g.operating_hours = n(g.operating_hours) + n(l.operating_hours); g.ownership_hours = n(g.ownership_hours) + n(l.ownership_hours); g.lines = n(g.lines) + 1;
          m.set(k, g);
        }
        rows = [...m.values()];
      }
      const sk = gb === "equipment" ? "equipment_code" : gb === "cost_code" ? "cost_code" : gb === "foreman" ? "foreman" : "date";
      rows.sort((x, y) => codeCompare(x[sk], y[sk]));
      const s = (k: string) => qty(lines.reduce((t, l) => t + n(l[k]), 0));
      return reply({ job: j ? jobBrief(j) : undefined, truncated: h.truncated,
        totals: { scope: h.truncated ? "partial (row cap hit)" : "full_date_range", start_date: r.start, end_date: r.end, lines: lines.length, total_hours: s("total_hours"), operating_hours: s("operating_hours"), ownership_hours: s("ownership_hours") },
        ...page(rows, a) });
    },
  );

  server.tool(
    "get_cost_code_progress",
    `Quantities installed and labor hours per cost code per day for one job (${DATE_HELP} range), with to-date values, joined to the cost code's budget qty and unit. by_cost_code=true (default) sums the range per cost code.`,
    { ...buArg, ...pageArgs, job: jobArg, start_date: z.string().optional().describe(DATE_HELP), end_date: z.string().optional().describe(DATE_HELP),
      cost_codes: z.array(z.string()).optional().describe("Only these cost codes, e.g. [\"2010\"]"), by_cost_code: z.boolean().default(true) },
    async (a) => {
      const r = range(a);
      const buId = await bu(a.business_unit_id);
      const j = await resolveJob(buId, a.job);
      const { byId, ids } = await resolveCostCodes(buId, String(j.id), a.cost_codes);
      const p = await hcss.cursorAll<Rec>("POST", "/api/v1/costCode/progress/advancedRequest", { jobId: j.id, startDate: r.start, endDate: r.end, costCodeIds: ids }, CAP);
      const info = (id: unknown) => { const c = byId.get(String(id)); return { cost_code: normCode(c?.code), description: c?.description, unit: normCode(c?.unitOfMeasure), budget_qty: c ? qty(n(c.quantity)) : undefined, budget_mh: c ? qty(n(c.laborHours)) : undefined }; };
      let rows: Rec[];
      if (a.by_cost_code) {
        const m = new Map<string, Rec>();
        for (const x of p.records) {
          const k = String(x.costCodeId);
          const g = m.get(k) ?? { ...info(k), quantity: 0, rework_quantity: 0, labor_hours: 0, cost: 0, days: 0, last_date: "" };
          g.quantity = n(g.quantity) + n(x.quantity); g.rework_quantity = n(g.rework_quantity) + n(x.reworkQuantity); g.labor_hours = n(g.labor_hours) + n(x.laborHours);
          g.cost = n(g.cost) + n(x.cost); g.days = n(g.days) + 1;
          const d = String(x.date ?? "").slice(0, 10);
          if (d >= String(g.last_date)) { g.last_date = d; g.to_date_quantity = n(x.toDateQuantity); g.to_date_labor_hours = n(x.toDateLaborHours); g.to_date_cost = money(n(x.toDateCost)); }
          m.set(k, g);
        }
        rows = [...m.values()].map((g) => ({ ...g, cost: money(n(g.cost)), units_per_mh: n(g.labor_hours) ? qty(n(g.quantity) / n(g.labor_hours)) : null,
          pct_complete_to_date: n(g.budget_qty) ? Math.round((n(g.to_date_quantity) / n(g.budget_qty)) * 1000) / 10 : null }));
        rows.sort((x, y) => codeCompare(x.cost_code, y.cost_code));
      } else {
        rows = p.records.map((x) => ({ date: String(x.date ?? "").slice(0, 10), ...info(x.costCodeId), quantity: n(x.quantity), rework_quantity: n(x.reworkQuantity), labor_hours: n(x.laborHours),
          cost: money(n(x.cost)), to_date_quantity: n(x.toDateQuantity), to_date_labor_hours: n(x.toDateLaborHours), to_date_cost: money(n(x.toDateCost)) }));
        rows.sort((x, y) => String(x.date).localeCompare(String(y.date)) || codeCompare(x.cost_code, y.cost_code));
      }
      return reply({ job: jobBrief(j), truncated: p.truncated,
        totals: { scope: p.truncated ? "partial (row cap hit)" : "full_date_range", start_date: r.start, end_date: r.end,
          labor_hours: qty(p.records.reduce((s, x) => s + n(x.laborHours), 0)), cost: money(p.records.reduce((s, x) => s + n(x.cost), 0)),
          note: "Quantities are not summed across cost codes (mixed units)." },
        ...page(rows, a) });
    },
  );

  server.tool(
    "get_diaries",
    `Foreman daily diaries (notes, working conditions, tags) for a job and/or foreman and date range (${DATE_HELP}), newest first. Notes are cut to 500 chars unless detail:true.`,
    { ...buArg, ...pageArgs, job: jobArg.optional(), foreman_id: guid.optional(), start_date: z.string().optional().describe(DATE_HELP), end_date: z.string().optional().describe(DATE_HELP),
      text: z.string().optional().describe("Only diaries whose note/working conditions contain this text"), detail: z.boolean().default(false) },
    async (a) => {
      const r = range(a);
      if (!a.job && !r.start) throw new Error("Give a job or a start_date to keep the request small.");
      const buId = await bu(a.business_unit_id);
      const j = a.job ? await resolveJob(buId, a.job) : undefined;
      const d = await hcss.cursorAll<Rec>("POST", "/api/v1/diaries/search", { businessUnitId: buId, jobIds: j ? [j.id] : undefined, foremanIds: a.foreman_id ? [a.foreman_id] : undefined, startDate: r.start, endDate: r.end }, CAP);
      const cut = (s: unknown) => (typeof s === "string" && !a.detail && s.length > 500 ? s.slice(0, 500) + "..." : s || undefined);
      const t = a.text?.trim().toLowerCase();
      let rows = d.records;
      if (t) rows = rows.filter((x) => `${x.note ?? ""} ${x.workingConditionNote ?? ""}`.toLowerCase().includes(t));
      const out = rows.map((x) => ({ id: x.id, date: String(x.date ?? "").slice(0, 10), job_code: normCode((x.job as Rec | undefined)?.code), foreman: name(x.foreman as Rec | undefined),
        note: cut(x.note), working_conditions: cut(x.workingConditionNote), tags: Array.isArray(x.tags) && (x.tags as Rec[]).length ? (x.tags as Rec[]).map((g) => normCode(g.code)) : undefined, revision: x.revision }))
        .sort((x, y) => y.date.localeCompare(x.date));
      return reply({ job: j ? jobBrief(j) : undefined, truncated: d.truncated, ...page(out, a, 25) });
    },
  );

  server.tool(
    "list_employees",
    "Employees in the business unit (code, name, foreman flag, default pay class), sorted by code. Use foremen_only to find foreman ids for other tools.",
    { ...buArg, ...pageArgs, text: z.string().optional().describe("Code or name contains"), foremen_only: z.boolean().default(false), include_inactive: z.boolean().default(false) },
    async (a) => {
      const rows = (await hcss.get<Rec[]>(`/api/v1/businessUnits/${await bu(a.business_unit_id)}/employees`, { isActive: a.include_inactive ? undefined : true, isDeleted: false, isForeman: a.foremen_only || undefined })) ?? [];
      const t = a.text?.trim().toLowerCase();
      let out = rows.map((e) => ({ id: e.id, code: normCode(e.code), name: [e.firstName, e.lastName].filter(Boolean).join(" "), nick_name: e.nickName || undefined, is_foreman: e.isForeman, is_active: e.isActive, default_pay_class: normCode(e.defaultPayClassCode) || undefined, assigned_equipment: normCode(e.assignedEquipmentCode) || undefined }));
      if (t) out = out.filter((e) => `${e.code} ${e.name} ${e.nick_name ?? ""}`.toLowerCase().includes(t));
      out.sort((x, y) => codeCompare(x.code, y.code));
      return reply(page(out, a, 100));
    },
  );

  server.tool(
    "list_equipment",
    "Equipment in the business unit (code, description, type, rental flag, make/model/year), sorted by code.",
    { ...buArg, ...pageArgs, text: z.string().optional().describe("Code, description or type contains"), include_inactive: z.boolean().default(false) },
    async (a) => {
      const rows = (await hcss.get<Rec[]>(`/api/v1/businessUnits/${await bu(a.business_unit_id)}/equipment`, { isActive: a.include_inactive ? undefined : true, isDeleted: false })) ?? [];
      const t = a.text?.trim().toLowerCase();
      let out = rows.map((e) => ({ id: e.equipmentId, code: normCode(e.equipmentCode), description: e.equipmentDescription, type: normCode(e.equipmentTypeCode) || undefined, type_description: e.equipmentTypeDescription || undefined, is_rental: e.isRental, make: e.make || undefined, model: e.model || undefined, year: e.year || undefined, is_active: e.isActive }));
      if (t) out = out.filter((e) => `${e.code} ${e.description ?? ""} ${e.type ?? ""} ${e.type_description ?? ""}`.toLowerCase().includes(t));
      out.sort((x, y) => codeCompare(x.code, y.code));
      return reply(page(out, a, 100));
    },
  );

  server.tool(
    "get_job_cost_summary",
    "Field vs budget per cost code for one job: budget vs actual quantity, man-hours (with earned MH, MH/unit, units/MH), equipment hours and dollars, plus linked HeavyBid estimate/biditem/activity. Job-to-date by default, or a date range (YYYY-MM-DD). Totals cover all cost codes. Use export_job_cost_summary for a file.",
    { ...buArg, ...pageArgs, job: jobArg, start_date: z.string().optional().describe(DATE_HELP), end_date: z.string().optional().describe(DATE_HELP),
      cost_code: z.string().optional().describe("Only this cost code"), with_activity_only: z.boolean().default(false).describe("Hide cost codes with no actual hours, quantity or cost"),
      sort_by: z.enum(["cost_code", "mh_over", "actual_total"]).default("cost_code").describe("mh_over = worst man-hour overrun first") },
    async (a) => {
      const r = range(a);
      const buId = await bu(a.business_unit_id);
      const j = await resolveJob(buId, a.job);
      const s = await jobCostSummary(hcss, buId, String(j.id), r);
      let rows = s.rows;
      if (a.cost_code) {
        rows = rows.filter((x) => codeEq(x.cost_code, a.cost_code));
        if (!rows.length) return reply({ job: jobBrief(j), count: 0, hint: `No cost code '${normCode(a.cost_code)}'; this job has ${s.rows.length} cost codes (e.g. ${s.rows.slice(0, 10).map((x) => x.cost_code).join(", ")}).` });
      }
      if (a.with_activity_only) rows = rows.filter((x) => n(x.actual_mh) || n(x.actual_qty) || n(x.actual_total));
      if (a.sort_by === "mh_over") rows = [...rows].sort((x, y) => n(x.mh_over_under) - n(y.mh_over_under));
      if (a.sort_by === "actual_total") rows = [...rows].sort((x, y) => n(y.actual_total) - n(x.actual_total));
      return reply({ job: jobBrief(j), source: s.source, truncated: s.truncated, totals: s.totals,
        actual_rows_without_cost_code: s.unmatchedActualRows || undefined,
        column_notes: "Budget = HeavyJob cost code setup (quantity, laborHours, *Dollars). Actual = time cards + cost entries as HCSS reports them. Derived columns are computed here. All UNVERIFIED against a HeavyJob Cost Report until compared once.",
        ...page(rows, a) });
    },
  );

  server.tool(
    "export_job_cost_summary",
    "Export the job cost summary (budget vs actual per cost code) as Excel (.xlsx) or CSV. Returns a one-time download link (expires in minutes).",
    { ...buArg, job: jobArg, start_date: z.string().optional().describe(DATE_HELP), end_date: z.string().optional().describe(DATE_HELP), format: z.enum(["xlsx", "csv"]).default("xlsx") },
    async (a) => {
      const r = range(a);
      const buId = await bu(a.business_unit_id);
      const j = await resolveJob(buId, a.job);
      const s = await jobCostSummary(hcss, buId, String(j.id), r);
      const code = normCode(j.code).replace(/[^\w.-]+/g, "_") || "job";
      const fname = `${code}-job-cost-summary${r.start || r.end ? `-${r.start ?? "start"}_${r.end ?? "today"}` : ""}.${a.format}`;
      const totalRow: Record<string, unknown> = { cost_code: "TOTAL", description: s.totals.scope };
      for (const [k, v] of Object.entries(s.totals)) if (typeof v === "number" && k !== "cost_codes") totalRow[k] = v;
      const rows = [...s.rows, totalRow];
      const buf = a.format === "csv"
        ? new TextEncoder().encode("\ufeff" + toCsv(SUMMARY_COLUMNS, rows))
        : toXlsx(SUMMARY_COLUMNS, rows, "Job Cost Summary", [["Job", `${normCode(j.code)} ${j.description ?? ""}`.trim()], ["Range", r.start || r.end ? `${r.start ?? "start"} to ${r.end ?? "today"}` : "job to date"], ["Generated (UTC)", new Date().toISOString()], ["Source", s.source], ["Totals scope", String(s.totals.scope)]]);
      if (buf.byteLength > 24 * 1024 * 1024) throw new Error("Export exceeds the 25 MiB KV value limit.");
      const mime = a.format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const id = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      await env.EXPORTS.put(`export:${id}`, buf, { expirationTtl: cfg.exportTtlSeconds, metadata: { name: fname, mime } });
      return reply({ file: fname, rows: s.rows.length, truncated: s.truncated, totals: s.totals, download_url: `${origin}/exports/${id}`, hcss_calls: hcss.used,
        note: `Single-use link, expires in ${Math.round(cfg.exportTtlSeconds / 60)} minutes. Don't share it.` });
    },
  );

  server.tool(
    "get_telematics_equipment",
    "Telematics equipment with last location, odometer, and engine hours. Registered units only unless include_unregistered is true (that omits isRegistered and returns every unit). Compact rows by default. detail:true returns each untouched HCSS record plus the mapped fields (HCSS keys are not renamed or dropped). If odometer or engine hours cannot be read, the row includes meter_fields_found: the field names actually on that HCSS record. Joined to HeavyJob equipment by code (trim, case-insensitive; inactive included, deleted excluded). Needs the telematics:read scope. All HCSS pages are fetched first (subrequest cap applies), then text filter, skip, and max_records. Totals cover the full matched set.",
    { ...buArg, ...pageArgs,
      text: z.string().optional().describe("Equipment code or description contains (case-insensitive)"),
      include_unregistered: z.boolean().default(false).describe("Also return unregistered units. Default is registered only."),
      detail: z.boolean().default(false).describe("Untouched HCSS record for each unit, plus mapped fields (equipment_code, odometer, engine_hours, HeavyJob match). Does not replace HCSS fields.") },
    async (a) => {
      const pulled = await hcss.fetchTelematicsEquipment(CAP, isRegisteredQuery(a.include_unregistered));
      const buId = await bu(a.business_unit_id);
      const hj = (await hcss.get<Rec[]>(`/api/v1/businessUnits/${buId}/equipment`, { isDeleted: false })) ?? [];
      const index = heavyjobIndex(hj);
      const built = buildEquipmentList(pulled.records, index, { text: a.text, skip: a.skip, max_records: a.max_records ?? 100, truncated: pulled.truncated });
      return reply({
        truncated: pulled.truncated,
        totals: built.totals,
        total_matching: built.total_matching,
        returned: built.returned,
        skip: built.skip,
        next_skip: built.next_skip,
        data: built.data.map((r) => a.detail ? mapTelematicsEquipmentDetail(r.raw, index) : r.compact),
      });
    },
  );

  server.tool(
    "get_telematics_usage",
    `Miles and engine hours from daily telematics snapshots (${DATE_HELP}, inclusive). Per unit per day, miles_driven is the odometer change versus the previous snapshot and engine_hours is the hour-meter change. group_by equipment (default) or date. Flags on each row: no_baseline, gap (missing days), negative_delta (meter reset or replacement), zero_jump (same reading and same timestamp as the previous snapshot), implausible_jump (over 1000 miles or 24 engine hours per day, scaled across a gap). Negative and implausible deltas are flagged and left out of the counted totals. Nothing is returned until the daily snapshot cron has stored at least one day.`,
    { ...pageArgs,
      start_date: z.string().describe(DATE_HELP),
      end_date: z.string().describe(DATE_HELP),
      equipment_code: z.string().optional().describe("Only this equipment code (trim and case ignored)"),
      group_by: z.enum(["equipment", "date"]).default("equipment") },
    async (a) => {
      const r = range(a);
      if (!r.start || !r.end) throw new Error("start_date and end_date are required (YYYY-MM-DD).");
      if (!env.TELEMATICS_DB) throw new Error("TELEMATICS_DB is not configured. Create the D1 database and apply migrations before calling get_telematics_usage.");
      const code = a.equipment_code?.trim() || undefined;
      const snaps = await loadSnapshots(env.TELEMATICS_DB, r.start, r.end, code);
      const usage = computeUsage(snaps, { start_date: r.start, end_date: r.end, equipment_code: code, group_by: a.group_by });
      const p = pageRows(usage.rows, a.skip ?? 0, a.max_records ?? 50);
      return reply({
        group_by: a.group_by,
        totals: usage.totals,
        note: "Usage starts accruing only after daily snapshots begin (cron 09:00 UTC). A unit's first snapshot has no delta until an earlier snapshot exists.",
        ...p,
      });
    },
  );

  return server;
}
