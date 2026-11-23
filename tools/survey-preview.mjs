import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { onRequestPost } from '../functions/api/submit.js';
import { LIMITS } from '../functions/_lib/core.js';

const port = Number(process.env.SURVEY_PREVIEW_PORT || 4322);
const origin = 'http://127.0.0.1:' + port;
const root = new URL('../', import.meta.url);
const state = new URL('.wrangler/state/survey-preview/', root);
mkdirSync(state, { recursive:true });
const db = new DatabaseSync(fileURLToPath(new URL('submissions.sqlite', state)));
db.exec(readFileSync(new URL('survey/migrations/0001_submissions.sql', root), 'utf8'));

// Run the same Pages Function and SQL as the hosted survey, with a local binding.
const env = {
  ALLOWED_ORIGINS:origin,
  IP_SALT:randomBytes(32).toString('hex'),
  DB:{
    prepare(sql) {
      const statement = db.prepare(sql);
      return { bind(...args) {
        return { first:() => statement.get(...args) ?? null, run:() => statement.run(...args) };
      } };
    },
  },
};

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
]);
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== '127.0.0.1:' + port) { res.writeHead(403).end(); return; }
    const path = new URL(req.url, origin).pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST' && path === '/api/submit') {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMITS.bodyBytes) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const name of ['origin', 'content-type', 'accept', 'user-agent']) {
        if (req.headers[name]) headers.set(name, req.headers[name]);
      }
      headers.set('CF-Connecting-IP', req.socket.remoteAddress);
      const request = new Request(origin + path, {method:'POST', headers, body:Buffer.concat(chunks)});
      const result = await onRequestPost({request, env});
      res.writeHead(result.status, Object.fromEntries(result.headers)).end(await result.text());
      return;
    }
    if (req.method === 'GET' && path === '/api/companies') {
      const catalog = new URL('site/public/data/v1/index.json', root);
      const rows = existsSync(catalog) ? JSON.parse(readFileSync(catalog, 'utf8')).companies : [];
      const companies = rows.map(({id, name, slug, aliases}) => ({id, name, slug, aliases}));
      res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({companies}));
      return;
    }
    const asset = assets.get(path);
    if (req.method !== 'GET' || !asset) { res.writeHead(404).end(); return; }
    const [filename, mime] = asset;
    let body = readFileSync(new URL('survey/' + filename, root), 'utf8');
    if (filename === 'index.html') {
      body = body.replace('</header>', '<span>本地联调 · 评价仅存本机</span></header>');
    }
    res.writeHead(200, {'Content-Type':mime + '; charset=utf-8'}).end(body);
  } catch (error) {
    console.error('处理本地问卷请求失败：', error.name);
    res.writeHead(500, {'Content-Type':'application/json'}).end(JSON.stringify({ok:false, code:'UPSTREAM'}));
  }
});
server.listen(port, '127.0.0.1', () => console.log('本地问卷就绪', origin));
