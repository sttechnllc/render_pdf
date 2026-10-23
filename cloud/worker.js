// Mark's Render PDF Editor – document host for "Get signatures".
// Stores end-to-end encrypted PDFs so signers just click a link. The key never reaches this server
// (it lives after the # in the link), so stored files are unreadable here.
//   GET /d/<id>                       -> the encrypted bytes
//   PUT /d/<id>  (X-Write: <secret>)  -> create, or replace when the secret matches the one it was created with
// Storage: Workers KV (binding DOCS, no card needed). To scale, bind an R2 bucket as FILES – it is used instead.
const MAX = 20 * 1024 * 1024;           // KV allows 25 MB per value
const TTL = 60 * 60 * 24 * 30;          // files delete themselves after 30 days
const ID = /^[A-Za-z0-9_-]{22}$/, SECRET = /^[A-Za-z0-9_-]{22,64}$/;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Write', 'Access-Control-Max-Age': '86400' };
const reply = (body, status = 200, h = {}) => new Response(body, { status, headers: { ...cors, ...h } });
const hash = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');

const store = env => env.FILES ? {
  get: async id => { const o = await env.FILES.get(id); if (!o || (o.customMetadata.exp && +o.customMetadata.exp < Date.now())) return null; return { value: await o.arrayBuffer(), wh: o.customMetadata.wh }; },
  meta: async id => { const o = await env.FILES.head(id); return o && { wh: o.customMetadata.wh }; },
  put: (id, data, wh) => env.FILES.put(id, data, { customMetadata: { wh, exp: String(Date.now() + TTL * 1000) } }),
} : {
  get: async id => { const r = await env.DOCS.getWithMetadata(id, 'arrayBuffer'); return r.value && { value: r.value, wh: r.metadata?.wh }; },
  meta: async id => { const r = await env.DOCS.getWithMetadata(id, 'stream'); r.value?.cancel(); return r.value && { wh: r.metadata?.wh }; },
  put: (id, data, wh) => env.DOCS.put(id, data, { expirationTtl: TTL, metadata: { wh } }),
};

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return reply(null, 204);
    const m = new URL(req.url).pathname.match(/^\/d\/([^/]+)$/);
    if (!m || !ID.test(m[1])) return reply('Not found', 404);
    const id = m[1], db = store(env);
    if (req.method === 'GET') {
      const r = await db.get(id);
      return r ? reply(r.value, 200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }) : reply('This document has expired or was removed.', 404);
    }
    if (req.method === 'PUT') {
      const w = req.headers.get('X-Write') || '';
      if (!SECRET.test(w)) return reply('Missing key', 403);
      if (+(req.headers.get('Content-Length') || 0) > MAX) return reply('Too large', 413);
      const data = await req.arrayBuffer();
      if (!data.byteLength || data.byteLength > MAX) return reply('Too large', 413);
      const wh = await hash(w), old = await db.meta(id);
      if (old && old.wh !== wh) return reply('Wrong key', 403);
      await db.put(id, data, wh);
      return reply('{"ok":true}', 200, { 'Content-Type': 'application/json' });
    }
    return reply('Method not allowed', 405);
  },
};
