// services.js — ittybitty hidden service registry + sandboxed iframe rendering

let _log = () => {};
export function setServicesLogger(fn) { _log = fn; }

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; media-src data: blob:; script-src 'unsafe-inline'">`;

const DEFAULT_STYLE = `
* { box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, sans-serif;
  max-width: 720px; margin: 0 auto; padding: 1rem;
  color: #c8c8d0; background: #0a0a0f; line-height: 1.5;
}
`.trim();

const RESIZE_SCRIPT = `
<script>
  new ResizeObserver(() => {
    parent.postMessage({ type: 'quartz-resize', height: document.documentElement.scrollHeight }, '*');
  }).observe(document.body);
  parent.postMessage({ type: 'quartz-resize', height: document.documentElement.scrollHeight }, '*');
<\/script>
`;

// Register a service in the Yjs doc
export async function registerService(doc, name, htmlContent) {
  const compressed = await gzipCompress(htmlContent);
  const encoded = bufToBase64url(new Uint8Array(compressed));
  const servicesMap = doc.getMap('services');
  servicesMap.set(name, encoded);
  _log(`registered service: ${name}`);
}

// List all services
export function listServices(doc) {
  const servicesMap = doc.getMap('services');
  const services = [];
  servicesMap.forEach((encoded, name) => {
    services.push({ name, encoded });
  });
  return services;
}

// Remove a service
export function removeService(doc, name) {
  doc.getMap('services').delete(name);
  _log(`removed service: ${name}`);
}

// Render a service in a sandboxed iframe
export async function renderService(container, encoded) {
  container.innerHTML = '';

  const compressed = base64urlToBuf(encoded);
  const html = await gzipDecompress(compressed);

  const srcdoc = wrapHTML(html);

  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-scripts'; // no allow-same-origin
  iframe.srcdoc = srcdoc;
  iframe.style.width = '100%';
  iframe.style.border = 'none';
  iframe.style.minHeight = '200px';

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'quartz-resize' && e.source === iframe.contentWindow) {
      iframe.style.height = `${e.data.height + 20}px`;
    }
  });

  container.appendChild(iframe);
  return iframe;
}

// Observe service changes
export function onServicesChange(doc, callback) {
  doc.getMap('services').observe(() => {
    callback(listServices(doc));
  });
}

// --- helpers ---

function wrapHTML(body) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${CSP}
<style>${DEFAULT_STYLE}</style>
</head><body>${body}${RESIZE_SCRIPT}</body></html>`;
}

async function gzipCompress(text) {
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
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
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
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(result);
}

function bufToBase64url(buf) {
  let binary = '';
  for (const byte of buf) binary += String.fromCharCode(byte);
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
