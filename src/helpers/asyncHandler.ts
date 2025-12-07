import { NextFunction } from "express";

const asyncHandler = (func) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(func(req, res, next)).catch(next);
  };
};

export default asyncHandler;
