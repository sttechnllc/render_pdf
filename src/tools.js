'use strict';
/* Mark's Render PDF Editor – Tools: shrink, extract images, convert, OCR, split, stamps, compare, batch, about.
   Everything runs locally. Tools work on the current document *including your edits* (via buildPdf). */

const APP = {
  name: "Mark's Render PDF Editor",
  version: '1.0.1',
  github: 'https://github.com/sttechnllc/render_pdf',
  coffee: 'https://www.buymeacoffee.com/nordberg',
};

/* ---------------- small utilities ---------------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(d) { let c = ~0; for (let i = 0; i < d.length; i++) c = CRC_T[(c ^ d[i]) & 255] ^ (c >>> 8); return ~c >>> 0; }
async function deflateRaw(d) {
  const s = new Blob([d]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const u8 = async x => x instanceof Uint8Array ? x : x instanceof Blob ? new Uint8Array(await x.arrayBuffer()) : typeof x === 'string' ? new TextEncoder().encode(x) : new Uint8Array(x);
// Minimal ZIP writer (deflate via the browser; already-compressed files are stored)
async function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const now = new Date(), dt = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(), tm = (now.getHours() << 11) | (now.getMinutes() << 5);
  for (const f of files) {
    const data = await u8(f.data), nm = enc.encode(f.name), crc = crc32(data);
    let comp = data, method = 0;
    if (!f.store && data.length > 100) { try { const c = await deflateRaw(data); if (c.length < data.length * 0.97) { comp = c; method = 8; } } catch { } }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
    lh.setUint16(10, tm, true); lh.setUint16(12, dt, true); lh.setUint32(14, crc, true); lh.setUint32(18, comp.length, true);
    lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(lh.buffer), nm, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, method, true); ch.setUint16(12, tm, true); ch.setUint16(14, dt, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), nm);
    off += 30 + nm.length + comp.length;
  }
  const csize = central.reduce((t, c) => t + c.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
const MIME = { pdf: 'application/pdf', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', txt: 'text/plain', md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
// Save any file: Windows "Save as" dialog when available, otherwise Downloads
async function saveAny(data, name) {
  const ext = name.split('.').pop().toLowerCase(), type = MIME[ext] || 'application/octet-stream';
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: ext.toUpperCase() + ' file', accept: { [type]: ['.' + ext] } }] });
      const w = await h.createWritable(); await w.write(blob); await w.close(); return true;
    } catch (e) { if (e.name === 'AbortError') return false; console.warn(e); }
  }
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000); return true;
}
const baseName = () => S.name.replace(/\.pdf$/i, '');
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const zpad = (n, w = 3) => String(n).padStart(w, '0');
const canvasBlob = (c, type = 'image/png', q) => new Promise(r => c.toBlob(r, type, q));
const xmlEsc = s => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function currentBytes() { commitEditing(); return buildPdf(S.pages); }
const openPdfjs = bytes => pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;

/* ---------------- text layout reader (Word / text / Markdown / compare) ---------------- */
async function readLines(pdf, prog, from = 0, to = pdf.numPages) {
  const pages = [];
  for (let i = from; i < to; i++) {
    if (prog) await prog((i - from) / (to - from), `Reading page ${i + 1} of ${to}`);
    const page = await pdf.getPage(i + 1), vp = page.getViewport({ scale: 1 }), tc = await page.getTextContent();
    const lines = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const t = pdfjsLib.Util.transform(vp.transform, it.transform), fh = Math.hypot(t[2], t[3]);
      if (fh < 1) continue;
      let ln = lines.find(l => Math.abs(l.base - t[5]) < Math.max(l.size, fh) * 0.4);
      if (!ln) { ln = { base: t[5], size: fh, parts: [] }; lines.push(ln); }
      ln.size = Math.max(ln.size, fh); ln.parts.push({ x: t[4], w: it.width, s: it.str, fh });
    }
    lines.sort((a, b) => a.base - b.base);
    for (const l of lines) {
      l.parts.sort((a, b) => a.x - b.x);
      let s = '', end = null;
      for (const p of l.parts) { if (end !== null && p.x - end > p.fh * 0.15 && !/\s$/.test(s) && !/^\s/.test(p.s)) s += ' '; s += p.s; end = p.x + p.w; }
      l.text = s.replace(/\s+/g, ' ').trim(); l.x = l.parts[0].x;
    }
    pages.push({ w: vp.width, h: vp.height, lines: lines.filter(l => l.text) });
    page.cleanup();
  }
  return pages;
}
function toParagraphs(pages) {
  const sizes = pages.flatMap(p => p.lines.map(l => Math.round(l.size * 2) / 2)).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 11;
  const level = s => s >= body * 1.45 ? 1 : s >= body * 1.18 ? 2 : 0;
  return pages.map(pg => {
    const paras = [];
    for (const l of pg.lines) {
      const prev = paras[paras.length - 1], lv = level(l.size);
      if (prev && !lv && !prev.level && Math.abs(prev.size - l.size) < 1 && l.base - prev.lastBase < l.size * 1.75 && !/^[•\-–*]\s/.test(l.text)) {
        prev.text = /[A-Za-z]-$/.test(prev.text) ? prev.text.slice(0, -1) + l.text : prev.text + ' ' + l.text;
        prev.lastBase = l.base;
      } else paras.push({ text: l.text, size: l.size, level: lv, lastBase: l.base });
    }
    return paras;
  });
}

/* ---------------- 1. shrink ---------------- */
const SHRINK = { small: { dpi: 72, q: 0.5 }, medium: { dpi: 120, q: 0.65 }, high: { dpi: 170, q: 0.8 } };
async function shrinkBytes(bytes, level = 'medium', opts = {}, prog) {
  const { dpi, q } = SHRINK[level], maxDim = Math.round(11.7 * dpi); // longest side of an A4/Letter page at that DPI
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const objs = doc.context.enumerateIndirectObjects(), masks = new Set();
  for (const [, o] of objs) if (o instanceof PDFRawStream) { const m = o.dict.get(PN('SMask')); if (m) masks.add(String(m)); }
  const imgs = objs.filter(([ref, o]) => o instanceof PDFRawStream && String(o.dict.lookup(PN('Subtype'))) === '/Image' && !masks.has(String(ref)));
  let done = 0;
  for (const [ref, o] of imgs) {
    if (prog && done++ % 3 === 0) await prog(done / imgs.length, `Optimizing image ${done} of ${imgs.length}`);
    try {
      const d = o.dict, num = k => d.lookup(PN(k))?.asNumber?.();
      const w = num('Width'), h = num('Height'), bpc = num('BitsPerComponent') || 8;
      if (!w || !h || d.lookup(PN('ImageMask'))?.toString() === 'true' || d.get(PN('Decode')) || o.contents.length < 15000) continue;
      const filt = d.lookup(PN('Filter')), f = filt instanceof PDFArray ? filt.asArray().map(String) : filt ? [String(filt)] : [];
      let cs = d.lookup(PN('ColorSpace')), comps = 0;
      if (cs instanceof PDFArray && String(cs.lookup(0)) === '/ICCBased') { comps = cs.lookup(1).dict.lookup(PN('N'))?.asNumber(); }
      else comps = { '/DeviceRGB': 3, '/DeviceGray': 1, '/CalRGB': 3, '/CalGray': 1 }[String(cs)] || 0;
      if (comps !== 1 && comps !== 3) continue; // CMYK / Indexed / special: leave untouched
      let bmp;
      if (f.length === 1 && f[0] === '/DCTDecode') bmp = await createImageBitmap(new Blob([o.contents], { type: 'image/jpeg' }));
      else if (f.length === 1 && f[0] === '/FlateDecode' && bpc === 8 && !d.get(PN('DecodeParms'))) {
        const raw = decodePDFRawStream(o).decode(); if (raw.length < w * h * comps) continue;
        const id = new ImageData(w, h), px = id.data;
        for (let i = 0, j = 0; i < w * h; i++, j += comps) { const k = i * 4; px[k] = raw[j]; px[k + 1] = raw[comps === 3 ? j + 1 : j]; px[k + 2] = raw[comps === 3 ? j + 2 : j]; px[k + 3] = 255; }
        bmp = await createImageBitmap(id);
      } else continue;
      const k = Math.min(1, maxDim / Math.max(w, h)), nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
      const c = el('canvas'); c.width = nw; c.height = nh;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, nw, nh); x.imageSmoothingQuality = 'high'; x.drawImage(bmp, 0, 0, nw, nh); bmp.close?.();
      if (opts.gray) { const id = x.getImageData(0, 0, nw, nh), p = id.data; for (let i = 0; i < p.length; i += 4) { const l = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114; p[i] = p[i + 1] = p[i + 2] = l; } x.putImageData(id, 0, 0); }
      const jpg = new Uint8Array(await (await canvasBlob(c, 'image/jpeg', q)).arrayBuffer());
      if (jpg.length > o.contents.length * 0.9) continue; // not worth it
      const nd = doc.context.obj({});
      for (const [kk, v] of d.entries()) if (!['/Filter', '/DecodeParms', '/Length', '/Width', '/Height', '/BitsPerComponent', '/ColorSpace', '/Decode'].includes(String(kk))) nd.set(kk, v);
      nd.set(PN('Filter'), PN('DCTDecode')); nd.set(PN('Width'), PDFNumber.of(nw)); nd.set(PN('Height'), PDFNumber.of(nh));
      nd.set(PN('BitsPerComponent'), PDFNumber.of(8)); nd.set(PN('ColorSpace'), PN('DeviceRGB'));
      doc.context.assign(ref, PDFRawStream.of(nd, jpg));
    } catch (e) { console.warn('shrink image', e); }
  }
  if (opts.strip) { // hidden extras
    doc.catalog.delete(PN('Metadata')); doc.catalog.delete(PN('PieceInfo'));
    for (const pg of doc.getPages()) { pg.node.delete(PN('Thumb')); pg.node.delete(PN('PieceInfo')); }
  }
  const out = await doc.save({ useObjectStreams: true });
  return out.length < bytes.length ? out : bytes;
}

/* ---------------- 2. extract images ---------------- */
async function extractImages(bytes, minSize = 40, prog, prefix = '') {
  const pdf = await openPdfjs(bytes), files = [], seen = new Set(), OPS = pdfjsLib.OPS;
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      if (prog) await prog((i - 1) / pdf.numPages, `Scanning page ${i} of ${pdf.numPages} · ${files.length} images found`);
      const page = await pdf.getPage(i), ops = await page.getOperatorList();
      let n = 0;
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k];
        if (fn !== OPS.paintImageXObject && fn !== OPS.paintImageXObjectRepeat && fn !== OPS.paintInlineImageXObject) continue;
        const arg = ops.argsArray[k][0];
        let img = arg;
        if (typeof arg === 'string') {
          if (seen.has(arg)) continue; seen.add(arg);
          const store = arg.startsWith('g_') ? page.commonObjs : page.objs;
          img = await new Promise(r => { try { store.get(arg, r); } catch { r(null); } });
        }
        if (!img || img.width < minSize || img.height < minSize) continue;
        const c = el('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d');
        if (img.bitmap) x.drawImage(img.bitmap, 0, 0);
        else if (img.data) {
          const id = x.createImageData(img.width, img.height), p = id.data, s = img.data;
          if (img.kind === 3) p.set(s.subarray(0, p.length));
          else if (img.kind === 2) for (let a = 0, b = 0; a < p.length; a += 4, b += 3) { p[a] = s[b]; p[a + 1] = s[b + 1]; p[a + 2] = s[b + 2]; p[a + 3] = 255; }
          else if (img.kind === 1) { const rowB = (img.width + 7) >> 3; for (let y = 0; y < img.height; y++) for (let xx = 0; xx < img.width; xx++) { const bit = (s[y * rowB + (xx >> 3)] >> (7 - (xx & 7))) & 1, a = (y * img.width + xx) * 4; p[a] = p[a + 1] = p[a + 2] = bit ? 255 : 0; p[a + 3] = 255; } }
          x.putImageData(id, 0, 0);
        } else continue;
        files.push({ name: `${prefix}page-${zpad(i)}-image-${++n}.png`, data: await canvasBlob(c), store: true });
      }
      page.cleanup();
    }
  } finally { pdf.destroy(); }
  return files;
}

/* ---------------- 3. convert ---------------- */
async function pagesToImages(bytes, { fmt = 'png', dpi = 150, range = '' } = {}, prog, prefix = '') {
  const pdf = await openPdfjs(bytes), files = [];
  try {
    const idx = range.trim() ? parseRange(range.replace(/\s*-\s*/g, '-'), pdf.numPages) : [...Array(pdf.numPages).keys()];
    for (let n = 0; n < idx.length; n++) {
      const i = idx[n];
      if (prog) await prog(n / idx.length, `Rendering page ${i + 1} (${n + 1} of ${idx.length})`);
      const page = await pdf.getPage(i + 1), vp = page.getViewport({ scale: dpi / 72 });
      const c = el('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: x, viewport: vp, intent: 'print' }).promise; // 'print' = no screen-refresh pacing, works while minimised
      files.push({ name: `${prefix}page-${zpad(i + 1)}.${fmt}`, data: await canvasBlob(c, fmt === 'jpg' ? 'image/jpeg' : 'image/png', 0.9), store: true });
      page.cleanup(); c.width = c.height = 0;
    }
  } finally { pdf.destroy(); }
  return files;
}
async function toText(bytes, md, prog) {
  const pdf = await openPdfjs(bytes);
  try {
    const paras = toParagraphs(await readLines(pdf, prog));
    return paras.map((ps, i) => (md ? '' : `--- Page ${i + 1} ---\n\n`) + ps.map(p => md && p.level ? '#'.repeat(p.level) + ' ' + p.text : p.text).join('\n\n')).join(md ? '\n\n---\n\n' : '\n\n');
  } finally { pdf.destroy(); }
}
async function toDocx(bytes, { scans = true } = {}, prog) {
  const pdf = await openPdfjs(bytes), media = [];
  try {
    const pages = await readLines(pdf, p => prog && prog(p * 0.7, `Reading text… ${Math.round(p * 100)}%`)), paras = toParagraphs(pages);
    let body = '';
    for (let i = 0; i < pages.length; i++) {
      if (i) body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      const textLen = pages[i].lines.reduce((t, l) => t + l.text.length, 0);
      if (scans && textLen < 20) { // scanned page: put the page in as a picture
        if (prog) await prog(0.7 + 0.3 * i / pages.length, `Adding picture of page ${i + 1}`);
        const page = await pdf.getPage(i + 1), vp = page.getViewport({ scale: 150 / 72 });
        const c = el('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: x, viewport: vp, intent: 'print' }).promise; // 'print' = no screen-refresh pacing, works while minimised
        const n = media.length + 1; media.push(await canvasBlob(c, 'image/jpeg', 0.85));
        const wPt = Math.min(468, pages[i].w), hPt = wPt * pages[i].h / pages[i].w, cx = Math.round(wPt * 12700), cy = Math.round(hPt * 12700);
        body += `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Page ${i + 1}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
        page.cleanup(); continue;
      }
      for (const p of paras[i]) {
        const style = p.level ? `<w:pPr><w:pStyle w:val="Heading${p.level}"/></w:pPr>` : '';
        const sz = p.level ? '' : `<w:rPr><w:sz w:val="${Math.round(Math.min(48, Math.max(16, p.size * 2)))}"/></w:rPr>`;
        body += `<w:p>${style}<w:r>${sz}<w:t xml:space="preserve">${xmlEsc(p.text)}</w:t></w:r></w:p>`;
      }
    }
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[1, 2].map(n => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="${n === 1 ? 36 : 28}"/></w:rPr></w:style>`).join('')}</w:styles>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${media.map((_, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.jpeg"/>`).join('')}</Relationships>`;
    const files = [
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
      { name: 'word/document.xml', data: doc },
      { name: 'word/styles.xml', data: styles },
      { name: 'word/_rels/document.xml.rels', data: rels },
      ...media.map((m, i) => ({ name: `word/media/image${i + 1}.jpeg`, data: m, store: true })),
    ];
    return makeZip(files);
  } finally { pdf.destroy(); }
}

/* ---------------- 4. OCR whole document (searchable PDF) ---------------- */
async function ocrDocument({ only = 'scanned', range = '' }, prog) {
  if (!helperUrl('ocr')) throw new Error('OCR uses the text recognition built into Windows – open the editor with "Mark\'s Render PDF Editor.exe" to use it.');
  const idx = range.trim() ? parseRange(range.replace(/\s*-\s*/g, '-'), S.pages.length) : S.pages.map((_, i) => i);
  snap(); let pagesDone = 0, lines = 0;
  for (let n = 0; n < idx.length; n++) {
    const p = S.pages[idx[n]];
    await prog(n / idx.length, `Reading page ${idx[n] + 1} (${n + 1} of ${idx.length})…`);
    if (only === 'scanned' && (await pageItems(p)).filter(i => !p.ocr?.includes(i)).reduce((t, i) => t + i.str.trim().length, 0) > 30) continue;
    const d = dims(p), res = await ocrRegion(p, { x: 0, y: 0, w: d.w, h: d.h });
    p.ocr = res.map(l => ({ text: l.text, x: l.x, y: l.y, w: l.w, h: l.h }));
    pagesDone++; lines += res.length;
  }
  if (!pagesDone) S.undo.pop();
  findCache.clear(); contentsFor = null;
  return { pagesDone, lines };
}

/* ---------------- 5. split ---------------- */
async function splitDoc({ mode, n = 1, ranges = '', mb = 10 }, prog) {
  const N = S.pages.length, groups = [];
  if (mode === 'every') for (let i = 0; i < N; i += n) groups.push({ idx: [...Array(Math.min(n, N - i)).keys()].map(k => i + k) });
  else if (mode === 'ranges') for (const part of ranges.split(/[;,]/)) { const idx = parseRange(part.trim().replace(/\s*-\s*/g, '-'), N); if (idx.length) groups.push({ idx, label: part.trim() }); }
  else if (mode === 'bookmarks') {
    const src = S.pages[0]?.src, s = S.sources[src]; let ol = null; try { ol = await s.doc.getOutline(); } catch { }
    if (!ol?.length) throw new Error('This PDF has no bookmarks. Choose another way to split.');
    const starts = [];
    for (const it of ol) {
      try {
        const d = typeof it.dest === 'string' ? await s.doc.getDestination(it.dest) : it.dest; if (!d) continue;
        const idx = typeof d[0] === 'object' ? await s.doc.getPageIndex(d[0]) : d[0];
        const pi = S.pages.findIndex(p => p.src === src && p.idx === idx); if (pi >= 0) starts.push({ pi, title: it.title });
      } catch { }
    }
    starts.sort((a, b) => a.pi - b.pi);
    if (starts[0]?.pi > 0) starts.unshift({ pi: 0, title: 'Front matter' });
    starts.forEach((st, k) => { const end = k + 1 < starts.length ? starts[k + 1].pi : N; if (end > st.pi) groups.push({ idx: [...Array(end - st.pi).keys()].map(j => st.pi + j), label: st.title }); });
  } else if (mode === 'size') {
    const limit = mb * 1048576 * 0.92; let cur = [], curSize = 0;
    for (let i = 0; i < N; i++) {
      await prog(i / N * 0.5, `Measuring page ${i + 1} of ${N}`);
      const sz = (await buildPdf([S.pages[i]])).length;
      if (cur.length && curSize + sz > limit) { groups.push({ idx: cur }); cur = []; curSize = 0; }
      cur.push(i); curSize += sz;
    }
    if (cur.length) groups.push({ idx: cur });
  }
  if (!groups.length) throw new Error('Nothing to split – check the page numbers.');
  const files = [];
  for (let g = 0; g < groups.length; g++) {
    await prog(0.5 + g / groups.length * 0.5, `Making file ${g + 1} of ${groups.length}`);
    const label = groups[g].label ? ' - ' + groups[g].label.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60) : '';
    files.push({ name: `${baseName()} part ${zpad(g + 1, 2)}${label}.pdf`, data: await buildPdf(groups[g].idx.map(i => S.pages[i])), store: true });
  }
  return files;
}

/* ---------------- 6. page numbers / header-footer / Bates / watermark ---------------- */
let measureCtx2;
const textWidth = (t, size, font = 'Helvetica', bold) => { measureCtx2 = measureCtx2 || el('canvas').getContext('2d'); measureCtx2.font = `${bold ? 'bold ' : ''}${size}px ${FONTS[font].css}`; return measureCtx2.measureText(t).width; };
function addStamps(o) {
  const idx = o.range.trim() ? parseRange(o.range.replace(/\s*-\s*/g, '-'), S.pages.length) : S.pages.map((_, i) => i);
  const list = o.skipFirst ? idx.filter(i => i !== idx[0]) : idx;
  if (!list.length) throw new Error('No pages selected.');
  snap();
  const total = S.pages.length, date = new Date().toLocaleDateString();
  list.forEach((pi, k) => {
    const p = S.pages[pi], d = dims(p), num = (+o.start || 1) + k;
    let text;
    if (o.kind === 'numbers') text = { n: `${num}`, page: `Page ${num}`, pageof: `Page ${num} of ${list.length + (+o.start || 1) - 1}`, slash: `${num} / ${list.length + (+o.start || 1) - 1}` }[o.format];
    else if (o.kind === 'bates') text = (o.prefix || '') + String((+o.start || 1) + k).padStart(+o.digits || 6, '0') + (o.suffix || '');
    else text = (o.text || '').replace(/\{page\}/g, pi + 1).replace(/\{total\}/g, total).replace(/\{date\}/g, date).replace(/\{file\}/g, baseName());
    if (!text) return;
    const size = +o.size || 11, bold = !!o.bold, F = FONTS.Helvetica, w = textWidth(text, size, 'Helvetica', bold), m = 28;
    const a = { id: nid(), type: 'text', text, size, font: 'Helvetica', bold, color: o.color || '#000000', tag: 'stamp' };
    if (o.kind === 'watermark') {
      const ang = +o.angle || 0, r = ang * Math.PI / 180, capH = size * 0.72;
      const vx = w / 2 * Math.cos(r) - capH / 2 * Math.sin(r), vy = w / 2 * Math.sin(r) + capH / 2 * Math.cos(r); // baseline-start → text centre (PDF y-up)
      const bx = d.w / 2 - vx, by = d.h / 2 + vy;
      Object.assign(a, { x: bx, y: by - F.base * size, angle: ang, op: +o.opacity || 0.2 });
    } else {
      const pos = o.pos || 'bc', top = pos[0] === 't';
      const x = pos[1] === 'l' ? m : pos[1] === 'r' ? d.w - m - w : (d.w - w) / 2;
      const base = top ? m + size * 0.8 : d.h - m + size * 0.2;
      Object.assign(a, { x, y: base - F.base * size });
    }
    p.annots.push(a);
  });
  S.pages.forEach(p => renderAnnots(p));
  return list.length;
}
async function stampBytes(bytes, o) { // batch version – draws directly with pdf-lib
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const f = await doc.embedFont(o.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica), pages = doc.getPages();
  pages.forEach((pg, k) => {
    if (o.skipFirst && k === 0) return;
    const num = (+o.start || 1) + k - (o.skipFirst ? 1 : 0), size = +o.size || 11, m = 28;
    const text = o.kind === 'bates' ? (o.prefix || '') + String(num).padStart(+o.digits || 6, '0') + (o.suffix || '')
      : o.kind === 'numbers' ? { n: `${num}`, page: `Page ${num}`, pageof: `Page ${num} of ${pages.length}`, slash: `${num} / ${pages.length}` }[o.format]
      : (o.text || '').replace(/\{page\}/g, k + 1).replace(/\{total\}/g, pages.length).replace(/\{date\}/g, new Date().toLocaleDateString());
    const cb = pg.getCropBox(), rot = ((pg.getRotation().angle % 360) + 360) % 360, sw = rot % 180 ? cb.height : cb.width, sh = rot % 180 ? cb.width : cb.height;
    // draw in "as you see it" coordinates, mapped onto the page's real rotation/crop
    const M = { 0: [1, 0, 0, 1, cb.x, cb.y], 90: [0, 1, -1, 0, cb.x + cb.width, cb.y], 180: [-1, 0, 0, -1, cb.x + cb.width, cb.y + cb.height], 270: [0, -1, 1, 0, cb.x, cb.y + cb.height] }[rot] || [1, 0, 0, 1, cb.x, cb.y];
    pg.pushOperators(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(...M));
    const W = sw, H = sh, w = f.widthOfTextAtSize(text, size), pos = o.pos || 'bc', c = hexRgb(o.color || '#000000');
    if (o.kind === 'watermark') { const r = (+o.angle || 0) * Math.PI / 180; pg.drawText(text, { x: W / 2 - (w / 2 * Math.cos(r) - size * 0.36 * Math.sin(r)), y: H / 2 - (w / 2 * Math.sin(r) + size * 0.36 * Math.cos(r)), size, font: f, color: c, opacity: +o.opacity || 0.2, rotate: degrees(+o.angle || 0) }); }
    else pg.drawText(text, { x: pos[1] === 'l' ? m : pos[1] === 'r' ? W - m - w : (W - w) / 2, y: pos[0] === 't' ? H - m - size * 0.8 : m - size * 0.2, size, font: f, color: c });
    pg.pushOperators(PDFLib.popGraphicsState());
  });
  return doc.save();
}

/* ---------------- 7. compare ---------------- */
function lcsDiff(a, b) {
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: a[i++] }); else out.push({ t: '+', s: b[j++], j: j - 1 }); }
  while (i < n) out.push({ t: '-', s: a[i++] });
  while (j < m) out.push({ t: '+', s: b[j++], j: j - 1 });
  return out;
}
async function compareWith(file, prog) {
  const other = await openPdfjs(new Uint8Array(await file.arrayBuffer()));
  try {
    const oldPages = await readLines(other, p => prog(p * 0.5, 'Reading the other PDF…'));
    const norm = s => s.replace(/\s+/g, ' ').trim();
    SR.results = []; SR.byPage.clear(); SR.active = -1; clearSearchMarks();
    let changes = 0;
    for (let i = 0; i < Math.max(S.pages.length, oldPages.length); i++) {
      await prog(0.5 + 0.5 * i / S.pages.length, `Comparing page ${i + 1}`);
      const p = S.pages[i];
      if (!p) { changes++; SR.results.push({ pi: S.pages.length - 1, pid: S.pages[S.pages.length - 1].id, kind: 'removed', text: `Page ${i + 1} exists only in "${file.name}"`, rects: [], ctx: ['', ''] }); continue; }
      const { text, map } = await pageText(p);
      const lines = []; let pos = 0;
      for (const ln of text.split('\n')) { lines.push({ s: pos, e: pos + ln.length, t: norm(ln) }); pos += ln.length + 1; }
      const cur = lines.filter(l => l.t), old = (oldPages[i]?.lines || []).map(l => norm(l.text)).filter(Boolean);
      for (const d of lcsDiff(old, cur.map(l => l.t))) {
        changes++;
        if (d.t === '+') { const l = cur[d.j]; SR.results.push({ pi: i, pid: p.id, kind: 'added', text: d.s, rects: rangeRects(map, l.s, l.e), ctx: ['', ''] }); }
        else SR.results.push({ pi: i, pid: p.id, kind: 'removed', text: d.s, rects: [], ctx: ['', ''] });
      }
    }
    SR.results.sort((a, b) => a.pi - b.pi);
    for (const r of SR.results) { if (!SR.byPage.has(r.pid)) SR.byPage.set(r.pid, []); SR.byPage.get(r.pid).push(r); }
    showSideTab('search');
    $('#sStatus').textContent = changes ? `Compared with "${file.name}": ${changes} changed line${changes > 1 ? 's' : ''}` : `No text differences with "${file.name}" 🎉`;
    renderResults(); drawAllSearchMarks(); updateSearchButtons();
    if (SR.results.length) gotoResult(0, true);
    return changes;
  } finally { other.destroy(); }
}

/* ---------------- Tools dialog ---------------- */
const TOOLS = [
  { id: 'shrink', icon: '🗜', name: 'Shrink PDF', desc: 'Make the file smaller for email – recompresses pictures.',
    form: `<label>Size <select name="level"><option value="small">Smallest (screen quality)</option><option value="medium" selected>Balanced (recommended)</option><option value="high">High quality (print)</option></select></label>
      <label><input type="checkbox" name="gray"> Make pictures black &amp; white</label><label><input type="checkbox" name="strip" checked> Remove hidden extras (metadata, thumbnails)</label>`,
    async run(o, prog) {
      const before = await currentBytes(); await prog(0.02, 'Optimizing…');
      const after = await shrinkBytes(before, o.level, { gray: o.gray, strip: o.strip }, prog);
      const pct = Math.round((1 - after.length / before.length) * 100);
      if (await saveAny(after, `${baseName()} (small).pdf`)) return `${fmtSize(before.length)} → ${fmtSize(after.length)}${pct > 0 ? ` (−${pct}%)` : ' – this PDF was already well compressed'}`;
    } },
  { id: 'images', icon: '🖼', name: 'Extract all images', desc: 'Save every picture in the PDF into one ZIP file.',
    form: `<label><input type="checkbox" name="skipSmall" checked> Skip tiny images (icons, lines)</label>`,
    async run(o, prog) {
      const files = await extractImages(await currentBytes(), o.skipSmall ? 40 : 1, prog);
      if (!files.length) return 'No images found in this PDF.';
      await prog(0.95, 'Packing ZIP…');
      if (await saveAny(await makeZip(files), `${baseName()} images.zip`)) return `Saved ${files.length} image${files.length > 1 ? 's' : ''}.`;
    } },
  { id: 'toimg', icon: '🏞', name: 'PDF → Pictures', desc: 'Turn pages into PNG or JPG images.',
    form: `<label>Format <select name="fmt"><option value="png">PNG (sharp)</option><option value="jpg">JPG (smaller)</option></select></label>
      <label>Quality <select name="dpi"><option value="96">Screen (96 dpi)</option><option value="150" selected>Good (150 dpi)</option><option value="300">Print (300 dpi)</option></select></label>
      <label>Pages <input name="range" placeholder="all – or e.g. 1-3, 7"></label>`,
    async run(o, prog) {
      const files = await pagesToImages(await currentBytes(), { fmt: o.fmt, dpi: +o.dpi, range: o.range }, prog);
      if (files.length === 1) { if (await saveAny(files[0].data, `${baseName()}.${o.fmt}`)) return 'Saved 1 picture.'; return; }
      await prog(0.97, 'Packing ZIP…');
      if (await saveAny(await makeZip(files), `${baseName()} pages.zip`)) return `Saved ${files.length} pictures in a ZIP.`;
    } },
  { id: 'word', icon: '📝', name: 'PDF → Word', desc: 'Editable .docx with paragraphs and headings.',
    form: `<label><input type="checkbox" name="scans" checked> Put scanned pages in as pictures</label><p class="muted">Tip: run “OCR whole document” first to turn scans into real text.</p>`,
    async run(o, prog) {
      const z = await toDocx(await currentBytes(), { scans: o.scans }, prog);
      if (await saveAny(z, `${baseName()}.docx`)) return 'Word document saved.';
    } },
  { id: 'text', icon: '📄', name: 'PDF → Text / Markdown', desc: 'All the text, cleaned up into paragraphs.',
    form: `<label>Format <select name="fmt"><option value="txt">Plain text (.txt)</option><option value="md">Markdown (.md) – keeps headings</option></select></label>`,
    async run(o, prog) {
      const t = await toText(await currentBytes(), o.fmt === 'md', prog);
      if (!t.trim()) return 'No text found – this looks like a scan. Run “OCR whole document” first.';
      if (await saveAny(t, `${baseName()}.${o.fmt}`)) return `Saved ${t.length.toLocaleString()} characters.`;
    } },
  { id: 'ocr', icon: '🔤', name: 'OCR whole document', desc: 'Make scanned pages searchable and copyable (Windows OCR).',
    form: `<label>Pages <select name="only"><option value="scanned">Only pages without text</option><option value="all">All pages</option></select></label>
      <label>Range <input name="range" placeholder="all – or e.g. 1-10"></label><p class="muted">The page looks the same; invisible text is added so you can search, select and copy. Save afterwards.</p>`,
    async run(o, prog) {
      const r = await ocrDocument(o, prog);
      return r.pagesDone ? `Recognised ${r.lines} lines on ${r.pagesDone} page${r.pagesDone > 1 ? 's' : ''}. Search now finds this text – Save to keep it.` : 'All pages already have text – nothing to do.';
    } },
  { id: 'split', icon: '✂', name: 'Split PDF', desc: 'Break into several files (ZIP).',
    form: `<label>How <select name="mode"><option value="every">Every N pages</option><option value="ranges">By page ranges</option><option value="bookmarks">By bookmarks (chapters)</option><option value="size">Max file size (for email)</option></select></label>
      <label data-show="every">Pages per file <input name="n" type="number" min="1" value="1"></label>
      <label data-show="ranges">Ranges <input name="ranges" placeholder="e.g. 1-3; 4-10; 11-"></label>
      <label data-show="size">Max MB per file <input name="mb" type="number" min="1" value="10"></label>`,
    async run(o, prog) {
      const files = await splitDoc({ mode: o.mode, n: Math.max(1, +o.n || 1), ranges: o.ranges, mb: Math.max(1, +o.mb || 10) }, prog);
      await prog(0.98, 'Packing ZIP…');
      if (await saveAny(await makeZip(files), `${baseName()} split.zip`)) return `Made ${files.length} PDF files.`;
    } },
  { id: 'stamp', icon: '#️⃣', name: 'Page numbers · Header · Bates · Watermark', desc: 'Stamp text on many pages at once (editable afterwards).',
    form: `<label>Add <select name="kind"><option value="numbers">Page numbers</option><option value="header">Header / footer text</option><option value="bates">Bates numbers (legal)</option><option value="watermark">Watermark</option></select></label>
      <label data-show="numbers">Style <select name="format"><option value="n">1</option><option value="page">Page 1</option><option value="pageof" selected>Page 1 of 10</option><option value="slash">1 / 10</option></select></label>
      <label data-show="header">Text <input name="text" value="{file} – page {page} of {total}"><span class="muted">{page} {total} {date} {file}</span></label>
      <label data-show="bates">Prefix <input name="prefix" value="DOC-"></label><label data-show="bates">Digits <input name="digits" type="number" value="6"></label><label data-show="bates">Suffix <input name="suffix"></label>
      <label data-show="watermark">Text <input name="wtext" value="CONFIDENTIAL"></label><label data-show="watermark">Angle <input name="angle" type="number" value="45"></label><label data-show="watermark">Opacity <input name="opacity" type="number" step="0.05" min="0.05" max="1" value="0.18"></label>
      <label data-hide="watermark">Position <select name="pos"><option value="bc">Bottom centre</option><option value="br">Bottom right</option><option value="bl">Bottom left</option><option value="tc">Top centre</option><option value="tr">Top right</option><option value="tl">Top left</option></select></label>
      <label data-show="numbers bates">Start at <input name="start" type="number" value="1"></label>
      <label>Size <input name="size" type="number" value="11"></label><label>Colour <input name="color" type="color" value="#000000"></label><label><input type="checkbox" name="bold"> Bold</label>
      <label>Pages <input name="range" placeholder="all – or e.g. 2-20"></label><label><input type="checkbox" name="skipFirst"> Skip the first page</label>`,
    async run(o) {
      if (o.kind === 'watermark') { o.text = o.wtext; if (+o.size === 11) o.size = 64; if (o.color === '#000000') o.color = '#c0392b'; }
      const n = addStamps(o);
      return `Added to ${n} page${n > 1 ? 's' : ''}. Each one is a normal text box – click to edit or delete. Ctrl+Z undoes all.`;
    } },
  { id: 'compare', icon: '🔀', name: 'Compare two PDFs', desc: 'See which lines changed between versions.',
    form: `<label>Compare this document with <input type="file" name="file" accept=".pdf,application/pdf"></label><p class="muted">Changed lines are highlighted on the pages and listed in the Search panel (“added” = only in this document, “removed” = only in the other one).</p>`,
    async run(o, prog) {
      if (!o.file) throw new Error('Choose the other PDF first.');
      const n = await compareWith(o.file, prog);
      return n ? `${n} changed line${n > 1 ? 's' : ''} – see the Search panel.` : 'No text differences found.';
    } },
  { id: 'batch', icon: '📦', name: 'Batch – many files at once', desc: 'Shrink, convert or stamp a whole folder of PDFs.', noDoc: true,
    form: `<label>Files <input type="file" name="files" accept=".pdf,application/pdf" multiple></label>
      <label>Do this <select name="action"><option value="shrink">Shrink (balanced)</option><option value="word">Convert to Word</option><option value="text">Convert to text</option><option value="images">Convert pages to PNG</option><option value="extract">Extract all images</option><option value="numbers">Add page numbers</option><option value="watermark">Add “CONFIDENTIAL” watermark</option><option value="merge">Merge into one PDF</option></select></label>
      <p class="muted">Results are collected into one ZIP (or one PDF for “Merge”). Your open document is not changed.</p>`,
    async run(o, prog) {
      const files = [...(o.files || [])]; if (!files.length) throw new Error('Choose some PDF files first.');
      const out = [];
      if (o.action === 'merge') {
        const doc = await PDFDocument.create();
        for (let i = 0; i < files.length; i++) {
          await prog(i / files.length, `Adding ${files[i].name}`);
          const src = await PDFDocument.load(await files[i].arrayBuffer(), { ignoreEncryption: true });
          (await doc.copyPages(src, src.getPageIndices())).forEach(p => doc.addPage(p));
        }
        if (await saveAny(await doc.save(), 'merged.pdf')) return `Merged ${files.length} files.`;
        return;
      }
      for (let i = 0; i < files.length; i++) {
        const f = files[i], base = f.name.replace(/\.pdf$/i, ''), bytes = new Uint8Array(await f.arrayBuffer());
        const sub = (a, b) => (frac, msg) => prog((i + a + frac * (b - a)) / files.length, `${f.name}: ${msg || ''}`);
        await prog(i / files.length, `Working on ${f.name} (${i + 1} of ${files.length})`);
        try {
          if (o.action === 'shrink') out.push({ name: `${base} (small).pdf`, data: await shrinkBytes(bytes, 'medium', { strip: true }, sub(0, 1)), store: true });
          else if (o.action === 'word') out.push({ name: `${base}.docx`, data: await toDocx(bytes, { scans: true }, sub(0, 1)), store: true });
          else if (o.action === 'text') out.push({ name: `${base}.txt`, data: await toText(bytes, false, sub(0, 1)) });
          else if (o.action === 'images') out.push(...await pagesToImages(bytes, { fmt: 'png', dpi: 150 }, sub(0, 1), base + '/'));
          else if (o.action === 'extract') out.push(...await extractImages(bytes, 40, sub(0, 1), base + '/'));
          else if (o.action === 'numbers') out.push({ name: `${base}.pdf`, data: await stampBytes(bytes, { kind: 'numbers', format: 'pageof', pos: 'bc', size: 10 }), store: true });
          else if (o.action === 'watermark') out.push({ name: `${base}.pdf`, data: await stampBytes(bytes, { kind: 'watermark', text: 'CONFIDENTIAL', size: 64, angle: 45, opacity: 0.18, color: '#c0392b' }), store: true });
        } catch (e) { console.error(e); out.push({ name: `${base} – ERROR.txt`, data: String(e.message || e) }); }
      }
      await prog(0.98, 'Packing ZIP…');
      if (await saveAny(await makeZip(out), `batch results.zip`)) return `Processed ${files.length} file${files.length > 1 ? 's' : ''}.`;
    } },
];

let toolRunning = null;
function openTools(id) {
  $('#tmodal').hidden = false; $('#tProg').hidden = true; $('#tMsg').textContent = '';
  if (!id) {
    $('#tTitle').textContent = '🧰 Tools'; $('#tBack').hidden = $('#tRun').hidden = true;
    $('#tBody').innerHTML = `<div class="tgrid">${TOOLS.map(t => `<button class="tcard" data-id="${t.id}"><span class="ti">${t.icon}</span><b>${t.name}</b><span>${t.desc}</span></button>`).join('')}</div>`;
    $$('.tcard').forEach(b => b.onclick = () => openTools(b.dataset.id));
    return;
  }
  const t = TOOLS.find(x => x.id === id);
  if (!t.noDoc && !S.pages.length) { toast('Open a PDF first.'); return openTools(); }
  if (t.custom) return t.custom();
  $('#tTitle').textContent = `${t.icon} ${t.name}`; $('#tBack').hidden = $('#tRun').hidden = false; $('#tRun').disabled = false;
  $('#tBody').innerHTML = `<p class="muted">${t.desc}</p><div class="tform">${t.form}</div>`;
  $('#tRun').onclick = () => runTool(t);
  const kindSel = $('#tBody [name="kind"], #tBody [name="mode"]');
  const vis = () => { const v = kindSel?.value; $$('#tBody [data-show]').forEach(e => e.hidden = !e.dataset.show.split(' ').includes(v)); $$('#tBody [data-hide]').forEach(e => e.hidden = e.dataset.hide === v); };
  if (kindSel) { kindSel.onchange = vis; vis(); }
  if (t.init) t.init();
}
function readForm() {
  const o = {};
  $$('#tBody [name]').forEach(e => { o[e.name] = e.type === 'checkbox' ? e.checked : e.type === 'file' ? (e.multiple ? e.files : e.files[0]) : e.value; });
  return o;
}
async function runTool(t) {
  if (toolRunning) return;
  toolRunning = t.id; $('#tRun').disabled = true; $('#tProg').hidden = false; $('#tMsg').textContent = '';
  const bar = $('#tProg i'), lbl = $('#tProg span'); let last = 0;
  const prog = async (f, msg) => { bar.style.width = Math.round(Math.min(1, f) * 100) + '%'; if (msg) lbl.textContent = msg; if (performance.now() - last > 40) { last = performance.now(); await new Promise(r => setTimeout(r)); } };
  const t0 = performance.now();
  try {
    await prog(0, 'Starting…');
    const msg = await t.run(readForm(), prog);
    bar.style.width = '100%'; lbl.textContent = msg ? `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s` : 'Cancelled';
    $('#tMsg').textContent = msg ? '✔ ' + msg : '';
  } catch (e) { console.error(e); lbl.textContent = 'Something went wrong'; $('#tMsg').textContent = '⚠ ' + (e.message || e); }
  finally { toolRunning = null; $('#tRun').disabled = false; }
}
$('#bTools').onclick = () => openTools();
$('#tBack').onclick = () => openTools();
$('#tClose').onclick = () => { if (!toolRunning) $('#tmodal').hidden = true; };
$('#tmodal').addEventListener('pointerdown', e => { if (e.target.id === 'tmodal' && !toolRunning) $('#tmodal').hidden = true; });

/* ---------------- About ---------------- */
function openAbout() {
  $('#amodal').hidden = false;
  $('#aVer').textContent = 'Version ' + APP.version;
  $('#aGit').hidden = !APP.github; $('#aGit').href = APP.github || '#';
  $('#aCoffee').hidden = !APP.coffee; $('#aCoffee').href = APP.coffee || '#';
}
$('#bAbout').onclick = openAbout;
$('#aClose').onclick = () => { $('#amodal').hidden = true; };
$('#amodal').addEventListener('pointerdown', e => { if (e.target.id === 'amodal') $('#amodal').hidden = true; });
$$('#amodal a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); if (a.href && !a.hidden) window.open(a.href, '_blank', 'noopener'); }));
addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (!$('#tmodal').hidden && !toolRunning) $('#tmodal').hidden = true; if (!$('#amodal').hidden) $('#amodal').hidden = true; }
});

/* ---------------- ZIP files (WinZip-style): make, open, extract ---------------- */
async function readZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('This is not a ZIP file, or it is damaged.');
  const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  if (p === 0xffffffff || count === 0xffff) throw new Error('Very large (ZIP64) archives are not supported yet.');
  const dec = new TextDecoder(), entries = [];
  for (let k = 0; k < count && p + 46 <= buf.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), time = dv.getUint16(p + 12, true), date = dv.getUint16(p + 14, true);
    const csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nl)).replace(/\\/g, '/');
    entries.push({ name, method, csize, size, off, enc: !!(flags & 1), dir: name.endsWith('/'),
      date: new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63) });
    p += 46 + nl + xl + cl;
  }
  return { name: file.name, buf, dv, entries };
}
async function zipEntryData(z, en) {
  if (en.enc) throw new Error(`"${en.name}" is password-protected – not supported.`);
  const o = en.off, start = o + 30 + z.dv.getUint16(o + 26, true) + z.dv.getUint16(o + 28, true);
  const raw = z.buf.subarray(start, start + en.csize);
  if (en.method === 0) return raw.slice();
  if (en.method === 8) return new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  throw new Error(`"${en.name}" uses a compression type this app can't read (method ${en.method}).`);
}
// only safe path parts – a ZIP can never write outside the folder you chose ("zip-slip")
const zipParts = name => name.split('/').filter(x => x && x !== '.' && x !== '..').map(x => x.replace(/[<>:"\\|?*\u0000-\u001f]/g, '_'));
async function extractZip(z, list, prog) {
  const files = list.filter(e => !e.dir);
  if (!files.length) return 0;
  if (window.showDirectoryPicker) {
    const root = await showDirectoryPicker({ mode: 'readwrite', id: 'unzip' });
    for (let i = 0; i < files.length; i++) {
      const en = files[i], parts = zipParts(en.name); if (!parts.length) continue;
      await prog(i / files.length, `Extracting ${parts.join('/')}`);
      let d = root; for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
      const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await w.write(await zipEntryData(z, en)); await w.close();
    }
    return files.length;
  }
  for (const en of files) download(await zipEntryData(z, en), zipParts(en.name).pop(), 'application/octet-stream');
  return files.length;
}
async function filesFromDrop(dt) { // files + whole folders dropped from Explorer
  const out = [], items = [...dt.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!items.length) return [...dt.files].map(f => ({ path: f.name, file: f }));
  const walk = async (entry, prefix) => {
    if (entry.isFile) out.push({ path: prefix + entry.name, file: await new Promise((r, j) => entry.file(r, j)) });
    else if (entry.isDirectory) {
      const reader = entry.createReader(); let batch;
      do { batch = await new Promise((r, j) => reader.readEntries(r, j)); for (const e of batch) await walk(e, prefix + entry.name + '/'); } while (batch.length);
    }
  };
  for (const it of items) await walk(it, '');
  return out;
}

let zipList = [], zipOpen = null;
function zipUI(tab = 'make') {
  $('#tTitle').textContent = '📦 ZIP files'; $('#tBack').hidden = false; $('#tRun').hidden = true;
  $('#tBody').innerHTML = `
    <div class="tabs"><button data-z="make">📥 Make a ZIP</button><button data-z="open">📂 Open a ZIP</button></div>
    <div data-zp="make">
      <div class="zdrop" id="zDrop">Drag files or whole folders here<div class="row" style="justify-content:center">
        <button id="zAdd">➕ Add files…</button><button id="zAddDir">📁 Add a folder…</button><button id="zAddCur">📄 Add the open PDF</button></div></div>
      <div class="zwrap"><table class="ztable"><thead><tr><th>Name</th><th>Size</th><th></th></tr></thead><tbody id="zList"></tbody></table></div>
      <div class="row"><label><input type="checkbox" id="zStore"> Faster (no compression)</label><span class="sp"></span><span id="zTotal" class="muted"></span>
        <button id="zClear">Clear</button><button id="zSave" class="pri">💾 Save ZIP…</button></div>
    </div>
    <div data-zp="open" hidden>
      <div class="zdrop" id="zDrop2">Drag a .zip file here<div class="row" style="justify-content:center"><button id="zOpenBtn">📂 Choose a ZIP…</button></div></div>
      <div id="zInfo" class="muted"></div>
      <div class="zwrap"><table class="ztable"><thead><tr><th><input type="checkbox" id="zAll" checked></th><th>Name</th><th>Size</th><th>Packed</th><th>Modified</th><th></th></tr></thead><tbody id="zEntries"></tbody></table></div>
      <div class="row"><span class="sp"></span><button id="zExtract" class="pri" disabled>📤 Extract to a folder…</button></div>
    </div>`;
  const showTab = t => { $$('[data-z]').forEach(b => b.classList.toggle('on', b.dataset.z === t)); $$('[data-zp]').forEach(p => p.hidden = p.dataset.zp !== t); };
  $$('[data-z]').forEach(b => b.onclick = () => showTab(b.dataset.z)); showTab(tab);
  const pick = (dir, cb) => { const i = el('input'); i.type = 'file'; i.multiple = true; if (dir) i.webkitdirectory = true; i.onchange = () => cb([...i.files]); i.click(); };
  const add = list => { for (const x of list) if (!zipList.some(y => y.path === x.path)) zipList.push(x); renderMake(); };
  $('#zAdd').onclick = () => pick(false, fs => add(fs.map(f => ({ path: f.name, file: f }))));
  $('#zAddDir').onclick = () => pick(true, fs => add(fs.map(f => ({ path: f.webkitRelativePath || f.name, file: f }))));
  $('#zAddCur').onclick = async () => { if (!S.pages.length) return toast('No PDF is open.'); add([{ path: S.name, file: new Blob([await currentBytes()]) }]); };
  $('#zClear').onclick = () => { zipList = []; renderMake(); };
  $('#zSave').onclick = () => {
    if (!zipList.length) return toast('Add some files first.');
    runZipJob(async prog => {
      const files = [];
      for (let i = 0; i < zipList.length; i++) { await prog(i / zipList.length * 0.9, `Packing ${zipList[i].path}`); files.push({ name: zipList[i].path, data: zipList[i].file, store: $('#zStore').checked }); }
      const z = await makeZip(files), raw = zipList.reduce((t, x) => t + x.file.size, 0);
      const first = zipList[0].path, nm = first.includes('/') ? first.split('/')[0] : zipList.length === 1 ? first.replace(/\.[^.]+$/, '') : 'Archive';
      if (await saveAny(z, nm + '.zip')) return `Saved ${zipList.length} file${zipList.length > 1 ? 's' : ''}: ${fmtSize(raw)} → ${fmtSize(z.size)}`;
    });
  };
  for (const [id, fn] of [['zDrop', async dt => add(await filesFromDrop(dt))], ['zDrop2', dt => dt.files[0] && loadZip(dt.files[0])]]) {
    const d = $('#' + id);
    d.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); d.classList.add('over'); });
    d.addEventListener('dragleave', () => d.classList.remove('over'));
    d.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); d.classList.remove('over'); document.body.classList.remove('dragging'); fn(e.dataTransfer); });
  }
  $('#zOpenBtn').onclick = () => { const i = el('input'); i.type = 'file'; i.accept = '.zip,application/zip'; i.onchange = () => i.files[0] && loadZip(i.files[0]); i.click(); };
  $('#zAll').onchange = e => $$('#zEntries input[type=checkbox]').forEach(c => c.checked = e.target.checked);
  $('#zExtract').onclick = () => {
    const sel = $$('#zEntries input[type=checkbox]').filter(c => c.checked).map(c => zipOpen.entries[+c.dataset.i]);
    runZipJob(async prog => { const n = await extractZip(zipOpen, sel, prog); return n ? `Extracted ${n} file${n > 1 ? 's' : ''}.` : 'Nothing selected.'; });
  };
  renderMake(); if (zipOpen) renderOpen();
}
function renderMake() {
  const tb = $('#zList'); if (!tb) return;
  tb.innerHTML = zipList.length ? '' : '<tr><td colspan="3" class="muted">No files yet.</td></tr>';
  zipList.forEach((x, i) => {
    const tr = el('tr'); tr.innerHTML = `<td></td><td>${fmtSize(x.file.size)}</td><td><button title="Remove">✕</button></td>`;
    tr.firstChild.textContent = x.path; tr.querySelector('button').onclick = () => { zipList.splice(i, 1); renderMake(); };
    tb.append(tr);
  });
  $('#zTotal').textContent = zipList.length ? `${zipList.length} file${zipList.length > 1 ? 's' : ''}, ${fmtSize(zipList.reduce((t, x) => t + x.file.size, 0))}` : '';
}
async function loadZip(file) {
  try { zipOpen = await readZip(file); } catch (e) { return toast(e.message, 5000); }
  if (!$('#zEntries') || $('#tmodal').hidden) { $('#tmodal').hidden = false; $('#tProg').hidden = true; $('#tMsg').textContent = ''; zipUI('open'); }
  else $$('[data-z]').find(b => b.dataset.z === 'open').click();
  renderOpen();
}
function renderOpen() {
  const z = zipOpen, tb = $('#zEntries'); tb.innerHTML = '';
  const files = z.entries.filter(e => !e.dir), total = files.reduce((t, e) => t + e.size, 0), packed = files.reduce((t, e) => t + e.csize, 0);
  $('#zInfo').textContent = `${z.name} · ${files.length} file${files.length !== 1 ? 's' : ''} · ${fmtSize(total)} (packed ${fmtSize(packed)}${total ? `, ${Math.max(0, Math.round((1 - packed / total) * 100))}% smaller` : ''})`;
  z.entries.forEach((en, i) => {
    if (en.dir) return;
    const tr = el('tr');
    tr.innerHTML = `<td><input type="checkbox" checked data-i="${i}"></td><td></td><td>${fmtSize(en.size)}</td><td>${fmtSize(en.csize)}</td><td>${isNaN(en.date) ? '' : en.date.toLocaleDateString()}</td><td></td>`;
    tr.children[1].textContent = (en.enc ? '🔒 ' : '') + en.name;
    if (/\.(pdf|png|jpe?g|gif|webp|bmp)$/i.test(en.name) && !en.enc) {
      const b = el('button'); b.textContent = 'Open'; b.title = 'Open in the editor';
      b.onclick = async () => {
        try {
          const d = await zipEntryData(z, en), nm = zipParts(en.name).pop(), isPdf = /\.pdf$/i.test(nm);
          const f = new File([d], nm, { type: isPdf ? 'application/pdf' : 'image/' + nm.split('.').pop().toLowerCase().replace('jpg', 'jpeg') });
          $('#tmodal').hidden = true; S.pages.length ? addFiles([f]) : openFiles([f]);
        } catch (err) { toast(err.message, 5000); }
      };
      tr.lastChild.append(b);
    }
    tb.append(tr);
  });
  $('#zExtract').disabled = !files.length;
}
async function runZipJob(job) {
  if (toolRunning) return; toolRunning = 'zip';
  $('#tProg').hidden = false; $('#tMsg').textContent = '';
  const bar = $('#tProg i'), lbl = $('#tProg span');
  const prog = async (f, m) => { bar.style.width = Math.round(f * 100) + '%'; if (m) lbl.textContent = m; await new Promise(r => setTimeout(r)); };
  try { const msg = await job(prog); bar.style.width = '100%'; lbl.textContent = msg ? 'Done' : 'Cancelled'; $('#tMsg').textContent = msg ? '✔ ' + msg : ''; }
  catch (e) { if (e.name !== 'AbortError') { console.error(e); $('#tMsg').textContent = '⚠ ' + (e.message || e); } lbl.textContent = ''; }
  finally { toolRunning = null; }
}
TOOLS.splice(0, 0, { id: 'zip', icon: '📦', name: 'ZIP files', desc: 'Make a ZIP from files or folders, or open a ZIP and extract it – WinZip-style.', noDoc: true, custom: zipUI });
// dropping a .zip anywhere opens it in the ZIP tool
addEventListener('drop', e => {
  const z = [...(e.dataTransfer?.files || [])].find(f => /\.zip$/i.test(f.name));
  if (!z || e.target.closest?.('#zDrop')) return;
  e.preventDefault(); e.stopImmediatePropagation(); document.body.classList.remove('dragging');
  loadZip(z);
}, true);

/* ---------------- everyday page tools (inspired by Stirling-PDF) ---------------- */
// Draw a whole page (any rotation) scaled to fit a box on another page
function drawFitted(page, emb, rot, X, Y, W, H, pad = 0) {
  const bw = emb.width, bh = emb.height, dw = rot % 180 ? bh : bw, dh = rot % 180 ? bw : bh;
  const s = Math.min((W - 2 * pad) / dw, (H - 2 * pad) / dh), X0 = X + (W - dw * s) / 2, Y0 = Y + (H - dh * s) / 2;
  const o = { 0: [X0, Y0, 0], 90: [X0, Y0 + bw * s, -90], 180: [X0 + bw * s, Y0 + bh * s, -180], 270: [X0 + bh * s, Y0, -270] }[rot] || [X0, Y0, 0];
  page.drawPage(emb, { x: o[0], y: o[1], xScale: s, yScale: s, rotate: degrees(o[2]) });
}
const PAPER = { letter: [612, 792], a4: [595.28, 841.89], legal: [612, 1008], a3: [841.89, 1190.55], a5: [419.53, 595.28] };
async function relayout(bytes, { paper = 'letter', perSheet = 1, landscape = false, margin = 0 }) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true }), out = await PDFDocument.create();
  let [W, H] = PAPER[paper] || PAPER.letter;
  const cols = perSheet === 4 ? 2 : perSheet === 2 ? 2 : 1, rows = perSheet === 4 ? 2 : 1;
  if (perSheet === 2) landscape = !landscape; // 2 portrait pages side by side on a landscape sheet
  if (landscape) [W, H] = [H, W];
  const pages = src.getPages(), embeds = await out.embedPages(pages, pages.map(p => { const c = p.getCropBox(); return { left: c.x, bottom: c.y, right: c.x + c.width, top: c.y + c.height }; }));
  for (let i = 0; i < pages.length; i += perSheet) {
    const sheet = out.addPage([W, H]), cw = W / cols, ch = H / rows;
    for (let k = 0; k < perSheet && i + k < pages.length; k++) {
      const col = k % cols, row = Math.floor(k / cols);
      drawFitted(sheet, embeds[i + k], ((pages[i + k].getRotation().angle % 360) + 360) % 360, col * cw, H - (row + 1) * ch, cw, ch, perSheet > 1 ? 12 : margin);
    }
  }
  return out.save();
}
async function isBlank(p) {
  if (p.annots.length) return false;
  if ((await pageItems(p)).some(i => i.str.trim())) return false; // any text at all → not blank
  const d = dims(p), c = await renderRegion(p, { x: 0, y: 0, w: d.w, h: d.h }, 0.5), px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let ink = 0; for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 690) ink++;
  return ink / (px.length / 4) < 0.0003; // practically nothing printed on it
}
TOOLS.push(
  { id: 'organize', icon: '🗂', name: 'Organize pages', desc: 'Remove blank pages, reverse, keep odd/even, duplicate.',
    form: `<label>Do this <select name="act"><option value="blank">Remove blank pages</option><option value="reverse">Reverse page order</option><option value="odd">Keep only odd pages (1, 3, 5…)</option><option value="even">Keep only even pages (2, 4, 6…)</option><option value="dup">Duplicate selected pages (or the current page)</option></select></label>
      <p class="muted">Changes the open document – Ctrl+Z undoes it.</p>`,
    async run(o, prog) {
      const before = S.pages.length;
      if (o.act === 'blank') {
        const drop = [];
        for (let i = 0; i < S.pages.length; i++) { await prog(i / S.pages.length, `Checking page ${i + 1} of ${S.pages.length}`); if (await isBlank(S.pages[i])) drop.push(S.pages[i].id); }
        if (!drop.length) return 'No blank pages found.';
        if (drop.length === S.pages.length) return 'Every page looks blank – nothing removed.';
        snap(); S.pages = S.pages.filter(p => !drop.includes(p.id));
      } else if (o.act === 'reverse') { snap(); S.pages.reverse(); }
      else if (o.act === 'odd' || o.act === 'even') { if (S.pages.length < 2) return 'Only one page.'; snap(); S.pages = S.pages.filter((_, i) => (i % 2 === 0) === (o.act === 'odd')); }
      else {
        const ids = targets(); snap();
        for (const id of ids) { const i = S.pages.findIndex(p => p.id === id), c = JSON.parse(JSON.stringify(S.pages[i])); c.id = nid(); c.annots.forEach(a => a.id = nid()); S.pages.splice(i + 1, 0, c); }
      }
      S.selPages.clear(); S.current = Math.min(S.current, S.pages.length - 1); refreshAll();
      const diff = S.pages.length - before;
      return diff < 0 ? `Removed ${-diff} page${diff < -1 ? 's' : ''} – ${S.pages.length} left.` : diff > 0 ? `Added ${diff} page${diff > 1 ? 's' : ''}.` : 'Done.';
    } },
  { id: 'resize', icon: '📐', name: 'Resize pages (Letter / A4…)', desc: 'Fit every page onto one paper size – handy before printing.',
    form: `<label>Paper <select name="paper"><option value="letter">Letter (8.5 × 11 in)</option><option value="a4">A4</option><option value="legal">Legal</option><option value="a3">A3</option><option value="a5">A5</option></select></label>
      <label><input type="checkbox" name="landscape"> Landscape</label><label>Margin <select name="margin"><option value="0">None</option><option value="18">Small</option><option value="36">Normal (½ in)</option></select></label>
      <p class="muted">Saves a new PDF. Links and form fields become part of the page.</p>`,
    async run(o, prog) {
      await prog(0.1, 'Fitting pages…');
      const b = await relayout(await currentBytes(), { paper: o.paper, landscape: o.landscape, margin: +o.margin });
      if (await saveAny(b, `${baseName()} (${o.paper.toUpperCase()}).pdf`)) return 'Saved.';
    } },
  { id: 'nup', icon: '🔲', name: 'Several pages per sheet', desc: 'Print 2 or 4 pages on each sheet to save paper.',
    form: `<label>Pages per sheet <select name="n"><option value="2">2</option><option value="4">4</option></select></label><label>Paper <select name="paper"><option value="letter">Letter</option><option value="a4">A4</option></select></label>`,
    async run(o, prog) {
      await prog(0.1, 'Arranging pages…');
      const b = await relayout(await currentBytes(), { paper: o.paper, perSheet: +o.n });
      if (await saveAny(b, `${baseName()} (${o.n} per sheet).pdf`)) return `Saved – ${Math.ceil(S.pages.length / +o.n)} sheets instead of ${S.pages.length}.`;
    } },
  { id: 'flatten', icon: '🧱', name: 'Flatten forms', desc: 'Lock filled-in form fields so they can no longer be changed.',
    form: `<p class="muted">Saves a copy where every form field becomes ordinary page content (good for sending a final version).</p>`,
    async run(o, prog) {
      await prog(0.2, 'Flattening…');
      const doc = await PDFDocument.load(await currentBytes(), { ignoreEncryption: true });
      let n = 0; try { const f = doc.getForm(); n = f.getFields().length; f.updateFieldAppearances(); f.flatten(); } catch (e) { console.warn(e); }
      if (!n) return 'This PDF has no form fields.';
      if (await saveAny(await doc.save(), `${baseName()} (final).pdf`)) return `Flattened ${n} field${n > 1 ? 's' : ''}.`;
    } },
  { id: 'meta', icon: '🏷', name: 'Title, author & info', desc: 'Change what shows in File → Properties (title, author, subject, keywords).',
    form: `<label>Title <input name="title"></label><label>Author <input name="author"></label><label>Subject <input name="subject"></label><label>Keywords <input name="keywords" placeholder="comma separated"></label>
      <label><input type="checkbox" name="clear"> Remove all other hidden info</label><p class="muted">Applied when you save.</p>`,
    async init() { // pre-fill from the open document
      const m = S.meta || {};
      if (!S.meta) { const s = S.sources.find(Boolean); try { const info = (await s.doc.getMetadata()).info || {}; Object.assign(m, { title: info.Title || '', author: info.Author || '', subject: info.Subject || '', keywords: info.Keywords || '' }); } catch { } }
      for (const k of ['title', 'author', 'subject', 'keywords']) { const i = $(`#tBody [name="${k}"]`); if (i) i.value = m[k] || ''; }
    },
    async run(o) {
      S.meta = { title: o.title.trim(), author: o.author.trim(), subject: o.subject.trim(), keywords: o.keywords.trim(), clear: o.clear };
      S.dirty = true; updateTitle();
      return 'Saved with the document next time you press Save.';
    } },
);
