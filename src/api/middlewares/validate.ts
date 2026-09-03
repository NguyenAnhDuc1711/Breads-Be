import { ZodError, type ZodSchema } from "zod";
import { BadRequestError } from "../../core/error.response.ts";
import logger from "../../core/logger.ts";

export const VALIDATION_ERROR_MESSAGE = "Invalid request payload";

type ValidateSchema = {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
};

export const validate = (schema: ValidateSchema) => (req, _res, next) => {
  try {
    if (schema.body) req.body = schema.body.parse(req.body);
    if (schema.query) req.query = schema.query.parse(req.query);
    if (schema.params) req.params = schema.params.parse(req.params);
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      logger.warn(
        { issues: err.issues, path: req.path },
        "payload validation failed"
      );
      return next(new BadRequestError(VALIDATION_ERROR_MESSAGE));
    }
    next(err);
  }
};
