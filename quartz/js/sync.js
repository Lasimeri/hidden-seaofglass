// sync.js — Yjs CRDT wrapper with encrypted gossip

import * as Y from 'https://cdn.jsdelivr.net/npm/yjs@13/+esm';
import { encryptBinary, decryptBinary } from './crypto.js?v=3';

let _log = () => {};
export function setSyncLogger(fn) { _log = fn; }

export function createDoc() {
  const doc = new Y.Doc();
  // Shared types
  doc.getMap('pages');      // page storage (ZeroNet-like)
  _log('yjs document created');
  return doc;
}

// Listen for local changes, encrypt and broadcast to peers
export function onLocalUpdate(doc, key, broadcastFn) {
  doc.on('update', async (update, origin) => {
    if (origin === 'remote') return; // don't re-broadcast remote updates
    try {
      const encrypted = await encryptBinary(update, key);
      broadcastFn(new Uint8Array(encrypted));
    } catch (e) {
      _log(`encrypt update failed: ${e.message}`);
    }
  });
}

// Apply an encrypted remote update
export async function applyRemoteUpdate(doc, encryptedData, key) {
  try {
    const decrypted = await decryptBinary(encryptedData, key);
    Y.applyUpdate(doc, new Uint8Array(decrypted), 'remote');
  } catch (e) {
    _log(`decrypt update failed: ${e.message}`);
  }
}

// Encode full state for storage/new peer sync
export async function encodeFullState(doc, key) {
  const state = Y.encodeStateAsUpdate(doc);
  return new Uint8Array(await encryptBinary(state, key));
}

// Decode full state from storage
export async function decodeAndApplyState(doc, encryptedData, key) {
  const decrypted = await decryptBinary(encryptedData, key);
  Y.applyUpdate(doc, new Uint8Array(decrypted), 'remote');
  _log('applied stored state');
}

// Encode state vector for delta sync
export function encodeStateVector(doc) {
  return Y.encodeStateVector(doc);
}

// Encode delta from a state vector
export async function encodeDelta(doc, remoteStateVector, key) {
  const delta = Y.encodeStateAsUpdate(doc, remoteStateVector);
  return new Uint8Array(await encryptBinary(delta, key));
}

// Re-export Y for external use
export { Y };
