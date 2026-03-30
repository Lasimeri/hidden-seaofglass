// index.ts — Quartz signaling worker
// Routes: WebSocket signaling via Durable Object, R2 state persistence

import { QuartzRoom } from './room';

export { QuartzRoom };

interface Env {
  QUARTZ_ROOM: DurableObjectNamespace;
  QUARTZ_R2: R2Bucket;
  ALLOWED_ORIGIN: string;
}

// Rate limiting (per IP)
const rateCounts = new Map<string, { count: number; reset: number }>();

function rateOk(ip: string, limit = 60): boolean {
  const now = Date.now();
  let entry = rateCounts.get(ip);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + 60000 };
    rateCounts.set(ip, entry);
  }
  entry.count++;
  return entry.count <= limit;
}

function cors(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data: unknown, status = 200, origin = '*'): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || '*';
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // Rate limit
    if (!rateOk(ip)) {
      return json({ error: 'rate limited' }, 429, origin);
    }

    const path = url.pathname;

    // WebSocket signaling: /ws/{roomId}?peer={peerId}
    if (path.startsWith('/ws/')) {
      const roomId = path.slice(4);
      if (!roomId || roomId.length < 4) {
        return json({ error: 'invalid room ID' }, 400, origin);
      }

      const peer = url.searchParams.get('peer');
      if (!peer) {
        return json({ error: 'peer param required' }, 400, origin);
      }

      const id = env.QUARTZ_ROOM.idFromName(roomId);
      const stub = env.QUARTZ_ROOM.get(id);
      // Forward the full request (includes Upgrade header + query params)
      return stub.fetch(request);
    }

    // State persistence: /state/{roomId}
    if (path.startsWith('/state/')) {
      const roomId = path.slice(7);
      if (!roomId || roomId.length < 4) {
        return json({ error: 'invalid room ID' }, 400, origin);
      }

      const r2Key = `rooms/${roomId}/state.bin`;

      if (request.method === 'PUT') {
        const body = await request.arrayBuffer();
        if (body.byteLength === 0) {
          return json({ error: 'empty body' }, 400, origin);
        }
        if (body.byteLength > 10 * 1024 * 1024) { // 10MB max
          return json({ error: 'too large' }, 413, origin);
        }
        await env.QUARTZ_R2.put(r2Key, body, {
          customMetadata: {
            updatedAt: Date.now().toString(),
          },
        });
        return json({ ok: true }, 200, origin);
      }

      if (request.method === 'GET') {
        const obj = await env.QUARTZ_R2.get(r2Key);
        if (!obj) {
          return new Response(null, { status: 404, headers: cors(origin) });
        }
        return new Response(obj.body, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            ...cors(origin),
          },
        });
      }

      if (request.method === 'DELETE') {
        await env.QUARTZ_R2.delete(r2Key);
        return json({ ok: true }, 200, origin);
      }

      return json({ error: 'method not allowed' }, 405, origin);
    }

    // Health check
    if (path === '/' || path === '/health') {
      return json({ service: 'quartz-relay', status: 'ok' }, 200, origin);
    }

    return json({ error: 'not found' }, 404, origin);
  },
};
