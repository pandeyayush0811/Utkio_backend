function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('Unhandled error:', err);
  const status = err.status || 500;

  // 4xx errors (CORS rejection, validation, etc.) are raised intentionally
  // by our own code with a message that's safe/useful for the client.
  // 5xx errors are usually unexpected (DB/network failures) and err.message
  // can contain internal details (Postgres/Supabase error text, stack info)
  // that shouldn't leak to a client — return a generic message instead and
  // keep the real one only in server logs (console.error above).
  const clientMessage = status < 500 ? (err.message || 'Request failed') : 'Internal server error';
  res.status(status).json({ error: clientMessage });
}

module.exports = { notFoundHandler, errorHandler };
