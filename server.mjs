import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createAccounts } from './lib/accounts.mjs';
import { createNews } from './lib/news.mjs';
const news = createNews(process.env.ORBITA_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)));
const accounts = await createAccounts(process.env.ORBITA_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)));
const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (await news(req,res,requestUrl)) return;
  if (await accounts.handle(req,res,requestUrl)) return;
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(path.resolve(root) + path.sep) || pathname.includes('\\')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const bytes = await readFile(target);
    res.writeHead(200, { 'Content-Type': (types[path.extname(target)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 400).end('File not found');
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Stop the other server or set PORT.` : error.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`ORBITA → http://localhost:${port}\nStop: Ctrl+C`));
