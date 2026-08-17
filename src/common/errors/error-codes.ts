/**
 * The full set of error codes the API can return. The frontend maps each one to a
 * specific interaction — a dialog, a field error, a screen — so an unmapped code shows up
 * as a generic "something went wrong", which is exactly the experience this list exists to
 * avoid. Adding a code means adding its handling on both sides.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Access exists but the role does not permit the action. Never used to hide existence. */
  FORBIDDEN: 'FORBIDDEN',
  /** Also returned for resources the caller may not see at all — see access resolution. */
  NOT_FOUND: 'NOT_FOUND',
  GONE: 'GONE',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  /** Deliberately does not distinguish "no such user" from "wrong password". */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  NAME_CONFLICT: 'NAME_CONFLICT',
  INVALID_MOVE_TARGET: 'INVALID_MOVE_TARGET',
  DEPTH_LIMIT_EXCEEDED: 'DEPTH_LIMIT_EXCEEDED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_MIME: 'UNSUPPORTED_MIME',
  UPLOAD_INTENT_EXPIRED: 'UPLOAD_INTENT_EXPIRED',
  UPLOAD_NOT_FINISHED: 'UPLOAD_NOT_FINISHED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
