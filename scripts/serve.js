#!/usr/bin/env node
// Local dev server + cloudflared tunnel. Spawns two children:
//   1. python3 -m http.server 8080   — serves public/ (battle-tested, no
//                                      weird keep-alive timeouts)
//   2. cloudflared tunnel            — gives the phone an HTTPS URL
//
// First iteration of this script used Node's http.createServer directly and
// hit intermittent 5-second stalls tied to Node's default keepAliveTimeout
// interacting with Chrome's connection pool. Python's http.server doesn't
// have that problem, so we just run it instead.
const dns     = require('dns');
const net     = require('net');
const path    = require('path');
const { spawn, execSync } = require('child_process');

const PORT = 8080;
const ROOT = path.join(__dirname, '..', 'public');

// Sweep stale children from earlier runs so ports don't fight.
try { execSync(`lsof -ti:${PORT} | xargs -r kill 2>/dev/null`); } catch (_) {}
try { execSync('pkill -f "cloudflared tunnel" 2>/dev/null'); } catch (_) {}

// No --bind: let Python's DualStackServer default bind both IPv6 (::1) and
// IPv4 (127.0.0.1). Binding IPv4-only (`--bind 0.0.0.0`) causes Chrome and
// curl to spend ~5s trying ::1 first before falling back to IPv4, which
// manifests as random 5-second stalls on localhost requests.
const http = spawn('python3', ['-m', 'http.server', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'pipe'],
});
http.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s && !s.includes('code 404') && !s.includes('code 304')) process.stderr.write(`[http] ${s}\n`);
});
http.on('error', (err) => {
  if (err.code === 'ENOENT') console.error('python3 not found in PATH');
  else                      console.error('http error:', err.message);
  process.exit(1);
});

// Wait until the HTTP server actually starts accepting connections before
// telling the user about it or launching the tunnel — otherwise cloudflared
// starts too early and the first real request fails with "connection refused".
waitForPort(PORT, () => {
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
    try { http.kill(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
});

// Poll until the server is actually accepting on the port.
function waitForPort(port, done) {
  let attempts = 0;
  const check = () => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); done(); });
    sock.once('error',   () => { sock.destroy(); attempts++;
      if (attempts > 50) { console.error('http failed to start within 5s'); process.exit(1); }
      setTimeout(check, 100);
    });
  };
  check();
}

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
