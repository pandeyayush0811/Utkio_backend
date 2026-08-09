const { supabaseAnon } = require('../lib/supabaseClient');

// Protects a route: expects "Authorization: Bearer <supabase-access-token>".
// Verifies it against Supabase and attaches the user to req.user.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  }

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = data.user;
  req.accessToken = token;
  next();
}

module.exports = { requireAuth };
