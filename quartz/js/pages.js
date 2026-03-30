// pages.js — page storage in Yjs Y.Map + sandboxed iframe rendering

let _log = () => {};
export function setPagesLogger(fn) { _log = fn; }

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; media-src data: blob:; script-src 'unsafe-inline'">`;

const DEFAULT_STYLE = `
* { box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, sans-serif;
  max-width: 720px; margin: 0 auto; padding: 1rem;
  color: #c8c8d0; background: #0a0a0f; line-height: 1.5;
}
img { max-width: 100%; height: auto; }
pre { overflow-x: auto; padding: 1rem; background: #12121a; border: 1px solid #1e1e2e; border-radius: 4px; }
code { font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; font-size: 0.9em; }
a { color: #4a9eff; }
h1,h2,h3,h4,h5,h6 { color: #e8e8f0; margin: 1.5em 0 0.5em; }
`.trim();

const RESIZE_SCRIPT = `
<script>
  new ResizeObserver(() => {
    parent.postMessage({ type: 'quartz-resize', height: document.documentElement.scrollHeight }, '*');
  }).observe(document.body);
  parent.postMessage({ type: 'quartz-resize', height: document.documentElement.scrollHeight }, '*');
<\/script>
`;

// Save a page to the Yjs doc
export async function savePage(doc, name, content, type) {
  const compressed = await gzipCompress(content);
  const encoded = bufToBase64url(new Uint8Array(compressed));
  const pagesMap = doc.getMap('pages');
  pagesMap.set(name, JSON.stringify({ encoded, type: type || 'html', updated: Date.now() }));
  _log(`saved page: ${name}`);
}

// Get a page's raw content
export async function getPageContent(doc, name) {
  const pagesMap = doc.getMap('pages');
  const raw = pagesMap.get(name);
  if (!raw) return null;
  const { encoded, type } = JSON.parse(raw);
  const compressed = base64urlToBuf(encoded);
  const content = await gzipDecompress(compressed);
  return { content, type };
}

// List all pages
export function listPages(doc) {
  const pagesMap = doc.getMap('pages');
  const pages = [];
  pagesMap.forEach((raw, name) => {
    try {
      const { type, updated } = JSON.parse(raw);
      pages.push({ name, type, updated });
    } catch {
      pages.push({ name, type: 'html', updated: 0 });
    }
  });
  return pages.sort((a, b) => b.updated - a.updated);
}

// Delete a page
export function deletePage(doc, name) {
  doc.getMap('pages').delete(name);
  _log(`deleted page: ${name}`);
}

// Render a page in a sandboxed iframe
let _resizeHandler = null;
export async function renderPage(container, doc, name) {
  container.innerHTML = '';

  // Clean up previous resize listener to prevent leaks
  if (_resizeHandler) {
    window.removeEventListener('message', _resizeHandler);
    _resizeHandler = null;
  }

  const page = await getPageContent(doc, name);
  if (!page) {
    container.innerHTML = '<div class="not-found">page not found</div>';
    return null;
  }

  const srcdoc = wrapHTML(page.content, page.type);

  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-scripts';
  iframe.srcdoc = srcdoc;
  iframe.style.width = '100%';
  iframe.style.border = 'none';
  iframe.style.minHeight = '200px';

  _resizeHandler = (e) => {
    if (e.data?.type === 'quartz-resize' && e.source === iframe.contentWindow) {
      iframe.style.height = `${e.data.height + 20}px`;
    }
  };
  window.addEventListener('message', _resizeHandler);

  container.appendChild(iframe);
  return iframe;
}

// Observe page changes
export function onPagesChange(doc, callback) {
  doc.getMap('pages').observe(() => {
    callback(listPages(doc));
  });
}

// --- helpers ---

export function wrapHTML(body, type) {
  let rendered = body;
  if (type === 'text') {
    rendered = `<pre>${escapeHTML(body)}</pre>`;
  }
  // TODO: markdown type renders as raw HTML (no markdown parser).
  // Adding marked.js as a dependency is deferred — would need bundling or CDN import.
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${CSP}
<style>${DEFAULT_STYLE}</style>
</head><body>${rendered}${RESIZE_SCRIPT}</body></html>`;
}

function escapeHTML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function gzipCompress(text) {
  const encoded = new TextEncoder().encode(text);
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(encoded);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result.buffer;
}

async function gzipDecompress(data) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(result);
}

function bufToBase64url(buf) {
  let binary = '';
  // Chunked to avoid stack overflow on large arrays
  for (let i = 0; i < buf.length; i += 8192) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuf(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  const binary = atob(b64 + '='.repeat(pad));
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}
