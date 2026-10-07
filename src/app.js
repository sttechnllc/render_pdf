'use strict';
/* Mark's Render PDF Editor – single-file, offline. Viewing: pdf.js, writing: pdf-lib. */
const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle, BlendMode } = PDFLib;
// Run pdf.js parsing/rendering in a real background thread (the worker code is embedded in this file)
(() => {
  const src = document.getElementById('pdfWorkerSrc');
  if (!src) return; // dev mode: worker script was loaded normally (main-thread fallback)
  try {
    const url = URL.createObjectURL(new Blob([src.textContent], { type: 'text/javascript' }));
    // one shared worker object: closing a document must never shut the worker down for the others
    window.PDFW = new pdfjsLib.PDFWorker({ port: new Worker(url) });
  } catch (e) {
    const sc = document.createElement('script'); sc.textContent = src.textContent; document.head.append(sc);
  }
})();
// Open a PDF with pdf.js (always through the shared worker; eval disabled for safety)
const pdfOpen = params => pdfjsLib.getDocument({ isEvalSupported: false, ...params, ...(window.PDFW ? { worker: window.PDFW } : {}) });
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

// Pages: {id, src, idx, baseRot, rot, w, h, annots[]}   (src -1 = blank page; w/h = size as originally displayed)
// Annots are stored in PDF points relative to the page as displayed (top-left origin).
const S = {
  sources: [], pages: [], images: {}, imageIds: {},
  zoom: 1, tool: 'select', sel: null, selPages: new Set(), current: 0,
  undo: [], redo: [], name: 'document.pdf', dirty: false, stamp: null,
  def: { font: 'Helvetica', size: 14, bold: false, color: '#000000', lw: 2 },
  forms: {}, formsDirty: {}, fileHandle: null, clip: null, zoomed: false,
};
let uid = 0;
const nid = () => 'i' + Date.now().toString(36) + (uid++).toString(36);

// Browser font used on screen + where its baseline sits inside a 1.2 line box (matches Arial/Times/Courier metrics)
const FONTS = {
  Helvetica: { css: 'Arial, Helvetica, sans-serif', base: 0.947, std: ['Helvetica', 'HelveticaBold'] },
  Times: { css: '"Times New Roman", Times, serif', base: 0.9375, std: ['TimesRoman', 'TimesRomanBold'] },
  Courier: { css: '"Courier New", Courier, monospace', base: 0.866, std: ['Courier', 'CourierBold'] },
};

const HINTS = {
  select: 'Click an item to select it. Drag to move, corner to resize, double-click text to edit. Press ? for shortcuts.',
  edittext: 'Click any text in the PDF to change it.',
  text: 'Click anywhere on a page and start typing.',
  place: 'Click on the page where it should go. (Esc to cancel)',
  highlight: 'Drag across the text you want to highlight.',
  whiteout: 'Drag a box over anything you want to hide.',
  draw: 'Hold the mouse button and draw.',
  check: 'Click to place a check mark.',
  cross: 'Click to place an X.',
  date: "Click to place today's date.",
  area: 'Drag a box around anything: copy its text (OCR for scans), copy as image, move or duplicate it.',
};

/* ---------------- helpers ---------------- */
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}
const pageById = id => S.pages.find(p => p.id === id);
const pageEl = p => document.querySelector(`.page[data-id="${p.id}"]`);
function dims(p) { return p.rot % 180 ? { w: p.h, h: p.w } : { w: p.w, h: p.h }; }
function totalRot(p) { return (p.baseRot + p.rot) % 360; }
function findAnnot(id) {
  for (const p of S.pages) { const a = p.annots.find(a => a.id === id); if (a) return { p, a }; }
  return null;
}
function readFile(f, as = 'arrayBuffer') {
  return new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej;
    as === 'url' ? r.readAsDataURL(f) : r.readAsArrayBuffer(f);
  });
}
function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
// Forget pictures nothing refers to any more (pages, undo/redo history, clipboard, current stamp)
function pruneImages() {
  const used = JSON.stringify([S.pages, S.undo, S.redo, S.clip, S.stamp]);
  for (const id of Object.keys(S.images)) if (!used.includes(id)) { delete S.imageIds[S.images[id]]; delete S.images[id]; }
}
function registerImage(dataUrl) {
  if (S.imageIds[dataUrl]) return S.imageIds[dataUrl];
  const id = nid(); S.images[id] = dataUrl; S.imageIds[dataUrl] = id; return id;
}
// Normalise any picture to PNG (or keep JPEG) so pdf-lib can embed it
async function imageToDataUrl(file) {
  const url = await readFile(file, 'url');
  if (/^data:image\/(png|jpeg)/.test(url)) return url;
  const img = await loadImg(url);
  const c = el('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/png');
}
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); }
function download(bytes, name, type = 'application/pdf') {
  const a = el('a'); a.href = URL.createObjectURL(bytes instanceof Blob ? bytes : new Blob([bytes], { type }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ---------------- undo ---------------- */
function updateTitle() { document.title = (S.dirty ? '• ' : '') + S.name + " – Mark's Render PDF Editor"; }
function snap() {
  S.undo.push(JSON.stringify({ p: S.pages, f: S.forms }));
  let tot = 0; // keep undo history under ~100 MB and 150 steps
  for (let i = S.undo.length - 1; i >= 0; i--) { tot += S.undo[i].length; if (tot > 50e6 || S.undo.length - i > 150) { S.undo.splice(0, i + 1); break; } }
  S.rev = (S.rev || 0) + 1;
  S.redo = []; S.dirty = true; updateButtons(); updateTitle();
}
function undoRedo(from, to) {
  commitEditing();
  if (!from.length) return;
  to.push(JSON.stringify({ p: S.pages, f: S.forms }));
  const st = JSON.parse(from.pop());
  S.pages = st.p || st; if (st.f) S.forms = st.f;
  S.rev = (S.rev || 0) + 1;
  S.sel = null; S.selPages = new Set([...S.selPages].filter(id => pageById(id)));
  S.current = Math.min(S.current, Math.max(0, S.pages.length - 1));
  S.dirty = true; refreshAll(true);
}
const undo = () => undoRedo(S.undo, S.redo);
const redo = () => undoRedo(S.redo, S.undo);
function updateButtons() {
  $('#bUndo').disabled = !S.undo.length; $('#bRedo').disabled = !S.redo.length;
  const none = !S.pages.length;
  ['#bSave', '#bSaveAs', '#sRotL', '#sRotR', '#sDel', '#sExtract'].forEach(s => $(s).disabled = none);
}

/* ---------------- loading ---------------- */
async function loadPdf(bytes, name) {
  let doc;
  try {
    doc = await pdfOpen({ data: bytes.slice(), isEvalSupported: false }).promise;
  } catch (e) {
    toast(e && e.name === 'PasswordException' ? `"${name}" is password-protected – remove the password first.` : `Could not open "${name}".`, 5000);
    throw e;
  }
  const src = S.sources.push({ name, bytes, doc, pg: {} }) - 1;
  const pgs = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
  return pgs.map((pg, i) => {
    const vp = pg.getViewport({ scale: 1 });
    S.sources[src].pg[i] = pg;
    return { id: nid(), src, idx: i, baseRot: pg.rotate, rot: 0, w: vp.width, h: vp.height, annots: [] };
  });
}
async function imagePage(file) {
  const url = await imageToDataUrl(file);
  const img = await loadImg(url);
  let w = img.naturalWidth * 0.75, h = img.naturalHeight * 0.75;
  const k = Math.min(1, 842 / Math.max(w, h)); w *= k; h *= k;
  return { id: nid(), src: -1, idx: 0, baseRot: 0, rot: 0, w, h,
    annots: [{ id: nid(), type: 'image', img: registerImage(url), x: 0, y: 0, w, h }] };
}
async function filesToPages(files) {
  const out = [];
  for (const f of files) {
    try {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) out.push(...await loadPdf(new Uint8Array(await readFile(f)), f.name));
      else if (f.type.startsWith('image/')) out.push(await imagePage(f));
      else toast(`Skipped "${f.name}" – not a PDF or image.`);
    } catch (e) { console.error(e); }
  }
  return out;
}
async function openFiles(files) {
  files = [...files]; if (!files.length) return;
  if (S.dirty && S.pages.length && !confirm('Discard your unsaved changes and open a new file?')) return;
  const firstNew = S.sources.length;
  const pages = await filesToPages(files);
  if (!pages.length) return;
  for (let i = 0; i < firstNew; i++) freeSource(i);
  thumbCache.clear(); findCache.clear(); contentsFor = null;
  if (typeof SR !== 'undefined') { SR.results = []; SR.byPage.clear(); $('#sResults').innerHTML = ''; $('#sStatus').textContent = ''; }
  S.images = {}; S.imageIds = {}; S.clip = null;
  S.pages = pages; S.undo = []; S.redo = []; S.sel = null; S.selPages.clear(); S.current = 0; S.dirty = false;
  S.name = files[0].name.replace(/\.[^.]+$/, '') + '.pdf';
  S.fileHandle = null; S.forms = {}; S.formsDirty = {}; S.meta = null; updateTitle();
  fitWidth(true); refreshAll(); setTool('select');
  backgroundIndex();
}
// Quietly read every page's text while the user looks at the document → the first search is instant
async function backgroundIndex() {
  const pages = S.pages.slice(), idle = () => new Promise(r => (window.requestIdleCallback || setTimeout)(r));
  for (let i = 0; i < pages.length; i += 16) {
    if (S.pages[0] !== pages[0]) return; // another file was opened
    await idle(); await Promise.all(pages.slice(i, i + 16).map(p => pageText(p).catch(() => {})));
  }
}
async function addFiles(files, at = S.pages.length) {
  files = [...files]; if (!files.length) return;
  if (!S.pages.length) return openFiles(files);
  const pages = await filesToPages(files);
  if (!pages.length) return;
  snap(); S.pages.splice(at, 0, ...pages); refreshAll();
  toast(`Added ${pages.length} page${pages.length > 1 ? 's' : ''}.`);
}
function freeSource(i) {
  const s = S.sources[i]; if (!s) return;
  try { s.doc.destroy(); } catch { }
  for (const [k, v] of erasedCache) if (k.startsWith(i + '|')) { v.then(r => r.pdf?.destroy()).catch(() => {}); erasedCache.delete(k); }
  delete libCache[i]; S.sources[i] = null;
}
function newBlank() {
  if (S.dirty && S.pages.length && !confirm('Discard your unsaved changes and start a new blank document?')) return;
  S.sources.forEach((_, i) => freeSource(i));
  thumbCache.clear(); findCache.clear(); contentsFor = null; resetSearch('');
  S.images = {}; S.imageIds = {}; S.clip = null; S.sel = null; S.selPages.clear(); S.current = 0;
  S.fileHandle = null; S.forms = {}; S.formsDirty = {};
  S.pages = [{ id: nid(), src: -1, idx: 0, baseRot: 0, rot: 0, w: 612, h: 792, annots: [] }];
  S.undo = []; S.redo = []; S.name = 'document.pdf'; S.dirty = true; updateTitle(); fitWidth(true); refreshAll();
}

/* ---------------- rendering ---------------- */
async function getPg(p) {
  if (p.erase?.length) return (await erasedPage(p)).pg;
  const s = S.sources[p.src];
  return s.pg[p.idx] || (s.pg[p.idx] = await s.doc.getPage(p.idx + 1));
}
// A page with edited text is previewed from a real re-written copy, so the screen matches the saved file
const libCache = {}, erasedCache = new Map(); // erasedCache: insertion-ordered → oldest first
const libFor = src => libCache[src] || (libCache[src] = PDFDocument.load(S.sources[src].bytes, { ignoreEncryption: true, updateMetadata: false }));
function erasedPage(p) {
  const key = `${p.src}|${p.idx}|${JSON.stringify(p.erase)}`;
  if (!erasedCache.has(key)) erasedCache.set(key, (async () => {
    const doc = await PDFDocument.create(), [cp] = await doc.copyPages(await libFor(p.src), [p.idx]);
    doc.addPage(cp);
    const hits = eraseText(doc, cp, p.erase);
    const pdf = await pdfOpen({ data: await doc.save(), isEvalSupported: false }).promise;
    return { pg: await pdf.getPage(1), hits, pdf };
  })());
  // keep a couple of versions per page (undo/redo), destroy older ones so memory doesn't grow
  const prefix = `${p.src}|${p.idx}|`, mine = [...erasedCache.keys()].filter(k => k.startsWith(prefix));
  const all = [...erasedCache.keys()];
  for (const k of new Set([...mine.slice(0, -3), ...all.slice(0, Math.max(0, all.length - 30))])) { if (k === key || !erasedCache.has(k)) continue; erasedCache.get(k).then(r => r.pdf.destroy()).catch(() => {}); erasedCache.delete(k); }
  return erasedCache.get(key);
}
function repaint(p) {
  const w = pageEl(p);
  if (w) { w._task?.cancel(); w._painted = false; w._tl = false; w.querySelector('.tl').innerHTML = ''; paintPage(w); }
  const t = document.querySelector(`.thumb[data-id="${p.id}"]`);
  if (t) { t._painted = false; paintThumb(t); }
}
const io = new IntersectionObserver(es => es.forEach(e => e.isIntersecting && paintPage(e.target)),
  { root: $('#view'), rootMargin: '900px 0px' });
// pages that scroll far away give their memory back (big documents stay fast)
const rio = new IntersectionObserver(es => es.forEach(e => !e.isIntersecting && unpaintPage(e.target)),
  { root: $('#view'), rootMargin: '3500px 0px' });
function unpaintPage(w) {
  if (!w._painted || w.contains(document.activeElement)) return;
  w._task?.cancel(); w._task = null; w._painted = false; w._tl = false;
  const c = w.querySelector('canvas'); c.width = c.height = 0;
  w.querySelector('.tl').innerHTML = ''; w.querySelector('.fl').innerHTML = ''; w.querySelector('.sl').innerHTML = '';
  const p = pageById(w.dataset.id); if (p && p.src >= 0 && !p.erase?.length) S.sources[p.src]?.pg[p.idx]?.cleanup();
}

function refreshAll(keepScroll) {
  if (typeof resetSearch === 'function' && SR.results.length) resetSearch('The document changed – search again.');
  buildThumbs(); buildView(keepScroll); updateButtons(); updateProps();
}
function buildView(keepScroll) {
  const view = $('#view'), cont = $('#pages');
  const ratio = keepScroll && cont.scrollHeight ? view.scrollTop / cont.scrollHeight : 0;
  for (const w of cont.children) w._task?.cancel();
  io.disconnect(); rio.disconnect(); cont.innerHTML = ''; cont._z = S.zoom; cont.style.transform = '';
  $('#empty').hidden = S.pages.length > 0;
  const frag = document.createDocumentFragment();
  S.pages.forEach((p, i) => {
    const d = dims(p), z = S.zoom, w = el('div', 'page');
    w.dataset.id = p.id;
    w.style.width = d.w * z + 'px'; w.style.height = d.h * z + 'px';
    w.innerHTML = `<canvas></canvas><div class="sl"></div><div class="tl"></div><div class="al"></div><div class="fl"></div><div class="pn">${i + 1} / ${S.pages.length}</div>`;
    frag.append(w); io.observe(w); rio.observe(w);
  });
  cont.append(frag);
  $$('#pages .page').forEach((w, i) => renderAnnots(S.pages[i], w)); // measure text boxes once attached
  if (keepScroll) view.scrollTop = ratio * cont.scrollHeight;
  updateZoomSel(); updateNav();
}
async function paintPage(w) {
  if (w._painted) return; w._painted = true;
  const gen = w._gen = (w._gen || 0) + 1, stale = () => !w.isConnected || !w._painted || gen !== w._gen;
  const p = pageById(w.dataset.id); if (!p) return;
  const d = dims(p), z = S.zoom * DPR(), c = el('canvas'); // render off-screen, then swap (no flicker)
  c.width = Math.ceil(d.w * z); c.height = Math.ceil(d.h * z);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  if (p.src >= 0) {
    const pg = await getPg(p);
    if (stale()) return;
    w._task = pg.render({ canvasContext: ctx, viewport: pg.getViewport({ scale: z, rotation: totalRot(p) }), annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS });
    try { await w._task.promise; } catch (e) { if (e?.name === 'RenderingCancelledException') return; }
    w._task = null;
    if (stale()) return;
    buildFormLayer(w, p, pg);
    if (S.tool === 'edittext') buildTextLayer(w, p, pg);
  }
  w.querySelector('canvas').replaceWith(c);
  drawSearchMarks(w, p);
}

// Invisible clickable boxes over the existing text, used by the "Edit text" tool
async function buildTextLayer(w, p, pg) {
  if (w._tl) return; w._tl = true;
  const vp = pg.getViewport({ scale: 1, rotation: totalRot(p) });
  const tc = await pg.getTextContent();
  const runs = [];
  for (const it of tc.items) {
    if (!it.str) continue;
    const t = pdfjsLib.Util.transform(vp.transform, it.transform);
    if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue; // skip rotated text
    const fh = Math.abs(t[3]); if (fh < 1) continue;
    const r = { x: t[4], base: t[5], fh, w: Math.abs(it.width), str: it.str,
      fam: (tc.styles[it.fontName] || {}).fontFamily || '', font: it.fontName };
    const last = runs[runs.length - 1];
    // merge pieces that sit on the same line next to each other
    if (last && Math.abs(last.base - r.base) < fh * 0.2 && Math.abs(last.fh - fh) < fh * 0.2 &&
        r.x - (last.x + last.w) < fh * 0.8 && r.x - (last.x + last.w) > -fh) {
      const gap = r.x - (last.x + last.w);
      if (gap > fh * 0.15 && !/\s$/.test(last.str) && !/^\s/.test(r.str)) last.str += ' ';
      last.str += r.str; last.w = r.x + r.w - last.x;
    } else if (it.str.trim()) runs.push(r);
  }
  const tl = w.querySelector('.tl'), z = S.zoom;
  w._runs = runs;
  runs.forEach((r, i) => {
    if (!r.str.trim()) return;
    const s = el('div', 'ts'); s.dataset.i = i;
    Object.assign(s.style, { left: r.x * z + 'px', top: (r.base - r.fh * 0.9) * z + 'px', width: r.w * z + 'px', height: r.fh * 1.15 * z + 'px' });
    s.title = 'Click to edit';
    tl.append(s);
  });
}

function renderAnnots(p, w = pageEl(p)) {
  if (!w) return;
  const al = w.querySelector('.al'); al.innerHTML = '';
  for (const a of p.annots) {
    const e = annotEl(a); al.append(e);
    if (a.type === 'text') { a.w = e.offsetWidth / S.zoom; a.h = e.offsetHeight / S.zoom; }
  }
}
function annotEl(a) {
  const z = S.zoom, e = el('div', 'an ' + a.type + (S.sel === a.id ? ' sel' : ''));
  e.dataset.id = a.id;
  e.style.left = a.x * z + 'px'; e.style.top = a.y * z + 'px';
  if (a.type === 'text') {
    e.textContent = a.text;
    Object.assign(e.style, { fontFamily: (a.css ? `"${a.css}", ` : '') + (a.css2 ? `"${a.css2}", ` : '') + FONTS[a.font].css, fontSize: a.size * z + 'px', color: a.color, fontWeight: a.bold ? 'bold' : 'normal' });
    if (a.angle) { e.style.transformOrigin = `0 ${FONTS[a.font].base * a.size * z}px`; e.style.transform = `rotate(${-a.angle}deg)`; }
    if (a.op != null && a.op < 1) e.style.opacity = a.op;
  } else {
    e.style.width = a.w * z + 'px'; e.style.height = a.h * z + 'px';
    if (a.type === 'rect') {
      e.style.background = a.color; e.style.opacity = a.op ?? 1;
      if (a.blend) e.style.mixBlendMode = a.blend;
    } else if (a.type === 'image' || a.type === 'clip') {
      const i = el('img'); i.src = S.images[a.img]; i.draggable = false; e.append(i);
    } else if (a.type === 'ink') {
      e.innerHTML = `<svg viewBox="0 0 1000 1000" preserveAspectRatio="none">${a.strokes.map(s =>
        `<polyline points="${s.map(q => (q[0] * 1000).toFixed(1) + ',' + (q[1] * 1000).toFixed(1)).join(' ')}" fill="none" stroke="${a.color}" stroke-width="${a.lw * z}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`).join('')}</svg>`;
    }
  }
  if (S.sel === a.id) e.append(el('div', 'h'));
  return e;
}

/* ---------------- thumbnails ---------------- */
const thumbCache = new Map();
const tio = new IntersectionObserver(es => es.forEach(e => e.isIntersecting && paintThumb(e.target)),
  { root: $('#thumbs'), rootMargin: '400px 0px' });
function buildThumbs() {
  const box = $('#thumbs'); tio.disconnect(); box.innerHTML = '';
  S.pages.forEach((p, i) => {
    const d = dims(p), k = Math.min(150 / d.w, 190 / d.h);
    const t = el('div', 'thumb' + (S.selPages.has(p.id) ? ' sel' : '') + (i === S.current ? ' cur' : ''));
    t.dataset.id = p.id; t.draggable = true;
    t.innerHTML = `<canvas style="width:${d.w * k}px;height:${d.h * k}px"></canvas><div class="n">${i + 1}</div>
      <div class="tb"><button data-a="rot" title="Rotate">⟳</button><button data-a="del" title="Delete page">✕</button></div>`;
    t._k = k; box.append(t); tio.observe(t);
  });
}
async function paintThumb(t) {
  if (t._painted) return; t._painted = true;
  const p = pageById(t.dataset.id); if (!p) return;
  const d = dims(p), k = t._k * DPR(), c = t.querySelector('canvas');
  c.width = Math.ceil(d.w * k); c.height = Math.ceil(d.h * k);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  if (p.src >= 0) {
    const key = `${p.src}|${p.idx}|${totalRot(p)}|${JSON.stringify(p.erase || [])}`;
    let cached = thumbCache.get(key);
    if (!cached) {
      const pg = await getPg(p);
      cached = el('canvas'); cached.width = c.width; cached.height = c.height;
      await pg.render({ canvasContext: cached.getContext('2d'), viewport: pg.getViewport({ scale: k, rotation: totalRot(p) }) }).promise.catch(() => {});
      thumbCache.set(key, cached);
      if (thumbCache.size > 80) thumbCache.delete(thumbCache.keys().next().value); // oldest out
    }
    ctx.drawImage(cached, 0, 0, c.width, c.height);
  }
  for (const a of p.annots) { // show pictures/boxes so image pages aren't blank
    if (a.type === 'image' || a.type === 'clip') { const i = await loadImg(S.images[a.img]); ctx.drawImage(i, a.x * k, a.y * k, a.w * k, a.h * k); }
    else if (a.type === 'rect') { ctx.globalAlpha = a.op ?? 1; ctx.fillStyle = a.color; ctx.fillRect(a.x * k, a.y * k, a.w * k, a.h * k); ctx.globalAlpha = 1; }
  }
}
function setCurrent(i, scroll) {
  if (i < 0 || i >= S.pages.length) return;
  S.current = i;
  document.querySelector('.thumb.cur')?.classList.remove('cur');
  $('#thumbs').children[i]?.classList.add('cur');
  updateNav();
  $('#pageLbl').textContent = S.pages.length ? `Page ${i + 1} / ${S.pages.length}` : '';
  if (scroll) pageEl(S.pages[i])?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
$('#view').addEventListener('scroll', () => {
  if (setCurrent.busy) return; setCurrent.busy = true;
  requestAnimationFrame(() => {
    setCurrent.busy = false;
    const v = $('#view'), mid = v.scrollTop + v.clientHeight / 3, pages = $('#pages').children;
    let lo = 0, hi = pages.length - 1, best = 0; // binary search – fast even with thousands of pages
    while (lo <= hi) { const m = (lo + hi) >> 1; if (pages[m].offsetTop <= mid) { best = m; lo = m + 1; } else hi = m - 1; }
    if (best !== S.current) {
      setCurrent(best);
      $('#thumbs').children[best]?.scrollIntoView({ block: 'nearest' });
    }
  });
});

/* thumbnail clicks / buttons */
$('#thumbs').addEventListener('click', e => {
  const t = e.target.closest('.thumb'); if (!t) return;
  const p = pageById(t.dataset.id), i = S.pages.indexOf(p);
  const act = e.target.closest('button')?.dataset.a;
  if (act === 'rot') return rotatePages([p.id], 90);
  if (act === 'del') return deletePages([p.id]);
  if (e.ctrlKey || e.metaKey) S.selPages.has(p.id) ? S.selPages.delete(p.id) : S.selPages.add(p.id);
  else if (e.shiftKey) {
    const a = Math.min(S.current, i), b = Math.max(S.current, i);
    for (let j = a; j <= b; j++) S.selPages.add(S.pages[j].id);
  } else S.selPages = new Set([p.id]);
  $$('.thumb').forEach(th => th.classList.toggle('sel', S.selPages.has(th.dataset.id)));
  setCurrent(i, true);
});

/* drag & drop reordering (+ dropping files into the page list) */
let dragIds = null;
$('#thumbs').addEventListener('dragstart', e => {
  const t = e.target.closest('.thumb'); if (!t) return;
  if (!S.selPages.has(t.dataset.id)) { S.selPages = new Set([t.dataset.id]); $$('.thumb').forEach(th => th.classList.toggle('sel', S.selPages.has(th.dataset.id))); }
  dragIds = S.pages.filter(p => S.selPages.has(p.id)).map(p => p.id);
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'pages');
});
function dropTarget(e) {
  const ts = $$('.thumb');
  for (let i = 0; i < ts.length; i++) {
    const r = ts[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) return i;
  }
  return ts.length;
}
function clearDropMarks() { $$('.thumb').forEach(t => t.classList.remove('dropB', 'dropA')); $('#thumbs').classList.remove('dropfile'); }
$('#thumbs').addEventListener('dragover', e => {
  e.preventDefault(); e.stopPropagation(); clearDropMarks();
  const ts = $$('.thumb'), i = dropTarget(e);
  if (!dragIds && !ts.length) $('#thumbs').classList.add('dropfile');
  if (i < ts.length) ts[i].classList.add('dropB'); else ts[ts.length - 1]?.classList.add('dropA');
});
$('#thumbs').addEventListener('dragleave', clearDropMarks);
$('#thumbs').addEventListener('drop', e => {
  e.preventDefault(); e.stopPropagation(); clearDropMarks(); document.body.classList.remove('dragging');
  let at = dropTarget(e);
  if (dragIds) {
    const moving = dragIds.map(pageById); dragIds = null;
    const before = S.pages.slice(0, at).filter(p => !moving.includes(p)).length;
    const rest = S.pages.filter(p => !moving.includes(p));
    const order = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
    if (order.every((p, i) => p === S.pages[i])) return;
    snap(); S.pages = order; S.current = before; refreshAll(); setCurrent(before, true);
  } else if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files, at);
});
$('#thumbs').addEventListener('dragend', () => { dragIds = null; clearDropMarks(); });

/* ---------------- page operations ---------------- */
function targets() {
  const sel = S.pages.filter(p => S.selPages.has(p.id)).map(p => p.id);
  return sel.length ? sel : S.pages[S.current] ? [S.pages[S.current].id] : [];
}
function rotatePages(ids, delta) {
  if (!ids.length) return; snap();
  for (const id of ids) {
    const p = pageById(id), d = dims(p);
    for (const a of [...p.annots, ...(p.ocr || [])]) { // keep annotations upright and travelling with the page
      const aw = a.w || 0, ah = a.h || 0, cx = a.x + aw / 2, cy = a.y + ah / 2;
      const [nx, ny] = delta === 90 ? [d.h - cy, cx] : [cy, d.w - cx];
      a.x = nx - aw / 2; a.y = ny - ah / 2;
    }
    p.rot = (p.rot + delta + 360) % 360;
  }
  refreshAll(true);
}
function deletePages(ids) {
  if (!ids.length) return;
  snap();
  S.pages = S.pages.filter(p => !ids.includes(p.id));
  ids.forEach(id => S.selPages.delete(id));
  S.current = Math.min(S.current, Math.max(0, S.pages.length - 1));
  refreshAll(true);
  toast(`Deleted ${ids.length} page${ids.length > 1 ? 's' : ''} – Ctrl+Z to undo`);
}
function insertBlank() {
  const cur = S.pages[S.current], d = cur ? dims(cur) : { w: 612, h: 792 };
  if (!S.pages.length) return newBlank();
  snap(); S.pages.splice(S.current + 1, 0, { id: nid(), src: -1, idx: 0, baseRot: 0, rot: 0, w: d.w, h: d.h, annots: [] });
  refreshAll(true); setCurrent(S.current + 1, true);
}
function parseRange(txt, n) {
  const out = [];
  for (const part of txt.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)?-(\d+)?$/.exec(part);
    const [a, b] = m ? [+(m[1] || 1), +(m[2] || n)] : [+part, +part];
    for (let i = Math.max(1, a); i <= Math.min(n, b); i++) if (!out.includes(i - 1)) out.push(i - 1);
  }
  return out;
}
async function extractPages() {
  let ids = S.pages.filter(p => S.selPages.has(p.id)).map(p => p.id);
  if (ids.length < 2) {
    const txt = prompt('Which pages do you want to save as a new PDF?\nExamples:  3   or   1-4   or   1, 3, 7-9', ids.length ? S.pages.findIndex(p => p.id === ids[0]) + 1 : S.current + 1);
    if (!txt) return;
    ids = parseRange(String(txt).replace(/\s*-\s*/g, '-'), S.pages.length).map(i => S.pages[i].id);
  }
  if (!ids.length) return toast('No pages matched.');
  commitEditing(); toast('Preparing…');
  const bytes = await buildPdf(S.pages.filter(p => ids.includes(p.id)));
  await saveBytes(bytes, S.name.replace(/\.pdf$/i, '') + `-pages.pdf`);
}
$('#sRotL').onclick = () => rotatePages(targets(), -90);
$('#sRotR').onclick = () => rotatePages(targets(), 90);
$('#sDel').onclick = () => deletePages(targets());
$('#sBlank').onclick = insertBlank;
$('#sExtract').onclick = extractPages;

/* ---------------- tools ---------------- */
function setTool(t) {
  if (typeof hideAreaMenu === 'function' && t !== 'area') hideAreaMenu();
  commitEditing();
  S.tool = t; if (t !== 'place') S.stamp = null;
  if (t === 'edittext') $$('.page').forEach(w => { const p = pageById(w.dataset.id); if (w._painted && p?.src >= 0) getPg(p).then(pg => buildTextLayer(w, p, pg)); });
  document.body.className = 'tool-' + t;
  $$('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  $('#bSign').classList.toggle('on', t === 'place' && S.stamp?.sig);
  $('#bImage').classList.toggle('on', t === 'place' && !S.stamp?.sig);
  if (t !== 'select') select(null);
  updateProps();
}
$$('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));

function select(id) {
  if (S.sel === id) return;
  const prev = S.sel && findAnnot(S.sel); S.sel = id;
  if (prev) renderAnnots(prev.p);
  const cur = id && findAnnot(id); if (cur) renderAnnots(cur.p);
  updateProps();
}
function updateProps() {
  const f = S.sel && findAnnot(S.sel), a = f && f.a;
  const src = a || S.def;
  $('#hint').textContent = S.pages.length ? (a ? 'Selected. Drag to move · corner to resize · Del to remove · arrows to nudge.' : HINTS[S.tool] || '') : 'Open a PDF to get started.';
  const isText = a ? a.type === 'text' : ['text', 'date', 'edittext', 'select'].includes(S.tool);
  const isLine = a ? a.type === 'ink' : ['draw', 'check', 'cross'].includes(S.tool);
  const hasColor = a ? a.type !== 'image' : !['place', 'whiteout'].includes(S.tool);
  $('#pFont').parentElement.hidden = $('#pSize').parentElement.hidden = $('#pBold').hidden = !isText;
  $('#pLw').parentElement.hidden = !isLine;
  $('#pColor').parentElement.hidden = !hasColor;
  $('#pDel').hidden = $('#pAll').hidden = !a;
  if (isText) {
    let o = $('#pFont option[value="PDF"]');
    if (!o) { o = el('option'); o.value = 'PDF'; o.textContent = 'Same as PDF'; $('#pFont').prepend(o); }
    o.hidden = !(a && a.pdfFont);
  }
  if (isText) { $('#pFont').value = a && a.pdfFont ? 'PDF' : src.font || S.def.font; $('#pSize').value = +(src.size || S.def.size).toFixed(1); $('#pBold').classList.toggle('on', !!src.bold); }
  if (isLine) $('#pLw').value = src.lw || S.def.lw;
  if (hasColor) $('#pColor').value = a ? a.color : (S.tool === 'highlight' ? '#ffe600' : S.def.color);
  setCurrent(S.current);
}
function saveDefaults() { try { localStorage.setItem('pdfeditor.defaults', JSON.stringify(S.def)); } catch { } }
try { Object.assign(S.def, JSON.parse(localStorage.getItem('pdfeditor.defaults')) || {}); } catch { }
function setProp(k, v) {
  const f = S.sel && findAnnot(S.sel);
  if (f) {
    const a = f.a; snap();
    if (k === 'color') a.color = v; else if (k in a || k === 'bold') a[k] = v;
    renderAnnots(f.p);
  } else if (!(k === 'color' && S.tool === 'highlight')) { S.def[k] = v; saveDefaults(); }
}
$('#pFont').onchange = e => {
  const f = S.sel && findAnnot(S.sel);
  if (e.target.value === 'PDF') return;
  if (f && f.a.pdfFont) { snap(); delete f.a.pdfFont; delete f.a.css; delete f.a.css2; f.a.fontChanged = true; }
  setProp('font', e.target.value); updateProps();
};
$('#pSize').onchange = e => setProp('size', Math.max(4, +e.target.value || 14));
$('#pBold').onclick = () => { const f = S.sel && findAnnot(S.sel); setProp('bold', !(f ? f.a.bold : S.def.bold)); updateProps(); };
$('#pColor').oninput = e => { const f = S.sel && findAnnot(S.sel); if (f) { if ($('#pColor')._snapped !== S.sel) { snap(); $('#pColor')._snapped = S.sel; } f.a.color = e.target.value; renderAnnots(f.p); } else setProp('color', e.target.value); };
$('#pColor').onchange = () => { $('#pColor')._snapped = null; };
$('#pLw').onchange = e => setProp('lw', Math.max(0.5, +e.target.value || 2));
$('#pDel').onclick = deleteSelected;

function deleteSelected() {
  const f = S.sel && findAnnot(S.sel); if (!f) return;
  snap(); f.p.annots = f.p.annots.filter(a => a !== f.a); S.sel = null; renderAnnots(f.p); updateProps();
}

/* text editing in place */
function startEdit(a, p, takeSnap = true) {
  const e = document.querySelector(`.an[data-id="${a.id}"]`); if (!e) return;
  if (takeSnap) snap();
  e.contentEditable = 'plaintext-only';
  if (e.contentEditable !== 'plaintext-only') e.contentEditable = 'true';
  e.querySelector('.h')?.remove();
  e.focus();
  const r = document.createRange(); r.selectNodeContents(e);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  e.oninput = () => { a.text = e.innerText; };
  e.onblur = e._finish = () => {
    if (e._done) return; e._done = true;
    e.contentEditable = 'false';
    a.text = e.innerText.replace(/\n$/, '');
    if (!a.text.trim()) { p.annots = p.annots.filter(x => x !== a); if (S.sel === a.id) S.sel = null; if (a._fresh) { S.undo.pop(); updateButtons(); } }
    delete a._fresh;
    renderAnnots(p); updateProps();
  };
}
function commitEditing() {
  for (const e of $$('.an.text')) if (e._finish && !e._done) e._finish();
  const ae = document.activeElement;
  if (ae && ae.isContentEditable) ae.blur();
}

/* -------- pointer interaction on pages -------- */
function drag(move, up) {
  const mm = e => move(e);
  const uu = e => { removeEventListener('pointermove', mm); removeEventListener('pointerup', uu); removeEventListener('pointercancel', uu); up && up(e); };
  addEventListener('pointermove', mm); addEventListener('pointerup', uu); addEventListener('pointercancel', uu);
}
function addAnnot(p, a, keepTool) {
  snap(); p.annots.push(a); S.sel = a.id; renderAnnots(p);
  if (!keepTool && S.tool !== 'text') setTool('select');
  updateProps();
}
const INK = {
  check: [[[0.08, 0.55], [0.38, 0.88], [0.94, 0.1]]],
  cross: [[[0.1, 0.1], [0.9, 0.9]], [[0.9, 0.1], [0.1, 0.9]]],
};

$('#pages').addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;
  const w = ev.target.closest('.page'); if (!w) return;
  const p = pageById(w.dataset.id);
  setCurrent(S.pages.indexOf(p));
  const r = w.getBoundingClientRect(), z = S.zoom;
  const pt = e => ({ x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z });
  const s = pt(ev);
  const ae = ev.target.closest('.an');
  const drawing = ['draw', 'highlight', 'whiteout', 'area'].includes(S.tool);

  /* resize handle */
  if (ev.target.classList.contains('h')) {
    ev.preventDefault();
    const a = p.annots.find(x => x.id === ae.dataset.id), o = { ...a }; let moved = false;
    drag(e => {
      const q = pt(e);
      if (!moved) { snap(); moved = true; }
      if (a.type === 'text') { a.size = Math.max(4, o.size * Math.max(0.1, (o.w + q.x - s.x) / o.w)); }
      else {
        a.w = Math.max(4, o.w + q.x - s.x);
        a.h = (a.type === 'image' || a.type === 'clip') && !e.shiftKey ? a.w * o.h / o.w : Math.max(2, o.h + q.y - s.y);
      }
      renderAnnots(p);
    }, () => updateProps());
    return;
  }

  /* select / move existing item */
  if (ae && !drawing) {
    const a = p.annots.find(x => x.id === ae.dataset.id);
    if (ae.isContentEditable) return; // let the caret move while typing
    ev.preventDefault(); commitEditing();
    const was = S.sel === a.id; select(a.id);
    const ox = a.x, oy = a.y; let moved = false;
    drag(e => {
      const q = pt(e);
      if (!moved) { if (Math.hypot(q.x - s.x, q.y - s.y) * z < 3) return; snap(); moved = true; }
      a.x = ox + q.x - s.x; a.y = oy + q.y - s.y;
      const n = document.querySelector(`.an[data-id="${a.id}"]`);
      if (n) { n.style.left = a.x * z + 'px'; n.style.top = a.y * z + 'px'; }
    }, () => { if (!moved && was && a.type === 'text') startEdit(a, p); });
    return;
  }

  /* click existing PDF text with Edit-text tool */
  if (S.tool === 'edittext' && ev.target.classList.contains('ts')) {
    ev.preventDefault(); editExistingText(p, w, w._runs[+ev.target.dataset.i]); ev.target.remove(); return;
  }

  const def = S.def;
  switch (S.tool) {
    case 'select': case 'edittext':
      commitEditing(); select(null); return;
    case 'text': case 'date': {
      ev.preventDefault(); commitEditing();
      const a = { id: nid(), type: 'text', x: s.x, y: s.y - def.size * 0.6, text: S.tool === 'date' ? new Date().toLocaleDateString() : '',
        size: def.size, font: def.font, bold: def.bold, color: def.color };
      if (S.tool === 'text') a._fresh = true;
      addAnnot(p, a, true);
      if (S.tool === 'text') startEdit(a, p, false); else select(null);
      return;
    }
    case 'check': case 'cross': {
      const sz = Math.max(10, def.size * 1.1);
      addAnnot(p, { id: nid(), type: 'ink', x: s.x - sz / 2, y: s.y - sz / 2, w: sz, h: sz, strokes: INK[S.tool], color: def.color, lw: def.lw }, true);
      return;
    }
    case 'place': {
      const st = S.stamp; if (!st) return;
      addAnnot(p, { id: nid(), type: 'image', img: st.img, x: s.x - st.w / 2, y: s.y - st.h / 2, w: st.w, h: st.h });
      return;
    }
    case 'highlight': case 'whiteout': case 'area': {
      ev.preventDefault(); hideAreaMenu();
      const band = el('div', 'band'); w.querySelector('.al').append(band);
      let q = s;
      const box = () => ({ x: Math.min(s.x, q.x), y: Math.min(s.y, q.y), w: Math.abs(q.x - s.x), h: Math.abs(q.y - s.y) });
      drag(e => { q = pt(e); const b = box(); Object.assign(band.style, { left: b.x * z + 'px', top: b.y * z + 'px', width: b.w * z + 'px', height: b.h * z + 'px' }); },
        () => {
          band.remove(); const b = box(); if (b.w < 3 || b.h < 3) return;
          if (S.tool === 'area') return showAreaMenu(p, b);
          const hl = S.tool === 'highlight';
          addAnnot(p, { id: nid(), type: 'rect', ...b, color: hl ? $('#pColor').value : '#ffffff', op: 1, blend: hl ? 'multiply' : undefined }, true);
          select(null);
        });
      return;
    }
    case 'draw': {
      ev.preventDefault();
      const pts = [[s.x, s.y]];
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'livesvg');
      const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      Object.entries({ fill: 'none', stroke: def.color, 'stroke-width': def.lw * z, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }).forEach(([k, v]) => pl.setAttribute(k, v));
      svg.append(pl); w.querySelector('.al').append(svg);
      const upd = () => pl.setAttribute('points', pts.map(q => q[0] * z + ',' + q[1] * z).join(' '));
      upd();
      drag(e => {
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ce of evs) { const q = pt(ce); pts.push([q.x, q.y]); }
        upd();
      }, () => {
        svg.remove();
        const pad = def.lw / 2;
        const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
        const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
        const bw = Math.max(1, Math.max(...xs) + pad - x), bh = Math.max(1, Math.max(...ys) + pad - y);
        addAnnot(p, { id: nid(), type: 'ink', x, y, w: bw, h: bh, strokes: [pts.map(q => [(q[0] - x) / bw, (q[1] - y) / bh])], color: def.color, lw: def.lw }, true);
        select(null);
      });
      return;
    }
  }
});
$('#pages').addEventListener('dblclick', e => {
  const ae = e.target.closest('.an.text'); if (!ae || ae.isContentEditable) return;
  const f = findAnnot(ae.dataset.id); if (f) startEdit(f.a, f.p);
});
$('#view').addEventListener('pointerdown', e => { if (!e.target.closest('.page') && S.sel) { commitEditing(); select(null); } });

/* "Edit text": really delete the original characters from the page and drop an editable copy in their place */
async function editExistingText(p, w, r) {
  commitEditing();
  const c = w.querySelector('canvas'), k = c.width / dims(p).w;
  let bg = '#ffffff', fg = '#000000';
  try {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const px = ctx.getImageData(Math.max(0, (r.x - 3) * k), Math.max(0, (r.base - r.fh * 0.5) * k), 1, 1).data;
    bg = '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    const bx = Math.max(0, r.x * k), by = Math.max(0, (r.base - r.fh * 0.8) * k);
    const bw = Math.max(1, Math.min(r.w * k, c.width - bx)), bh = Math.max(1, Math.min(r.fh * k, c.height - by));
    const d = ctx.getImageData(bx, by, bw, bh).data; let best = 765;
    for (let i = 0; i < d.length; i += 4) { const l = d[i] + d[i + 1] + d[i + 2]; if (l < best) { best = l; fg = '#' + [d[i], d[i + 1], d[i + 2]].map(v => v.toString(16).padStart(2, '0')).join(''); } }
  } catch (e) { /* ignore */ }
  const fam = (r.fam + ' ' + r.font).toLowerCase();
  const font = /mono|courier/.test(fam) ? 'Courier' : /serif/.test(fam) && !/sans/.test(fam) || /times/.test(fam) ? 'Times' : 'Helvetica';
  const bold = /bold|black|heavy/.test(fam);
  snap();
  // delete box in PDF user space (independent of later page rotation)
  const vp = (await getPg(p)).getViewport({ scale: 1, rotation: totalRot(p) });
  const c1 = vp.convertToPdfPoint(r.x - 0.5, r.base - r.fh * 0.85), c2 = vp.convertToPdfPoint(r.x + r.w + 0.5, r.base + r.fh * 0.2);
  p.erase = [...(p.erase || []), [Math.min(c1[0], c2[0]), Math.min(c1[1], c2[1]), Math.max(c1[0], c2[0]), Math.max(c1[1], c2[1])]];
  let ok = false, pdfFont = null, baseFont = '';
  try { const res = await erasedPage(p), n = res.hits.length - 1; ok = res.hits[n] > 0; pdfFont = res.hits.fonts[n]; baseFont = res.hits.bases[n] || ''; } catch (e) { console.warn(e); }
  if (ok) repaint(p);
  else { // text lives somewhere we can't rewrite (e.g. inside a form object) – fall back to covering it
    p.erase.pop();
    p.annots.push({ id: nid(), type: 'rect', x: r.x - 1, y: r.base - r.fh * 0.92, w: r.w + 2, h: r.fh * 1.18, color: bg, op: 1 });
  }
  const a ={ id: nid(), type: 'text', x: r.x, y: r.base - FONTS[font].base * r.fh, text: r.str.trim(), size: r.fh, font, bold, color: fg };
  if (ok && pdfFont) { a.pdfFont = pdfFont; a.css = r.font; } // reuse the PDF's own font
  if (baseFont) {
    a.baseFont = baseFont;
    systemFont(baseFont).then(sf => {
      if (!sf || a.css2) return; a.css2 = sf.family;
      const e = document.querySelector(`.an[data-id="${a.id}"]`);
      if (e && e.isContentEditable) e.style.fontFamily = `${a.css ? `"${a.css}", ` : ''}"${a.css2}", ${FONTS[a.font].css}`; // just swap the font, keep typing
      else renderAnnots(p);
    });
  }
  p.annots.push(a); S.sel = a.id; renderAnnots(p); updateProps();
  startEdit(a, p, false);
}

/* ---------------- signatures & images ---------------- */
const SIG_KEY = 'pdfeditor.signatures';
const sigStore = {
  get() { try { return JSON.parse(localStorage.getItem(SIG_KEY)) || []; } catch { return []; } },
  set(v) { try { localStorage.setItem(SIG_KEY, JSON.stringify(v)); } catch { toast('Could not remember signature (storage blocked).'); } },
};
let sigTab = 'draw', sigInk = '#000000', sigUpload = null, sigFont = 0, sigDrawn = false;
const SIG_FONTS = ['"Segoe Script"', '"Ink Free"', '"Lucida Handwriting"', '"Brush Script MT", cursive'];

function openSig() {
  if (!S.pages.length) return toast('Open a PDF first.');
  const saved = sigStore.get();
  $('#savedWrap').hidden = !saved.length;
  $('#savedSigs').innerHTML = '';
  saved.forEach((u, i) => {
    const d = el('div', 'sv'); d.innerHTML = `<img src="${u}"><button class="x" title="Forget this signature">✕</button>`;
    d.onclick = e => {
      if (e.target.classList.contains('x')) { const v = sigStore.get(); v.splice(i, 1); sigStore.set(v); return openSig(); }
      closeSig(); useStamp(u, true);
    };
    $('#savedSigs').append(d);
  });
  clearSigCanvas(); $('#modal').hidden = false;
  renderSigFonts();
}
function closeSig() { $('#modal').hidden = true; }
$('#bSign').onclick = openSig;
$('#sigCancel').onclick = closeSig;
$('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal') closeSig(); });
$$('.tabs button').forEach(b => b.onclick = () => {
  sigTab = b.dataset.tab;
  $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('.tab').forEach(t => t.hidden = t.dataset.tab !== sigTab);
  if (sigTab === 'type') $('#sigText').focus();
});

const sc = $('#sigCanvas'), sctx = sc.getContext('2d');
function clearSigCanvas() { sctx.clearRect(0, 0, sc.width, sc.height); sigDrawn = false; }
$('#sigClear').onclick = clearSigCanvas;
$$('.ink').forEach(b => b.onclick = () => { sigInk = b.dataset.c; $$('.ink').forEach(x => x.classList.toggle('on', x === b)); renderSigFonts(); });
sc.addEventListener('pointerdown', e => {
  const r = sc.getBoundingClientRect(), k = sc.width / r.width;
  const P = ev => [(ev.clientX - r.left) * k, (ev.clientY - r.top) * k];
  let last = P(e); sigDrawn = true;
  sctx.strokeStyle = sigInk; sctx.lineCap = sctx.lineJoin = 'round';
  sctx.fillStyle = sigInk; sctx.beginPath(); sctx.arc(last[0], last[1], 1.4, 0, 7); sctx.fill();
  try { sc.setPointerCapture(e.pointerId); } catch { }
  const mv = ev => {
    for (const ce of (ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev])) {
      const q = P(ce), dist = Math.hypot(q[0] - last[0], q[1] - last[1]);
      sctx.lineWidth = Math.max(1.6, 3.6 - dist * 0.08); // thinner when moving fast = pen-like
      sctx.beginPath(); sctx.moveTo(...last); sctx.lineTo(...q); sctx.stroke(); last = q;
    }
  };
  const up = () => { sc.removeEventListener('pointermove', mv); sc.removeEventListener('pointerup', up); };
  sc.addEventListener('pointermove', mv); sc.addEventListener('pointerup', up);
});
function renderSigFonts() {
  const txt = $('#sigText').value || 'Your Name';
  $('#sigFonts').innerHTML = '';
  SIG_FONTS.forEach((f, i) => {
    const b = el('button', i === sigFont ? 'on' : ''); b.textContent = txt; b.style.fontFamily = f; b.style.color = sigInk;
    b.onclick = () => { sigFont = i; renderSigFonts(); }; $('#sigFonts').append(b);
  });
}
$('#sigText').oninput = renderSigFonts;
$('#sigPick').onclick = () => $('#fSig').click();
$('#fSig').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; sigUpload = await imageToDataUrl(f); $('#sigUp').src = sigUpload; };

function trimCanvas(c) {
  const ctx = c.getContext('2d'), d = ctx.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const o = el('canvas'), pad = 4; o.width = x1 - x0 + 1 + pad * 2; o.height = y1 - y0 + 1 + pad * 2;
  o.getContext('2d').drawImage(c, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
  return o.toDataURL('image/png');
}
async function makeSignature() {
  if (sigTab === 'draw') return sigDrawn ? trimCanvas(sc) : null;
  if (sigTab === 'type') {
    const t = $('#sigText').value.trim(); if (!t) return null;
    const c = el('canvas'), x = c.getContext('2d'), font = `96px ${SIG_FONTS[sigFont]}`;
    x.font = font; c.width = Math.ceil(x.measureText(t).width + 60); c.height = 170;
    x.font = font; x.fillStyle = sigInk; x.textBaseline = 'middle'; x.fillText(t, 30, 85);
    return trimCanvas(c);
  }
  if (!sigUpload) return null;
  const img = await loadImg(sigUpload), c = el('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  if ($('#sigTransp').checked) {
    const id = x.getImageData(0, 0, c.width, c.height), d = id.data;
    for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; if (l > 200) d[i + 3] = Math.max(0, 255 - (l - 200) * 255 / 40); }
    x.putImageData(id, 0, 0);
  }
  return trimCanvas(c);
}
$('#sigUse').onclick = async () => {
  const url = await makeSignature();
  if (!url) return toast(sigTab === 'draw' ? 'Draw your signature in the box first.' : sigTab === 'type' ? 'Type your name first.' : 'Choose an image first.');
  if ($('#sigRemember').checked) { const v = sigStore.get(); if (!v.includes(url)) { v.unshift(url); sigStore.set(v.slice(0, 8)); } }
  closeSig(); useStamp(url, true);
};
async function useStamp(url, sig) {
  const img = await loadImg(url);
  const w = sig ? 170 : Math.min(300, img.naturalWidth * 0.75);
  S.stamp = { img: registerImage(url), w, h: w * img.naturalHeight / img.naturalWidth, sig };
  setTool('place'); S.stamp.sig = sig; $('#bSign').classList.toggle('on', sig); $('#bImage').classList.toggle('on', !sig);
  $('#hint').textContent = HINTS.place;
}
$('#bImage').onclick = () => { if (!S.pages.length) return toast('Open a PDF first.'); $('#fImg').click(); };
$('#fImg').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) useStamp(await imageToDataUrl(f), false); };

/* ---------------- true text deletion ----------------
   Parses the page content stream, tracks the text/graphics state to find where every glyph lands,
   and removes the glyphs whose centre falls inside a delete box. Removed glyphs are replaced by an
   equal TJ spacing so the rest of the line doesn't shift. */
const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, decodePDFRawStream } = PDFLib;
const PN = n => PDFName.of(n);
const WS = new Set([0, 9, 10, 12, 13, 32]), DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const WIN_HI = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
const mmul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const mapply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const fmtN = v => (Math.round(v * 1000) / 1000).toString();

function parseContent(b) {
  let i = 0, operands = [], opStart = -1;
  const n = b.length, ops = [];
  const skip = () => {
    for (;;) {
      while (i < n && WS.has(b[i])) i++;
      if (b[i] === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; } else break;
    }
  };
  const word = () => { let s = ''; while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) s += String.fromCharCode(b[i++]); return s; };
  function value() {
    const c = b[i];
    if (c === 40) { // (literal string)
      i++; let depth = 1; const out = [];
      while (i < n) {
        let ch = b[i++];
        if (ch === 92) {
          ch = b[i++];
          const esc = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[ch];
          if (esc !== undefined) out.push(esc);
          else if (ch >= 48 && ch <= 55) { let v = ch - 48; for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + b[i++] - 48; out.push(v & 255); }
          else if (ch === 13) { if (b[i] === 10) i++; }
          else if (ch !== 10) out.push(ch);
        } else if (ch === 40) { depth++; out.push(ch); }
        else if (ch === 41) { if (--depth === 0) break; out.push(ch); }
        else out.push(ch);
      }
      return { str: out };
    }
    if (c === 60) {
      if (b[i + 1] === 60) { // <<dict>>
        i += 2; const d = {};
        for (;;) { skip(); if (i >= n) break; if (b[i] === 62 && b[i + 1] === 62) { i += 2; break; } const k = value(); skip(); d[k && k.name] = value(); }
        return { dict: d };
      }
      i++; let h = ''; // <hex string>
      while (i < n && b[i] !== 62) { if (!WS.has(b[i])) h += String.fromCharCode(b[i]); i++; }
      i++; if (h.length % 2) h += '0';
      const out = []; for (let k = 0; k < h.length; k += 2) out.push(parseInt(h.substr(k, 2), 16));
      return { str: out };
    }
    if (c === 91) { i++; const arr = []; for (;;) { skip(); if (i >= n) break; if (b[i] === 93) { i++; break; } arr.push(value()); } return arr; }
    if (c === 47) { i++; return { name: word().replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) }; }
    const s = word();
    if (!s) { i++; ops.anomaly = true; return { kw: String.fromCharCode(c) }; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return +s;
    return { kw: s };
  }
  for (;;) {
    skip(); if (i >= n) break;
    const st = i, v = value();
    if (v && v.kw !== undefined && !['true', 'false', 'null'].includes(v.kw)) {
      const op = { op: v.kw, args: operands, start: opStart < 0 ? st : opStart, end: i };
      if (v.kw === 'BI') { // inline image: jump past binary data to EI
        let j = i;
        while (j < n - 1 && !(b[j] === 73 && b[j + 1] === 68 && WS.has(b[j - 1]) && (j + 2 >= n || WS.has(b[j + 2])))) j++;
        const hdr = String.fromCharCode(...b.subarray(i, j)), len = /\/(?:L|Length)\s+(\d+)/.exec(hdr);
        j += 3;
        if (len) j += +len[1];
        while (j < n - 1 && !(WS.has(b[j - 1]) && b[j] === 69 && b[j + 1] === 73 && (j + 2 >= n || WS.has(b[j + 2])))) j++;
        i = op.end = Math.min(n, j + 2);
      }
      ops.push(op); operands = []; opStart = -1;
    } else { if (opStart < 0) opStart = st; operands.push(v); }
  }
  return ops;
}

let measureCtx;
// Parse an embedded CMap stream: code-space ranges (how many bytes per code) + code→CID mapping
function parseCMap(bytes) {
  const txt = new TextDecoder('latin1').decode(bytes), spaces = [], cids = [];
  const hx = h => parseInt(h, 16);
  for (const blk of txt.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g))
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) spaces.push({ lo: hx(m[1]), hi: hx(m[2]), len: m[1].length / 2 });
  for (const blk of txt.matchAll(/begincidrange([\s\S]*?)endcidrange/g))
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\d+)/g)) cids.push([hx(m[1]), hx(m[2]), +m[3]]);
  for (const blk of txt.matchAll(/begincidchar([\s\S]*?)endcidchar/g))
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*(\d+)/g)) cids.push([hx(m[1]), hx(m[1]), +m[2]]);
  if (!spaces.length) return null;
  spaces.sort((a, b) => a.len - b.len);
  return {
    next(by, k) {
      for (const s of spaces) {
        if (k + s.len > by.length) continue;
        let c = 0; for (let j = 0; j < s.len; j++) c = c * 256 + by[k + j];
        if (c >= s.lo && c <= s.hi) return { code: c, len: s.len };
      }
      return { code: by[k], len: 1 };
    },
    cid(code) { for (const [lo, hi, c] of cids) if (code >= lo && code <= hi) return c + code - lo; return 0; },
  };
}
// Font metrics needed to locate glyphs: how to split a string into codes, and each glyph's advance width
function fontInfo(d) {
  const num = x => x instanceof PDFNumber ? x.asNumber() : undefined;
  const look = x => d.context.lookup(x);
  const sub = String(d.lookup(PN('Subtype')) || '').replace('/', '');
  if (sub === 'Type0') {
    const enc = d.lookup(PN('Encoding'));
    let cmap;
    if (String(enc) === '/Identity-H') cmap = { next: (by, k) => ({ code: (by[k] << 8) | (by[k + 1] || 0), len: 2 }), cid: c => c };
    else if (enc instanceof PDFRawStream && !/WMode\s+1/.test(new TextDecoder('latin1').decode(decodePDFRawStream(enc).decode()))) cmap = parseCMap(decodePDFRawStream(enc).decode());
    if (!cmap) return null; // predefined CJK CMaps / vertical text: not supported → cover box fallback
    const desc = d.lookup(PN('DescendantFonts'), PDFArray).lookup(0, PDFDict);
    const dw = num(desc.lookup(PN('DW'))) ?? 1000, map = new Map(), W = desc.lookup(PN('W'));
    if (W instanceof PDFArray) {
      const a = W.asArray().map(look);
      for (let k = 0; k < a.length;) {
        const c1 = num(a[k]); a[k + 1] = look(a[k + 1]) ?? a[k + 1];
        if (!Number.isFinite(c1)) break;
        if (a[k + 1] instanceof PDFArray) { a[k + 1].asArray().forEach((w, j) => map.set(c1 + j, num(look(w)))); k += 2; }
        else { const c2 = num(a[k + 1]), w = num(look(a[k + 2])); if (!Number.isFinite(c2) || c2 - c1 > 65535) break; for (let c = c1; c <= c2; c++) map.set(c, w); k += 3; }
      }
    }
    const w = cid => map.get(cid) ?? dw;
    return { scale: 0.001, next: cmap.next, w: code => w(cmap.cid(code)) };
  }
  const next = (by, k) => ({ code: by[k], len: 1 });
  let scale = 0.001;
  if (sub === 'Type3') { const fm = d.lookup(PN('FontMatrix')); if (fm instanceof PDFArray) scale = num(fm.lookup(0)) || 0.001; }
  const fc = num(d.lookup(PN('FirstChar'))) ?? 0, W = d.lookup(PN('Widths')), fd = d.lookup(PN('FontDescriptor'));
  const missing = (fd instanceof PDFDict && num(fd.lookup(PN('MissingWidth')))) || 0;
  if (W instanceof PDFArray) { const ws = W.asArray().map(x => num(look(x)) ?? missing); return { scale, next, w: c => ws[c - fc] ?? missing }; }
  // Standard-14 font without widths: measure with the metric-compatible Windows font
  const base = String(d.lookup(PN('BaseFont')) || '').toLowerCase();
  const css = /courier/.test(base) ? '"Courier New"' : /times/.test(base) ? '"Times New Roman"' : 'Arial';
  measureCtx = measureCtx || el('canvas').getContext('2d');
  const font = `${/italic|oblique/.test(base) ? 'italic ' : ''}${/bold/.test(base) ? 'bold ' : ''}1000px ${css}`, cache = {};
  return { scale: 0.001, next, w: c => cache[c] ?? (measureCtx.font = font, cache[c] = measureCtx.measureText(c >= 128 && c < 160 ? WIN_HI[c - 128] : String.fromCharCode(c)).width) };
}

const streamData = s => s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getUnencodedContents();
function eraseText(doc, page, boxes) {
  const hits = boxes.map(() => 0), node = page.node;
  hits.fonts = []; hits.bases = [];
  const cont = node.lookup(PN('Contents'));
  if (!cont) return hits;
  const streams = cont instanceof PDFArray ? cont.asArray().map(r => doc.context.lookup(r)) : [cont];
  const parts = streams.map(streamData);
  const bytes = new Uint8Array(parts.reduce((t, p) => t + p.length + 1, 0));
  let off = 0; for (const p of parts) { bytes.set(p, off); off += p.length; bytes[off++] = 10; }
  const gs0 = { ctm: [1, 0, 0, 1, 0, 0], Tc: 0, Tw: 0, Th: 1, TL: 0, font: null, Tfs: 0, Ts: 0 };
  const r = rewriteContent(doc, bytes, node.Resources(), gs0, boxes, hits, 0, true);
  if (r.bytes) node.set(PN('Contents'), doc.context.register(doc.context.flateStream(r.bytes)));
  if (r.res) node.set(PN('Resources'), r.res);
  return hits;
}

// Walk one content stream (page or Form XObject). Returns new bytes and/or new resources if anything was removed.
function rewriteContent(doc, bytes, res, gs0, boxes, hits, depth, isPage) {
  const fontDict = res && res.lookup(PN('Font')), fcache = {}, xobjNew = {};
  const getFont = name => {
    if (name in fcache) return fcache[name];
    let f = null;
    try { const d = fontDict && fontDict.lookup(PN(name)); if (d instanceof PDFDict) f = fontInfo(d); } catch (e) { console.warn(e); }
    return fcache[name] = f;
  };
  let gs = { ...gs0 };
  const stack = [], edits = [];
  let Tm = [1, 0, 0, 1, 0, 0], Tlm = Tm, lost = false;
  const nextLine = () => { Tlm = mmul([1, 0, 0, 1, 0, -gs.TL], Tlm); Tm = Tlm; lost = false; };
  const show = items => {
    const f = gs.font;
    if (!f || !gs.Tfs || !gs.Th) { lost = true; return null; } // positions unknown until the next text move
    if (lost) return null;
    const out = []; let pend = 0, changed = false;
    const keepBytes = bs => {
      if (pend) { out.push(pend); pend = 0; }
      const last = out[out.length - 1];
      if (Array.isArray(last)) last.push(...bs); else out.push([...bs]);
    };
    for (const it of items) {
      if (typeof it === 'number') { Tm = mmul([1, 0, 0, 1, -it / 1000 * gs.Tfs * gs.Th, 0], Tm); pend += it; continue; }
      if (!it || !it.str) continue;
      const by = it.str;
      for (let k = 0; k < by.length;) {
        const { code, len } = f.next(by, k);
        const w0 = f.w(code) * f.scale;
        const tx = (w0 * gs.Tfs + gs.Tc + (len === 1 && code === 32 ? gs.Tw : 0)) * gs.Th;
        const trm = mmul([gs.Tfs * gs.Th, 0, 0, gs.Tfs, 0, gs.Ts], mmul(Tm, gs.ctm));
        const [cx, cy] = mapply(trm, w0 / 2, 0.3);
        const bi = boxes.findIndex(b => cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3]);
        if (bi >= 0) { hits[bi]++; hits.fonts[bi] = hits.fonts[bi] || (isPage ? gs.fontName : null); hits.bases[bi] = hits.bases[bi] || gs.fontBase; changed = true; pend -= tx * 1000 / (gs.Tfs * gs.Th); }
        else keepBytes(by.slice(k, k + len));
        Tm = mmul([1, 0, 0, 1, tx, 0], Tm);
        k += len;
      }
    }
    if (pend && Number.isFinite(pend)) out.push(pend);
    if (out.some(t => typeof t === 'number' && !Number.isFinite(t))) return null;
    return changed ? '[' + out.map(t => typeof t === 'number' ? fmtN(t) : '<' + t.map(x => x.toString(16).padStart(2, '0')).join('') + '>').join(' ') + '] TJ' : null;
  };
  const parsed = parseContent(bytes);
  if (parsed.anomaly) return {}; // don't risk corrupting an unusual content stream
  for (const o of parsed) {
    const a = o.args;
    try {
      switch (o.op) {
        case 'q': stack.push({ ...gs }); break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': gs.ctm = mmul(a.slice(0, 6), gs.ctm); break;
        case 'BT': Tm = Tlm = [1, 0, 0, 1, 0, 0]; lost = false; break;
        case 'Tc': gs.Tc = a[0]; break;
        case 'Tw': gs.Tw = a[0]; break;
        case 'Tz': gs.Th = a[0] / 100; break;
        case 'TL': gs.TL = a[0]; break;
        case 'Ts': gs.Ts = a[0]; break;
        case 'Tf': gs.fontName = a[0].name; try { gs.fontBase = String(fontDict.lookup(PN(a[0].name)).lookup(PN('BaseFont')) || '').replace(/^\//, ''); } catch { gs.fontBase = ''; } gs.font = getFont(a[0].name); gs.Tfs = a[1]; break;
        case 'TD': gs.TL = -a[1]; // falls through
        case 'Td': Tlm = mmul([1, 0, 0, 1, a[0], a[1]], Tlm); Tm = Tlm; lost = false; break;
        case 'Tm': Tlm = Tm = a.slice(0, 6); lost = false; break;
        case 'T*': nextLine(); break;
        case 'Tj': { const r = show([a[0]]); if (r) edits.push([o, r]); break; }
        case 'TJ': { const r = show(a[0]); if (r) edits.push([o, r]); break; }
        case "'": { nextLine(); const r = show([a[0]]); if (r) edits.push([o, 'T* ' + r]); break; }
        case '"': { gs.Tw = a[0]; gs.Tc = a[1]; nextLine(); const r = show([a[2]]); if (r) edits.push([o, `${fmtN(a[0])} Tw ${fmtN(a[1])} Tc T* ${r}`]); break; }
        case 'Do': { // text inside a Form XObject (headers, footers, stamped pages…)
          if (depth > 4 || !res) break;
          const xd = res.lookup(PN('XObject')), name = a[0].name;
          const xo = xd instanceof PDFDict ? xd.lookup(PN(name)) : null;
          if (!(xo instanceof PDFRawStream) || String(xo.dict.lookup(PN('Subtype'))) !== '/Form') break;
          const m = xo.dict.lookup(PN('Matrix'));
          const mat = m instanceof PDFArray ? m.asArray().map(x => doc.context.lookup(x).asNumber()) : [1, 0, 0, 1, 0, 0];
          const subRes = xo.dict.lookup(PN('Resources')) || res;
          const r = rewriteContent(doc, streamData(xo), subRes, { ...gs, ctm: mmul(mat, gs.ctm) }, boxes, hits, depth + 1, false);
          if (r.bytes || r.res) { // write a private copy of the XObject so other pages sharing it are untouched
            const ns = doc.context.flateStream(r.bytes || streamData(xo));
            for (const [k, v] of xo.dict.entries()) if (!['/Filter', '/DecodeParms', '/Length'].includes(String(k))) ns.dict.set(k, v);
            if (r.res) ns.dict.set(PN('Resources'), r.res);
            xobjNew[name] = doc.context.register(ns);
          }
          break;
        }
      }
    } catch (e) { console.warn('content op', o.op, e); }
  }
  const result = {};
  if (edits.length) {
    const enc = new TextEncoder(), chunks = []; let pos = 0;
    for (const [o, txt] of edits) { chunks.push(bytes.subarray(pos, o.start), enc.encode(txt)); pos = o.end; }
    chunks.push(bytes.subarray(pos));
    const outBytes = new Uint8Array(chunks.reduce((t, c) => t + c.length, 0));
    let o2 = 0; for (const c of chunks) { outBytes.set(c, o2); o2 += c.length; }
    result.bytes = outBytes;
  }
  if (Object.keys(xobjNew).length) {
    const nr = res.clone(doc.context), nx = res.lookup(PN('XObject')).clone(doc.context);
    for (const [k, v] of Object.entries(xobjNew)) nx.set(PN(k), v);
    nr.set(PN('XObject'), nx); result.res = nr;
  }
  return result;
}

/* Write text with the PDF's own (often subset) font. Characters are mapped back to font codes via the
   font's ToUnicode table; returns false (→ standard-font fallback) if any character isn't in the font. */
function fontEncoder(fd) {
  const map = new Map(); let nbytes = 1;
  const tu = fd.lookup(PN('ToUnicode'));
  const u16 = h => { let s = ''; for (let i = 0; i + 3 < h.length + 0; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16)); return s; };
  if (tu instanceof PDFRawStream) {
    const txt = new TextDecoder('latin1').decode(decodePDFRawStream(tu).decode());
    for (const blk of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
      for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) { nbytes = m[1].length / 2; const ch = u16(m[2]); if (ch.length === 1 && !map.has(ch)) map.set(ch, parseInt(m[1], 16)); }
    for (const blk of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
      for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
        nbytes = m[1].length / 2; const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
        if (m[4]) { const base = parseInt(m[4], 16); for (let c = lo; c <= hi && c - lo < 65536; c++) { const ch = String.fromCharCode(base + c - lo); if (!map.has(ch)) map.set(ch, c); } }
        else [...m[5].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, j) => { const ch = u16(d[1]); if (ch.length === 1 && !map.has(ch)) map.set(ch, lo + j); });
      }
  } else if (String(fd.lookup(PN('Subtype'))) !== '/Type0' && String(fd.lookup(PN('Encoding'))) === '/WinAnsiEncoding') {
    for (let c = 32; c < 256; c++) map.set(c >= 128 && c < 160 ? WIN_HI[c - 128] : String.fromCharCode(c), c);
  }
  if (String(fd.lookup(PN('Subtype'))) === '/Type0') nbytes = 2;
  return { map, nbytes };
}
function writeWithPdfFont(doc, page, pageFonts, a, ox, top) {
  try {
    const fd = pageFonts.lookup(PN(a.pdfFont)); if (!(fd instanceof PDFDict)) return false;
    const { map, nbytes } = fontEncoder(fd), info = fontInfo(fd);
    const hex = c => c.toString(16).padStart(nbytes * 2, '0');
    if (!info) return false;
    const c = hexRgb(a.color), L = PDFLib;
    const ops = [L.pushGraphicsState(), L.beginText(), L.setFontAndSize(a.pdfFont, a.size), L.setCharacterSpacing(0), L.setWordSpacing(0),
      L.setFillingRgbColor(c.red, c.green, c.blue)];
    const lines = a.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      const arr = PDFArray.withContext(doc.context);
      for (const ch of lines[i].replace(/\u00a0/g, ' ')) {
        const code = map.get(ch);
        if (code !== undefined && (info.w(code) > 0 || ch === ' ')) arr.push(L.PDFHexString.of(hex(code)));
        else if (ch === ' ') arr.push(PDFNumber.of(-278)); // subset fonts often drop the space glyph – use a gap instead
        else return false;
      }
      ops.push(L.setTextMatrix(1, 0, 0, 1, ox + a.x, top - (a.y + FONTS[a.font].base * a.size + i * 1.2 * a.size)), L.PDFOperator.of('TJ', [arr]));
    }
    ops.push(L.endText(), L.popGraphicsState());
    page.pushOperators(...ops);
    return true;
  } catch (e) { console.warn('pdf font write failed', e); return false; }
}

/* Find the complete version of a PDF font on this computer (PDFs usually embed only the letters used) */
const FONT_FILES = {
  arial: 'arial', arialmt: 'arial', helvetica: 'arial', calibri: 'calibri', cambria: 'cambria', candara: 'candara',
  georgia: 'georgia', verdana: 'verdana', tahoma: 'tahoma', trebuchetms: 'trebuc', segoeui: 'segoeui',
  timesnewroman: 'times', timesnewromanps: 'times', timesnewromanpsmt: 'times', times: 'times', timesroman: 'times',
  couriernew: 'cour', couriernewps: 'cour', couriernewpsmt: 'cour', courier: 'cour', consolas: 'consola',
  garamond: 'gara', bookantiqua: 'bkant', centurygothic: 'gothic', palatinolinotype: 'pala', lucidasans: 'lsans', aptos: 'aptos',
};
const STYLE_SUFFIX = { arial: ['bd', 'i', 'bi'], calibri: ['b', 'i', 'z'], georgia: ['b', 'i', 'z'], verdana: ['b', 'i', 'z'], times: ['bd', 'i', 'bi'],
  cour: ['bd', 'i', 'bi'], segoeui: ['b', 'i', 'z'], trebuc: ['bd', 'it', 'bi'], tahoma: ['bd', '', ''], consola: ['b', 'i', 'z'], cambria: ['b', 'i', 'z'], candara: ['b', 'i', 'z'] };
const sysFontCache = {};
function systemFont(base) {
  const ps = base.replace(/^[A-Z]{6}\+/, '');
  if (ps in sysFontCache) return sysFontCache[ps];
  return sysFontCache[ps] = (async () => {
    const low = ps.toLowerCase(), bold = /bold|black|heavy|semibold/.test(low), ital = /italic|oblique/.test(low);
    const family = ps.replace(/[-,].*$/, '').replace(/(PS)?MT$|PS$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
    const key = ps.replace(/[-,].*$/, '').toLowerCase();
    // 1) direct file read (works in PDFEditor.exe)
    const file = FONT_FILES[key] || FONT_FILES[key.replace(/(ps)?mt$/, '')];
    if (file) {
      const sfx = STYLE_SUFFIX[file], v = bold && ital ? 2 : ital ? 1 : bold ? 0 : -1;
      for (const name of [v >= 0 && sfx && sfx[v] ? file + sfx[v] : null, file].filter(Boolean)) {
        try {
          const r = await fetch(`file:///C:/Windows/Fonts/${name}.ttf`);
          if (r.ok) return { bytes: new Uint8Array(await r.arrayBuffer()), family };
        } catch { /* not allowed here */ }
      }
    }
    // 2) Local Font Access API (Edge/Chrome, asks permission once)
    if (window.queryLocalFonts) {
      try {
        const list = await queryLocalFonts({ postscriptNames: [ps] });
        if (list[0]) return { bytes: new Uint8Array(await (await list[0].blob()).arrayBuffer()), family: list[0].family };
      } catch { /* denied */ }
    }
    return null;
  })();
}
function startEditIfFocused(a, p) {
  const e = document.querySelector(`.an[data-id="${a.id}"]`);
  if (e && !e.isContentEditable && S.sel === a.id) startEdit(a, p, false);
}

/* ---------------- saving ---------------- */
function cleanText(s, font) {
  let o = '';
  for (const ch of s.replace(/\t/g, '    ').replace(/ /g, ' ')) {
    try { font.encodeText(ch); o += ch; } catch { o += '?'; }
  }
  return o;
}
async function buildPdf(list) {
  const out = await PDFDocument.create();
  const libs = {}, fonts = {}, imgs = {}, sysFonts = {};
  out.registerFontkit(fontkit);
  const getFont = async k => fonts[k] || (fonts[k] = await out.embedFont(StandardFonts[k]));
  const getImg = async id => {
    if (imgs[id]) return imgs[id];
    const u = S.images[id], b = new Uint8Array(await (await fetch(u)).arrayBuffer());
    return imgs[id] = u.startsWith('data:image/jpeg') ? await out.embedJpg(b) : await out.embedPng(b);
  };
  for (const p of list) {
    const d = dims(p); let page, ox = 0, oy = 0, pageFonts = null, rotated = false;
    if (p.src < 0) page = out.addPage([d.w, d.h]);
    else {
      let lib = libs[p.src];
      if (!lib) { // reuse the already-parsed original (fast); only form-filled files need a fresh private copy
        if (S.formsDirty[p.src]) { lib = await PDFDocument.load(S.sources[p.src].bytes, { ignoreEncryption: true, updateMetadata: false }); applyForm(lib, p.src); }
        else lib = await libFor(p.src);
        libs[p.src] = lib;
      }
      const total = totalRot(p);
      const [cp] = await out.copyPages(lib, [p.idx]);
      if (p.erase?.length) eraseText(out, cp, p.erase);
      page = out.addPage(cp); page.setRotation(degrees(total));
      try { pageFonts = page.node.Resources()?.lookup(PN('Font')); } catch { }
      if (p.annots.length || p.ocr?.length) {
        // isolate the original content's graphics state, then map our upright page coordinates onto the rotated page
        const cur = page.node.get(PN('Contents'));
        if (cur && !(page.node.lookup(PN('Contents')) instanceof PDFArray)) page.node.set(PN('Contents'), out.context.obj([cur]));
        page.node.wrapContentStreams(out.context.register(out.context.stream('q\n')), out.context.register(out.context.stream('\nQ\n')));
        const cb = page.getCropBox(), W = cb.width, Hc = cb.height;
        const M = { 0: [1, 0, 0, 1, cb.x, cb.y], 90: [0, 1, -1, 0, cb.x + W, cb.y], 180: [-1, 0, 0, -1, cb.x + W, cb.y + Hc], 270: [0, -1, 1, 0, cb.x, cb.y + Hc] }[total];
        page.pushOperators(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(...M));
        rotated = true;
      }
    }
    const H = d.h;
    for (const a of p.annots) {
      if (a.type === 'rect') {
        page.drawRectangle({ x: ox + a.x, y: oy + H - a.y - a.h, width: a.w, height: a.h, color: hexRgb(a.color), opacity: a.op ?? 1,
          blendMode: a.blend === 'multiply' ? BlendMode.Multiply : undefined });
      } else if (a.type === 'clip') { // moved/duplicated part of a page: embedded as real vector content
        const sl = libs[a.src] || (libs[a.src] = await libFor(a.src));
        const [x0, y0, x1, y1] = a.ubox, bw = x1 - x0, bh = y1 - y0, r = a.srot || 0;
        const emb = await out.embedPage(sl.getPage(a.idx), { left: x0, bottom: y0, right: x1, top: y1 });
        const sc = a.w / (r % 180 ? bh : bw), X0 = ox + a.x, Y0 = oy + H - a.y - a.h;
        const o = { 0: [X0, Y0, 0], 90: [X0, Y0 + bw * sc, -90], 180: [X0 + bw * sc, Y0 + bh * sc, -180], 270: [X0 + bh * sc, Y0, -270] }[r];
        page.drawPage(emb, { x: o[0], y: o[1], xScale: sc, yScale: sc, rotate: degrees(o[2]) });
      } else if (a.type === 'image') {
        page.drawImage(await getImg(a.img), { x: ox + a.x, y: oy + H - a.y - a.h, width: a.w, height: a.h });
      } else if (a.type === 'text') {
        if (a.pdfFont && pageFonts && writeWithPdfFont(out, page, pageFonts, a, ox, oy + H)) continue;
        const F = FONTS[a.font];
        let f = null;
        if (a.baseFont && !a.fontChanged) { // the PDF only holds some letters – embed the full font from this computer
          const sf = await systemFont(a.baseFont);
          if (sf) try { f = sysFonts[a.baseFont] || (sysFonts[a.baseFont] = await out.embedFont(sf.bytes, { subset: true })); } catch (e) { console.warn(e); }
        }
        f = f || await getFont(F.std[a.bold ? 1 : 0]);
        a.text.split('\n').forEach((ln, i) => {
          if (!ln) return;
          page.drawText(cleanText(ln, f), { x: ox + a.x, y: oy + H - (a.y + F.base * a.size + i * 1.2 * a.size), size: a.size, font: f, color: hexRgb(a.color),
            rotate: a.angle ? degrees(a.angle) : undefined, opacity: a.op ?? 1 });
        });
      } else if (a.type === 'ink') {
        const c = hexRgb(a.color);
        for (const s of a.strokes) {
          const P = q => ({ x: ox + a.x + q[0] * a.w, y: oy + H - (a.y + q[1] * a.h) });
          if (s.length === 1) { const q = P(s[0]); page.drawCircle({ x: q.x, y: q.y, size: a.lw / 2, color: c }); continue; }
          for (let i = 1; i < s.length; i++)
            page.drawLine({ start: P(s[i - 1]), end: P(s[i]), thickness: a.lw, color: c, lineCap: LineCapStyle.Round });
        }
      }
    }
    if (p.ocr?.length) { // recognised text from scans: invisible, but searchable and copyable in any PDF viewer
      const f = await getFont('Helvetica'), key = page.node.newFontDictionary(f.name, f.ref), L = PDFLib;
      const ops = [L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible)];
      for (const l of p.ocr) {
        const t = cleanText(l.text, f); if (!t.trim()) continue;
        const size = Math.max(4, l.h * 0.85), tw = f.widthOfTextAtSize(t, size) || 1;
        ops.push(L.setFontAndSize(key, size), L.setTextMatrix(l.w / tw, 0, 0, 1, ox + l.x, oy + H - l.y - l.h * 0.8), L.showText(f.encodeText(t)));
      }
      ops.push(L.endText(), L.popGraphicsState());
      page.pushOperators(...ops);
    }
    if (rotated) page.pushOperators(PDFLib.popGraphicsState());
  }
  linkFormFields(out);
  out.setProducer("Mark's Render PDF Editor"); out.setCreator("Mark's Render PDF Editor");
  if (S.meta) { // Tools → Title, author & info
    const m = S.meta;
    if (m.title) out.setTitle(m.title); if (m.author) out.setAuthor(m.author); if (m.subject) out.setSubject(m.subject);
    if (m.keywords) out.setKeywords(m.keywords.split(',').map(k => k.trim()).filter(Boolean));
  } else { const s0 = S.sources.find(Boolean); try { const info = s0 && (await s0.doc.getMetadata()).info; if (info?.Title) out.setTitle(info.Title); if (info?.Author) out.setAuthor(info.Author); } catch { } }
  return out.save();
}
async function saveBytes(bytes, name, remember) {
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] });
      const w = await h.createWritable(); await w.write(bytes); await w.close();
      if (remember) { S.fileHandle = h; S.name = h.name; }
      toast('Saved ✔'); return true;
    } catch (e) { if (e.name === 'AbortError') return false; console.warn(e); }
  }
  download(bytes, name); toast('Saved to your Downloads folder ✔'); return true;
}
async function save(saveAs) {
  if (!S.pages.length) return;
  commitEditing(); toast('Saving…', 10000);
  try {
    const rev = S.rev, bytes = await buildPdf(S.pages);
    const clean = () => { S.dirty = S.rev !== rev; updateTitle(); pruneImages(); };
    if (S.fileHandle && !saveAs) { // after the first save, Ctrl+S simply overwrites that file
      try {
        const w = await S.fileHandle.createWritable(); await w.write(bytes); await w.close();
        clean(); return toast('Saved ✔');
      } catch (e) { console.warn(e); }
    }
    if (await saveBytes(bytes, S.name, true)) clean(); else toast('Save cancelled');
  } catch (e) { console.error(e); toast('Sorry, saving failed: ' + e.message, 6000); }
}

/* ---------------- zoom ---------------- */
function setZoom(z, fit) {
  commitEditing();
  S.zoom = Math.min(5, Math.max(0.1, z)); S.zoomed = !fit; updateZoomSel();
  const cont = $('#pages');
  cont.style.transformOrigin = 'top center'; cont.style.transform = `scale(${S.zoom / (cont._z || S.zoom)})`;
  clearTimeout(setZoom.t); setZoom.t = setTimeout(() => buildView(true), 140);
}
function fitWidth(silent) {
  const maxW = Math.max(...S.pages.map(p => dims(p).w), 1);
  const z = Math.min(1.6, Math.max(0.3, ($('#view').clientWidth - 60) / maxW));
  if (silent) { S.zoom = z; S.zoomed = false; } else setZoom(z, true);
}
$('#bZoomIn').onclick = () => setZoom(S.zoom * 1.2);
$('#bZoomOut').onclick = () => setZoom(S.zoom / 1.2);
$('#view').addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });

/* ---------------- form filling ---------------- */
async function buildFormLayer(w, p, pg) {
  const fl = w.querySelector('.fl'); fl.innerHTML = '';
  let anns = [];
  try { anns = await pg.getAnnotations({ intent: 'display' }); } catch { return; }
  const vp = pg.getViewport({ scale: S.zoom, rotation: totalRot(p) });
  const vals = S.forms[p.src] || (S.forms[p.src] = {});
  const mark = () => { S.formsDirty[p.src] = true; S.dirty = true; updateTitle(); };
  for (const an of anns) {
    if (an.subtype !== 'Widget' || !an.fieldName || an.readOnly || !['Tx', 'Btn', 'Ch'].includes(an.fieldType) || an.pushButton) continue;
    const r = pdfjsLib.Util.normalizeRect(vp.convertToViewportRectangle(an.rect));
    const name = an.fieldName;
    let e;
    if (an.fieldType === 'Tx') {
      e = el(an.multiLine ? 'textarea' : 'input');
      e.value = vals[name] ?? an.fieldValue ?? '';
      if (an.maxLen) e.maxLength = an.maxLen;
      e.onfocus = () => { e._snapped = false; };
      e.oninput = () => { if (!e._snapped) { snap(); e._snapped = true; } vals[name] = e.value; mark(); $$('.fl .ff').forEach(o => o !== e && o.dataset.f === name && (o.value = e.value)); };
      e.style.fontSize = Math.min((r[3] - r[1]) * 0.7, 12 * S.zoom) + 'px';
    } else if (an.fieldType === 'Ch') {
      e = el('select');
      for (const o of an.options || []) { const op = el('option'); op.value = o.exportValue; op.textContent = o.displayValue; e.append(op); }
      const cur = vals[name] ?? (Array.isArray(an.fieldValue) ? an.fieldValue[0] : an.fieldValue);
      if (cur != null) e.value = cur;
      e.onchange = () => { snap(); vals[name] = e.value; mark(); };
    } else {
      e = el('input'); e.type = an.radioButton ? 'radio' : 'checkbox';
      if (an.radioButton) {
        e.name = 'r_' + p.src + '_' + name;
        e.checked = (vals[name] ?? an.fieldValue) === an.buttonValue;
        e.onchange = () => { snap(); vals[name] = an.buttonValue; mark(); };
      } else {
        e.checked = vals[name] ?? (!!an.fieldValue && an.fieldValue !== 'Off');
        e.onchange = () => { snap(); vals[name] = e.checked; mark(); };
      }
    }
    e.dataset.f = name; e.className = 'ff'; e.title = an.alternativeText || name;
    Object.assign(e.style, { left: r[0] + 'px', top: r[1] + 'px', width: r[2] - r[0] + 'px', height: r[3] - r[1] + 'px' });
    fl.append(e);
  }
}
function applyForm(lib, src) {
  const vals = S.forms[src];
  if (!vals || !S.formsDirty[src]) return;
  let form; try { form = lib.getForm(); } catch { return; }
  for (const [name, v] of Object.entries(vals)) {
    try {
      const f = form.getField(name);
      if (f.setText) f.setText(String(v));
      else if (f.check) v ? f.check() : f.uncheck();
      else if (f.select) f.select(String(v));
    } catch (e) { console.warn('form field', name, e); }
  }
  try { form.updateFieldAppearances(); } catch (e) { console.warn(e); }
}
// copyPages keeps the field widgets; re-register them so the saved PDF is still a fillable form
function linkFormFields(out) {
  const roots = new Map();
  for (const pg of out.getPages()) {
    const annots = pg.node.lookup(PN('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (const ref of annots.asArray()) {
      let r = ref, node = out.context.lookup(ref);
      if (!(node instanceof PDFDict) || String(node.lookup(PN('Subtype'))) !== '/Widget') continue;
      while (node.get(PN('Parent'))) { r = node.get(PN('Parent')); node = out.context.lookup(r); }
      roots.set(String(r), r);
    }
  }
  if (roots.size) out.catalog.set(PN('AcroForm'), out.context.obj({ Fields: [...roots.values()], DA: PDFLib.PDFString.of('/Helv 0 Tf 0 g') }));
}

/* ---------------- text index (shared by search, copy-text, contents) ---------------- */
const findCache = new Map();
async function pageItems(p) {
  const key = p.id + JSON.stringify(p.erase || []) + p.rot + '|' + (p.ocr?.length || 0);
  if (!findCache.has(key)) for (const k of findCache.keys()) if (k.startsWith(p.id + '[') || k.startsWith(p.id + '|') ) findCache.delete(k); // old versions of this page
  if (!findCache.has(key)) findCache.set(key, (async () => {
    let items = [];
    if (p.src >= 0) {
      const pg = await getPg(p), vp = pg.getViewport({ scale: 1, rotation: totalRot(p) });
      items = (await pg.getTextContent()).items.filter(i => i.str).map(i => {
        const t = pdfjsLib.Util.transform(vp.transform, i.transform), fh = Math.hypot(t[2], t[3]);
        return { str: i.str, x: t[4], y: t[5] - fh * 0.9, w: i.width, h: fh * 1.15, fh };
      });
    }
    for (const l of p.ocr || []) items.push({ str: l.text, x: l.x, y: l.y, w: l.w, h: l.h, fh: l.h / 1.15 });
    return items;
  })());
  return findCache.get(key);
}
// Page text as one string (lines joined with \n) plus where every item sits in it
const textCache = new WeakMap(); // tied to the cached text items – freed automatically
async function pageText(p) {
  const items = await pageItems(p);
  if (textCache.has(items)) return textCache.get(items);
  let text = ''; const map = []; let prev = null;
  for (const it of items) {
    if (prev) {
      const sameLine = Math.abs(prev.y - it.y) < Math.max(prev.h, it.h) * 0.5;
      if (!sameLine) text += '\n';
      else if (it.x - (prev.x + prev.w) > it.fh * 0.12 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
    }
    map.push({ it, s: text.length, e: text.length + it.str.length });
    text += it.str; prev = it;
  }
  const r = { text, map }; textCache.set(items, r); return r;
}
// Where characters a..b of a text item sit: split the item's width by real letter widths (not by count)
let wctx;
function charOffsets(str) {
  wctx = wctx || el('canvas').getContext('2d'); wctx.font = '100px Arial';
  const off = [0]; for (const ch of str) { const w = wctx.measureText(ch).width || 50; for (let k = 0; k < ch.length; k++) off.push(off[off.length - 1] + (k ? 0 : w)); }
  return off;
}
function rangeRects(map, s, e) {
  const out = [];
  for (const m of map) {
    if (m.e <= s || m.s >= e) continue;
    const it = m.it, a = Math.max(s, m.s) - m.s, b = Math.min(e, m.e) - m.s;
    const off = it._off || (it._off = charOffsets(it.str)), tot = off[off.length - 1] || 1;
    const x0 = it.x + it.w * off[a] / tot, x1 = it.x + it.w * off[b] / tot;
    out.push({ x: x0, y: it.y, w: Math.max(1, x1 - x0), h: it.h, fh: it.fh });
  }
  return out;
}

/* ---------------- advanced search ---------------- */
function resetSearch(msg) {
  if (typeof SR === 'undefined') return;
  SR.token++; SR.results = []; SR.byPage.clear(); SR.active = -1; clearSearchMarks();
  $('#sResults').innerHTML = ''; $('#sStatus').textContent = msg || ''; updateSearchButtons();
}
const PRESETS = {
  'Emails': '[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+',
  'Phones': '(\\+?1[\\s.-]?)?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}\\b',
  'SSNs': '\\b\\d{3}[- ]?\\d{2}[- ]?\\d{4}\\b',
  'Dates': '\\b(\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.? \\d{1,2},? \\d{4})\\b',
  'Money': '[$€£₹]\\s?\\d[\\d,]*(\\.\\d{2})?|\\b\\d[\\d,]*\\.\\d{2}\\b',
  'Links': '\\b(https?://|www\\.)\\S+',
  'Card #s': '\\b(?:\\d[ -]?){13,16}\\b',
};
const SR = { results: [], active: -1, token: 0, byPage: new Map() };
const fold = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const foldKeep = s => /[\u0080-￿]/.test(s) ? s.replace(/[\u0080-￿]/g, c => fold(c)[0] || c) : s; // same length → positions stay valid
function buildMatcher() {
  const q = $('#sQ').value, mode = $('#sMode').value, mc = $('#sCase').checked, ww = $('#sWord').checked, acc = $('#sAccent').checked;
  if (!q.trim()) return null;
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prep = t => acc ? fold(t) : t;
  const wrap = t => ww ? `(?<![\\p{L}\\p{N}])(?:${t})(?![\\p{L}\\p{N}])` : t;
  let srcs;
  if (mode === 'regex') srcs = [q];
  else if (mode === 'phrase') srcs = [wrap(esc(prep(q.trim())).replace(/\s+/g, '[\\s\\p{P}_]+'))]; // a space also matches . , - _
  else { const words = prep(q).split(/\s+/).filter(Boolean).map(esc); srcs = mode === 'any' ? [wrap(words.join('|'))] : words.map(wrap); }
  try {
    const res = srcs.map(s => new RegExp(s, 'gu' + (mc ? '' : 'i')));
    return { res, all: mode === 'all', acc };
  } catch (e) { $('#sStatus').textContent = 'Pattern error: ' + e.message; return null; }
}
function searchScope() {
  const sc = $('#sScope').value, n = S.pages.length;
  if (sc === 'current') return [S.current];
  if (sc === 'selected') { const s = S.pages.map((p, i) => S.selPages.has(p.id) ? i : -1).filter(i => i >= 0); return s.length ? s : [S.current]; }
  if (sc === 'range') return parseRange($('#sRange').value.replace(/\s*-\s*/g, '-'), n);
  return S.pages.map((_, i) => i);
}
async function runSearch() {
  const m = buildMatcher();
  const tok = ++SR.token;
  const results = []; SR.results = []; SR.active = -1; SR.byPage.clear(); clearSearchMarks();
  $('#sResults').innerHTML = '';
  if (!m) { $('#sStatus').textContent = $('#sStatus').textContent.startsWith('Pattern') ? $('#sStatus').textContent : ''; updateSearchButtons(); return; }
  const pages = searchScope(), t0 = performance.now();
  const wantAnn = $('#sAnn').checked;
  for (let n = 0; n < pages.length; n++) {
    const pi = pages[n], p = S.pages[pi];
    if (n % 32 === 0) { // read the next pages' text in parallel (background thread), keep the window responsive
      $('#sStatus').textContent = `Searching… page ${n + 1} of ${pages.length}`;
      await Promise.all(pages.slice(n, n + 32).map(i => pageText(S.pages[i])));
      if (tok !== SR.token) return;
    }
    const { text, map } = await pageText(p);
    if (tok !== SR.token) return;
    const pt = await pageText(p), hay = m.acc ? (pt.folded ??= foldKeep(text)) : text; // folded copy cached per page
    const found = [];
    for (const re of m.res) {
      re.lastIndex = 0; let mm, any = false;
      while ((mm = re.exec(hay))) {
        if (!mm[0].length) { re.lastIndex++; continue; }
        any = true; found.push({ s: mm.index, e: mm.index + mm[0].length });
        if (found.length > 5000) break;
      }
      if (m.all && !any) { found.length = 0; break; }
    }
    found.sort((a, b) => a.s - b.s);
    for (const f of found) {
      const rects = rangeRects(map, f.s, f.e); if (!rects.length) continue;
      results.push({ pi, pid: p.id, kind: 'text', s: f.s, e: f.e, rects, text: text.slice(f.s, f.e), ctx: [text.slice(Math.max(0, f.s - 40), f.s), text.slice(f.e, f.e + 40)] });
    }
    if (wantAnn) { // also search text you added and form answers
      const added = p.annots.filter(a => a.type === 'text').map(a => ({ str: a.text, a }));
      const fv = S.forms[p.src] || {};
      for (const { str, a } of added) for (const re of m.res) { re.lastIndex = 0; const mm = re.exec(m.acc ? foldKeep(str) : str); if (mm) { results.push({ pi, pid: p.id, kind: 'annot', aid: a.id, text: mm[0], rects: [{ x: a.x, y: a.y, w: a.w || 50, h: a.h || 14 }], ctx: [str.slice(Math.max(0, mm.index - 40), mm.index), str.slice(mm.index + mm[0].length, mm.index + mm[0].length + 40)] }); break; } }
      if (p === S.pages.find(q => q.src === p.src)) for (const [k, v] of Object.entries(fv)) for (const re of m.res) { re.lastIndex = 0; if (typeof v === 'string' && re.test(v)) { results.push({ pi, pid: p.id, kind: 'form', text: v, rects: [], ctx: [k + ': ', ''] }); break; } }
    }
    if (results.length > 20000) break;
  }
  if (tok !== SR.token) return;
  SR.results = results;
  for (const r of SR.results) { if (!SR.byPage.has(r.pid)) SR.byPage.set(r.pid, []); SR.byPage.get(r.pid).push(r); }
  const pagesHit = SR.byPage.size;
  $('#sStatus').textContent = SR.results.length ? `${SR.results.length} match${SR.results.length > 1 ? 'es' : ''} on ${pagesHit} page${pagesHit > 1 ? 's' : ''} · ${Math.round(performance.now() - t0)} ms` : 'No matches.';
  renderResults(); drawAllSearchMarks(); updateSearchButtons();
  if (SR.results.length) gotoResult(SR.results.findIndex(r => r.pi >= S.current) >= 0 ? SR.results.findIndex(r => r.pi >= S.current) : 0, true);
}
const escHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function renderResults() {
  const box = $('#sResults'); box.innerHTML = '';
  let lastPage = -1, frag = document.createDocumentFragment(), shown = 0;
  SR.results.forEach((r, i) => {
    if (shown > 1500) return; shown++;
    if (r.pi !== lastPage) {
      lastPage = r.pi;
      const h = el('div', 'sr-page'); h.textContent = `Page ${r.pi + 1}`;
      const c = el('span', 'sr-count'); c.textContent = SR.byPage.get(r.pid).length; h.append(c); frag.append(h);
    }
    const d = el('div', 'sr'); d.dataset.i = i;
    d.innerHTML = (r.kind !== 'text' ? `<span class="sr-tag">${r.kind === 'annot' ? 'added' : 'form'}</span>` : '') +
      `…${escHtml(r.ctx[0].replace(/\n/g, ' '))}<mark>${escHtml(r.text)}</mark>${escHtml(r.ctx[1].replace(/\n/g, ' '))}…`;
    frag.append(d);
  });
  if (SR.results.length > shown) { const d = el('div', 'muted'); d.textContent = `…and ${SR.results.length - shown} more (all are highlighted on the pages)`; frag.append(d); }
  box.append(frag);
}
$('#sResults').addEventListener('click', e => { const d = e.target.closest('.sr'); if (d) gotoResult(+d.dataset.i); });
function gotoResult(i, noScrollList) {
  if (!SR.results.length) return;
  SR.active = (i + SR.results.length) % SR.results.length;
  const r = SR.results[SR.active], p = pageById(r.pid); if (!p) return;
  $$('#sResults .sr.on').forEach(d => d.classList.remove('on'));
  const row = $(`#sResults .sr[data-i="${SR.active}"]`); if (row) { row.classList.add('on'); if (!noScrollList) row.scrollIntoView({ block: 'nearest' }); }
  $('#sPos').textContent = `${SR.active + 1} / ${SR.results.length}`;
  setCurrent(S.pages.indexOf(p));
  const w = pageEl(p); if (!w) return;
  drawAllSearchMarks();
  const rc = r.rects[0];
  if (rc) {
    const v = $('#view'), top = w.offsetTop + rc.y * S.zoom - v.clientHeight / 3, left = w.offsetLeft + rc.x * S.zoom - v.clientWidth / 3;
    v.scrollTo({ top, left: Math.max(0, left), behavior: Math.abs(v.scrollTop - top) > 3000 ? 'auto' : 'smooth' });
  } else w.scrollIntoView({ block: 'start' });
  if (r.kind === 'annot') { setTool('select'); select(r.aid); }
}
function clearSearchMarks() { $$('.sl').forEach(l => l.innerHTML = ''); }
function drawSearchMarks(w, p) {
  const l = w.querySelector('.sl'); if (!l) return;
  l.innerHTML = '';
  const list = SR.byPage.get(p.id); if (!list) return;
  const z = S.zoom, act = SR.results[SR.active], frag = document.createDocumentFragment();
  for (const r of list) for (const rc of r.rects) {
    const m = el('div', 'hit' + (r === act ? ' act' : ''));
    m.style.cssText = `left:${rc.x * z - 1}px;top:${rc.y * z}px;width:${rc.w * z + 2}px;height:${rc.h * z}px`;
    frag.append(m);
  }
  l.append(frag);
}
function drawAllSearchMarks() { $$('.page').forEach(w => { if (w._painted) drawSearchMarks(w, pageById(w.dataset.id)); }); }
function updateSearchButtons() { const none = !SR.results.some(r => r.kind === 'text'); ['#sHl', '#sRedact', '#sReplace', '#sCopy'].forEach(s => $(s).disabled = none && s !== '#sCopy' || !SR.results.length); $('#sPos').textContent = SR.results.length ? `${Math.max(0, SR.active) + 1} / ${SR.results.length}` : ''; }

// Replace a page by a flat picture of itself (with black boxes burned in) – guarantees nothing underneath survives
async function flattenPage(p) {
  const d = dims(p), k = 200 / 72, c = await renderRegion(p, { x: 0, y: 0, w: d.w, h: d.h }, k), x = c.getContext('2d');
  for (const a of p.annots) if (a.type === 'rect' && a.color === '#000000') { x.fillStyle = '#000'; x.fillRect(a.x * k, a.y * k, a.w * k, a.h * k); }
  const img = registerImage(c.toDataURL('image/jpeg', 0.9));
  Object.assign(p, { src: -1, idx: 0, baseRot: 0, rot: 0, w: d.w, h: d.h, erase: undefined, ocr: undefined,
    annots: [{ id: nid(), type: 'image', img, x: 0, y: 0, w: d.w, h: d.h }, ...p.annots.filter(a => a.type === 'rect' && a.color === '#000000')] });
}
async function bulkOnResults(kind) {
  const list = SR.results.filter(r => r.kind === 'text'); if (!list.length) return;
  let repl = '';
  if (kind === 'replace') { repl = $('#sRepl').value; if (!repl && !confirm('Replace every match with nothing (delete them)?')) return; }
  if (kind === 'redact' && !confirm(`Permanently remove ${list.length} match${list.length > 1 ? 'es' : ''} from the document and black them out?\n(The text is really deleted, not just covered.)`)) return;
  snap();
  const touched = new Set(), before = new Map(), chars = t => t.replace(/\s/g, '').length;
  if (kind === 'redact') for (const pid of new Set(list.map(r => r.pid))) { const p = pageById(pid); if (p) before.set(p, chars((await pageText(p)).text)); }
  for (const r of list) {
    const p = pageById(r.pid); if (!p) continue;
    if (kind === 'highlight') { for (const rc of r.rects) p.annots.push({ id: nid(), type: 'rect', x: rc.x, y: rc.y + rc.h * 0.05, w: rc.w, h: rc.h * 0.9, color: '#ffe600', op: 1, blend: 'multiply' }); touched.add(p); continue; }
    const vp = (await getPg(p)).getViewport({ scale: 1, rotation: totalRot(p) });
    if (p.ocr?.length && kind !== 'highlight') { // invisible OCR text must go too
      for (const l of p.ocr) if (r.rects.some(rc => rc.x < l.x + l.w && rc.x + rc.w > l.x && rc.y < l.y + l.h && rc.y + rc.h > l.y))
        l.text = l.text.split(r.text).join(kind === 'replace' ? ($('#sRepl').value || ' ') : ' '.repeat(r.text.length));
    }
    for (const rc of r.rects) {
      const padX = kind === 'redact' ? Math.max(0.8, rc.fh * 0.12) : 0.6; // redaction: a little extra so edge letters can't survive
      const c1 = vp.convertToPdfPoint(rc.x - padX, rc.y + rc.h * 0.02), c2 = vp.convertToPdfPoint(rc.x + rc.w + padX, rc.y + rc.h * 0.98);
      p.erase = [...(p.erase || []), [Math.min(c1[0], c2[0]), Math.min(c1[1], c2[1]), Math.max(c1[0], c2[0]), Math.max(c1[1], c2[1])]];
      if (kind === 'redact') p.annots.push({ id: nid(), type: 'rect', x: rc.x, y: rc.y + rc.h * 0.05, w: rc.w, h: rc.h * 0.9, color: '#000000', op: 1 });
    }
    if (kind === 'replace' && repl) {
      const rc = r.rects[0], size = rc.fh, base = rc.y + rc.fh * 0.9;
      p.annots.push({ id: nid(), type: 'text', x: rc.x, y: base - FONTS.Helvetica.base * size, text: repl, size, font: 'Helvetica', bold: false, color: '#000000' });
    }
    touched.add(p);
  }
  for (const p of touched) { renderAnnots(p); if (kind !== 'highlight' && pageEl(p)?._painted) repaint(p); }
  if (kind === 'redact') { // make sure the words are really gone from the file, not just covered
    $('#sStatus').textContent = 'Checking that the text is really removed…';
    const left = [];
    for (const p of touched) {
      // every letter of every match must be gone: count the letters left on the page
      const removed = list.filter(r => r.pid === p.id).reduce((t, r) => t + chars(r.text), 0);
      if (chars((await pageText(p)).text) > before.get(p) - removed) left.push(p);
    }
    if (left.length && confirm(`On ${left.length} page${left.length > 1 ? 's' : ''} (${left.map(p => S.pages.indexOf(p) + 1).join(', ')}) some matches could not be removed from the file's text (unusual font). They are covered, but could still be copied.\n\nTurn ${left.length > 1 ? 'those pages' : 'that page'} into a flat image so nothing can be copied? (Recommended)`)) {
      for (const p of left) await flattenPage(p);
      refreshAll(true);
    } else if (left.length) toast('Some matches are only covered, not removed – see pages ' + left.map(p => S.pages.indexOf(p) + 1).join(', '), 7000);
  }
  toast(`${kind === 'highlight' ? 'Highlighted' : kind === 'redact' ? 'Redacted' : 'Replaced'} ${list.length} match${list.length > 1 ? 'es' : ''} – Ctrl+Z to undo`, 4000);
  if (kind !== 'highlight') { SR.results = []; SR.byPage.clear(); clearSearchMarks(); $('#sResults').innerHTML = ''; $('#sStatus').textContent = 'Done. Search again to refresh.'; updateSearchButtons(); }
}
$('#sHl').onclick = () => bulkOnResults('highlight');
$('#sRedact').onclick = () => bulkOnResults('redact');
$('#sReplace').onclick = () => bulkOnResults('replace');
$('#sCopy').onclick = async () => {
  await copyToClipboard(SR.results.map(r => `p.${r.pi + 1}\t${r.text}`).join('\n'));
  toast(`Copied ${SR.results.length} results`);
};
let sTimer;
$('#sQ').addEventListener('input', () => { clearTimeout(sTimer); sTimer = setTimeout(runSearch, 250); });
$('#sQ').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); if (!SR.results.length) runSearch(); else gotoResult(SR.active + (e.shiftKey ? -1 : 1)); }
  if (e.key === 'Escape') { e.target.blur(); }
});
['#sMode', '#sCase', '#sWord', '#sAccent', '#sAnn', '#sScope'].forEach(s => $(s).addEventListener('change', () => { $('#sRange').hidden = $('#sScope').value !== 'range'; runSearch(); }));
$('#sRange').addEventListener('change', runSearch);
$('#sPrev').onclick = () => gotoResult(SR.active - 1);
$('#sNext').onclick = () => gotoResult(SR.active + 1);
$('#sClear').onclick = () => { $('#sQ').value = ''; runSearch(); $('#sQ').focus(); };
for (const [name, re] of Object.entries(PRESETS)) {
  const b = el('button', 'chip'); b.textContent = name; b.title = 'Find all ' + name.toLowerCase();
  b.onclick = () => { $('#sMode').value = 'regex'; $('#sQ').value = re; $('#sWord').checked = false; runSearch(); };
  $('#sPresets').append(b);
}
function openSearch() {
  if (!S.pages.length) return;
  showSideTab('search');
  const sel = getSelection().toString().trim();
  if (sel && sel.length < 100) { $('#sQ').value = sel; runSearch(); }
  $('#sQ').focus(); $('#sQ').select();
}
$('#bFind').onclick = openSearch;

/* ---------------- side panel tabs + contents (index) ---------------- */
function showSideTab(t) {
  $$('#sideTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $$('.pane').forEach(p => p.hidden = p.dataset.t !== t);
  $('#side').classList.toggle('wide', t !== 'pages');
  if (t === 'contents') buildContents();
}
$$('#sideTabs button').forEach(b => b.onclick = () => showSideTab(b.dataset.t));

let contentsFor = null;
async function buildContents(force) {
  const key = S.pages.map(p => p.id).join() + S.sources.length;
  if (contentsFor === key && !force) return;
  contentsFor = key;
  const box = $('#tocList'); box.innerHTML = '<div class="muted">Reading…</div>';
  const out = document.createDocumentFragment();
  const srcs = [...new Set(S.pages.filter(p => p.src >= 0).map(p => p.src))];
  let any = false;
  for (const src of srcs) {
    const s = S.sources[src]; if (!s) continue;
    let outline = null; try { outline = await s.doc.getOutline(); } catch { }
    if (!outline || !outline.length) continue;
    any = true;
    if (srcs.length > 1) { const h = el('div', 'toc-src'); h.textContent = s.name; out.append(h); }
    const walk = (items, depth) => {
      for (const it of items) {
        const d = el('div', 'toc'); d.style.paddingLeft = 8 + depth * 14 + 'px'; d.textContent = it.title;
        if (it.bold) d.style.fontWeight = '600';
        d.onclick = () => gotoDest(src, it.dest, it.url);
        out.append(d);
        if (it.items?.length) walk(it.items, depth + 1);
      }
    };
    walk(outline, 0);
  }
  if (!any) { // no bookmarks: build a smart index from the headings (larger text)
    const h = el('div', 'toc-src'); h.textContent = 'Headings found in the document'; out.append(h);
    const lines = [];
    const limit = Math.min(S.pages.length, 400);
    for (let i = 0; i < limit; i++) {
      const p = S.pages[i]; if (p.src < 0) continue;
      const { text, map } = await pageText(p);
      let cur = null;
      for (const m of map) {
        const line = cur && Math.abs(cur.y - m.it.y) < m.it.h * 0.5 ? cur : null;
        if (line) { line.text += (/\s$/.test(line.text) ? '' : ' ') + m.it.str; line.fh = Math.max(line.fh, m.it.fh); }
        else { cur = { text: m.it.str, fh: m.it.fh, y: m.it.y, pi: i }; lines.push(cur); }
      }
    }
    const sizes = lines.filter(l => l.text.trim().length > 2).map(l => l.fh).sort((a, b) => a - b);
    const body = sizes[Math.floor(sizes.length / 2)] || 10;
    const heads = lines.filter(l => l.fh >= body * 1.2 && l.text.trim().length >= 3 && l.text.trim().length <= 90 && /[A-Za-z]/.test(l.text));
    const levels = [...new Set(heads.map(l => Math.round(l.fh)))].sort((a, b) => b - a).slice(0, 3);
    for (const l of heads.slice(0, 600)) {
      const lv = levels.indexOf(Math.round(l.fh)); if (lv < 0) continue;
      const d = el('div', 'toc'); d.style.paddingLeft = 8 + lv * 14 + 'px'; d.textContent = l.text.trim();
      const pg = el('span', 'toc-pg'); pg.textContent = l.pi + 1; d.append(pg);
      d.onclick = () => scrollToPoint(l.pi, l.y);
      out.append(d);
    }
    if (!heads.length) { const m = el('div', 'muted'); m.textContent = 'This PDF has no bookmarks or headings. Use the page list or Go to page.'; out.append(m); }
  }
  box.innerHTML = ''; box.append(out);
}
async function gotoDest(src, dest, url) {
  if (url) { // web link inside a PDF bookmark: ask first (the app is otherwise fully offline)
    if (/^(https?:|mailto:)/i.test(url) && confirm(`This bookmark opens a web page:\n\n${url}\n\nOpen it?`)) window.open(url, '_blank', 'noopener');
    return;
  }
  const s = S.sources[src]; if (!s || !dest) return;
  try {
    const d = typeof dest === 'string' ? await s.doc.getDestination(dest) : dest;
    if (!d) return;
    const idx = typeof d[0] === 'object' ? await s.doc.getPageIndex(d[0]) : d[0];
    const pi = S.pages.findIndex(p => p.src === src && p.idx === idx);
    if (pi < 0) return toast('That page was removed from this document.');
    const p = S.pages[pi];
    let y = 0;
    if (d[1]?.name === 'XYZ' && d[3] != null) { const vp = (await getPg(p)).getViewport({ scale: 1, rotation: totalRot(p) }); y = vp.convertToViewportPoint(d[2] || 0, d[3])[1]; }
    else if (d[1]?.name === 'FitH' || d[1]?.name === 'FitBH') { const vp = (await getPg(p)).getViewport({ scale: 1, rotation: totalRot(p) }); y = d[2] != null ? vp.convertToViewportPoint(0, d[2])[1] : 0; }
    scrollToPoint(pi, y);
  } catch (e) { console.warn(e); }
}
function scrollToPoint(pi, y) {
  const p = S.pages[pi], w = p && pageEl(p); if (!w) return;
  setCurrent(pi);
  $('#view').scrollTo({ top: w.offsetTop + Math.max(0, y - 20) * S.zoom, behavior: 'auto' });
}

/* ---------------- page navigation + zoom bar ---------------- */
function updateNav() {
  const n = S.pages.length;
  $('#navPage').value = n ? S.current + 1 : ''; $('#navTotal').textContent = n ? '/ ' + n : '';
  ['#navFirst', '#navPrev'].forEach(s => $(s).disabled = !n || S.current === 0);
  ['#navNext', '#navLast'].forEach(s => $(s).disabled = !n || S.current >= n - 1);
}
$('#navFirst').onclick = () => setCurrent(0, true);
$('#navPrev').onclick = () => setCurrent(S.current - 1, true);
$('#navNext').onclick = () => setCurrent(S.current + 1, true);
$('#navLast').onclick = () => setCurrent(S.pages.length - 1, true);
$('#navPage').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const v = parseInt(e.target.value, 10);
  if (v >= 1 && v <= S.pages.length) { setCurrent(v - 1, true); e.target.blur(); } else { e.target.value = S.current + 1; toast(`Pages go from 1 to ${S.pages.length}`); }
});
$('#navPage').addEventListener('focus', e => e.target.select());
function fitPage() {
  const p = S.pages[S.current] || S.pages[0]; if (!p) return;
  const d = dims(p), v = $('#view');
  if (v.clientHeight < 50) return;
  setZoom(Math.min((v.clientWidth - 60) / d.w, (v.clientHeight - 40) / d.h), true);
}
$('#zoomSel').onchange = e => {
  const v = e.target.value;
  if (v === 'width') fitWidth(); else if (v === 'page') fitPage(); else setZoom(+v / 100);
  e.target.blur();
};
function updateZoomSel() {
  const sel = $('#zoomSel'), pct = Math.round(S.zoom * 100);
  let o = sel.querySelector('option[data-cur]');
  if (!o) { o = el('option'); o.dataset.cur = 1; sel.prepend(o); }
  o.value = pct; o.textContent = pct + '%'; sel.value = pct;
}


/* ---------------- print ---------------- */
async function printPdf() {
  if (!S.pages.length) return;
  commitEditing(); toast('Preparing to print…');
  const url = URL.createObjectURL(new Blob([await buildPdf(S.pages)], { type: 'application/pdf' }));
  const f = el('iframe'); f.style.cssText = 'position:fixed;width:1px;height:1px;border:0;right:0;bottom:0;opacity:0';
  f.src = url; document.body.append(f);
  f.onload = () => setTimeout(() => { try { f.contentWindow.print(); } catch { window.open(url); } }, 400);
  setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 300000);
}

/* ---------------- apply to all pages ---------------- */
function applyToAllPages() {
  const f = S.sel && findAnnot(S.sel); if (!f) return;
  const others = S.pages.filter(p => p !== f.p);
  if (!others.length) return toast('There is only one page.');
  snap();
  for (const p of others) { const c = { ...JSON.parse(JSON.stringify(f.a)), id: nid() }; delete c.pdfFont; delete c.css; p.annots.push(c); }
  others.forEach(p => renderAnnots(p));
  toast(`Copied to ${others.length} other page${others.length > 1 ? 's' : ''} – Ctrl+Z to undo`);
}
$('#pAll').onclick = applyToAllPages;
$('#bPrint').onclick = printPdf;

/* ---------------- select area: copy text / OCR / copy image / move / duplicate ---------------- */
// OCR helper (Windows' built-in OCR) is provided by PDFEditor.exe through a local-only, token-protected port
if (location.protocol === 'file:') {
  const sc = el('script'); sc.src = 'server.js'; sc.onerror = () => {}; document.head.append(sc);
}
const helperUrl = p => window.__helper && `http://127.0.0.1:${window.__helper.port}/${p}?t=${window.__helper.token}`;
setInterval(() => { const u = helperUrl('ping'); if (u) fetch(u).catch(() => {}); }, 30000);
setTimeout(() => { const u = helperUrl('ping'); if (u) fetch(u).catch(() => {}); }, 1500);

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { }
  const t = el('textarea'); t.value = text; document.body.append(t); t.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { }
  t.remove();
  if (!ok) showTextBox(text); // Windows refused the clipboard: show the text so it can be copied by hand
  return ok;
}
function showTextBox(text) {
  $('#tmodal').hidden = false; $('#tProg').hidden = true; $('#tMsg').textContent = '';
  $('#tTitle').textContent = '📋 Text'; $('#tBack').hidden = true; $('#tRun').hidden = true;
  $('#tBody').innerHTML = '<p class="muted">Select the text and press Ctrl+C:</p><textarea class="textout" readonly></textarea>';
  const ta = $('#tBody textarea'); ta.value = text; ta.focus(); ta.select();
}
// Render part of a page (display coords, scale 1) to a canvas at k× resolution
async function renderRegion(p, b, k) {
  const c = el('canvas'); c.width = Math.max(1, Math.round(b.w * k)); c.height = Math.max(1, Math.round(b.h * k));
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  if (p.src >= 0) {
    const pg = await getPg(p);
    await pg.render({ canvasContext: ctx, viewport: pg.getViewport({ scale: k, rotation: totalRot(p) }), transform: [1, 0, 0, 1, -b.x * k, -b.y * k],
      intent: 'print', annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
  }
  for (const a of p.annots) if (a.type === 'image' || a.type === 'clip') { // include pictures/signatures that were added
    const i = await loadImg(S.images[a.img]); ctx.drawImage(i, (a.x - b.x) * k, (a.y - b.y) * k, a.w * k, a.h * k);
  }
  return c;
}
// Text inside a box, in reading order, using the PDF's own text (exact, instant)
async function textInBox(p, b) {
  const items = (await pageItems(p)).map(it => {
    const n = it.str.length; if (!n || it.w <= 0) return null;
    if (it.y + it.h / 2 < b.y || it.y + it.h / 2 > b.y + b.h) return null;
    const s = Math.max(0, Math.round((b.x - it.x) / it.w * n)), e = Math.min(n, Math.round((b.x + b.w - it.x) / it.w * n));
    if (e <= s) return null;
    return { str: it.str.slice(s, e), x: it.x + it.w * s / n, y: it.y, h: it.h, w: it.w * (e - s) / n };
  }).filter(Boolean).sort((a, c) => a.y - c.y || a.x - c.x);
  const lines = [];
  for (const it of items) {
    const ln = lines.find(l => Math.abs(l.y - it.y) < it.h * 0.5);
    if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  return lines.sort((a, c) => a.y - c.y).map(l => {
    l.items.sort((a, c) => a.x - c.x); let s = '', end = null;
    for (const it of l.items) { if (end !== null && it.x - end > it.h * 0.2 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' '; s += it.str; end = it.x + it.w; }
    return s.replace(/\s+$/, '');
  }).join('\n');
}
async function ocrRegion(p, b) {
  const u = helperUrl('ocr');
  if (!u) throw new Error('Text recognition needs PDFEditor.exe (it uses the OCR engine built into Windows).');
  const k = Math.min(4, Math.max(2, 1600 / Math.max(b.w, b.h)));
  const c = await renderRegion(p, b, k);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  let res;
  try { res = await (await fetch(u, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/png' } })).json(); }
  catch { throw new Error("Couldn't reach the text-recognition helper. Close the editor and open it again (from the .exe)."); }
  if (res.error) throw new Error(res.error);
  const fix = t => t.replace(/(\d) ([,.]\d)/g, '$1$2').replace(/ ([,.;:!?])(\s|$)/g, '$1$2');
  return res.lines.map(l => ({ text: fix(l.text), x: b.x + l.x / k, y: b.y + l.y / k, w: l.w / k, h: l.h / k }));
}
function sampleBg(p, b) {
  try {
    const c = pageEl(p).querySelector('canvas'), k = c.width / dims(p).w;
    const px = c.getContext('2d').getImageData(Math.max(0, (b.x - 2) * k), Math.max(0, (b.y - 2) * k), 1, 1).data;
    return '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  } catch { return '#ffffff'; }
}

let areaSel = null;
function showAreaMenu(p, b) {
  areaSel = { p, b };
  const w = pageEl(p), z = S.zoom, m = $('#areaMenu');
  const band = el('div', 'band areasel'); band.id = 'areaBand';
  Object.assign(band.style, { left: b.x * z + 'px', top: b.y * z + 'px', width: b.w * z + 'px', height: b.h * z + 'px' });
  $('#areaBand')?.remove(); w.querySelector('.al').append(band);
  $('#view').append(m); m.hidden = false; // lives in the scroll area (pages get rebuilt)
  m.style.left = w.offsetLeft + b.x * z + 'px'; m.style.top = w.offsetTop + (b.y + b.h) * z + 6 + 'px';
  $('#amMove').disabled = $('#amDup').disabled = p.src < 0 && !p.annots.length;
}
function hideAreaMenu() { $('#areaMenu').hidden = true; $('#areaBand')?.remove(); areaSel = null; }

async function areaAction(act) {
  if (!areaSel) return;
  const { p, b } = areaSel;
  try {
    if (act === 'text' || act === 'ocr') {
      let txt = act === 'text' ? await textInBox(p, b) : '';
      let how = 'from the PDF';
      if (!txt.trim()) { toast('Reading the image…'); txt = (await ocrRegion(p, b)).map(l => l.text).join('\n'); how = 'with OCR'; }
      if (!txt.trim()) return toast('No text found in that area.');
      if (!(await copyToClipboard(txt))) return;
      toast(`Copied ${txt.length} characters ${how}: “${txt.slice(0, 60).replace(/\n/g, ' ')}${txt.length > 60 ? '…' : ''}”`, 4000);
    } else if (act === 'image') {
      const c = await renderRegion(p, b, 3);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Image copied – paste it anywhere (Ctrl+V)'); }
      catch { download(blob, 'selection.png'); toast('Saved the image as selection.png'); }
    } else if (act === 'editable') { // scanned page → real, editable text in place
      toast('Reading the image…');
      const lines = await ocrRegion(p, b);
      if (!lines.length) return toast('No text found in that area.');
      snap();
      const bg = sampleBg(p, b);
      for (const l of lines) {
        p.annots.push({ id: nid(), type: 'rect', x: l.x - 1, y: l.y - 1, w: l.w + 2, h: l.h + 2, color: bg, op: 1 });
        const size = Math.max(5, l.h / 1.0);
        p.annots.push({ id: nid(), type: 'text', x: l.x, y: l.y + l.h - FONTS.Helvetica.base * size + size * 0.18, text: l.text, size, font: 'Helvetica', bold: false, color: '#000000' });
      }
      renderAnnots(p); toast(`Converted ${lines.length} line${lines.length > 1 ? 's' : ''} to editable text – double-click to edit`);
    } else if (act === 'move' || act === 'dup') {
      const snapCanvas = await renderRegion(p, b, 3);
      const img = registerImage(snapCanvas.toDataURL('image/png'));
      let clip;
      if (p.src >= 0) {
        const vp = (await getPg(p)).getViewport({ scale: 1, rotation: totalRot(p) });
        const c1 = vp.convertToPdfPoint(b.x, b.y), c2 = vp.convertToPdfPoint(b.x + b.w, b.y + b.h);
        clip = { id: nid(), type: 'clip', src: p.src, idx: p.idx, srot: totalRot(p), img,
          ubox: [Math.min(c1[0], c2[0]), Math.min(c1[1], c2[1]), Math.max(c1[0], c2[0]), Math.max(c1[1], c2[1])], x: b.x, y: b.y, w: b.w, h: b.h };
      } else clip = { id: nid(), type: 'image', img, x: b.x, y: b.y, w: b.w, h: b.h }; // blank page: just a picture of the added items
      snap();
      if (act === 'move') {
        if (p.src >= 0) p.erase = [...(p.erase || []), clip.ubox];
        p.annots.push({ id: nid(), type: 'rect', x: b.x, y: b.y, w: b.w, h: b.h, color: sampleBg(p, b), op: 1 });
        if (p.erase) repaint(p);
      } else { clip.x += 15; clip.y += 15; }
      p.annots.push(clip); S.sel = clip.id; renderAnnots(p); setTool('select'); select(clip.id);
      toast(act === 'move' ? 'Now drag it where you want it (copy/paste with Ctrl+C / Ctrl+V works too)' : 'Copy made – drag it into place');
    }
  } catch (e) { console.error(e); toast(e.message, 6000); }
  if (act !== 'move' && act !== 'dup') hideAreaMenu(); else hideAreaMenu();
}
$$('#areaMenu button').forEach(bt => bt.onclick = () => areaAction(bt.dataset.a));

/* ---------------- auto-fill profiles ---------------- */
const PROFILE_FIELDS = [
  ['first', 'First name'], ['middle', 'Middle name'], ['last', 'Last name'], ['dob', 'Date of birth'], ['ssn', 'SSN'],
  ['email', 'Email'], ['phone', 'Phone'], ['street', 'Street address'], ['street2', 'Apt / Suite'], ['city', 'City'],
  ['state', 'State'], ['zip', 'ZIP'], ['country', 'Country'], ['company', 'Company'], ['title', 'Job title'],
];
const FIELD_RULES = [
  ['ssn', /\bssn\b|social\s*sec|soc\.?\s*sec|\btin\b|taxpayer\s*id/i],
  ['dob', /\bdob\b|birth|d\.o\.b/i],
  ['email', /e-?mail/i],
  ['phone', /phone|\btel\b|mobile|\bcell/i],
  ['zip', /\bzip|postal\s*code|post\s*code/i],
  ['street2', /address\s*(line)?\s*2|\bapt\b|apartment|suite|\bunit\b/i],
  ['city', /\bcity\b|\btown\b/i],
  ['state', /\bstate\b|province/i],
  ['country', /country/i],
  ['street', /address|street/i],
  ['company', /company|employer|organi[sz]ation|business\s*name/i],
  ['title', /job\s*title|occupation|position/i],
  ['first', /first\s*name|given\s*name|\bfname\b|first\b/i],
  ['middle', /middle\s*(name|initial)|\bmi\b/i],
  ['last', /last\s*name|surname|family\s*name|\blname\b/i],
  ['full', /full\s*name|print(ed)?\s*name|your\s*name|applicant|\bname\b/i],
  ['date', /^\s*date\s*:?\s*_*\s*$|date\s*signed|today/i],
];
const PSTORE = 'pdfeditor.profiles';
let profiles = null, profPass = null, curProfile = 0;
const b64 = u8 => btoa(String.fromCharCode(...u8)), unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function profKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function loadProfiles() {
  if (profiles) return true;
  let raw; try { raw = JSON.parse(localStorage.getItem(PSTORE)); } catch { }
  if (!raw) { profiles = []; return true; }
  if (!raw.ct) { profiles = raw.list || []; return true; }
  const pass = prompt('Your profiles are password-protected.\nEnter your profile password:');
  if (!pass) return false;
  try {
    const key = await profKey(pass, unb64(raw.salt));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(raw.iv) }, key, unb64(raw.ct));
    profiles = JSON.parse(new TextDecoder().decode(pt)); profPass = pass; return true;
  } catch { toast('Wrong password.'); return false; }
}
async function storeProfiles() {
  try {
    if (profPass) {
      const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await profKey(profPass, salt), new TextEncoder().encode(JSON.stringify(profiles))));
      localStorage.setItem(PSTORE, JSON.stringify({ salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
    } else {
      // without a password, sensitive numbers are kept only while the app is open – never written to disk
      const hadSsn = profiles.some(p => p.ssn);
      localStorage.setItem(PSTORE, JSON.stringify({ list: profiles.map(({ ssn, ...rest }) => rest) }));
      if (hadSsn) toast('SSN kept only until you close the app – set a password (🔓 button) to save it securely.', 6000);
    }
  } catch (e) { toast('Could not save profiles: ' + e.message); }
}
function profileValues(pr) {
  const v = { ...pr };
  v.full = [pr.first, pr.middle, pr.last].filter(Boolean).join(' ');
  v.date = new Date().toLocaleDateString();
  return v;
}
function renderProfileForm() {
  const sel = $('#profSel'); sel.innerHTML = '';
  profiles.forEach((pr, i) => { const o = el('option'); o.value = i; o.textContent = pr.label || `Profile ${i + 1}`; sel.append(o); });
  if (!profiles.length) { const o = el('option'); o.textContent = '(no profiles yet)'; sel.append(o); }
  sel.value = curProfile;
  const pr = profiles[curProfile] || {};
  $('#profLabel').value = pr.label || '';
  $('#profGrid').innerHTML = PROFILE_FIELDS.map(([k, l]) =>
    `<label>${l}<input data-k="${k}" ${k === 'ssn' ? 'type="password" autocomplete="off"' : ''} value="${(pr[k] || '').replace(/"/g, '&quot;')}"></label>`).join('');
  $('#profGrid').querySelector('[data-k="ssn"]').onfocus = e => e.target.type = 'text';
  $('#profLock').textContent = profPass ? '🔒 Password on (change/remove)' : '🔓 Protect with a password';
  $('#profFill').disabled = !profiles.length || !S.pages.length;
}
function readProfileForm() {
  if (!profiles[curProfile]) return;
  const pr = profiles[curProfile]; pr.label = $('#profLabel').value.trim() || pr.label;
  $$('#profGrid input').forEach(i => pr[i.dataset.k] = i.value.trim());
}
async function openProfiles() {
  if (!(await loadProfiles())) return;
  if (!profiles.length) profiles.push({ label: 'Me' });
  curProfile = Math.min(curProfile, profiles.length - 1);
  renderProfileForm(); $('#pmodal').hidden = false;
}
$('#bFill').onclick = openProfiles;
$('#profSel').onchange = e => { readProfileForm(); curProfile = +e.target.value; renderProfileForm(); };
$('#profNew').onclick = () => { readProfileForm(); profiles.push({ label: `Profile ${profiles.length + 1}` }); curProfile = profiles.length - 1; renderProfileForm(); $('#profLabel').focus(); $('#profLabel').select(); };
$('#profDel').onclick = () => {
  if (!profiles[curProfile] || !confirm(`Delete profile "${profiles[curProfile].label}"?`)) return;
  profiles.splice(curProfile, 1); curProfile = 0; storeProfiles(); renderProfileForm();
};
$('#profSave').onclick = async () => { readProfileForm(); await storeProfiles(); renderProfileForm(); toast('Profile saved on this computer ✔'); };
$('#profClose').onclick = () => { $('#pmodal').hidden = true; };
$('#pmodal').addEventListener('pointerdown', e => { if (e.target.id === 'pmodal') $('#pmodal').hidden = true; });
$('#profLock').onclick = async () => {
  const p1 = prompt(profPass ? 'New profile password (leave empty to remove the password):' : 'Choose a password to encrypt your profiles (SSN etc.):');
  if (p1 === null) return;
  if (p1 && prompt('Type it again to confirm:') !== p1) return toast('Passwords did not match.');
  readProfileForm(); profPass = p1 || null; await storeProfiles(); renderProfileForm();
  toast(profPass ? 'Profiles are now encrypted 🔒' : 'Password removed');
};
$('#profFill').onclick = async () => {
  readProfileForm(); await storeProfiles();
  const n = await fillFromProfile(profileValues(profiles[curProfile]));
  $('#pmodal').hidden = true;
  toast(n ? `Filled ${n} field${n > 1 ? 's' : ''} – check them, Ctrl+Z to undo` : 'No matching fields found on this PDF.', 5000);
};
const matchKey = label => { for (const [k, re] of FIELD_RULES) if (re.test(label)) return k; return null; };

async function fillFromProfile(v) {
  let n = 0; snap(); // one undo step for the whole fill
  // 1) real form fields
  const seenSrc = new Set();
  for (const p of S.pages) {
    if (p.src < 0) continue;
    const pg = await getPg(p); let anns = [];
    try { anns = await pg.getAnnotations(); } catch { }
    for (const an of anns) {
      if (an.subtype !== 'Widget' || an.fieldType !== 'Tx' || an.readOnly || !an.fieldName) continue;
      const label = (an.alternativeText || '') + ' ' + an.fieldName.replace(/\[\d+\]/g, '').split('.').pop().replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
      const k = matchKey(label), val = k && v[k];
      if (!val) continue;
      const vals = S.forms[p.src] || (S.forms[p.src] = {});
      if (vals[an.fieldName] || an.fieldValue) continue; // never overwrite something already filled
      vals[an.fieldName] = val; S.formsDirty[p.src] = true; seenSrc.add(p.src); n++;
    }
  }
  if (n) { S.dirty = true; updateTitle(); $$('.page').forEach(w => { const p = pageById(w.dataset.id); if (w._painted && p.src >= 0) getPg(p).then(pg => buildFormLayer(w, p, pg)); }); }
  if (n) return n;
  // 2) flat PDFs: find printed labels ("Name: ______") and type next to them
  let added = 0;
  for (const p of S.pages) {
    const items = await pageItems(p);
    for (const it of items) {
      const m = /^\s*([A-Za-z][A-Za-z .()#/'-]{1,40}?)\s*:?\s*(_{3,}|\.{4,})?\s*$/.exec(it.str);
      if (!m) continue;
      const k = matchKey(m[1]), val = k && v[k];
      if (!val) continue;
      const labelW = it.w * (m[1].length + (it.str.indexOf(':') > -1 ? 1 : 0)) / it.str.length;
      const x = it.x + labelW + 6, base = it.y + it.h * 0.78, size = Math.min(14, Math.max(8, it.h * 0.8));
      // skip if something is already written right of the label
      if (items.some(o => o !== it && Math.abs(o.y - it.y) < it.h * 0.5 && o.x > x - 2 && o.x < x + 80 && !/^[_.\s]+$/.test(o.str))) continue;
      if (p.annots.some(a => Math.abs(a.y - (base - FONTS.Helvetica.base * size)) < 4 && Math.abs(a.x - x) < 20)) continue;
      p.annots.push({ id: nid(), type: 'text', x, y: base - FONTS.Helvetica.base * size, text: val, size, font: 'Helvetica', bold: false, color: '#1a3fb0' });
      added++;
    }
    if (added) renderAnnots(p);
  }
  if (!added) S.undo.pop();
  return added;
}

/* ---------------- top-level wiring ---------------- */
$('#bOpen').onclick = $('#eOpen').onclick = () => $('#fOpen').click();
$('#bAdd').onclick = () => $('#fAdd').click();
$('#eBlank').onclick = newBlank;
$('#fOpen').onchange = e => { openFiles(e.target.files); e.target.value = ''; };
$('#fAdd').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
$('#bSave').onclick = () => save();
$('#bSaveAs').onclick = () => save(true);
$('#bUndo').onclick = undo;
$('#bRedo').onclick = redo;

addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', e => {
  e.preventDefault(); document.body.classList.remove('dragging');
  if (e.dataTransfer.files.length) S.pages.length ? addFiles(e.dataTransfer.files) : openFiles(e.dataTransfer.files);
});

addEventListener('keydown', e => {
  const ae = document.activeElement, ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const typing = ae && (ae.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));
  if (ctrl && k === 's') { e.preventDefault(); return save(e.shiftKey); }
  if (ctrl && k === 'p') { e.preventDefault(); return printPdf(); }
  if (ctrl && k === 'f') { e.preventDefault(); return openSearch(); }
  if (k === 'f3') { e.preventDefault(); return gotoResult(SR.active + (e.shiftKey ? -1 : 1)); }
  if (ctrl && k === 'g') { e.preventDefault(); return $('#navPage').focus(); }
  if (ctrl && k === 'o') { e.preventDefault(); return $('#fOpen').click(); }
  if (!$('#modal').hidden) { if (k === 'escape') closeSig(); return; }
  if (!$('#pmodal').hidden) { if (k === 'escape') $('#pmodal').hidden = true; return; }
  if (typing) { if (k === 'escape') ae.blur(); return; }
  if (ctrl && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (ctrl && k === 'y') { e.preventDefault(); return redo(); }
  if (k === 'escape') { hideAreaMenu(); select(null); return setTool('select'); }
  if (ctrl && k === 'c' && S.sel) { S.clip = JSON.stringify(findAnnot(S.sel).a); return toast('Copied – Ctrl+V to paste (works on other pages too)'); }
  if (ctrl && (k === 'v' || k === 'd') && (k === 'd' ? S.sel : S.clip)) {
    e.preventDefault();
    const src = k === 'd' ? findAnnot(S.sel) : null, a = JSON.parse(src ? JSON.stringify(src.a) : S.clip);
    const p = src ? src.p : S.pages[S.current]; if (!p) return;
    a.id = nid(); delete a._fresh;
    if (a.type === 'clip' && !S.sources[a.src]) { a.type = 'image'; delete a.ubox; } // its source PDF was closed – keep the picture
    if (!src || src.p !== p) { delete a.pdfFont; delete a.css; }
    if (src || p.annots.some(x => x.x === a.x && x.y === a.y)) { a.x += 12; a.y += 12; }
    return addAnnot(p, a, true);
  }
  if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); return setZoom(S.zoom * 1.2); }
  if (ctrl && k === '-') { e.preventDefault(); return setZoom(S.zoom / 1.2); }
  if (ctrl && k === '0') { e.preventDefault(); return fitWidth(); }
  if (k === 'home' || k === 'end') { e.preventDefault(); return setCurrent(k === 'home' ? 0 : S.pages.length - 1, true); }
  if (k === 'pagedown' || k === 'pageup') { e.preventDefault(); return setCurrent(S.current + (k === 'pagedown' ? 1 : -1), true); }
  if (!ctrl && !e.altKey && S.pages.length) {
    const t = { a: 'area', v: 'select', e: 'edittext', t: 'text', h: 'highlight', w: 'whiteout', d: 'draw', x: 'cross', c: 'check' }[k];
    if (t) return setTool(t);
    if (k === 's') return openSig();
    if (k === 'f1') { e.preventDefault(); return openAbout(); }
    if (k === '?') return toast('Keys: V select · E edit text · T text · S sign · H highlight · W whiteout · D draw · C check · X cross · Ctrl+C/V/D copy/paste/duplicate · Ctrl+F search · F3 next match · Ctrl+G go to page · Home/End first/last page · Ctrl+P print · Ctrl+Shift+S save as', 9000);
  }
  if (k === 'delete' || k === 'backspace') {
    e.preventDefault();
    if (S.sel) return deleteSelected();
    if (S.selPages.size) return deletePages(targets());
  }
  if (S.sel && k.startsWith('arrow')) {
    e.preventDefault();
    const f = findAnnot(S.sel), n = e.shiftKey ? 10 : 1;
    if (!e.repeat) snap();
    if (k === 'arrowleft') f.a.x -= n; if (k === 'arrowright') f.a.x += n;
    if (k === 'arrowup') f.a.y -= n; if (k === 'arrowdown') f.a.y += n;
    renderAnnots(f.p);
  }
});
addEventListener('beforeunload', e => { if (S.dirty && S.pages.length) { e.preventDefault(); e.returnValue = ''; } });
addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(() => { if (S.pages.length && !S.zoomed) fitWidth(); }, 250); });

setTool('select'); updateButtons();

// PDFEditor.exe passes a file (drag onto exe / "Open with") as a small script next to this page
window.__openPending = (name, b64) => {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  openFiles([new File([u8], name, { type: 'application/pdf' })]);
};
{
  const m = /open=([\w-]+)/.exec(location.hash);
  if (m) { const s = el('script'); s.src = `pending/${m[1]}.js`; document.body.append(s); history.replaceState(null, '', location.pathname); }
}
