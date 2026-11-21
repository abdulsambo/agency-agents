#!/usr/bin/env node
// Chess Duel – local network server.
// Run `node server.js` on any computer, then open the printed address on two
// devices connected to the same Wi-Fi. No packages to install.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const PAGE = path.join(__dirname, 'index.html');
const CODE = /^[a-z0-9]{3,12}$/;
const ID = /^[a-z0-9]{1,24}$/;
const rooms = new Map();

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = { state: null, clients: new Set(), touched: Date.now() }; rooms.set(code, r); }
  r.touched = Date.now();
  return r;
}

// Same ordering rule the page uses, so every device settles on one state.
function better(a, b) {
  if (!b) return true;
  if (a.seq !== b.seq) return a.seq > b.seq;
  const am = (a.mv || []).length, bm = (b.mv || []).length;
  if (am !== bm) return am > bm;
  return String(a.by || '') > String(b.by || '');
}

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function peerList(r) { return [...r.clients].map(c => ({ pid: c.pid, name: c.name })); }
function sendPeers(r) { const p = peerList(r); for (const c of r.clients) sse(c.res, 'peers', p); }
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function cleanName(s) { return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24); }

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(`http://${a.address}:${PORT}`);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    fs.readFile(PAGE, (err, buf) => {
      if (err) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('index.html must sit in the same folder as server.js'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/ping') { json(res, 200, { ok: true, app: 'chess-duel', urls: lanUrls() }); return; }

  if (req.method === 'GET' && u.pathname === '/api/events') {
    const code = u.searchParams.get('room') || '', pid = u.searchParams.get('pid') || '';
    if (!CODE.test(code) || !ID.test(pid)) { json(res, 400, { error: 'bad room or player id' }); return; }
    const r = getRoom(code);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    const client = { res, pid, name: cleanName(u.searchParams.get('name')) };
    r.clients.add(client);
    if (r.state) sse(res, 'state', r.state);
    sendPeers(r);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => { clearInterval(beat); r.clients.delete(client); sendPeers(r); });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/state') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 32768) req.destroy(); });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch (e) { json(res, 400, { error: 'bad json' }); return; }
      if (!msg || !CODE.test(msg.room || '') || !msg.state || typeof msg.state.seq !== 'number' || !Array.isArray(msg.state.mv)) { json(res, 400, { error: 'bad state' }); return; }
      const r = getRoom(msg.room);
      if (better(msg.state, r.state)) {
        r.state = msg.state;
        for (const c of r.clients) sse(c.res, 'state', r.state);
      }
      json(res, 200, { ok: true });
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

// Forget rooms nobody has touched for 12 hours.
setInterval(() => {
  const cutoff = Date.now() - 12 * 3600 * 1000;
  for (const [code, r] of rooms) if (!r.clients.size && r.touched < cutoff) rooms.delete(code);
}, 3600 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  console.log('\n  Chess Duel is running.\n');
  if (urls.length) {
    console.log('  Open this address on both devices (same Wi-Fi):\n');
    for (const url of urls) console.log('    ' + url);
  } else {
    console.log('  No Wi-Fi address found. Connect this computer to Wi-Fi and restart.');
  }
  console.log(`\n  On this computer you can also use http://localhost:${PORT}`);
  console.log('  Press Ctrl+C to stop.\n');
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Try: PORT=8090 node server.js`);
  else console.error(err);
  process.exit(1);
});
