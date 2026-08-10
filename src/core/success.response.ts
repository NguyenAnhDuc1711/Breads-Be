import HTTPStatus from "../utils/httpStatus.ts";

class SuccessResponse {
  constructor({
    message,
    statusCode = HTTPStatus.OK,
    reasonStatusCode = "OK",
    metadata = {},
  }) {
    this.statusCode = statusCode;
    this.message = message || reasonStatusCode;
    this.metadata = metadata;
    this.reasonStatusCode = reasonStatusCode;
  }

  send(res, headers = {}) {
    return res.status(this.statusCode).json(this);
  }
}

class OK extends SuccessResponse {
  constructor({ message, metadata }) {
    super({ message, metadata });
  }
}

class CREATED extends SuccessResponse {
  constructor({
    message,
    statusCode = HTTPStatus.CREATED,
    reasonStatusCode = "Created",
    metadata,
  }) {
    super({ message, statusCode, reasonStatusCode, metadata });
  }
}

export { SuccessResponse, OK, CREATED };
