# Uktio Backend

Express API backend for the Uktio app — handles auth, profile, chat-history
sync, and AI-generated session reports. Database is Supabase
(Postgres + Auth + Row Level Security).

## Architecture, in short

- **Auth**: Supabase handles signup/login/Google sign-in. The frontend
  gets a Supabase access token and sends it as `Authorization: Bearer
  <token>` on every request. `middleware/authMiddleware.js` verifies it
  against Supabase and attaches `req.user`.
- **Database access**: two Supabase clients (`lib/supabaseClient.js`) —
  `supabaseAnon` (used only to verify user tokens) and `supabaseAdmin`
  (service-role, bypasses RLS, used for all actual reads/writes — every
  route still explicitly filters by `req.user.id`, so RLS + explicit
  filtering are both defense layers, not just one).
- **Voice chat**: real-time voice happens **directly between the user's
  device and Google Gemini** (BYOK — the user brings their own Gemini API
  key, entered in Settings). This backend never sees or proxies that
  audio traffic — it only receives the finished transcript once a
  session ends (`POST /chat/sessions`), and generates the post-session
  report via OpenAI (`POST /chat/sessions/:id/analyze`).
- **Rate limiting**: in-memory by default (fine for a single server
  instance). If you ever run 2+ instances behind a load balancer, set
  `REDIS_URL` — see `.env.example` and `middleware/rateLimiter.js`.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create a Supabase project** (if you don't have one) at
   [supabase.com](https://supabase.com), then run the schema:
   - Open Supabase Dashboard → SQL Editor
   - Paste the entire contents of `sql/schema.sql` and run it
   - This file is safe to re-run any time (e.g. after pulling a schema
     update) — every statement is idempotent (`if not exists`,
     drop-then-create for policies/constraints).

3. **Set environment variables** — copy `.env.example` to `.env` and
   fill in:
   - `SUPABASE_URL` / `SUPABASE_ANON_KEY` — Project Settings → API
   - `SUPABASE_SERVICE_ROLE_KEY` — same page, "service_role" secret.
     **Never** put this in the frontend/app, server-only.
   - `OPENAI_API_KEY` — the backend's own key, used only for the
     post-session analysis report (separate from the user's own Gemini
     key, which never touches this backend).
   - Everything else in `.env.example` is optional and documented
     inline (Sentry DSN, `ALLOWED_ORIGINS`, `REDIS_URL`, etc.)

4. **Run it**
   ```bash
   npm start          # or: npm run dev — both just run node index.js
   ```
   Confirm it's up: `curl http://localhost:3000/health`

5. **Run the tests**
   ```bash
   npm test
   ```

## Project layout

```
index.js                    App entry point — Express setup, middleware, mounts routes
lib/supabaseClient.js       The two Supabase clients (anon + admin)
middleware/
  authMiddleware.js          Verifies Bearer token -> req.user
  errorHandler.js            Centralized error responses (see note below)
  rateLimiter.js              generalLimiter / authLimiter / writeLimiter
routes/
  authRoutes.js               Signup/login/Google auth
  userRoutes.js                Profile CRUD, onboarding
  chatRoutes.js                 Session sync, report generation, report retrieval
sql/schema.sql               Full DB schema — run in Supabase SQL Editor
test/                          Unit tests (node:test, no DB/network needed)
```

## A couple of things worth knowing before you deploy

- **5xx error responses are intentionally generic** (`errorHandler.js`)
  — the real error (which might contain internal DB details) only goes
  to server logs/Sentry, never to the client. 4xx errors (like a CORS
  rejection or a validation message) still return their real message,
  since those are written to be safe and useful for the client.
- **`MIN_TURNS_FOR_ANALYSIS = 10`** is duplicated in three places
  (this backend's `chatRoutes.js`, and the frontend's `chat.html` +
  `history.html`) because the frontend is static files with no shared
  build step with the backend. If you ever tune this number, grep for
  `MIN_TURNS_FOR_ANALYSIS` across both repos and update all three.
- **Rate limiting is per-instance by default.** Fine up to one server.
  If you deploy a second instance, set `REDIS_URL` (see
  `.env.example`) so both instances share the same counters — otherwise
  an attacker effectively gets `max × instance count` requests through.


everything is good at this level - GOAT 1.1.1