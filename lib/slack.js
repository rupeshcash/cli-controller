// lib/slack.js — validate a Slack bot token via auth.test using raw HTTPS
// (no SDK needed for the wizard). Resolves { ok, userId, team } | { ok:false, error }.
const https = require('https');

function authTest(botToken) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: 'slack.com', path: '/api/auth.test', method: 'POST', headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { const j = JSON.parse(b); resolve(j.ok ? { ok: true, userId: j.user_id, team: j.team } : { ok: false, error: j.error || 'unknown' }); } catch { resolve({ ok: false, error: 'bad response' }); } }); },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

module.exports = { authTest };
