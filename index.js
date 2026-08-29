require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

// Safety net: an awaited async call that rejects without a surrounding
// try/catch becomes an "unhandled rejection" — on Node 15+ that CRASHES
// the whole process by default, taking down every in-flight request
// (including unrelated ones), not just the one that failed. Individual
// routes/handlers should still catch their own errors properly — this is
// only the last
// resort backstop so a missed case degrades to a logged error instead of
// a full outage + Render restart loop.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED PROMISE REJECTION (recovered, not crashing):', reason);
});

// Fail fast with a clear message instead of a confusing crash later.
const requiredEnv = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

// Error monitoring — optional. If SENTRY_DSN isn't set (e.g. local dev),
// this just silently no-ops, so nothing breaks without it.
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    // Privacy: this app handles personal conversation data (and some
    // users are minors) — never send request bodies or user PII to
    // Sentry, only the error itself.
    sendDefaultPii: false,
    dataCollection: { httpBodies: [] }
  });
  console.log('Sentry error monitoring enabled.');
} else {
  console.log('SENTRY_DSN not set — error monitoring disabled (fine for local dev).');
}

const { generalLimiter, authLimiter, writeLimiter } = require('./middleware/rateLimiter');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const chatRoutes = require('./routes/chatRoutes');
const scenarioRoutes = require('./routes/scenarioRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const adminRoutes = require('./routes/adminRoutes');
const announcementRoutes = require('./routes/announcementRoutes');

const app = express();
// Render (and most PaaS hosts) sit in front of this app as a reverse
// proxy, adding an X-Forwarded-For header with the real client IP.
// Without this, Express doesn't trust that header (correctly, by
// default — trusting it blindly would let a client fake their own IP
// on a setup with no proxy in front). Since we know there's exactly one
// trusted proxy hop (Render's edge), `1` tells express-rate-limit to use
// the IP one hop back from itself, i.e. the real client — not the
// proxy's own IP for every single request. Was previously throwing an
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning on every request.
app.set('trust proxy', 1);

// Origins allowed to call this API from a browser/WebView context.
// - Native Android/iOS (Capacitor) requests report their origin as
//   'capacitor://localhost' (Android) / 'ionic://localhost' or
//   'http://localhost' depending on platform — these aren't real
//   websites, just how Capacitor's WebView identifies itself, so they're
//   safe to allow.
// - Add your deployed web origin(s) here once you have one (e.g.
//   'https://app.uktio.com') via the ALLOWED_ORIGINS env var (comma-
//   separated). Anything not listed gets rejected by the browser's CORS
//   check — before this fix, app.use(cors()) with no options meant ANY
//   website could call this API from a visitor's browser using that
//   visitor's own logged-in session (their token, sent from a page you
//   don't control).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'capacitor://localhost,ionic://localhost,http://localhost')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Default helmet CSP is `script-src 'self'` etc — this SILENTLY blocked
// both the checkout page's own script/style tags *and* Razorpay's
// checkout.js SDK (loaded from checkout.razorpay.com), because neither
// matched the default allowlist. Symptom in production: the hosted
// /checkout.html page opened fine (static HTML/CSS painted) but froze
// forever on "Loading your order..." — the JS that fetches the order
// and opens the Razorpay widget never ran, and it failed *silently*
// (browsers don't surface CSP violations to users, only to devtools
// console). This explicit policy allows exactly what checkout.html
// needs and nothing else. checkout.html itself now uses only external
// same-origin <script src="/checkout.js"> / <link href="/checkout.css">
// files (no inline <script>/<style>), so we don't need 'unsafe-inline'
// anywhere — keeps the rest of the CSP strict.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
      styleSrc: ["'self'"],
      // Razorpay's widget opens payment/OTP/UPI flows inside iframes it
      // injects itself, hits its own API for order/payment status, and
      // loads its own images/fonts — all from *.razorpay.com.
      frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
      connectSrc: ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
      imgSrc: ["'self'", 'data:', 'https://*.razorpay.com'],
      fontSrc: ["'self'", 'https://checkout.razorpay.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  }
}));
app.use(cors({
  origin(origin, callback) {
    // No Origin header at all (native HTTP clients, curl, server-to-
    // server) — allow, there's no browser enforcing same-origin here
    // anyway, so an allowlist check is meaningless for these callers.
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    const err = new Error(`CORS: origin not allowed: ${origin}`);
    err.status = 403;
    callback(err);
  }
}));
app.use(express.json({
  limit: '5mb',
  // Stashes the exact raw bytes of the request body onto req.rawBody,
  // alongside the normal parsed req.body — needed by
  // routes/paymentRoutes.js's webhook handler, which has to verify a
  // signature computed over the exact bytes Razorpay sent, not a
  // re-serialized copy of the parsed JSON (whitespace/key-order
  // differences would make the signature check fail even for a
  // legitimate request). Harmless for every other route — it's just an
  // extra property nobody else reads.
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(morgan('combined'));
app.use(generalLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Serves public/checkout.html — the hosted Razorpay checkout page opened
// in the SYSTEM BROWSER (not the app's WebView) via
// POST /payments/checkout/init. Static, unauthenticated by design (see
// sql/migrations/003_checkout_tokens.sql for why). Nothing else in
// public/ is expected to exist; this only ever serves that one page (and
// its own inline script), so it can't accidentally expose anything else.
app.use(express.static(require('path').join(__dirname, 'public')));

app.use('/auth', authLimiter, authRoutes);
// writeLimiter only kicks in for POST/PATCH — GETs (like /users/me,
// /chat/sessions) stay under the general limiter only.
app.use('/users', (req, res, next) => (req.method === 'GET' ? next() : writeLimiter(req, res, next)), userRoutes);
// Mounted at the MORE SPECIFIC path ('/chat/scenario') and BEFORE the
// broader '/chat' mount below — Express matches middleware in
// registration order, so without this ordering a request to
// /chat/scenario/today would first enter chatRoutes (mounted at '/chat'),
// which has no matching route for it and would only reach scenarioRoutes
// by falling through. Mounting the specific path first avoids depending
// on that fallthrough behavior at all.
//
// Kept as its own route file (not just another route in chatRoutes.js)
// to keep the "daily scenario picking" concern out of the already large
// session-sync/analysis file — GET-only today, so it never needs
// writeLimiter, but the split holds even if that changes later.
app.use('/chat/scenario', (req, res, next) => (req.method === 'GET' ? next() : writeLimiter(req, res, next)), scenarioRoutes);
app.use('/chat', (req, res, next) => (req.method === 'GET' ? next() : writeLimiter(req, res, next)), chatRoutes);
app.use('/payments', (req, res, next) => (req.method === 'GET' ? next() : writeLimiter(req, res, next)), paymentRoutes);
// Uses the general limiter, not writeLimiter — this is an operator/cron
// endpoint gated by ADMIN_SECRET (see adminRoutes.js), not a per-user
// action, so the per-user write budget doesn't apply here.
app.use('/admin', adminRoutes);
app.use('/announcements', announcementRoutes);

app.use(notFoundHandler);
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app); // reports to Sentry, then falls through
app.use(errorHandler); // still sends the JSON response to the client either way

const http = require('http');

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

server.listen(PORT, () => console.log(`Utkio backend listening on port ${PORT}`));

// ═══════════════════════════════════════════════════════════════
// OPTIONAL in-process payment reconciliation scheduler.
//
// Off by default (RECONCILE_INTERVAL_MINUTES unset) — nothing changes
// for anyone who doesn't opt in. If set, runs
// reconcilePendingPayments() on that interval so payments Razorpay
// captured but our webhook + client /verify both missed still get
// activated automatically, without needing an external cron.
//
// Fine for a single-instance deploy (this app's documented deployment
// target — see README's rate-limiting note). If you run 2+ instances,
// prefer an external cron hitting POST /admin/reconcile-payments once
// instead of setting this on every instance — reconcilePendingPayments
// is safe to call concurrently (same atomic activatePlan() guard as
// everything else) but there's no reason to have every instance doing
// duplicate Razorpay API calls on the same schedule.
// ═══════════════════════════════════════════════════════════════
const RECONCILE_INTERVAL_MINUTES = Number(process.env.RECONCILE_INTERVAL_MINUTES) || 0;
if (RECONCILE_INTERVAL_MINUTES > 0) {
  const { reconcilePendingPayments } = require('./lib/reconcilePayments');
  console.log(`Payment reconciliation scheduler enabled — running every ${RECONCILE_INTERVAL_MINUTES} minute(s).`);

  const runReconciliation = async () => {
    try {
      const summary = await reconcilePendingPayments();
      if (summary.skipped) {
        return;
      }
      if (summary.activated > 0 || summary.errors.length > 0) {
        console.log('[reconcile] scheduled run:', summary);
      }
    } catch (err) {
      console.error('[reconcile] scheduled run failed:', err);
    }
  };

  setInterval(runReconciliation, RECONCILE_INTERVAL_MINUTES * 60 * 1000);
  // Also run once shortly after boot, so a restart doesn't leave a
  // long gap before the first check.
  setTimeout(runReconciliation, 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════
// OPTIONAL in-process Commit Mode midnight sweep.
//
// Off by default (COMMIT_MODE_SWEEP_ENABLED unset) — same opt-in
// pattern as the reconciliation scheduler above. If enabled, self-
// schedules its FIRST run for the next IST midnight (+ a small safety
// delay so it runs just after, not exactly at, the boundary — avoids a
// race against sessions still being saved in the final seconds of the
// day), then re-arms itself every 24h after that.
//
// Single-instance-deploy assumption, same caveat as the reconciliation
// scheduler: on a multi-instance deploy, prefer an external cron hitting
// POST /admin/commit-mode-sweep once instead of enabling this on every
// instance. Unlike reconciliation, running this sweep TWICE in the same
// day is still safe (judged_at guard in lib/commitModeEnforcer.js makes
// it a no-op the second time) but there's no reason to do the redundant
// work.
// ═══════════════════════════════════════════════════════════════
if (process.env.COMMIT_MODE_SWEEP_ENABLED === 'true') {
  const { runCommitModeMidnightSweep } = require('./lib/commitModeEnforcer');
  const { msUntilNextIstMidnight } = require('./lib/commitMode');
  const SWEEP_SAFETY_DELAY_MS = 5 * 60 * 1000; // run at 00:05 IST, not 00:00 IST sharp
  const DAY_MS = 24 * 60 * 60 * 1000;

  console.log('Commit Mode midnight sweep scheduler enabled.');

  const runSweep = async () => {
    try {
      const summary = await runCommitModeMidnightSweep();
      console.log('[commitModeEnforcer] sweep run:', summary);
    } catch (err) {
      console.error('[commitModeEnforcer] sweep run failed:', err);
    }
  };

  const armNextSweep = () => {
    const delay = msUntilNextIstMidnight() + SWEEP_SAFETY_DELAY_MS;
    setTimeout(async () => {
      await runSweep();
      setInterval(runSweep, DAY_MS); // now that we're aligned to ~00:05 IST, plain 24h ticks stay aligned
    }, delay);
  };

  armNextSweep();
}