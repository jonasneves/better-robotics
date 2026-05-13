#!/usr/bin/env node
// Local dev server + cloudflared tunnel.
//
// History note: Python's http.server was the first attempt — it has quirks
// with HTTP/1.1 keep-alive under Chrome's connection-pool reuse that
// manifested as random modules stuck at (pending) in DevTools. Switched to
// a minimal Node HTTP server that binds dual-stack (::) so neither Chrome
// nor curl's IPv6-first resolution takes the 5-second IPv4-fallback path,
// and lets Node's HTTP/1.1 keep-alive work normally — it handles
// concurrent pool reuse correctly where Python's SimpleHTTPRequestHandler
// does not.
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const dns     = require('dns');
const net     = require('net');
const { spawn, execSync } = require('child_process');

const PORT = 8080;
const ROOT = path.join(__dirname, '..', 'public');

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.ico':   'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm':  'application/wasm',
  '.map':   'application/json',
  '.pdf':   'application/pdf',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type':  MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// Sweep stale children / port holders from earlier runs.
try { execSync(`lsof -ti:${PORT} | xargs -r kill 2>/dev/null`); } catch (_) {}
try { execSync('pkill -f "cloudflared tunnel" 2>/dev/null'); } catch (_) {}

// "::" binds both IPv6 and IPv4 via v4-mapped addresses on macOS/Linux.
// Avoids the 5s IPv6→IPv4 fallback that bit the `--bind 0.0.0.0` version.
server.listen(PORT, '::', () => {
  console.log('');
  console.log(`  \x1b[32m→  Desktop:\x1b[0m  http://localhost:${PORT}`);
  console.log(`  \x1b[2m→  Tunnel:   starting…\x1b[0m`);

  const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let tunnelUrl = null;
  function parseLine(line) {
    if (tunnelUrl) return;
    const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!match) return;
    tunnelUrl = match[0];
    waitForDns(new URL(tunnelUrl).hostname, () => {
      console.log(`  \x1b[32m→  Phone:  \x1b[0m  ${tunnelUrl}`);
      console.log(`  \x1b[2m→  Signal:  \x1b[0m  signal.neevs.io`);
      console.log('');
    });
  }
  tunnel.stdout.on('data', (d) => d.toString().split('\n').forEach(parseLine));
  tunnel.stderr.on('data', (d) => d.toString().split('\n').forEach(parseLine));

  tunnel.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.log('');
      console.log('  \x1b[33m→  cloudflared not installed.\x1b[0m');
      console.log('     Install: \x1b[36mbrew install cloudflared\x1b[0m');
      console.log('     (Desktop URL still works without the tunnel.)');
      console.log('');
    } else {
      console.error('Tunnel error:', err.message);
    }
  });
  tunnel.on('close', (code) => {
    if (code) console.error('Tunnel exited with code', code);
    shutdown();
  });

  const shutdown = () => {
    try { tunnel.kill(); } catch {}
    try { server.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
});

// cloudflared prints the URL before DNS has propagated; poll until the
// hostname resolves anywhere, so the user doesn't tap a dead link.
function waitForDns(hostname, done) {
  const resolver = new dns.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  let attempts = 0;
  const check = () => {
    attempts++;
    resolver.resolve4(hostname, (err) => {
      if (!err) return done();
      if (attempts > 30) {
        console.log(`  \x1b[33m→  Warning:\x1b[0m  DNS slow to propagate, URL may need a moment`);
        return done();
      }
      setTimeout(check, 1000);
    });
  };
  check();
}
