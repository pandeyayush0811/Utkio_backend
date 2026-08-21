const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-service-role-key';

const announcementRoutes = require('../routes/announcementRoutes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/announcements', announcementRoutes);
  return app;
}

function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'GET' },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode, data: JSON.parse(body) });
            } catch (e) {
              resolve({ status: res.statusCode, raw: body });
            }
          });
        }
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

test('GET /announcements returns active announcements with required fields', async () => {
  const app = buildApp();
  const { status, data } = await get(app, '/announcements');

  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(data.announcements));
  assert.ok(data.announcements.length > 0);

  const first = data.announcements[0];
  assert.ok(typeof first.id === 'string' && first.id.length > 0);
  assert.ok(typeof first.title === 'string' && first.title.length > 0);
  assert.ok(typeof first.desc === 'string' && first.desc.length > 0);
});
