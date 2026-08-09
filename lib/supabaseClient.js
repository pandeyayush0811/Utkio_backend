const { createClient } = require('@supabase/supabase-js');

// Anon client — used to verify user tokens (auth.getUser) and to run
// signup/login/google exchanges. Only ever does what a normal client can do.
const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Service-role client — used ONLY on the server to read/write the
// `profiles` table bypassing RLS (e.g. auto-creating a profile row).
// NEVER expose this key or this client to the frontend/app.
let supabaseAdmin = null;
if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
} else {
  console.warn('SUPABASE_SERVICE_ROLE_KEY not set — profile auto-creation and /users/me profile data will be skipped.');
}

module.exports = { supabaseAnon, supabaseAdmin };
