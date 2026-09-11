import { ZodError } from 'zod';
import type { AppError } from '../../shared/api';

export function redact(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, (match: string, protocol: string, userInfo: string) =>
      protocol.toLowerCase() === 'ssh://' && !userInfo.includes(':') ? match : `${protocol}[redacted]@`)
    .replace(/([?&](?:access_token|token|password|passwd|secret|key|auth|signature)=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1[redacted]');
}

export class GitError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(redact(message));
    this.name = 'GitError';
    this.code = code;
    this.detail = detail ? redact(detail) : undefined;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof ZodError) {
    return { code: 'INVALID_INPUT', message: 'The request contains invalid input.', detail: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n') };
  }
  if (error instanceof GitError) return { code: error.code, message: error.message, detail: error.detail };
  if (error instanceof Error) {
    return { code: 'OPERATION_FAILED', message: redact(error.message) };
  }
  return { code: 'OPERATION_FAILED', message: 'The operation failed. Refresh the repository and try again.' };
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function requireConfirmation(confirmed: boolean | undefined): void {
  if (confirmed !== true) throw new GitError('CONFIRMATION_REQUIRED', 'Confirm this operation before continuing.');
}
