import HTTPStatus from "../utils/httpStatus.ts";

class ErrorResponse extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

class ConflictRequestError extends ErrorResponse {
  constructor(message = "Conflict", statusCode = HTTPStatus.CONFLICT) {
    super(message, statusCode);
  }
}

class BadRequestError extends ErrorResponse {
  constructor(message = "Bad Request", statusCode = HTTPStatus.BAD_REQUEST) {
    super(message, statusCode);
  }
}

class AuthFailureError extends ErrorResponse {
  constructor(
    message = "Unauthorized",
    statusCode = HTTPStatus.UNAUTHORIZED
  ) {
    super(message, statusCode);
  }
}

class NotFoundError extends ErrorResponse {
  constructor(message = "Not Found", statusCode = HTTPStatus.NOT_FOUND) {
    super(message, statusCode);
  }
}

class ForbiddenError extends ErrorResponse {
  constructor(message = "Forbidden", statusCode = HTTPStatus.FORBIDDEN) {
    super(message, statusCode);
  }
}

class RedisErrorResponse extends ErrorResponse {
  constructor(
    message = REDIS_CONNECT_MESSAGE,
    statusCode = HTTPStatus.SERVER_ERR
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
