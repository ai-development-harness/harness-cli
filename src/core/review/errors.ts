export class ReviewCoreError extends Error {
  constructor(
    readonly code:
      | 'VERIFICATION_INVALID'
      | 'VERIFICATION_EXECUTION_FAILED'
      | 'REVIEW_CONTRACT_INVALID'
      | 'REVIEW_STALE_BASIS'
      | 'REVIEW_EXPECTATION_MISSING'
      | 'REVIEW_EXECUTION_MISMATCH'
      | 'COMPLETION_CONTRACT_INVALID'
      | 'COMPLETION_PROOF_INCOMPLETE'
      | 'SEMANTIC_PAYLOAD_INVALID'
      | 'PROGRESS_GUARD_BLOCKED',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ReviewCoreError';
  }
}
