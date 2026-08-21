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

// GET /announcements — returns active system announcements.
// Fail-safe and lightweight: never throws or crashes if database is slow.
router.get('/', async (req, res, next) => {
  try {
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
            return res.json({ announcements: parsed });
          }
          if (parsed && typeof parsed === 'object' && parsed.id) {
            return res.json({ announcements: [parsed] });
          }
        } catch {
          // If prompt is plain text instead of JSON, wrap as a single announcement
          return res.json({
            announcements: [
              {
                id: 'custom-announcement',
                badge: 'Notice',
                title: 'Announcement',
                desc: configRow.prompt,
                link: null
              }
            ]
          });
        }
      }
    }

    res.json({ announcements: DEFAULT_ANNOUNCEMENTS });
  } catch (err) { next(err); }
});

module.exports = router;
