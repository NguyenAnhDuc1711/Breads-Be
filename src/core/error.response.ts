import httpStatusCode from "../utils/httpStatusCode.ts";
const { STATUS_CODES, REASON_PHRASES } = httpStatusCode;

class ErrorResponse extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class ConflictRequestError extends ErrorResponse {
  constructor(
    message = REASON_PHRASES.CONFLICT,
    statusCode = STATUS_CODES.CONFLICT
  ) {
    super(message, statusCode);
  }
}

class BadRequestError extends ErrorResponse {
  constructor(
    message = REASON_PHRASES.BAD_REQUEST,
    statusCode = STATUS_CODES.BAD_REQUEST
  ) {
    super(message, statusCode);
  }
}

class AuthFailureError extends ErrorResponse {
  constructor(
    message = REASON_PHRASES.UNAUTHORIZED,
    statusCode = STATUS_CODES.UNAUTHORIZED
  ) {
    super(message, statusCode);
  }
}

class NotFoundError extends ErrorResponse {
  constructor(
    message = REASON_PHRASES.NOT_FOUND,
    statusCode = STATUS_CODES.NOT_FOUND
  ) {
    super(message, statusCode);
  }
}

class ForbiddenError extends ErrorResponse {
  constructor(
    message = REASON_PHRASES.FORBIDDEN,
    statusCode = STATUS_CODES.FORBIDDEN
  ) {
    super(message, statusCode);
  }
}

class RedisErrorResponse extends ErrorResponse {
  constructor(
    message = REDIS_CONNECT_MESSAGE,
    statusCode = STATUS_CODES.INTERNAL_SERVER_ERROR
  ) {
    super(message, statusCode);
  }
}

export {
  ErrorResponse,
  ConflictRequestError,
  BadRequestError,
  AuthFailureError,
  NotFoundError,
  ForbiddenError,
  RedisErrorResponse,
};
