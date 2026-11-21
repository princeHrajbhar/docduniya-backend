export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
    /** Stable machine-readable error code returned to clients. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message = 'Bad Request', details?: unknown) {
    return new ApiError(400, message, details, 'BAD_REQUEST');
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message, undefined, 'UNAUTHORIZED');
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(403, message, undefined, 'FORBIDDEN');
  }

  static notFound(message = 'Not Found') {
    return new ApiError(404, message, undefined, 'NOT_FOUND');
  }
}
