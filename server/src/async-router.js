import { Router } from "express";

// O Express 4 não pega erro de função async: a requisição ficava pendurada
// sem resposta quando o Supabase falhava no meio de uma rota (auditoria M5).
// Este Router passa a promessa rejeitada para o handler de erro (app.js),
// que responde 500.
const wrap = (fn) =>
  typeof fn !== "function" || fn.length === 4
    ? fn
    : function asyncSafe(req, res, next) {
        try {
          const out = fn(req, res, next);
          if (out && typeof out.catch === "function") out.catch(next);
        } catch (e) {
          next(e);
        }
      };

export function asyncRouter() {
  const router = Router();
  for (const method of ["get", "post", "put", "patch", "delete", "all", "use"]) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
  return router;
}
