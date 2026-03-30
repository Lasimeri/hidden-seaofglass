// ui.js — ZeroNet-like page browser with ittybitty editor

import { createRoom, joinRoom, leaveRoom, setRoomLogger, setRoomCallbacks, getDoc, getRoomId, getExportedKey } from './room.js?v=3';
import { setSignalingLogger } from './signaling.js?v=3';
import { savePage, getPageContent, listPages, renderPage, onPagesChange, setPagesLogger } from './pages.js?v=3';

const $ = (s) => document.querySelector(s);

// --- DOM refs ---
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
const addressInput = $('#address-input');
const goBtn = $('#go-btn');
const newPageBtn = $('#new-page-btn');
const pageListEl = $('#page-list');
const pageViewer = $('#page-viewer');
const viewerTitle = $('#viewer-title');
const editPageBtn = $('#edit-page-btn');
const viewerFrame = $('#viewer-frame');
const editorSection = $('#editor-section');
const editorPageName = $('#editor-page-name');
const editorType = $('#editor-type');
const editorSaveBtn = $('#editor-save-btn');
const editorCancelBtn = $('#editor-cancel-btn');
const editorPane = $('#editor-pane');
const previewContainer = $('#preview-container');
const counterRaw = $('#counter-raw');
const counterCompressed = $('#counter-compressed');
const logEl = $('#log');

let _cmEditor = null;
let _currentPage = null;
let _roomKey = null;

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
setPagesLogger(log);

// --- Room callbacks ---
setRoomCallbacks({
  onStateChange: (state) => {
    connStateEl.textContent = state;
    connStateEl.className = 'badge';
    if (state === 'connected') connStateEl.classList.add('conn-connected');
    else if (state === 'connecting') connStateEl.classList.add('conn-connecting');
    else connStateEl.classList.add('conn-disconnected');
  },
  onPeerCountChange: (count) => {
    peerCountEl.textContent = `${count} peer${count !== 1 ? 's' : ''}`;
  }
});

// --- View management ---
function showRoom() {
  landingSection.classList.add('hidden');
  roomSection.classList.remove('hidden');
  roomIdEl.textContent = getRoomId();
}

function showLanding() {
  roomSection.classList.add('hidden');
  landingSection.classList.remove('hidden');
  pageListEl.innerHTML = '';
  viewerFrame.innerHTML = '';
  pageViewer.classList.add('hidden');
  editorSection.classList.add('hidden');
  logEl.innerHTML = '';
  _currentPage = null;
  _cmEditor = null;
}

// --- Page list rendering ---
function renderPageList(pages) {
  pageListEl.innerHTML = '';
  if (pages.length === 0) {
    pageListEl.innerHTML = '<div class="page-empty">no pages yet — create one</div>';
    return;
  }
  for (const page of pages) {
    const el = document.createElement('div');
    el.className = 'page-entry';
    if (page.name === _currentPage) el.classList.add('active');
    el.innerHTML = `<span class="page-name">${escapeHTML(page.name)}</span><span class="page-type">${page.type}</span>`;
    el.addEventListener('click', () => navigateTo(page.name));
    pageListEl.appendChild(el);
  }
}

// --- Navigation ---
async function navigateTo(pageName) {
  if (!pageName) return;
  _currentPage = pageName;
  addressInput.value = pageName;
  editorSection.classList.add('hidden');
  pageViewer.classList.remove('hidden');
  viewerTitle.textContent = pageName;
  await renderPage(viewerFrame, getDoc(), pageName);
  // Update active state in page list
  renderPageList(listPages(getDoc()));
}

// --- Editor ---
async function openEditor(pageName, existingContent, existingType) {
  pageViewer.classList.add('hidden');
  editorSection.classList.remove('hidden');
  editorPageName.value = pageName || '';
  editorType.value = existingType || 'html';

  if (!_cmEditor) {
    const { EditorView, EditorState, basicSetup, html, markdown: mdLang, oneDark } =
      await import('../lib/codemirror-bundle.js');

    const langMap = {
      html: html(),
      markdown: mdLang(),
      text: [],
    };

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) schedulePreview();
    });

    _cmEditor = {
      view: new EditorView({
        state: EditorState.create({
          doc: existingContent || '',
          extensions: [basicSetup, oneDark, langMap.html, updateListener],
        }),
        parent: editorPane,
      }),
      EditorView, EditorState, basicSetup, oneDark, langMap, updateListener,
    };
  } else {
    const { view, EditorState, basicSetup, oneDark, langMap, updateListener } = _cmEditor;
    const type = editorType.value;
    view.setState(EditorState.create({
      doc: existingContent || '',
      extensions: [basicSetup, oneDark, langMap[type] || [], updateListener],
    }));
  }

  editorPageName.focus();
  schedulePreview();
}

let _previewTimer = null;
function schedulePreview() {
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(updatePreview, 300);
}

function updatePreview() {
  if (!_cmEditor) return;
  const content = _cmEditor.view.state.doc.toString();
  const rawBytes = new TextEncoder().encode(content).length;
  counterRaw.textContent = `raw: ${formatBytes(rawBytes)}`;
  // Preview not implemented inline (would need render.js), skip for now
  previewContainer.innerHTML = `<div style="padding:0.5rem;color:#8a6a3e;font-size:0.7rem">${formatBytes(rawBytes)} — save to preview in iframe</div>`;
}

// --- Event handlers ---

createBtn.addEventListener('click', async () => {
  const { key } = await createRoom();
  _roomKey = key;
  const url = `${location.origin}${location.pathname}#${key}`;
  history.replaceState(null, '', location.pathname);
  showRoom();
  onPagesChange(getDoc(), renderPageList);
  renderPageList(listPages(getDoc()));
  log(`share link: ${url}`, 'info');
  try { await navigator.clipboard.writeText(url); log('link copied to clipboard', 'info'); } catch {}
});

joinBtn.addEventListener('click', async () => {
  const input = joinInput.value.trim();
  if (!input) return;
  const key = extractKey(input);
  if (!key) { log('invalid room link or key', 'error'); return; }
  await _joinWithKey(key);
});

goBtn.addEventListener('click', () => {
  const name = addressInput.value.trim();
  if (name) navigateTo(name);
});

addressInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const name = addressInput.value.trim();
    if (name) navigateTo(name);
  }
});

newPageBtn.addEventListener('click', () => openEditor('', '', 'html'));

editPageBtn.addEventListener('click', async () => {
  if (!_currentPage) return;
  const page = await getPageContent(getDoc(), _currentPage);
  openEditor(_currentPage, page?.content || '', page?.type || 'html');
});

editorSaveBtn.addEventListener('click', async () => {
  const name = editorPageName.value.trim();
  if (!name) { log('page name required', 'error'); return; }
  if (!_cmEditor) return;
  const content = _cmEditor.view.state.doc.toString();
  const type = editorType.value;
  await savePage(getDoc(), name, content, type);
  editorSection.classList.add('hidden');
  navigateTo(name);
});

editorCancelBtn.addEventListener('click', () => {
  editorSection.classList.add('hidden');
  if (_currentPage) {
    pageViewer.classList.remove('hidden');
  }
});

editorType.addEventListener('change', () => {
  if (!_cmEditor) return;
  const { view, EditorState, basicSetup, oneDark, langMap, updateListener } = _cmEditor;
  const type = editorType.value;
  const doc = view.state.doc.toString();
  view.setState(EditorState.create({
    doc,
    extensions: [basicSetup, oneDark, langMap[type] || [], updateListener],
  }));
});

copyLinkBtn.addEventListener('click', async () => {
  if (_roomKey) {
    const url = `${location.origin}${location.pathname}#${_roomKey}`;
    try {
      await navigator.clipboard.writeText(url);
      log('link copied', 'info');
    } catch {}
  }
});

leaveBtn.addEventListener('click', () => {
  leaveRoom();
  showLanding();
});

// --- Helpers ---
function extractKey(input) {
  if (input.includes('#')) return input.split('#').pop();
  if (/^[A-Za-z0-9_-]{43}$/.test(input)) return input;
  return null;
}

async function _joinWithKey(key) {
  try {
    _roomKey = key;
    await joinRoom(key);
    history.replaceState(null, '', location.pathname);
    showRoom();
    onPagesChange(getDoc(), renderPageList);
    renderPageList(listPages(getDoc()));
    log(`joined room ${getRoomId()}`, 'success');
  } catch (e) {
    log(`join failed: ${e.message}`, 'error');
  }
}

function escapeHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// --- Auto-join from fragment ---
(async function init() {
  const hash = location.hash.slice(1);
  if (hash && hash.length >= 43) {
    await _joinWithKey(hash);
  }
})();
