// room.js — room lifecycle orchestrator
// State machine: idle → connecting → signaling → connected → disconnected

import { generateKey, exportKey, importKey, deriveRoomId, encrypt, decrypt, encryptBinary, decryptBinary } from './crypto.js?v=2';
import { connect as wsConnect, send as wsSend, onMessage as wsOnMessage, disconnect as wsDisconnect, isConnected as wsIsConnected } from './signaling.js?v=2';
import { createPeerConnection, createOffer, createAnswer, acceptAnswer, onDataChannel, waitForOpen, setRtcLogger } from './rtc.js?v=2';
import { createDoc, onLocalUpdate, applyRemoteUpdate, encodeFullState, decodeAndApplyState, setSyncLogger } from './sync.js?v=2';

const WORKER_URL = 'wss://quartz-relay.seaofglass.workers.dev';
const STATE_SAVE_INTERVAL = 30000; // 30s

let _state = 'idle';
let _key = null;
let _roomId = null;
let _peerId = null;
let _doc = null;
let _peers = new Map(); // peerId → { pc, dc }
let _stateTimer = null;
let _log = () => {};
let _onStateChange = () => {};
let _onPeerCountChange = () => {};

export function setRoomLogger(fn) {
  _log = fn;
  setRtcLogger(fn);
  setSyncLogger(fn);
}

export function setRoomCallbacks({ onStateChange, onPeerCountChange }) {
  if (onStateChange) _onStateChange = onStateChange;
  if (onPeerCountChange) _onPeerCountChange = onPeerCountChange;
}

function setState(s) {
  _state = s;
  _onStateChange(s);
  _log(`state: ${s}`);
}

export function getState() { return _state; }
export function getRoomId() { return _roomId; }
export function getDoc() { return _doc; }
export function getPeerCount() { return _peers.size; }

// Create a new room — returns { key (base64url), roomId }
export async function createRoom() {
  _key = await generateKey();
  const keyStr = await exportKey(_key);
  _roomId = await deriveRoomId(_key);
  _peerId = crypto.randomUUID().slice(0, 8);
  _doc = createDoc();

  _log(`room created: ${_roomId}`);
  _startSignaling();

  return { key: keyStr, roomId: _roomId };
}

// Join an existing room from a key string
export async function joinRoom(keyStr) {
  _key = await importKey(keyStr);
  _roomId = await deriveRoomId(_key);
  _peerId = crypto.randomUUID().slice(0, 8);
  _doc = createDoc();

  _log(`joining room: ${_roomId}`);

  // Try to load persisted state first
  await _loadPersistedState();

  _startSignaling();

  return { roomId: _roomId };
}

function _startSignaling() {
  setState('connecting');
  wsConnect(WORKER_URL, _roomId, _peerId);

  wsOnMessage(async (msg) => {
    switch (msg.type) {
      case 'peers':
        _log(`peers in room: ${msg.list.length}`);
        // Initiate connection to each existing peer
        for (const pid of msg.list) {
          if (pid !== _peerId) await _initiateConnection(pid);
        }
        setState('connected');
        break;

      case 'peer-joined':
        _log(`peer joined: ${msg.peerId}`);
        // New peer will initiate to us, we wait
        break;

      case 'peer-left':
        _log(`peer left: ${msg.peerId}`);
        _removePeer(msg.peerId);
        break;

      case 'signal':
        await _handleSignal(msg);
        break;

      case 'error':
        _log(`server error: ${msg.message}`);
        break;
    }
  });

  // Wire Yjs updates to broadcast to all peers
  onLocalUpdate(_doc, _key, (encrypted) => {
    for (const [, peer] of _peers) {
      if (peer.dc && peer.dc.readyState === 'open') {
        peer.dc.send(encrypted);
      }
    }
  });

  // Start periodic state saving
  _stateTimer = setInterval(() => _saveState(), STATE_SAVE_INTERVAL);
  window.addEventListener('beforeunload', _saveState);
}

async function _initiateConnection(remotePeerId) {
  _log(`initiating connection to ${remotePeerId}`);
  const pc = createPeerConnection((type, state) => {
    _log(`${remotePeerId} ${type}: ${state}`);
    if (state === 'failed' || state === 'disconnected') _removePeer(remotePeerId);
  });

  const { dataChannel, sdp } = await createOffer(pc);

  // Encrypt SDP before sending
  const encryptedSdp = await encrypt(sdp, _key);
  wsSend({ type: 'signal', to: remotePeerId, from: _peerId, data: encryptedSdp, step: 'offer' });

  _peers.set(remotePeerId, { pc, dc: dataChannel });
  _onPeerCountChange(_peers.size);

  _setupDataChannel(dataChannel, remotePeerId);
}

async function _handleSignal(msg) {
  const { from, data, step } = msg;

  if (step === 'offer') {
    // Decrypt SDP
    const sdp = await decrypt(data, _key);
    _log(`received offer from ${from}`);

    const pc = createPeerConnection((type, state) => {
      _log(`${from} ${type}: ${state}`);
      if (state === 'failed' || state === 'disconnected') _removePeer(from);
    });

    const answerSdp = await createAnswer(pc, sdp);
    const encryptedAnswer = await encrypt(answerSdp, _key);
    wsSend({ type: 'signal', to: from, from: _peerId, data: encryptedAnswer, step: 'answer' });

    // Wait for their DataChannel
    const dc = await onDataChannel(pc);
    await waitForOpen(dc);
    _peers.set(from, { pc, dc });
    _onPeerCountChange(_peers.size);
    _setupDataChannel(dc, from);

    // Send full state to new peer
    _sendFullState(from);

  } else if (step === 'answer') {
    const peer = _peers.get(from);
    if (!peer) return;
    const sdp = await decrypt(data, _key);
    _log(`received answer from ${from}`);
    await acceptAnswer(peer.pc, sdp);
    await waitForOpen(peer.dc);

    // Send full state
    _sendFullState(from);
  }
}

function _setupDataChannel(dc, remotePeerId) {
  dc.binaryType = 'arraybuffer';

  dc.onmessage = async (e) => {
    await applyRemoteUpdate(_doc, e.data, _key);
  };

  dc.onclose = () => {
    _log(`channel closed: ${remotePeerId}`);
    _removePeer(remotePeerId);
  };

  _log(`data channel open with ${remotePeerId}`);
}

async function _sendFullState(remotePeerId) {
  const peer = _peers.get(remotePeerId);
  if (!peer || !peer.dc || peer.dc.readyState !== 'open') return;
  const state = await encodeFullState(_doc, _key);
  peer.dc.send(state);
  _log(`sent full state to ${remotePeerId}`);
}

function _removePeer(peerId) {
  const peer = _peers.get(peerId);
  if (peer) {
    if (peer.dc) try { peer.dc.close(); } catch {}
    if (peer.pc) try { peer.pc.close(); } catch {}
    _peers.delete(peerId);
    _onPeerCountChange(_peers.size);
  }
}

// --- R2 state persistence ---

async function _saveState() {
  if (!_doc || !_key || !_roomId) return;
  try {
    const encrypted = await encodeFullState(_doc, _key);
    const workerHttp = WORKER_URL.replace('wss://', 'https://');
    await fetch(`${workerHttp}/state/${_roomId}`, {
      method: 'PUT',
      body: encrypted,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  } catch (e) {
    // Silent fail — best effort persistence
  }
}

async function _loadPersistedState() {
  try {
    const workerHttp = WORKER_URL.replace('wss://', 'https://');
    const res = await fetch(`${workerHttp}/state/${_roomId}`);
    if (!res.ok) return;
    const data = await res.arrayBuffer();
    if (data.byteLength > 0) {
      await decodeAndApplyState(_doc, data, _key);
      _log('loaded persisted state from R2');
    }
  } catch (e) {
    _log(`no persisted state found`);
  }
}

// Leave room
export function leaveRoom() {
  _saveState();
  if (_stateTimer) clearInterval(_stateTimer);
  window.removeEventListener('beforeunload', _saveState);
  for (const [pid] of _peers) _removePeer(pid);
  wsDisconnect();
  _doc = null;
  _key = null;
  _roomId = null;
  setState('idle');
}
