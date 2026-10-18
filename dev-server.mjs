// Local development server: serves the static site and runs the Pages Functions in functions/api/ the way
// Cloudflare Pages does, with secrets from .env (or .dev.vars, Cloudflare's name for the same file). Edits to
// either file are picked up on the next request.
//   node dev-server.mjs [port]      (default 4330)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 4330);

function loadEnv() {
    const env = {};
    for (const name of ['.dev.vars', '.env']) {   // .env wins where both set a value
        const file = path.join(root, name);
        if (!existsSync(file)) continue;
        for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
            const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
            if (m && m[2]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    }
    return env;
}

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
};
const PRIVATE = /(^|\/)(\.|functions\/|dev-server\.mjs)/;   // never served as files

async function handleFunction(req, res, name) {
    const file = path.join(root, 'functions', 'api', `${name}.js`);
    if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) return false;
    const mod = await import(`${pathToFileURL(file).href}?t=${(await stat(file)).mtimeMs}`);   // picks up edits
    const handler = req.method === 'POST' ? mod.onRequestPost : req.method === 'GET' ? mod.onRequestGet : null;
    if (!handler) { res.writeHead(405).end(); return true; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const response = await handler({ request, env: loadEnv() });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return true;
}

createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        const api = /^\/api\/([^/]+)$/.exec(url.pathname);
        if (api && await handleFunction(req, res, api[1])) return;
        let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        if (!rel || rel.endsWith('/')) rel += 'index.html';
        if (PRIVATE.test(rel)) { res.writeHead(404).end('Not found'); return; }
        const file = path.join(root, rel);
        if (!file.startsWith(root) || !existsSync(file) || !(await stat(file)).isFile()) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(await readFile(file));
    } catch (err) {
        console.error(err);
        if (!res.headersSent) res.writeHead(500);
        res.end('Server error');
    }
}).listen(port, '127.0.0.1', () => console.log(`Visualiser studio on http://127.0.0.1:${port}`));
