// room.ts — QuartzRoom Durable Object
// Manages WebSocket connections for one signaling room

interface WSMessage {
  type: string;
  roomId?: string;
  peerId?: string;
  to?: string;
  from?: string;
  data?: string;
  step?: string;
  message?: string;
}

interface Session {
  ws: WebSocket;
  peerId: string;
}

export class QuartzRoom {
  state: DurableObjectState;
  sessions: Map<string, Session> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);

    // Reset idle alarm
    await this.state.storage.setAlarm(Date.now() + 30 * 60 * 1000);

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
      case 'join':
        await this.handleJoin(ws, msg);
        break;

      case 'signal':
        await this.handleSignal(ws, msg);
        break;

      default:
        this.sendTo(ws, { type: 'error', message: `unknown type: ${msg.type}` });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const peerId = this.findPeerId(ws);
    if (peerId) {
      this.sessions.delete(peerId);
      this.broadcast({ type: 'peer-left', peerId }, peerId);
    }

    // If room is empty, set short cleanup alarm
    if (this.sessions.size === 0) {
      await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    // Auto-cleanup if no peers for extended period
    if (this.sessions.size === 0) {
      // DO will be evicted naturally
    }
  }

  // --- handlers ---

  private async handleJoin(ws: WebSocket, msg: WSMessage): Promise<void> {
    const peerId = msg.peerId;
    if (!peerId) {
      this.sendTo(ws, { type: 'error', message: 'peerId required' });
      return;
    }

    // Broadcast to existing peers
    this.broadcast({ type: 'peer-joined', peerId }, peerId);

    // Add to sessions
    this.sessions.set(peerId, { ws, peerId });

    // Send current peer list to the joiner
    const peerList = Array.from(this.sessions.keys()).filter(id => id !== peerId);
    this.sendTo(ws, { type: 'peers', list: peerList });

    // Reset alarm
    await this.state.storage.setAlarm(Date.now() + 30 * 60 * 1000);
  }

  private async handleSignal(ws: WebSocket, msg: WSMessage): Promise<void> {
    const { to, from, data, step } = msg;
    if (!to || !from || !data) {
      this.sendTo(ws, { type: 'error', message: 'signal requires to, from, data' });
      return;
    }

    const target = this.sessions.get(to);
    if (!target) {
      this.sendTo(ws, { type: 'error', message: `peer ${to} not found` });
      return;
    }

    // Relay the signal message (opaque encrypted data)
    this.sendTo(target.ws, { type: 'signal', from, data, step });
  }

  // --- helpers ---

  private sendTo(ws: WebSocket, msg: WSMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Connection may be closing
    }
  }

  private broadcast(msg: WSMessage, excludePeerId?: string): void {
    for (const [peerId, session] of this.sessions) {
      if (peerId !== excludePeerId) {
        this.sendTo(session.ws, msg);
      }
    }
  }

  private findPeerId(ws: WebSocket): string | undefined {
    for (const [peerId, session] of this.sessions) {
      if (session.ws === ws) return peerId;
    }
    return undefined;
  }
}
