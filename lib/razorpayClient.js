const Razorpay = require('razorpay');

// Same pattern as supabaseAdmin in supabaseClient.js — if the keys
// aren't set (e.g. local dev without payment testing configured), this
// is null instead of crashing the whole server at boot. Routes that
// need it check for null and return a clear 500 instead of throwing.
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
} else {
  console.warn('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — payment routes will return 500 until configured.');
}

module.exports = { razorpay };
