import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../errors/domain-error';
import { ErrorCode } from '../errors/error-codes';
import { isUniqueViolation, violatedConstraintName } from '../errors/prisma-error';

interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * The single place that turns a thrown value into an HTTP response.
 *
 * Everything the client sees goes through here, which is what keeps the error envelope
 * consistent and stops a raw database error — index names, column names, SQL — from
 * reaching a browser.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body, logAsError } = this.translate(exception);

    if (logAsError) {
      // Unexpected failures are logged with the stack; expected ones are not, so the log
      // stays a signal rather than a stream of 404s.
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    response.status(status).json(body);
  }

  private translate(exception: unknown): {
    status: number;
    body: ErrorBody;
    logAsError: boolean;
  } {
    if (exception instanceof DomainError) {
      return {
        status: exception.status,
        body: {
          error: { code: exception.code, message: exception.message, details: exception.details },
        },
        logAsError: false,
      };
    }

    if (isUniqueViolation(exception)) {
      // Reaching here means a code path let a constraint violation escape instead of
      // translating it. That is a bug in that path, so it is logged, but the client still
      // gets a sane conflict rather than a 500.
      this.logger.warn(`Untranslated unique violation: ${violatedConstraintName(exception)}`);
      return {
        status: HttpStatus.CONFLICT,
        body: { error: { code: ErrorCode.NAME_CONFLICT, message: 'That item already exists' } },
        logAsError: false,
      };
    }

    if (exception instanceof HttpException) {
      return this.translateHttpException(exception);
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: ErrorCode.INTERNAL, message: 'Unexpected server error' } },
      logAsError: true,
    };
  }

  /**
   * Nest's own exceptions (validation pipe, throttler, guards) arrive as HttpException.
   * They are re-shaped into the same envelope, and validation messages are preserved
   * because the frontend maps them onto form fields.
   */
  private translateHttpException(exception: HttpException): {
    status: number;
    body: ErrorBody;
    logAsError: boolean;
  } {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const messages =
      typeof payload === 'object' && payload !== null && 'message' in payload
        ? (payload as { message: string | string[] }).message
        : exception.message;

    const codeByStatus: Partial<Record<number, ErrorCode>> = {
      [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
      [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
      [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
      [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
      [HttpStatus.CONFLICT]: ErrorCode.NAME_CONFLICT,
      [HttpStatus.GONE]: ErrorCode.GONE,
      [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.FILE_TOO_LARGE,
      [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.VALIDATION_FAILED,
      [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
    };

    return {
      status,
      body: {
        error: {
          code: codeByStatus[status] ?? ErrorCode.INTERNAL,
          message: Array.isArray(messages) ? messages.join('; ') : messages,
          details: Array.isArray(messages) ? { fieldErrors: messages } : undefined,
        },
      },
      logAsError: status >= HttpStatus.INTERNAL_SERVER_ERROR,
    };
  }
}
