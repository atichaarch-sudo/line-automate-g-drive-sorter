#!/usr/bin/env node
/**
 * One-time OAuth2 re-authorization script.
 * Gets a new refresh token with Drive + Sheets scopes,
 * then updates GOOGLE_REFRESH_TOKEN in Vercel automatically.
 *
 * Before running:
 *   1. In GCP Console → APIs & Services → Credentials → your OAuth client
 *      → add  http://localhost:3456  to "Authorized redirect URIs" → Save
 *   2. Run:  node scripts/reauth.mjs
 */

import http from 'http';
import { execSync } from 'child_process';

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3456';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.\n');
  console.error('    Run first:  vercel env pull .env.local  then  source .env.local');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
].join(' ');

const authUrl =
  'https://accounts.google.com/o/oauth2/auth?' +
  new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',   // force refresh_token to be returned
  });

console.log('\n🔐  Re-authorizing Google OAuth2 — Drive + Sheets scopes\n');
console.log('Opening browser...\n');
try { execSync(`start "" "${authUrl}"`); } catch { /* non-Windows: user copies URL manually */ }
console.log('If browser did not open, paste this URL manually:\n');
console.log(authUrl + '\n');

const server = http.createServer(async (req, res) => {
  const url  = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const err  = url.searchParams.get('error');

  if (err) {
    res.writeHead(400); res.end(`<h2>❌ Error: ${err}</h2>`);
    console.error('❌  Authorization failed:', err);
    server.close(); process.exit(1);
  }
  if (!code) { res.writeHead(404); res.end('No code'); return; }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h2 style="font-family:sans-serif">✅ Authorization successful — you can close this tab.</h2>');
  server.close();

  // Exchange authorization code for tokens
  console.log('Exchanging code for tokens...');
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    }),
  });

  const tokens = await tokenResp.json();

  if (!tokens.refresh_token) {
    console.error('❌  No refresh_token in response:', JSON.stringify(tokens, null, 2));
    console.error('\nMake sure "prompt=consent" is in the URL and you authorized a fresh account.');
    process.exit(1);
  }

  console.log('\n✅  Got new refresh token. Updating Vercel...\n');

  // Remove old token, add new one (production + development)
  for (const env of ['production', 'development']) {
    try {
      execSync(`vercel env rm GOOGLE_REFRESH_TOKEN ${env} --yes`, { stdio: 'inherit' });
    } catch { /* may not exist yet */ }
    execSync(
      `echo "${tokens.refresh_token}" | vercel env add GOOGLE_REFRESH_TOKEN ${env}`,
      { stdio: 'inherit' }
    );
  }

  console.log('\n✅  GOOGLE_REFRESH_TOKEN updated in Vercel (production + development).');
  console.log('    Deploy again with:  vercel --prod\n');
});

server.listen(3456, () => {
  console.log('Waiting for browser redirect on http://localhost:3456 ...\n');
});
