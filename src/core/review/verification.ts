import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArtifactDocument } from '../artifacts/index.js';
import { readConfig } from '../config.js';
import { resolvePortablePathWithinBoundary } from '../path-boundary.js';
import { stableHash } from '../planning/hash.js';
import { ReviewCoreError } from './errors.js';
import { atomicWriteText, replaceH2Section } from './document-write.js';
import { repositoryRevision } from './revision.js';
import type {
  RepositoryRevision,
  VerificationEntry,
  VerificationFreshness,
  VerificationStatus,
} from './types.js';

const execFileAsync = promisify(execFile);
const EVIDENCE_START = '<!-- VERIFICATION-EVIDENCE:START -->';
const EVIDENCE_END = '<!-- VERIFICATION-EVIDENCE:END -->';
const CONTROL_TOKENS = new Set(['|', '||', '&&', ';', '<', '>', '>>', '2>', '2>>', '&']);
const CAPTURE_TAIL_BYTES = 64 * 1024;

async function stepPath(projectRoot: string, stepId: string): Promise<string> {
  const config = await readConfig(projectRoot);
  const directory = await resolvePortablePathWithinBoundary(
    projectRoot,
    config.protocol.taskDirectory,
    'protocol.taskDirectory',
  );
  return path.join(directory, stepId + '.md');
}

export function parseArgv(command: string): string[] {
  const input = command.trim();
  if (!input) throw new ReviewCoreError('VERIFICATION_INVALID', 'verification command is empty');
  const argv: string[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  const push = () => {
    if (!started) return;
    argv.push(token);
    token = '';
    started = false;
  };

  for (const char of input) {
    if (escaped) {
      token += char;
      started = true;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    token += char;
    started = true;
  }
  if (escaped || quote !== null) {
    throw new ReviewCoreError('VERIFICATION_INVALID', 'verification command contains unterminated quote or escape');
  }
  push();
  if (argv.length === 0) throw new ReviewCoreError('VERIFICATION_INVALID', 'verification command is empty');
  const controls = argv.filter((item) => CONTROL_TOKENS.has(item));
  if (controls.length > 0) {
    throw new ReviewCoreError(
      'VERIFICATION_INVALID',
      'shell control operators are not supported; move complex logic into a repository script: ' + [...new Set(controls)].sort().join(', '),
    );
  }
  return argv;
}

export function validateVerificationEntries(value: unknown): VerificationEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReviewCoreError('VERIFICATION_INVALID', 'verification must be a non-empty array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ReviewCoreError('VERIFICATION_INVALID', 'verification[' + index + '] must be an object');
    }
    const item = entry as Record<string, unknown>;
    const unknown = Object.keys(item).filter((key) => !['kind', 'value'].includes(key));
    if (unknown.length > 0) {
      throw new ReviewCoreError('VERIFICATION_INVALID', 'verification[' + index + '] has unsupported keys: ' + unknown.sort().join(', '));
    }
    if (item.kind !== 'command' && item.kind !== 'manual') {
      throw new ReviewCoreError('VERIFICATION_INVALID', 'verification[' + index + '].kind must be command or manual');
    }
    if (typeof item.value !== 'string' || item.value.trim().length === 0) {
      throw new ReviewCoreError('VERIFICATION_INVALID', 'verification[' + index + '].value must be non-empty');
    }
    const normalized: VerificationEntry = { kind: item.kind, value: item.value.trim() };
    if (normalized.kind === 'command') parseArgv(normalized.value);
    return normalized;
  });
}

export async function parseVerification(
  projectRoot: string,
  stepId: string,
): Promise<VerificationEntry[]> {
  const document = await parseArtifactDocument(await stepPath(projectRoot, stepId));
  const section = document.sections['Verification'] ?? '';
  const entries: VerificationEntry[] = [];
  const errors: string[] = [];
  for (const [index, raw] of section.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const command = /^- command:\s*`([^`]+)`\s*$/.exec(line);
    if (command) {
      entries.push({ kind: 'command', value: command[1].trim() });
      continue;
    }
    const manual = /^- manual:\s*(.+?)\s*$/.exec(line);
    if (manual) {
      entries.push({ kind: 'manual', value: manual[1].trim() });
      continue;
    }
    errors.push('line ' + (index + 1) + ': unsupported Verification entry; use explicit command or manual format');
  }
  if (errors.length > 0) throw new ReviewCoreError('VERIFICATION_INVALID', errors.join('; '));
  return validateVerificationEntries(entries);
}

export function renderVerificationEntries(entries: readonly VerificationEntry[]): string {
  return validateVerificationEntries(entries).map((entry) =>
    entry.kind === 'command'
      ? '- command: ' + String.fromCharCode(96) + entry.value + String.fromCharCode(96)
      : '- manual: ' + entry.value
  ).join('\n');
}

export async function verificationContractBasis(projectRoot: string, stepId: string): Promise<string> {
  return stableHash(await parseVerification(projectRoot, stepId));
}

export async function verificationSubjectRevision(projectRoot: string, stepId: string): Promise<RepositoryRevision> {
  const task = await stepPath(projectRoot, stepId);
  const rel = path.relative(projectRoot, task).split(path.sep).join('/');
  return repositoryRevision(projectRoot, { ignoredPaths: new Set([rel]) });
}

function tail(buffer: Buffer): string | null {
  if (buffer.length === 0) return null;
  const text = buffer.subarray(Math.max(0, buffer.length - CAPTURE_TAIL_BYTES)).toString('utf8').trim();
  return text ? text.slice(-800) : null;
}

interface StreamState {
  hash: ReturnType<typeof createHash>;
  bytes: number;
  tail: Buffer;
}

function appendStream(state: StreamState, chunk: Buffer): void {
  state.hash.update(chunk);
  state.bytes += chunk.length;
  state.tail = Buffer.concat([state.tail, chunk]);
  if (state.tail.length > CAPTURE_TAIL_BYTES) state.tail = state.tail.subarray(state.tail.length - CAPTURE_TAIL_BYTES);
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        timeout: 5_000,
      });
    } catch {
      // Process may already have exited.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Process group may already have exited.
  }
}

async function runCommand(
  projectRoot: string,
  command: string,
  timeoutSeconds: number,
): Promise<Readonly<Record<string, unknown>>> {
  const argv = parseArgv(command);
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const stdout: StreamState = { hash: createHash('sha256'), bytes: 0, tail: Buffer.alloc(0) };
    const stderr: StreamState = { hash: createHash('sha256'), bytes: 0, tail: Buffer.alloc(0) };

    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: projectRoot,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        kind: 'command',
        command,
        argv,
        status: 'BLOCKED',
        reasonCode: 'EXECUTABLE_NOT_FOUND',
        message: (error as Error).message,
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => appendStream(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendStream(stderr, chunk));

    const timer = setTimeout(async () => {
      timedOut = true;
      if (child.pid) await killProcessTree(child.pid);
    }, timeoutSeconds * 1000);

    child.on('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        kind: 'command',
        command,
        argv,
        status: 'BLOCKED',
        reasonCode: 'EXECUTABLE_NOT_FOUND',
        message: error.message,
      });
    });

    child.on('close', async (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (process.platform !== 'win32' && child.pid) await killProcessTree(child.pid);
      const result: Record<string, unknown> = {
        kind: 'command',
        command,
        argv,
        durationMs: Date.now() - started,
        stdoutSha256: stdout.hash.digest('hex'),
        stderrSha256: stderr.hash.digest('hex'),
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        exitCode: timedOut ? null : code,
      };
      if (timedOut) {
        result.status = 'FAIL';
        result.reasonCode = 'TIMEOUT';
        result.timeoutSeconds = timeoutSeconds;
        result.stdoutTail = tail(stdout.tail);
        result.stderrTail = tail(stderr.tail);
      } else {
        result.status = code === 0 ? 'PASS' : 'FAIL';
        if (code !== 0) {
          result.stdoutTail = tail(stdout.tail);
          result.stderrTail = tail(stderr.tail);
        }
      }
      resolve(result);
    });
  });
}

function evidenceBlock(result: Readonly<Record<string, any>>): string {
  const revision = result.revision as RepositoryRevision;
  const subject = result.subjectRevision as RepositoryRevision;
  const lines = [
    EVIDENCE_START,
    '- Verification run: ' + String(result.runAt),
    '- Status: ' + String(result.status),
    '- Git head: ' + (revision.gitHead ?? 'none'),
    '- Worktree hash: ' + (revision.worktreeHash ?? 'clean'),
    '- Verification contract basis: ' + String(result.contractBasis),
    '- Subject git head: ' + (subject.gitHead ?? 'none'),
    '- Subject worktree hash: ' + (subject.worktreeHash ?? 'clean'),
    '',
    '### Automated verification',
  ];
  const commands = Array.isArray(result.commands) ? result.commands : [];
  if (commands.length === 0) lines.push('- none');
  for (const item of commands) {
    lines.push(
      '- Command: ' + String(item.command),
      '  - Status: ' + String(item.status),
      '  - Exit code: ' + String(item.exitCode ?? 'none'),
      '  - Duration ms: ' + String(item.durationMs ?? 0),
      '  - stdout sha256: ' + String(item.stdoutSha256 ?? ''),
      '  - stderr sha256: ' + String(item.stderrSha256 ?? ''),
      '  - stdout bytes: ' + String(item.stdoutBytes ?? 0),
      '  - stderr bytes: ' + String(item.stderrBytes ?? 0),
    );
  }
  lines.push('', '### Manual verification');
  const manual = Array.isArray(result.manual) ? result.manual : [];
  const pending = Array.isArray(result.manualPending) ? result.manualPending : [];
  if (manual.length === 0 && pending.length === 0) lines.push('- none');
  for (const item of manual) {
    lines.push(
      '- Check: ' + String(item.check),
      '  - Status: ' + String(item.status),
      '  - Observed: ' + JSON.stringify(item.observed),
    );
  }
  for (const check of pending) lines.push('- Check: ' + String(check), '  - Status: PENDING');
  lines.push(EVIDENCE_END);
  return lines.join('\n');
}

function upsertEvidence(current: string, block: string): string {
  const start = current.indexOf(EVIDENCE_START);
  const end = current.indexOf(EVIDENCE_END);
  if ((start >= 0) !== (end >= 0)) {
    throw new ReviewCoreError('VERIFICATION_INVALID', 'malformed generated verification Evidence markers');
  }
  if (start >= 0) {
    if (end < start) throw new ReviewCoreError('VERIFICATION_INVALID', 'reversed generated verification Evidence markers');
    const before = current.slice(0, start).trim();
    const after = current.slice(end + EVIDENCE_END.length).trim();
    return [before, block, after].filter(Boolean).join('\n\n');
  }
  const semantic = current.trim() === '—' ? '' : current.trim();
  return [block, semantic].filter(Boolean).join('\n\n');
}

export async function writeVerificationEvidence(
  projectRoot: string,
  stepId: string,
  result: Readonly<Record<string, unknown>>,
): Promise<void> {
  const target = await stepPath(projectRoot, stepId);
  const document = await parseArtifactDocument(target);
  const evidence = upsertEvidence(document.sections['Evidence'] ?? '', evidenceBlock(result as any));
  await atomicWriteText(target, replaceH2Section(document.text, 'Evidence', evidence));
}

export async function runStepVerification(
  projectRoot: string,
  stepId: string,
  options: {
    readonly manualResults?: readonly Readonly<{ check: string; status: 'PASS' | 'FAIL'; observed: string }>[];
    readonly writeEvidence?: boolean;
  } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const config = await readConfig(projectRoot);
  const entries = await parseVerification(projectRoot, stepId);
  const before = await repositoryRevision(projectRoot);
  const contractBasis = stableHash(entries);
  const subjectRevision = await verificationSubjectRevision(projectRoot, stepId);

  const commands: Readonly<Record<string, unknown>>[] = [];
  for (const entry of entries) {
    if (entry.kind === 'command') {
      commands.push(await runCommand(projectRoot, entry.value, config.execution.verificationCommandTimeoutSeconds));
    }
  }

  const expectedManual = entries.filter((entry) => entry.kind === 'manual').map((entry) => entry.value);
  const supplied = options.manualResults ?? [];
  const byCheck = new Map<string, Readonly<{ check: string; status: 'PASS' | 'FAIL'; observed: string }>>();
  for (const item of supplied) {
    if (!expectedManual.includes(item.check)) {
      throw new ReviewCoreError('VERIFICATION_INVALID', 'unknown manual verification check: ' + item.check);
    }
    if (byCheck.has(item.check)) {
      throw new ReviewCoreError('VERIFICATION_INVALID', 'duplicate manual verification check: ' + item.check);
    }
    if (!item.observed.trim()) {
      throw new ReviewCoreError('VERIFICATION_INVALID', 'manual verification observed must be non-empty');
    }
    byCheck.set(item.check, { ...item, observed: item.observed.trim() });
  }
  const manual = expectedManual.filter((check) => byCheck.has(check)).map((check) => byCheck.get(check)!);
  const manualPending = expectedManual.filter((check) => !byCheck.has(check));

  const after = await repositoryRevision(projectRoot);
  let status: VerificationStatus = 'PASS';
  let reasonCode: string | null = null;
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    status = 'BLOCKED';
    reasonCode = 'VERIFICATION_MUTATED_REPOSITORY';
  } else if (commands.some((item) => item.status === 'BLOCKED')) {
    status = 'BLOCKED';
    reasonCode = String(commands.find((item) => item.status === 'BLOCKED')?.reasonCode ?? 'VERIFICATION_BLOCKED');
  } else if (commands.some((item) => item.status === 'FAIL') || manual.some((item) => item.status === 'FAIL')) {
    status = 'FAIL';
    reasonCode = 'VERIFICATION_FAILED';
  } else if (manualPending.length > 0) {
    status = 'MANUAL_REQUIRED';
    reasonCode = 'MANUAL_VERIFICATION_REQUIRED';
  }

  const result = {
    schemaVersion: 1,
    stepId,
    status,
    reasonCode,
    runAt: new Date().toISOString(),
    revision: before,
    contractBasis,
    subjectRevision,
    commands,
    manual,
    manualPending,
  };
  if (options.writeEvidence !== false) await writeVerificationEvidence(projectRoot, stepId, result);
  return result;
}

function field(block: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const match = new RegExp('^- ' + escaped + ': (.+?)\\s*$', 'm').exec(block);
  return match?.[1]?.trim() ?? null;
}

export async function verificationFreshness(
  projectRoot: string,
  stepId: string,
): Promise<VerificationFreshness> {
  const document = await parseArtifactDocument(await stepPath(projectRoot, stepId));
  const evidence = document.sections['Evidence'] ?? '';
  const start = evidence.indexOf(EVIDENCE_START);
  const end = evidence.indexOf(EVIDENCE_END);
  if (start < 0 || end < 0 || end < start) {
    return { status: 'MISSING', fresh: false, reasonCode: 'VERIFICATION_EVIDENCE_MISSING' };
  }
  const block = evidence.slice(start + EVIDENCE_START.length, end);
  const status = (field(block, 'Status') ?? 'UNKNOWN') as VerificationStatus;
  const storedContractBasis = field(block, 'Verification contract basis');
  const storedHead = field(block, 'Subject git head');
  const storedWorktree = field(block, 'Subject worktree hash');
  if (!storedContractBasis || storedHead === null || storedWorktree === null) {
    return { status, fresh: false, reasonCode: 'VERIFICATION_FRESHNESS_UNKNOWN' };
  }

  const currentContractBasis = await verificationContractBasis(projectRoot, stepId);
  const currentSubjectRevision = await verificationSubjectRevision(projectRoot, stepId);
  const storedSubjectRevision: RepositoryRevision = {
    gitHead: storedHead === 'none' ? null : storedHead,
    worktreeHash: storedWorktree === 'clean' ? null : storedWorktree,
  };
  if (storedContractBasis !== currentContractBasis) {
    return {
      status,
      fresh: false,
      reasonCode: 'VERIFICATION_CONTRACT_STALE',
      storedContractBasis,
      currentContractBasis,
    };
  }
  if (JSON.stringify(storedSubjectRevision) !== JSON.stringify(currentSubjectRevision)) {
    return {
      status,
      fresh: false,
      reasonCode: 'VERIFICATION_SUBJECT_STALE',
      storedSubjectRevision,
      currentSubjectRevision,
    };
  }
  return {
    status,
    fresh: status === 'PASS',
    reasonCode: status === 'PASS' ? null : 'VERIFICATION_NOT_PASS',
    contractBasis: currentContractBasis,
    subjectRevision: currentSubjectRevision,
  };
}

export async function verificationBasis(projectRoot: string, stepId: string): Promise<string> {
  const freshness = await verificationFreshness(projectRoot, stepId);
  return stableHash({
    status: freshness.status,
    fresh: freshness.fresh,
    reasonCode: freshness.reasonCode,
    contractBasis: freshness.contractBasis ?? freshness.currentContractBasis ?? freshness.storedContractBasis ?? null,
    subjectRevision: freshness.subjectRevision ?? freshness.currentSubjectRevision ?? freshness.storedSubjectRevision ?? null,
  });
}
