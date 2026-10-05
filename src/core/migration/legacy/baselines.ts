import { legacyBaselineBlobSha1Part1 } from './baseline-0.10.4-hashes-1.js';
import { legacyBaselineBlobSha1Part2 } from './baseline-0.10.4-hashes-2.js';
import { legacyBaselineBlobSha1Part3 } from './baseline-0.10.4-hashes-3.js';
import { legacyBaselineBlobSha1Part4 } from './baseline-0.10.4-hashes-4.js';
import { legacyBaselineBlobSha1Part5 } from './baseline-0.10.4-hashes-5.js';
import { legacyBaselineBlobSha1Part6 } from './baseline-0.10.4-hashes-6.js';
import { legacyBaselineBlobSha1Part7 } from './baseline-0.10.4-hashes-7.js';
import { legacyBaselineBlobSha1Part8 } from './baseline-0.10.4-hashes-8.js';
import { legacyBaselineBlobSha1Part9 } from './baseline-0.10.4-hashes-9.js';
import { legacyBaselineBlobSha1Part10 } from './baseline-0.10.4-hashes-10.js';
import { legacyBaselineBlobSha1Part11 } from './baseline-0.10.4-hashes-11.js';
import { legacyBaselineBlobSha1Part12 } from './baseline-0.10.4-hashes-12.js';
import { legacyBaselineBlobSha1Part13 } from './baseline-0.10.4-hashes-13.js';
import { legacyBaselineBlobSha1Part14 } from './baseline-0.10.4-hashes-14.js';
import { legacyBaselineBlobSha1Part15 } from './baseline-0.10.4-hashes-15.js';
import { legacyBaselineBlobSha1Part16 } from './baseline-0.10.4-hashes-16.js';

export interface LegacyBaselineDescriptor {
  release: string;
  source: {
    repository: string;
    ref: string;
    commit: string;
  };
  ownership: {
    harnessOwned: readonly string[];
    shared: readonly string[];
    markerMerge: readonly string[];
  };
  baselineBlobSha1: Readonly<Record<string, string>>;
}

const harnessOwned = [
  '.harness/harness-update-graph.json',
  '.harness/command-transitions.json',
  '.harness/reasoning-boundaries.json',
  '.harness/runtime-adapter-contract.json',
  '.agents/skills/README.md',
  '.agents/skills/init-project/**',
  '.agents/skills/add-plan-step/**',
  '.agents/skills/find-skill/**',
  '.agents/skills/install-skill/**',
  '.agents/skills/create-skill/**',
  '.agents/skills/plan-step/**',
  '.agents/skills/implement-step/**',
  '.agents/skills/review-step/**',
  '.agents/skills/fix-step/**',
  '.agents/skills/run-step/**',
  '.agents/skills/audit-step/**',
  '.agents/skills/project-status/**',
  '.agents/skills/reconcile-project/**',
  '.agents/skills/release-check/**',
  '.agents/skills/requirements-review/**',
  '.agents/skills/architecture-change/**',
  '.agents/skills/documentation-sync/**',
  '.agents/skills/code-review/**',
  '.agents/skills/security-review/**',
  '.agents/skills/write-tests/**',
  '.agents/skills/git-workflow/**',
  '.agents/skills/quick-fix/**',
  '.agents/skills/generate-github-templates/**',
  '.agents/skills/update-harness/**',
  '.codex/README.md',
  '.claude/README.md',
  '.harness/README.md',
  '.harness/harness-policy.toml',
  '.harness/harness-update.toml',
  '.harness/docs/**',
  'planning/harness-updates/README.md',
  '.harness/tools/**',
] as const;

const shared = [
  '.codex/config.toml',
  '.codex/agents/**',
  'CLAUDE.md',
  '.claude/settings.json',
  '.claude/agents/**',
  '.github/**',
  '.gitignore',
  '.gitmessage',
  '.harness/git-policy.toml',
  '.harness/manifest.yaml',
  'AGENTS.local.example.md',
  'PROJECT_BRIEF.example.md',
] as const;

const markerMerge = ['AGENTS.md', 'README.md'] as const;

export const legacyBaseline0104: LegacyBaselineDescriptor = {
  release: '0.10.4',
  source: {
    repository: 'ai-development-harness/ai-development-harness-template',
    ref: 'v0.10.4',
    commit: '6832c41ad6a0cae4fceffbadf7a4258a441d1001',
  },
  ownership: { harnessOwned, shared, markerMerge },
  baselineBlobSha1: {
    ...legacyBaselineBlobSha1Part1,
    ...legacyBaselineBlobSha1Part2,
    ...legacyBaselineBlobSha1Part3,
    ...legacyBaselineBlobSha1Part4,
    ...legacyBaselineBlobSha1Part5,
    ...legacyBaselineBlobSha1Part6,
    ...legacyBaselineBlobSha1Part7,
    ...legacyBaselineBlobSha1Part8,
    ...legacyBaselineBlobSha1Part9,
    ...legacyBaselineBlobSha1Part10,
    ...legacyBaselineBlobSha1Part11,
    ...legacyBaselineBlobSha1Part12,
    ...legacyBaselineBlobSha1Part13,
    ...legacyBaselineBlobSha1Part14,
    ...legacyBaselineBlobSha1Part15,
    ...legacyBaselineBlobSha1Part16,
  },
};

const BASELINES: Readonly<Record<string, LegacyBaselineDescriptor>> = {
  [legacyBaseline0104.release]: legacyBaseline0104,
};

export function getLegacyBaselineDescriptor(release: string): LegacyBaselineDescriptor | null {
  return BASELINES[release] ?? null;
}

export function supportedLegacyReleases(): string[] {
  return Object.keys(BASELINES).sort();
}
