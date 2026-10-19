Apply the middleware where routes are mounted (`src/app.ts` in `tneemo/hono-api`):

```ts
import { rateLimit } from "./middleware/rate-limit";

// Everything: 100 requests per minute per IP.
app.use(rateLimit({ limit: 100, windowMs: 60_000 }));

// Stricter limit for login and signup (before app.route("/auth", ...)).
app.use("/auth/*", rateLimit({ limit: 10, windowMs: 15 * 60_000 }));
```

Register middleware before the routes it should protect. To limit per signed-in user instead of per IP, pass `key: (c) => String(c.get("user")?.id ?? "anon")` and apply it after the auth middleware.
