import 'dotenv/config';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { initDb, db } from '../core/db.js';
import { createLinkToken, exchangePublicToken } from '../core/plaid.js';
import { encryptToken } from '../core/crypto.js';

const PORT = 4747;

function linkPage(linkToken: string) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Fungible — Connect Bank</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 40px; text-align: center; max-width: 380px; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; color: #fff; }
    p { color: #888; font-size: 0.9rem; margin-bottom: 28px; }
    button { background: #00d4aa; color: #000; border: none; border-radius: 8px; padding: 12px 28px; font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #00bfa0; }
    .status { margin-top: 20px; font-size: 0.85rem; color: #888; }
    .success { color: #00d4aa; }
    .error { color: #ff6b6b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>fungible</h1>
    <p>Connect your bank account to start tracking expenses.</p>
    <button id="connect-btn">Connect Bank</button>
    <div class="status" id="status"></div>
  </div>

  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    const btn = document.getElementById('connect-btn');
    const status = document.getElementById('status');

    btn.addEventListener('click', () => {
      const handler = Plaid.create({
        token: '${linkToken}',
        onSuccess: async (publicToken, metadata) => {
          btn.disabled = true;
          status.textContent = 'Connecting...';
          try {
            const res = await fetch('/callback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ public_token: publicToken, institution: metadata.institution }),
            });
            if (res.ok) {
              status.className = 'status success';
              status.textContent = 'Connected! You can close this window.';
              btn.textContent = 'Done';
            } else {
              throw new Error(await res.text());
            }
          } catch (e) {
            status.className = 'status error';
            status.textContent = 'Error: ' + e.message;
            btn.disabled = false;
          }
        },
        onExit: (err) => {
          if (err) {
            status.className = 'status error';
            status.textContent = err.display_message || 'Exited without connecting.';
          }
        },
      });
      handler.open();
    });
  </script>
</body>
</html>`;
}

function successPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Connected</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 40px; text-align: center; }
    h1 { color: #00d4aa; margin-bottom: 8px; }
    p { color: #888; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connected!</h1>
    <p>You can close this window and return to the terminal.</p>
  </div>
</body>
</html>`;
}

async function main() {
  await initDb();
  console.log('Creating Plaid link token...');
  const linkToken = await createLinkToken('local-user');

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(linkPage(linkToken));
      return;
    }

    if (req.method === 'POST' && req.url === '/callback') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { public_token, institution } = JSON.parse(body);
          const { accessToken, itemId } = await exchangePublicToken(public_token);

          const institutionName = institution?.name ?? null;

          await db.execute({
            sql: `INSERT INTO plaid_items (item_id, access_token, institution_name)
                  VALUES (?, ?, ?)
                  ON CONFLICT(item_id) DO UPDATE SET access_token=excluded.access_token, institution_name=excluded.institution_name`,
            args: [itemId, encryptToken(accessToken), institutionName],
          });

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(successPage());

          console.log(`\n✓ Connected: ${institutionName ?? itemId}`);
          console.log('  Run `npm run dev` to open the dashboard.\n');

          setTimeout(() => server.close(), 1000);
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(e.message);
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Opening ${url} ...`);
    execFile('open', [url]);
  });
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
