export type ServiceErrorStatus = 401 | 400 | 403 | 404 | 409 | 503;

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: ServiceErrorStatus
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export class UnauthorizedError extends ServiceError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ValidationError extends ServiceError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'ValidationError';
  }
}

export class ForbiddenError extends ServiceError {
  constructor(message: string) {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends ServiceError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class IdempotencyConflictError extends ServiceError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'IdempotencyConflictError';
  }
}

export class IntegrityConflictError extends ServiceError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'IntegrityConflictError';
  }
}

export class RetryableMutationError extends ServiceError {
  constructor(message: string) {
    super(message, 503);
    this.name = 'RetryableMutationError';
  }
}
