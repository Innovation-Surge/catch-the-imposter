// Netlify Function serving POST /api/* — the same API as server.js, with rooms
// stored in Netlify Blobs (functions are stateless, so memory can't hold games).
import { getStore } from '@netlify/blobs';
import game from '../../lib/game.js';

const { createApi } = game;

function blobStore() {
  // Strong consistency: every poll must see the latest write, not a cached copy.
  const blobs = getStore({ name: 'imposter-rooms', consistency: 'strong' });
  return {
    async load(code) {
      const key = `room-${code}`;
      let r = await blobs.getWithMetadata(key, { type: 'json' });
      if (r && !r.etag) {
        // The local `netlify dev` sandbox omits ETags on reads; its listing has them.
        // Take the ETag first, then re-read: a race can only make the write retry.
        const { blobs: list } = await blobs.list({ prefix: key });
        const etag = list.find((b) => b.key === key)?.etag || 'missing';
        r = await blobs.getWithMetadata(key, { type: 'json' });
        if (r) r.etag = etag;
      }
      return r ? { room: r.data, etag: r.etag } : null;
    },
    async save(code, room, etag) {
      const { modified } = await blobs.setJSON(`room-${code}`, room, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
      return modified;
    },
    async loadSeen(code) {
      return blobs.get(`seen-${code}`, { type: 'json' });
    },
    async saveSeen(code, seen) {
      await blobs.setJSON(`seen-${code}`, seen);
    },
  };
}

export default async (req) => {
  if (req.method !== 'POST') return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405 });
  const route = new URL(req.url).pathname.replace(/^\/api\//, '');
  let body = {};
  try {
    const text = await req.text();
    if (text.length > 16 * 1024) return Response.json({ ok: false, error: 'Request too large.' });
    body = text ? JSON.parse(text) : {};
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON.' });
  }
  const api = createApi(blobStore());
  return Response.json(await api(route, body), { headers: { 'Cache-Control': 'no-store' } });
};

export const config = { path: '/api/*' };
