// signaling.js — CF Worker WebSocket signaling client

let _ws = null;
let _handlers = [];
let _reconnectTimer = null;
let _reconnectDelay = 1000;
let _config = null;
let _log = () => {};

export function setSignalingLogger(fn) { _log = fn; }

export function connect(workerUrl, roomId, peerId) {
  _config = { workerUrl, roomId, peerId };
  _doConnect();
}

function _doConnect() {
  if (!_config) return;
  const { workerUrl, roomId, peerId } = _config;
  const url = `${workerUrl}/ws/${roomId}`;

  _log(`connecting to signaling server...`);

  try {
    _ws = new WebSocket(url);
  } catch (e) {
    _log(`ws connect failed: ${e.message}`);
    _scheduleReconnect();
    return;
  }

  _ws.onopen = () => {
    _log('signaling connected');
    _reconnectDelay = 1000;
    send({ type: 'join', roomId: _config.roomId, peerId: _config.peerId });
  };

  _ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      _handlers.forEach(cb => cb(msg));
    } catch (err) {
      _log(`bad ws message: ${err.message}`);
    }
  };

  _ws.onclose = (e) => {
    _log(`signaling disconnected (code ${e.code})`);
    _ws = null;
    if (_config) _scheduleReconnect();
  };

  _ws.onerror = () => {
    // onclose will fire after this
  };
}

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  _log(`reconnecting in ${_reconnectDelay / 1000}s...`);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _reconnectDelay = Math.min(_reconnectDelay * 2, 30000);
    _doConnect();
  }, _reconnectDelay);
}

export function send(msg) {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(msg));
  }
}

export function onMessage(cb) {
  _handlers.push(cb);
}

export function disconnect() {
  _config = null;
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_ws) {
    _ws.close();
    _ws = null;
  }
  _handlers = [];
}

export function isConnected() {
  return _ws && _ws.readyState === WebSocket.OPEN;
}
