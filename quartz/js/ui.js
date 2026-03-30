// ui.js — DOM bindings and entry point

import { createRoom, joinRoom, leaveRoom, setRoomLogger, setRoomCallbacks, getDoc, getRoomId, getPeerCount } from './room.js';
import { setSignalingLogger } from './signaling.js';
import { listServices, registerService, renderService, onServicesChange, setServicesLogger } from './services.js';

// --- DOM refs ---
const $ = (s) => document.querySelector(s);
const landingSection = $('#landing-section');
const roomSection = $('#room-section');
const createBtn = $('#create-btn');
const joinBtn = $('#join-btn');
const joinInput = $('#join-input');
const roomIdEl = $('#room-id');
const peerCountEl = $('#peer-count');
const connStateEl = $('#conn-state');
const copyLinkBtn = $('#copy-link-btn');
const leaveBtn = $('#leave-btn');
const padEl = $('#pad');
const addServiceBtn = $('#add-service-btn');
const serviceListEl = $('#service-list');
const serviceFrameEl = $('#service-frame');
const addServiceModal = $('#add-service-modal');
const serviceNameInput = $('#service-name');
const serviceHtmlInput = $('#service-html');
const serviceCancelBtn = $('#service-cancel');
const serviceSubmitBtn = $('#service-submit');
const logEl = $('#log');

// --- Logging ---
function log(msg, cls) {
  const entry = document.createElement('div');
  entry.className = `entry${cls ? ' ' + cls : ''}`;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  entry.textContent = `[${ts}] ${msg}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

setRoomLogger(log);
setSignalingLogger(log);
setServicesLogger(log);

// --- Room state callbacks ---
setRoomCallbacks({
  onStateChange: (state) => {
    connStateEl.textContent = state;
    connStateEl.className = 'badge';
    if (state === 'connected') connStateEl.classList.add('conn-connected');
    else if (state === 'connecting' || state === 'signaling') connStateEl.classList.add('conn-connecting');
    else connStateEl.classList.add('conn-disconnected');
  },
  onPeerCountChange: (count) => {
    peerCountEl.textContent = `${count} peer${count !== 1 ? 's' : ''}`;
  }
});

// --- View switching ---
function showRoom() {
  landingSection.classList.add('hidden');
  roomSection.classList.remove('hidden');
  roomIdEl.textContent = getRoomId();
}

function showLanding() {
  roomSection.classList.add('hidden');
  landingSection.classList.remove('hidden');
  padEl.value = '';
  serviceListEl.innerHTML = '';
  serviceFrameEl.innerHTML = '';
  serviceFrameEl.classList.add('hidden');
  logEl.innerHTML = '';
}

// --- Pad binding (Yjs Y.Text ↔ textarea) ---
let _suppressTextUpdate = false;

function bindPad() {
  const doc = getDoc();
  if (!doc) return;
  const ytext = doc.getText('pad');

  // Yjs → textarea
  ytext.observe(() => {
    if (_suppressTextUpdate) return;
    const val = ytext.toString();
    if (padEl.value !== val) {
      const start = padEl.selectionStart;
      const end = padEl.selectionEnd;
      padEl.value = val;
      padEl.setSelectionRange(start, end);
    }
  });

  // textarea → Yjs
  padEl.addEventListener('input', () => {
    _suppressTextUpdate = true;
    const newVal = padEl.value;
    const ytext = doc.getText('pad');
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, newVal);
    });
    _suppressTextUpdate = false;
  });
}

// --- Service list rendering ---
function renderServiceList(services) {
  serviceListEl.innerHTML = '';
  for (const svc of services) {
    const el = document.createElement('div');
    el.className = 'service-entry';
    el.textContent = svc.name;
    el.addEventListener('click', async () => {
      serviceFrameEl.classList.remove('hidden');
      await renderService(serviceFrameEl, svc.encoded);
    });
    serviceListEl.appendChild(el);
  }
}

// --- Event handlers ---

createBtn.addEventListener('click', async () => {
  const { key, roomId } = await createRoom();
  const url = `${location.origin}${location.pathname}#${key}`;
  history.replaceState(null, '', location.pathname);
  showRoom();
  bindPad();

  // Observe service changes
  onServicesChange(getDoc(), renderServiceList);

  log(`room ${roomId} created`, 'success');
  log(`share link: ${url}`, 'info');

  // Copy link to clipboard
  try { await navigator.clipboard.writeText(url); log('link copied to clipboard', 'info'); }
  catch { /* clipboard may not be available */ }
});

joinBtn.addEventListener('click', async () => {
  const input = joinInput.value.trim();
  if (!input) return;
  const key = extractKey(input);
  if (!key) { log('invalid room link or key', 'error'); return; }
  await _joinWithKey(key);
});

copyLinkBtn.addEventListener('click', async () => {
  // Re-export key to build link (key is in room.js memory)
  // For now, log that we can't re-export — user should save the original link
  log('copy the original room link from the log above', 'info');
});

leaveBtn.addEventListener('click', () => {
  leaveRoom();
  showLanding();
});

// Service modal
addServiceBtn.addEventListener('click', () => {
  addServiceModal.classList.remove('hidden');
  serviceNameInput.value = '';
  serviceHtmlInput.value = '';
  serviceNameInput.focus();
});

serviceCancelBtn.addEventListener('click', () => {
  addServiceModal.classList.add('hidden');
});

serviceSubmitBtn.addEventListener('click', async () => {
  const name = serviceNameInput.value.trim();
  const html = serviceHtmlInput.value.trim();
  if (!name || !html) return;
  await registerService(getDoc(), name, html);
  addServiceModal.classList.add('hidden');
});

// --- Fragment parsing ---
function extractKey(input) {
  // Full URL: hidden.seaof.glass/quartz/#KEY
  if (input.includes('#')) {
    return input.split('#').pop();
  }
  // Raw base64url key (43 chars)
  if (/^[A-Za-z0-9_-]{43}$/.test(input)) {
    return input;
  }
  return null;
}

async function _joinWithKey(key) {
  try {
    await joinRoom(key);
    history.replaceState(null, '', location.pathname);
    showRoom();
    bindPad();
    onServicesChange(getDoc(), renderServiceList);
    // Initial service render
    renderServiceList(listServices(getDoc()));
    log(`joined room ${getRoomId()}`, 'success');
  } catch (e) {
    log(`join failed: ${e.message}`, 'error');
  }
}

// --- Auto-join from URL fragment ---
async function init() {
  const hash = location.hash.slice(1);
  if (hash && hash.length >= 43) {
    await _joinWithKey(hash);
  }
}

init();
