/** Lock-manifest approval and evaluation evidence (§5.4, §16.6). Host options, never agent configuration. */
import type { GovernanceOptions } from "../types/options.js";
import type { EvalReportRecord, ExecutionPersistence, LockApprovalRecord } from "../types/persistence.js";
import { SFieldError } from "../errors.js";
import { nowIso } from "../util/digest.js";

export interface GovernanceStores {
  lockApprovals: ExecutionPersistence["lockApprovals"];
  evalReports: ExecutionPersistence["evalReports"];
}

export function effectiveRequireApproved(governance: GovernanceOptions | undefined, deployment: string): boolean {
  return governance?.requireApproved ?? deployment === "service";
}

/** Startup/reload check: the compiled digest must be approved when required. */
export async function checkLockApproved(digest: string, governance: GovernanceOptions | undefined, deployment: string, stores: GovernanceStores): Promise<LockApprovalRecord | null> {
  const store = governance?.approvalStore ?? stores.lockApprovals;
  const record = await store.get(digest);
  if (effectiveRequireApproved(governance, deployment) && !record) {
    throw new SFieldError("LOCK_MANIFEST_UNAPPROVED", `lock manifest ${digest} has no approval record`, { suggestion: `Run: sfield lock approve ${digest}` });
  }
  return record;
}

export interface ApproveLockInput {
  digest: string;
  approver: string;
  comment?: string;
  evalReportId?: string;
  /** Records an explicit host action when no baseline exists yet. */
  noBaseline?: boolean;
}

/** Creates an approval record, enforcing requireEval when configured (§16.6). */
export async function approveLock(input: ApproveLockInput, governance: GovernanceOptions | undefined, stores: GovernanceStores): Promise<{ record: LockApprovalRecord; changed: boolean }> {
  const store = governance?.approvalStore ?? stores.lockApprovals;
  const record: LockApprovalRecord = { digest: input.digest, approver: input.approver, decidedAt: nowIso() };
  if (input.comment) record.comment = input.comment;
  const req = governance?.requireEval;
  if (req) {
    const report = await resolveEvidence(input, req, stores);
    record.evalReportId = report.id;
    record.suite = req.suite;
    if (!report.baselineDigest) record.noBaseline = true;
  } else if (input.evalReportId) {
    record.evalReportId = input.evalReportId;
  }
  return store.put(record);
}

async function resolveEvidence(input: ApproveLockInput, req: NonNullable<GovernanceOptions["requireEval"]>, stores: GovernanceStores): Promise<EvalReportRecord> {
  let report: EvalReportRecord | null = null;
  if (input.evalReportId) report = await stores.evalReports.get(input.evalReportId);
  else {
    const all = await stores.evalReports.list({ suite: req.suite, candidateDigest: input.digest });
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    report = all[0] ?? null;
  }
  if (!report || report.candidateDigest !== input.digest || report.suite !== req.suite) {
    throw new SFieldError("EVAL_EVIDENCE_MISSING", `no evaluation report for suite ${req.suite} bound to digest ${input.digest}`, { suggestion: `Run: sfield eval --suite ${req.suite} --candidate ${input.digest}` });
  }
  const maxAgeMs = (req.evidenceMaxAgeSeconds ?? 2592000) * 1000;
  const now = Date.now();
  if (Date.parse(report.createdAt) + maxAgeMs < now || Date.parse(report.expiresAt) <= now) {
    throw new SFieldError("EVAL_EVIDENCE_EXPIRED", `evaluation report ${report.id} is older than ${req.evidenceMaxAgeSeconds ?? 2592000} seconds`);
  }
  if (req.requireLive && report.mode !== "live") throw new SFieldError("EVAL_EVIDENCE_MISSING", `evaluation report ${report.id} is replay evidence; live evidence is required`);
  // Baseline resolution.
  let baselineDigest: string | undefined;
  if (req.baseline === "current_approved") {
    const latest = await (stores.lockApprovals.latest(req.suite));
    if (latest) baselineDigest = latest.digest;
    else if (!input.noBaseline) {
      throw new SFieldError("EVAL_BASELINE_UNAVAILABLE", `no approved baseline exists for suite ${req.suite}`, { suggestion: "Pass an explicit baseline digest, or record a --no-baseline host action for the first approval" });
    }
  } else baselineDigest = req.baseline.digest;
  if (baselineDigest && report.baselineDigest && report.baselineDigest !== baselineDigest) {
    throw new SFieldError("EVAL_BASELINE_UNAVAILABLE", `evaluation report ${report.id} was measured against ${report.baselineDigest}, not the resolved baseline ${baselineDigest}`);
  }
  const failures: string[] = [];
  if (report.passRate < req.minPassRate) failures.push(`passRate ${report.passRate} < ${req.minPassRate}`);
  if (req.maxCostDeltaRatio !== undefined && baselineDigest) {
    if (report.costDeltaRatio === undefined) failures.push("costDeltaRatio missing");
    else if (report.costDeltaRatio > req.maxCostDeltaRatio) failures.push(`costDeltaRatio ${report.costDeltaRatio} > ${req.maxCostDeltaRatio}`);
  }
  if (req.maxLatencyDeltaRatio !== undefined && baselineDigest) {
    if (report.latencyDeltaRatio === undefined) failures.push("latencyDeltaRatio missing");
    else if (report.latencyDeltaRatio > req.maxLatencyDeltaRatio) failures.push(`latencyDeltaRatio ${report.latencyDeltaRatio} > ${req.maxLatencyDeltaRatio}`);
  }
  if (failures.length) throw new SFieldError("EVAL_THRESHOLD_NOT_MET", `evaluation report ${report.id} does not meet the thresholds: ${failures.join("; ")}`);
  return report;
}
