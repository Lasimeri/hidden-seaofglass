// room.ts — QuartzRoom Durable Object (hibernation API)
// WebSocket hub for signaling between peers in a room

import { DurableObject } from 'cloudflare:workers';

interface Env {
  QUARTZ_R2: R2Bucket;
  ALLOWED_ORIGIN: string;
}

interface WSMessage {
  type: string;
  roomId?: string;
  peerId?: string;
  to?: string;
  from?: string;
  data?: string;
  step?: string;
  message?: string;
  list?: string[];
}

export class QuartzRoom extends DurableObject<Env> {

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Extract peerId from URL query param
    const url = new URL(request.url);
    const peerId = url.searchParams.get('peer');
    if (!peerId) {
      return new Response('peer param required', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Tag the WebSocket with peerId for hibernation recovery
    this.ctx.acceptWebSocket(server, [peerId]);

    // Notify existing peers
    const existingPeerIds = this.getPeerIds();
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (tags[0] !== peerId) {
        this.sendTo(ws, { type: 'peer-joined', peerId });
      }
    }

    // Send peer list to the new joiner (after accept, but before client reads)
    // We need to send via the server side of the pair
    const peerList = existingPeerIds.filter(id => id !== peerId);
    this.sendTo(server, { type: 'peers', list: peerList });

    // Reset idle alarm
    await this.ctx.storage.setAlarm(Date.now() + 30 * 60 * 1000);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;

    let msg: WSMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendTo(ws, { type: 'error', message: 'invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'signal':
        this.handleSignal(ws, msg);
        break;

      case 'ping':
        this.sendTo(ws, { type: 'pong' });
        break;

      default:
        // Ignore unknown types (join is handled in fetch now)
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const peerId = tags[0];
    if (peerId) {
      // Broadcast peer-left to remaining peers
      for (const other of this.ctx.getWebSockets()) {
        const otherTags = this.ctx.getTags(other);
        if (otherTags[0] !== peerId) {
          this.sendTo(other, { type: 'peer-left', peerId });
        }
      }
    }

    // If room is empty, set cleanup alarm
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1006);
  }

  async alarm(): Promise<void> {
    // Auto-eviction when idle
  }

  // --- helpers ---

  private handleSignal(ws: WebSocket, msg: WSMessage): void {
    const { to, from, data, step } = msg;
    if (!to || !from || !data) {
      this.sendTo(ws, { type: 'error', message: 'signal requires to, from, data' });
      return;
    }

    // Find target WebSocket by peerId tag
    const targets = this.ctx.getWebSockets(to);
    if (targets.length === 0) {
      this.sendTo(ws, { type: 'error', message: `peer ${to} not found` });
      return;
    }

    this.sendTo(targets[0], { type: 'signal', from, data, step });
  }

  private getPeerIds(): string[] {
    const ids: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (tags[0]) ids.push(tags[0]);
    }
    return ids;
  }

  private sendTo(ws: WebSocket, msg: WSMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Connection may be closing
    }
  }
}
