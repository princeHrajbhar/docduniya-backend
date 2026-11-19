import type { Request, Response, NextFunction } from 'express';
import type { ZodType } from 'zod';

type Schemas = { body?: ZodType; query?: ZodType; params?: ZodType };

/** Validates request parts against Zod schemas. Errors are forwarded to the error handler. */
export const validate =
  (schemas: Schemas) => (req: Request, _res: Response, next: NextFunction) => {
    if (schemas.body) req.body = schemas.body.parse(req.body);
    if (schemas.params) Object.assign(req.params, schemas.params.parse(req.params));
    if (schemas.query) {
      // Express 5 exposes req.query as a getter, so redefine it with the parsed value
      Object.defineProperty(req, 'query', {
        value: schemas.query.parse(req.query),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    next();
  };
