const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseClient');

// Default active announcement — real guidance encouraging daily conversation practice.
const DEFAULT_ANNOUNCEMENTS = [
  {
    id: 'daily-practice-guide-v1',
    badge: 'Tip',
    title: 'Daily 5-minute English practice',
    desc: 'Regular daily voice conversations build natural fluency and confidence faster.',
    link: 'chat.html'
  }
];

let cachedAnnouncements = null;
let cacheExpiresAt = 0;
const ANNOUNCEMENTS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// GET /announcements — returns active system announcements.
// Fail-safe, cached, and lightweight: never throws or crashes if database is slow.
router.get('/', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');

    if (cachedAnnouncements && Date.now() < cacheExpiresAt) {
      return res.json({ announcements: cachedAnnouncements });
    }

    let announcements = DEFAULT_ANNOUNCEMENTS;

    if (supabaseAdmin) {
      const { data: configRow } = await supabaseAdmin
        .from('prompt_configs')
        .select('prompt')
        .eq('key', 'active_announcement')
        .maybeSingle();

      if (configRow && configRow.prompt) {
        try {
          const parsed = JSON.parse(configRow.prompt);
          if (Array.isArray(parsed) && parsed.length > 0) {
            announcements = parsed;
          } else if (parsed && typeof parsed === 'object' && parsed.id) {
            announcements = [parsed];
          }
        } catch {
          // If prompt is plain text instead of JSON, wrap as a single announcement
          announcements = [
            {
              id: 'custom-announcement',
              badge: 'Notice',
              title: 'Announcement',
              desc: configRow.prompt,
              link: null
            }
          ];
        }
      }
    }

    cachedAnnouncements = announcements;
    cacheExpiresAt = Date.now() + ANNOUNCEMENTS_CACHE_TTL_MS;
    res.json({ announcements });
  } catch (err) { next(err); }
});

module.exports = router;
