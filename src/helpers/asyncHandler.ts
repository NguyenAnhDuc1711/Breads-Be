import { Request, Response, NextFunction, RequestHandler } from "express";

const asyncHandler = (func: RequestHandler): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(func(req, res, next)).catch(next);
  };
};

export default asyncHandler;
