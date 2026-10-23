/**
 * Express 4 does not catch errors from async route handlers: an exception
 * thrown (or a promise rejected) outside the handler's own try/catch never
 * reaches the error handler. The request hangs, and Node treats the
 * unhandled rejection as fatal — one malformed request to POST
 * /washes/:id/resolve-dispute was enough to take the whole API down.
 *
 * This patches Express's route layer so a handler's returned promise is
 * caught and passed to next(err), the same thing Express already does for a
 * synchronous throw. Behaviour is otherwise identical to the original
 * Layer.handle_request. Imported once, first thing, in app.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Layer = require('express/lib/router/layer');

Layer.prototype.handle_request = function handleRequest(req: any, res: any, next: (err?: any) => void) {
  const fn = this.handle;
  // Error-handling middleware (4 arguments) is skipped in the normal flow,
  // exactly as the original does.
  if (fn.length > 3) return next();
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};

export {};
