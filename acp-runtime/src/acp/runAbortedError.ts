export class RunAbortedError extends Error {
  readonly name = 'RunAbortedError';

  constructor(message = 'Run aborted.') {
    super(message);
  }
}

export function isRunAbortedError(error: unknown): error is RunAbortedError {
  return error instanceof RunAbortedError
    || (error instanceof Error && error.name === 'RunAbortedError');
}
