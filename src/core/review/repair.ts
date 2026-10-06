import { reviewReports } from './history.js';
import type { ReviewFinding } from './types.js';

const SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const VERIFICATION_RANK: Record<string, number> = { BLOCKED: 0, FAIL: 1, MANUAL_REQUIRED: 2, PASS: 3 };

export interface RepairSnapshot {
  readonly report: string;
  readonly verdict: string;
  readonly contractBasis: string | null;
  readonly verificationBasis: string | null;
  readonly verificationStatus: string | null;
  readonly reviewedRevision: unknown;
  readonly findings: readonly ReviewFinding[];
}

function highest(findings: readonly ReviewFinding[]): string | null {
  if (findings.length === 0) return null;
  return [...findings].sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))[0].severity;
}

export function compareRepairSnapshots(
  before: RepairSnapshot,
  after: RepairSnapshot,
  cycle: number,
): Readonly<Record<string, unknown>> {
  if (!Number.isInteger(cycle) || cycle < 1) throw new Error('adaptive comparison requires cycle >= 1');
  const beforeMap = new Map(before.findings.map((item) => [item.fingerprint, item]));
  const afterMap = new Map(after.findings.map((item) => [item.fingerprint, item]));
  const beforeFps = new Set(beforeMap.keys());
  const afterFps = new Set(afterMap.keys());
  const resolved = [...beforeFps].filter((item) => !afterFps.has(item)).sort();
  const persisted = [...beforeFps].filter((item) => afterFps.has(item)).sort();
  const introduced = [...afterFps].filter((item) => !beforeFps.has(item)).sort();
  const highestBefore = highest(before.findings);
  const highestAfter = highest(after.findings);
  const scopeComparable = Boolean(before.contractBasis && before.contractBasis === after.contractBasis);
  const revisionChanged = JSON.stringify(before.reviewedRevision) !== JSON.stringify(after.reviewedRevision);
  const verificationChanged =
    before.verificationBasis && after.verificationBasis
      ? before.verificationBasis !== after.verificationBasis
      : null;
  const verificationRegressed =
    before.verificationStatus && after.verificationStatus &&
    before.verificationStatus in VERIFICATION_RANK && after.verificationStatus in VERIFICATION_RANK
      ? VERIFICATION_RANK[after.verificationStatus] < VERIFICATION_RANK[before.verificationStatus]
      : null;

  let stop: string | null = null;
  let message = 'repair cycle made deterministic progress or scope is not comparable';
  if (scopeComparable) {
    if (verificationRegressed === true) {
      stop = 'REGRESSION';
      message = 'deterministic verification status became worse while contract scope stayed unchanged';
    } else if (beforeFps.size === afterFps.size && [...beforeFps].every((item) => afterFps.has(item))) {
      if (revisionChanged) {
        stop = 'REPEATED_FINDINGS';
        message = 'FIX changed repository revision, but the same material findings remain';
      } else {
        stop = 'NO_PROGRESS';
        message = 'FIX produced no repository revision delta and did not resolve findings';
      }
    } else if (introduced.length > 0 && (SEVERITY_RANK[highestAfter ?? ''] ?? 0) > (SEVERITY_RANK[highestBefore ?? ''] ?? 0)) {
      stop = 'REGRESSION';
      message = 'FIX introduced a higher-severity finding while contract scope stayed unchanged';
    } else if (resolved.length === 0 && (SEVERITY_RANK[highestAfter ?? ''] ?? 0) >= (SEVERITY_RANK[highestBefore ?? ''] ?? 0)) {
      stop = 'NO_PROGRESS';
      message = 'FIX resolved no findings and did not reduce highest material severity';
    }
  }

  return {
    cycle,
    beforeReport: before.report,
    afterReport: after.report,
    findingsBefore: before.findings.length,
    findingsAfter: after.findings.length,
    resolved: resolved.length,
    persisted: persisted.length,
    introduced: introduced.length,
    highestSeverityBefore: highestBefore,
    highestSeverityAfter: highestAfter,
    repositoryRevisionChanged: revisionChanged,
    contractBasisChanged: before.contractBasis !== after.contractBasis,
    scopeComparable,
    verificationChanged,
    verificationStatusBefore: before.verificationStatus,
    verificationStatusAfter: after.verificationStatus,
    verificationRegressed,
    stopDecision: stop ?? 'continue',
    reasonCode: stop,
    message,
  };
}


export async function repairCycleDecision(
  projectRoot: string,
  stepId: string,
  cycle: number,
): Promise<Readonly<Record<string, unknown>> | null> {
  const reports = await reviewReports(projectRoot, stepId);
  if (reports.length < 2) return null;
  const [before, after] = reports.slice(-2);
  const snapshot = (report: typeof before): RepairSnapshot => ({
    report: report.relativePath,
    verdict: report.verdict,
    contractBasis:
      typeof report.document.frontmatter.contract_basis === 'string'
        ? report.document.frontmatter.contract_basis
        : null,
    verificationBasis:
      typeof report.document.frontmatter.verification_basis === 'string'
        ? report.document.frontmatter.verification_basis
        : null,
    verificationStatus:
      typeof report.document.frontmatter.verification_status === 'string'
        ? report.document.frontmatter.verification_status
        : null,
    reviewedRevision: report.document.frontmatter.reviewed_revision,
    findings: report.findings,
  });
  const result = compareRepairSnapshots(snapshot(before), snapshot(after), cycle);
  return result.reasonCode ? result : null;
}
