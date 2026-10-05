export const ID_PATTERNS = Object.freeze({
  requirement: /^REQ-\d{3,}$/,
  adr: /^ADR-\d{3,}$/,
  step: /^STEP-\d{3,}$/,
  openQuestion: /^OQ-\d{3,}$/,
  principle: /^PRN-\d{3,}$/,
});

export const PRIORITIES = Object.freeze(['critical', 'high', 'medium', 'low'] as const);
export const ADR_STATUSES = Object.freeze(['proposed', 'accepted', 'superseded', 'rejected'] as const);
export const STEP_STATUSES = Object.freeze([
  'planned',
  'in_progress',
  'blocked',
  'completed',
  'deferred',
  'cancelled',
] as const);
export const STEP_TYPES = Object.freeze([
  'implementation',
  'bugfix',
  'refactor',
  'research',
  'adr',
  'audit',
  'review',
  'hardening',
  'documentation',
  'release',
] as const);
export const PLAN_STATUSES = Object.freeze(['not_planned', 'draft', 'ready'] as const);
export const OQ_STATUSES = Object.freeze(['open', 'resolved', 'deferred'] as const);
export const PRN_STATUSES = Object.freeze(['active', 'superseded', 'deprecated'] as const);
export const PRN_SEVERITIES = Object.freeze(['blocking', 'advisory'] as const);
export const REVIEW_VERDICTS = Object.freeze(['pass', 'fail', 'blocked'] as const);
export const FINDING_CATEGORIES = Object.freeze(['implementation', 'evidence', 'contract'] as const);
export const RISK_FLAGS = Object.freeze([
  'none',
  'security-sensitive',
  'data-migration',
  'destructive',
  'public-api',
  'architecture',
  'concurrency',
  'external-integration',
  'performance-critical',
  'release-critical',
] as const);

export const REQUIRED_SECTIONS = Object.freeze({
  requirement: ['Requirement', 'Rationale', 'Acceptance'],
  adr: [
    'Context',
    'Problem',
    'Decision',
    'Alternatives considered',
    'Consequences',
    'Security implications',
    'Data / migration implications',
    'Compatibility / operational implications',
  ],
  step: [
    'Goal',
    'Context',
    'Scope',
    'Mutation policy',
    'Out of scope',
    'Acceptance criteria',
    'Verification',
    'Deliverables',
    'Implementation plan',
    'Evidence',
    'Blocker / Failure reason',
  ],
  openQuestion: ['Context', 'Decision needed'],
  principle: ['Rule', 'Rationale', 'Applies to', 'Exceptions / approved deviation'],
  semanticReview: ['Scope checked', 'Findings', 'Verdict rationale'],
  audit: ['Sources checked', 'Actual state', 'Drift / findings', 'Evidence', 'Corrective actions'],
  release: [
    'Requirements / scope',
    'Verification gates',
    'Security / migrations / compatibility',
    'Unresolved blockers',
    'Evidence',
  ],
  skillSearch: [
    'Search strategy',
    'Ranking criteria',
    'Candidates',
    'Rejected / notable alternatives',
    'Next command',
  ],
} as const);

export const TEMPLATE_CONTRACTS = Object.freeze({
  requirement: {
    file: 'TEMPLATE.md',
    schema: 1,
    id: 'REQ-NNN',
    sections: REQUIRED_SECTIONS.requirement,
  },
  adr: {
    file: 'TEMPLATE.md',
    schema: 1,
    id: 'ADR-NNN',
    sections: REQUIRED_SECTIONS.adr,
  },
  step: {
    file: 'TEMPLATE.md',
    schema: 1,
    id: 'STEP-NNN',
    sections: REQUIRED_SECTIONS.step,
  },
  openQuestion: {
    file: 'TEMPLATE.md',
    schema: 1,
    id: 'OQ-NNN',
    sections: ['Context', 'Decision needed', 'Resolution'],
  },
  principle: {
    file: 'TEMPLATE.md',
    schema: 1,
    id: 'PRN-NNN',
    sections: REQUIRED_SECTIONS.principle,
  },
} as const);

export const DURABLE_REPORT_PREFIX = Object.freeze({
  step_review: 'REVIEW-',
  planning_review: 'PLAN-REVIEW-',
  init_review: 'INIT-REVIEW-',
  audit: 'AUDIT-',
  release_check: 'RELEASE-',
  skill_search: 'SKILL-SEARCH-',
} as const);
