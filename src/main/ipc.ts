import { z } from 'zod';
import type { AppError, CommandArgs, CommandData, CommandHandlers, CommandName, Result } from '../shared/api';
import { commandNames, parseCommandArgs } from '../shared/validation';

export function safeMessage(message: string): string {
  return message
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:access_token|token|password|key)=)[^&\s]+/gi, '$1[redacted]');
}

export function appError(error: unknown): AppError {
  if (error instanceof z.ZodError) {
    return { code: 'INVALID_INPUT', message: 'The request contains invalid input.', detail: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n') };
  }
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'OPERATION_FAILED';
    const detail = 'detail' in error && typeof error.detail === 'string' ? error.detail : undefined;
    return { code, message: safeMessage(error.message), detail: detail ? safeMessage(detail) : undefined };
  }
  return { code: 'OPERATION_FAILED', message: 'The operation failed with an unexpected error. Try refreshing the repository.' };
}

export function trustedSender(url: string, documentUrl: string, devUrl?: string): boolean {
  try {
    const sender = new URL(url);
    const expected = new URL(devUrl ?? documentUrl);
    return sender.protocol === expected.protocol && sender.host === expected.host && sender.pathname === expected.pathname && !sender.search && !sender.hash;
  } catch {
    return false;
  }
}

export async function runCommand<K extends CommandName>(
  handlers: Pick<CommandHandlers, K>,
  command: K,
  input: unknown,
): Promise<Result<CommandData<K>>> {
  try {
    const args: CommandArgs<K> = parseCommandArgs(command, input);
    const data = await handlers[command](args);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: appError(error) };
  }
}

export { commandNames };
