import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

/**
 * Errors thrown by services. Services do not know about HTTP — they throw one of these,
 * and a single exception filter decides the status and shape of the response. Two places
 * deciding the status for one code is how a 404 becomes a 403 in half the endpoints.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: HttpStatus,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  static emailTaken(): DomainError {
    return new DomainError(ErrorCode.EMAIL_TAKEN, HttpStatus.CONFLICT, 'Email is already registered');
  }

  static invalidCredentials(): DomainError {
    return new DomainError(
      ErrorCode.INVALID_CREDENTIALS,
      HttpStatus.UNAUTHORIZED,
      'Email or password is incorrect',
    );
  }

  static unauthenticated(message = 'Authentication required'): DomainError {
    return new DomainError(ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, message);
  }

  /**
   * For "you may read this but not change it". Never for hiding existence — that is
   * notFound(), because confirming that a resource exists is itself a leak in a
   * due-diligence product.
   */
  static forbidden(message = 'Read-only access'): DomainError {
    return new DomainError(ErrorCode.FORBIDDEN, HttpStatus.FORBIDDEN, message);
  }

  static notFound(message = 'Not found'): DomainError {
    return new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND, message);
  }

  static gone(message: string): DomainError {
    return new DomainError(ErrorCode.GONE, HttpStatus.GONE, message);
  }

  static nameConflict(name: string, details?: Record<string, unknown>): DomainError {
    return new DomainError(
      ErrorCode.NAME_CONFLICT,
      HttpStatus.CONFLICT,
      `An item named "${name}" already exists in this folder`,
      details,
    );
  }

  static invalidMoveTarget(message: string): DomainError {
    return new DomainError(ErrorCode.INVALID_MOVE_TARGET, HttpStatus.UNPROCESSABLE_ENTITY, message);
  }

  static depthLimitExceeded(limit: number): DomainError {
    return new DomainError(
      ErrorCode.DEPTH_LIMIT_EXCEEDED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Folders cannot be nested more than ${limit} levels deep`,
    );
  }

  static fileTooLarge(maxBytes: number): DomainError {
    return new DomainError(
      ErrorCode.FILE_TOO_LARGE,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Files must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller`,
      { maxBytes },
    );
  }

  static unsupportedMime(mimeType: string): DomainError {
    return new DomainError(
      ErrorCode.UNSUPPORTED_MIME,
      HttpStatus.UNPROCESSABLE_ENTITY,
      `Files of type ${mimeType} cannot be uploaded`,
      { mimeType },
    );
  }

  static uploadIntentExpired(): DomainError {
    return new DomainError(
      ErrorCode.UPLOAD_INTENT_EXPIRED,
      HttpStatus.GONE,
      'This upload expired before it finished; please try again',
    );
  }

  static uploadNotFinished(): DomainError {
    return new DomainError(
      ErrorCode.UPLOAD_NOT_FINISHED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      'The uploaded file is missing or incomplete',
    );
  }
}
