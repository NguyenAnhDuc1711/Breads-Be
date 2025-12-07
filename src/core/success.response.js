import httpStatusCode from "../utils/httpStatusCode.ts";
const { STATUS_CODES, REASON_PHRASES } = httpStatusCode;

class SuccessResponse {
  constructor({
    message,
    statusCode = STATUS_CODES.OK,
    reasonStatusCode = REASON_PHRASES.OK,
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
    statusCode = STATUS_CODES.CREATED,
    reasonStatusCode = REASON_PHRASES.CREATED,
    metadata,
  }) {
    super({ message, statusCode, reasonStatusCode, metadata });
  }
}

export { SuccessResponse, OK, CREATED };
