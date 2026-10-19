import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { env } from "./env";

export function createApp() {
  const app = new Hono();

  if (env.NODE_ENV !== "test") app.use(logger());
  app.use(secureHeaders());

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Mount feature routers here, e.g. app.route("/todos", todoRoutes);

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.res ?? c.json({ error: err.message }, err.status);
    if (err instanceof ZodError) return c.json({ error: "Invalid request", issues: err.issues }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "Invalid JSON body" }, 400);
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}

export const app = createApp();
