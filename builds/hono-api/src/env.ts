import { z } from "zod";

// Load .env when present (Node >= 20.12). Real environment variables win.
try {
  process.loadEnvFile();
} catch {
  // No .env file: fine.
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
});

/** Validated environment. Add new variables to the schema above. */
export const env = schema.parse(process.env);
