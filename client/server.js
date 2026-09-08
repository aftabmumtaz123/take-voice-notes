/**
 * Lightweight static frontend on :3000
 * API calls go to the backend (default http://localhost:4000).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.CLIENT_PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  // simple SPA fallback
  if (!path.extname(filePath)) filePath = '/index.html';
  const full = path.join(__dirname, path.normalize(filePath).replace(/^(\.\.[/\\])+/, ''));

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`AI Note Taker client: http://localhost:${port}`);
  console.log(`API expected at: ${process.env.API_URL || 'http://localhost:4000'}`);
});
