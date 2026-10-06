import type { ParsedArtifactDocument } from '../artifacts/index.js';
import { stableHash } from '../planning/hash.js';
import { ReviewCoreError } from './errors.js';
import type {
  FindingCategory,
  FindingSeverity,
  ReviewFinding,
} from './types.js';

export const FINDING_CONTRACT_VERSION = 2 as const;
export const FINDING_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low'] as const);
export const FINDING_CATEGORIES = Object.freeze(['implementation', 'evidence', 'contract'] as const);

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `${label} must be a non-empty string`);
  }
  return value.replace(/\r\n?/g, '\n').trim();
}

function single(value: unknown, label: string): string {
  const result = text(value, label);
  if (result.includes('\n')) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `${label} must be a single line`);
  }
  return result;
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `${label} must be an array`);
  }
  return value.map((item, index) => single(item, `${label}[${index}]`));
}

function semanticIdentity(finding: Omit<ReviewFinding, 'id' | 'title' | 'severity' | 'impact' | 'repair' | 'constraints' | 'evidence' | 'fingerprint'>): unknown {
  return {
    category: finding.category,
    location: finding.location,
    scenario: finding.scenario,
    expected: finding.expected,
    observed: finding.observed,
  };
}

export function normalizeFinding(value: unknown, index: number): ReviewFinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}] must be an object`);
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set([
    'id','title','severity','category','location','scenario','expected','observed',
    'impact','repair','constraints','evidence','fingerprint',
  ]);
  const unknown = Object.keys(item).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}] has unsupported keys: ${unknown.sort().join(', ')}`);
  }

  const expectedId = `F-${String(index).padStart(3, '0')}`;
  const id = item.id === undefined ? expectedId : single(item.id, `findings[${index}].id`);
  if (id !== expectedId) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}].id must be ${expectedId}`);
  }

  const severity = single(item.severity, `findings[${index}].severity`) as FindingSeverity;
  const category = single(item.category, `findings[${index}].category`) as FindingCategory;
  if (!FINDING_SEVERITIES.includes(severity)) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}].severity is invalid`);
  }
  if (!FINDING_CATEGORIES.includes(category)) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}].category is invalid`);
  }

  if (typeof item.location !== 'object' || item.location === null || Array.isArray(item.location)) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}].location must be an object`);
  }
  const locationValue = item.location as Record<string, unknown>;
  if (Object.keys(locationValue).some((key) => !['path','line'].includes(key))) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}].location has unsupported keys`);
  }
  const line = locationValue.line;
  if (line !== undefined && line !== null && (!Number.isInteger(line) || (line as number) < 1)) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}].location.line must be null or positive integer`);
  }

  if (typeof item.scenario !== 'object' || item.scenario === null || Array.isArray(item.scenario)) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}].scenario must be an object`);
  }
  const scenarioValue = item.scenario as Record<string, unknown>;
  if (Object.keys(scenarioValue).some((key) => !['given','when','then'].includes(key))) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}].scenario has unsupported keys`);
  }

  if (typeof item.repair !== 'object' || item.repair === null || Array.isArray(item.repair)) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}].repair must be an object`);
  }
  const repairValue = item.repair as Record<string, unknown>;
  if (Object.keys(repairValue).some((key) => !['direction','admissibleAlternatives'].includes(key))) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}].repair has unsupported keys`);
  }

  const base = {
    category,
    location: {
      path: single(locationValue.path, `findings[${index}].location.path`),
      line: line === undefined ? null : (line as number | null),
    },
    scenario: {
      given: text(scenarioValue.given, `findings[${index}].scenario.given`),
      when: text(scenarioValue.when, `findings[${index}].scenario.when`),
      then: text(scenarioValue.then, `findings[${index}].scenario.then`),
    },
    expected: text(item.expected, `findings[${index}].expected`),
    observed: text(item.observed, `findings[${index}].observed`),
  };
  const fingerprint = stableHash(semanticIdentity(base));
  if (item.fingerprint !== undefined && item.fingerprint !== fingerprint) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', `findings[${index}].fingerprint does not match deterministic fingerprint`);
  }

  return {
    id,
    title: single(item.title, `findings[${index}].title`),
    severity,
    category,
    location: base.location,
    scenario: base.scenario,
    expected: base.expected,
    observed: base.observed,
    impact: text(item.impact, `findings[${index}].impact`),
    repair: {
      direction: text(repairValue.direction, `findings[${index}].repair.direction`),
      admissibleAlternatives: stringList(repairValue.admissibleAlternatives, `findings[${index}].repair.admissibleAlternatives`),
    },
    constraints: stringList(item.constraints, `findings[${index}].constraints`),
    evidence: stringList(item.evidence, `findings[${index}].evidence`),
    fingerprint,
  };
}

export function normalizeFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', 'findings must be an array');
  }
  const findings = value.map((item, index) => normalizeFinding(item, index + 1));
  const fingerprints = findings.map((item) => item.fingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', 'findings must not contain duplicate fingerprints');
  }
  return findings;
}

export function machineFindingPayload(findings: readonly ReviewFinding[]): Readonly<Record<string, unknown>> {
  return { schemaVersion: FINDING_CONTRACT_VERSION, findings };
}


export function parseMachineFindings(document: ParsedArtifactDocument): ReviewFinding[] {
  const section = document.sections['Machine-readable findings'];
  if (typeof section !== 'string' || !section.trim()) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', "missing or empty section '## Machine-readable findings'");
  }
  const text = section.trim();
  const fence = String.fromCharCode(96).repeat(3);
  const start = fence + 'json\n';
  const end = '\n' + fence;
  if (!text.startsWith(start) || !text.endsWith(end)) {
    throw new ReviewCoreError(
      'REVIEW_CONTRACT_INVALID',
      'Machine-readable findings must contain exactly one JSON fenced object',
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text.slice(start.length, -end.length));
  } catch (error) {
    throw new ReviewCoreError(
      'REVIEW_CONTRACT_INVALID',
      'invalid machine findings JSON: ' + (error as Error).message,
    );
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', 'machine findings payload must be an object');
  }
  const object = payload as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== 'findings,schemaVersion') {
    throw new ReviewCoreError('REVIEW_CONTRACT_INVALID', 'machine findings payload keys must be schemaVersion, findings');
  }
  if (object.schemaVersion !== FINDING_CONTRACT_VERSION) {
    throw new ReviewCoreError(
      'REVIEW_CONTRACT_INVALID',
      'machine findings schemaVersion must be ' + FINDING_CONTRACT_VERSION,
    );
  }
  return normalizeFindings(object.findings);
}
