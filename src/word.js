/* Word documents → PDF.
   1) Windows app with Microsoft Word installed: Word itself converts it (exact layout, via the local helper).
   2) Everywhere else (.docx only): a built-in converter lays out paragraphs, lists, tables, images, headers and footers. */

const WORD_RE = /\.(docx|docm|dotx|doc|rtf|odt)$/i;
const isWordFile = f => WORD_RE.test(f.name) || /officedocument\.wordprocessingml|msword|rtf|opendocument\.text/.test(f.type || '');

async function wordToPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const u = helperUrl('word');
  if (u) {
    toast(`Converting "${file.name}" with Microsoft Word…`, 60000);
    try {
      const r = await (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, b64: await toB64(bytes) }) })).json();
      if (r.ok) { toast('Converted with Microsoft Word.'); return fromB64(r.b64); }
      if (r.error !== 'noword') console.warn('Word conversion failed:', r.error);
    } catch (e) { console.warn(e); }
  }
  if (!/\.(docx|docm|dotx)$/i.test(file.name) && !/wordprocessingml/.test(file.type || ''))
    throw new Error(`"${file.name}" is an older Word/RTF file – it needs Microsoft Word to convert. Save it as .docx and try again.`);
  toast(`Converting "${file.name}"…`, 30000);
  const out = await docxToPdf(bytes);
  toast(u ? 'Converted (Microsoft Word not found – simple layout).' : 'Converted. Complex layouts may differ a little from Word.', 5000);
  return out;
}

/* ---------------- built-in .docx converter ---------------- */
async function docxToPdf(bytes) {
  const z = await readZip(new File([bytes], 'd.docx'));
  const part = async n => { const en = z.entries.find(e => e.name === n); return en ? zipEntryData(z, en) : null; };
  const xml = async n => { const b = await part(n); return b && new DOMParser().parseFromString(new TextDecoder().decode(b), 'application/xml'); };
  const doc = await xml('word/document.xml'); if (!doc) throw new Error('This is not a Word document.');
  const [styles, numbering, rels] = await Promise.all([xml('word/styles.xml'), xml('word/numbering.xml'), xml('word/_rels/document.xml.rels')]);

  // tiny XML helpers (namespace-free: match on local names)
  const kids = (n, name) => n ? [...n.children].filter(c => !name || c.localName === name) : [];
  const kid = (n, name) => kids(n, name)[0] || null;
  const at = (n, a) => n && (n.getAttribute('w:' + a) ?? n.getAttribute(a));
  const on = n => !!n && !/^(0|false|off|none)$/.test(at(n, 'val') ?? 'true');
  const num = (v, d) => v == null || isNaN(+v) ? d : +v;
  const relTarget = id => { const r = rels && [...rels.getElementsByTagName('Relationship')].find(x => x.getAttribute('Id') === id); return r && 'word/' + r.getAttribute('Target').replace(/^\/?word\//, '').replace(/^\.\//, ''); };

  /* styles: paragraph + run properties with basedOn inheritance */
  const styleById = {};
  for (const s of kids(styles?.documentElement, 'style')) styleById[at(s, 'styleId')] = s;
  const docDef = { font: 'Calibri', size: 11, after: 8, line: 1.08 };
  const dd = kid(styles?.documentElement, 'docDefaults');
  if (dd) {
    const rp = kid(kid(dd, 'rPrDefault'), 'rPr');
    const f = kid(rp, 'rFonts'), sz = kid(rp, 'sz');
    if (f && at(f, 'ascii')) docDef.font = at(f, 'ascii');
    if (sz) docDef.size = num(at(sz, 'val'), 22) / 2;
    const sp = kid(kid(kid(dd, 'pPrDefault'), 'pPr'), 'spacing');
    if (sp) { docDef.after = num(at(sp, 'after'), 160) / 20; if (at(sp, 'line') && (at(sp, 'lineRule') || 'auto') === 'auto') docDef.line = num(at(sp, 'line'), 259) / 240; }
  }
  const readRun = (rPr, o) => {
    if (!rPr) return o;
    for (const c of rPr.children) switch (c.localName) {
      case 'b': o.bold = on(c); break;
      case 'i': o.ital = on(c); break;
      case 'u': o.under = at(c, 'val') !== 'none'; break;
      case 'strike': o.strike = on(c); break;
      case 'caps': o.caps = on(c); break;
      case 'sz': o.size = num(at(c, 'val'), 22) / 2; break;
      case 'color': if (/^[0-9a-f]{6}$/i.test(at(c, 'val') || '')) o.color = at(c, 'val'); break;
      case 'rFonts': if (at(c, 'ascii')) o.font = at(c, 'ascii'); else if (at(c, 'hAnsi')) o.font = at(c, 'hAnsi'); break;
      case 'vertAlign': o.va = at(c, 'val'); break;
      case 'vanish': o.hidden = on(c); break;
      case 'highlight': o.hl = at(c, 'val'); break;
    }
    return o;
  };
  const readPara = (pPr, o) => {
    if (!pPr) return o;
    for (const c of pPr.children) switch (c.localName) {
      case 'jc': o.align = { both: 'justify', distribute: 'justify', end: 'right', start: 'left' }[at(c, 'val')] || at(c, 'val'); break;
      case 'spacing':
        if (at(c, 'before') != null) o.before = num(at(c, 'before'), 0) / 20;
        if (at(c, 'after') != null) o.after = num(at(c, 'after'), 0) / 20;
        if (at(c, 'line') != null) { const rule = at(c, 'lineRule') || 'auto'; o.line = rule === 'auto' ? num(at(c, 'line'), 240) / 240 : -num(at(c, 'line'), 240) / 20; }
        break;
      case 'ind':
        o.left = num(at(c, 'left') ?? at(c, 'start'), o.left * 20) / 20; o.right = num(at(c, 'right') ?? at(c, 'end'), o.right * 20) / 20;
        if (at(c, 'firstLine') != null) o.first = num(at(c, 'firstLine'), 0) / 20;
        if (at(c, 'hanging') != null) o.first = -num(at(c, 'hanging'), 0) / 20;
        break;
      case 'numPr': o.numId = at(kid(c, 'numId'), 'val'); o.ilvl = num(at(kid(c, 'ilvl'), 'val'), 0); break;
      case 'pageBreakBefore': o.breakBefore = on(c); break;
      case 'contextualSpacing': o.ctx = on(c); break;
      case 'shd': if (/^[0-9a-f]{6}$/i.test(at(c, 'fill') || '')) o.shade = at(c, 'fill'); break;
    }
    return o;
  };
  const styleChain = id => { const out = []; for (let s = styleById[id], n = 0; s && n < 20; s = styleById[at(kid(s, 'basedOn'), 'val')], n++) out.unshift(s); return out; };
  const defaultPara = Object.values(styleById).find(s => at(s, 'type') === 'paragraph' && at(s, 'default') === '1');
  const paraStyle = id => {
    const p = { align: 'left', before: 0, after: docDef.after, line: docDef.line, left: 0, right: 0, first: 0 }, r = { font: docDef.font, size: docDef.size, color: '000000' };
    for (const s of styleChain(id || at(defaultPara, 'styleId'))) { readPara(kid(s, 'pPr'), p); readRun(kid(s, 'rPr'), r); }
    return { p, r };
  };

  /* lists */
  const absOf = {}, lvlDef = {};
  for (const n of kids(numbering?.documentElement, 'num')) absOf[at(n, 'numId')] = at(kid(n, 'abstractNumId'), 'val');
  for (const a of kids(numbering?.documentElement, 'abstractNum'))
    lvlDef[at(a, 'abstractNumId')] = Object.fromEntries(kids(a, 'lvl').map(l => [at(l, 'ilvl'), {
      fmt: at(kid(l, 'numFmt'), 'val') || 'bullet', text: at(kid(l, 'lvlText'), 'val') || '•', start: num(at(kid(l, 'start'), 'val'), 1), pPr: kid(l, 'pPr') }]));
  const counters = {};
  const roman = n => { let s = ''; for (const [v, r] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) while (n >= v) { s += r; n -= v; } return s; };
  const fmtNum = (f, n) => f === 'lowerLetter' ? String.fromCharCode(96 + ((n - 1) % 26) + 1) : f === 'upperLetter' ? String.fromCharCode(64 + ((n - 1) % 26) + 1)
    : f === 'lowerRoman' ? roman(n) : f === 'upperRoman' ? roman(n).toUpperCase() : String(n);
  const listLabel = (numId, ilvl) => {
    const defs = lvlDef[absOf[numId]]; const d = defs?.[ilvl]; if (!d || numId === '0') return null;
    const c = counters[numId] ||= {};
    c[ilvl] = (c[ilvl] ?? d.start - 1) + 1; for (const k in c) if (+k > ilvl) delete c[k];
    if (d.fmt === 'bullet') return { text: /[]/.test(d.text) || !d.text.trim() ? '•' : d.text === 'o' ? '◦' : d.text, pPr: d.pPr };
    if (d.fmt === 'none') return { text: '', pPr: d.pPr };
    return { text: d.text.replace(/%(\d)/g, (_, k) => fmtNum(defs[k - 1]?.fmt, c[k - 1] ?? defs[k - 1]?.start ?? 1)), pPr: d.pPr };
  };

  /* page setup */
  const body = kid(doc.documentElement, 'body');
  const sect = kid(body, 'sectPr');
  const pgSz = kid(sect, 'pgSz'), pgMar = kid(sect, 'pgMar');
  const PW = num(at(pgSz, 'w'), 12240) / 20, PH = num(at(pgSz, 'h'), 15840) / 20;
  const M = { t: num(at(pgMar, 'top'), 1440) / 20, b: num(at(pgMar, 'bottom'), 1440) / 20, l: num(at(pgMar, 'left'), 1440) / 20, r: num(at(pgMar, 'right'), 1440) / 20,
    h: num(at(pgMar, 'header'), 720) / 20, f: num(at(pgMar, 'footer'), 720) / 20 };

  /* fonts: the real font when this computer has it, otherwise the closest standard PDF font */
  const pdf = await PDFLib.PDFDocument.create();
  if (typeof fontkit !== 'undefined') pdf.registerFontkit(fontkit);
  const fontCache = {};
  const stdFor = (fam, b, i) => {
    const f = fam.toLowerCase(), S = PDFLib.StandardFonts;
    const kind = /mono|courier|consol/.test(f) ? 'C' : /times|georgia|garamond|cambria|book|serif|palatino|century/.test(f) && !/sans/.test(f) ? 'T' : 'H';
    return { C: [S.Courier, S.CourierBold, S.CourierOblique, S.CourierBoldOblique], T: [S.TimesRoman, S.TimesRomanBold, S.TimesRomanItalic, S.TimesRomanBoldItalic],
      H: [S.Helvetica, S.HelveticaBold, S.HelveticaOblique, S.HelveticaBoldOblique] }[kind][(b ? 1 : 0) + (i ? 2 : 0)];
  };
  const getFont = async (fam, b, i) => {
    const key = fam + (b ? 'B' : '') + (i ? 'I' : '');
    if (fontCache[key]) return fontCache[key];
    let f = null;
    if (typeof fontkit !== 'undefined' && typeof systemFont === 'function') {
      try { const sf = await systemFont(fam.replace(/\s+/g, '') + (b || i ? '-' + (b ? 'Bold' : '') + (i ? 'Italic' : '') : '')); if (sf) f = await pdf.embedFont(sf.bytes, { subset: true }); } catch { f = null; }
    }
    return fontCache[key] = { font: f || await pdf.embedFont(stdFor(fam, b, i)), std: !f };
  };
  const safe = (fo, t) => fo.std ? t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7e\xa0-\xff•€]/g, '?') : t;

  /* images */
  const imgCache = {};
  const getImage = async rid => {
    if (rid in imgCache) return imgCache[rid];
    const t = relTarget(rid), b = t && await part(t);
    let im = null;
    try { if (b) im = /\.png$/i.test(t) ? await pdf.embedPng(b) : /\.jpe?g$/i.test(t) ? await pdf.embedJpg(b) : null; } catch { im = null; }
    return imgCache[rid] = im;
  };

  /* collect a paragraph's pieces: words, tabs, breaks, images */
  const runsOf = async (p, ps) => {
    const out = [];
    const walk = async (n, rBase) => {
      for (const c of n.children) {
        const ln = c.localName;
        if (ln === 'r') {
          const r = { ...rBase }, rs = at(kid(kid(c, 'rPr'), 'rStyle'), 'val');
          if (rs) for (const s of styleChain(rs)) readRun(kid(s, 'rPr'), r); // character style, then the run's own formatting
          readRun(kid(c, 'rPr'), r);
          if (r.hidden) continue;
          for (const e of c.children) {
            if (e.localName === 't') out.push({ t: r.caps ? e.textContent.toUpperCase() : e.textContent, r });
            else if (e.localName === 'tab') out.push({ tab: true, r });
            else if (e.localName === 'br') out.push(at(e, 'type') === 'page' ? { page: true } : { br: true, r });
            else if (e.localName === 'drawing' || e.localName === 'pict') {
              const blip = e.getElementsByTagNameNS('*', 'blip')[0], ext = e.getElementsByTagNameNS('*', 'extent')[0];
              const rid = blip && (blip.getAttribute('r:embed') || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed'));
              const im = rid && await getImage(rid);
              if (im) out.push({ img: im, w: num(ext?.getAttribute('cx'), im.width * 9525) / 12700, h: num(ext?.getAttribute('cy'), im.height * 9525) / 12700 });
            }
          }
        } else if (['hyperlink', 'smartTag', 'ins', 'sdt', 'sdtContent', 'fldSimple', 'customXml'].includes(ln)) await walk(c, rBase);
      }
    };
    await walk(p, ps.r);
    return out;
  };

  /* line breaking + drawing */
  let page = null, y = 0, pages = [];
  const area = { x: M.l, w: PW - M.l - M.r, top: M.t, bottom: PH - M.b };
  const newPage = () => { page = pdf.addPage([PW, PH]); pages.push(page); y = area.top; };
  const rgb = h => { const n = parseInt(h || '000000', 16); return PDFLib.rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); };

  // lay out one paragraph into lines (no drawing): returns [{items, w, h, asc}]
  const layoutPara = async (pieces, width, first) => {
    const lines = []; let cur = [], cw = 0, maxH = 0, maxA = 0, avail = width - Math.max(0, first);
    const push = force => { lines.push({ items: cur, w: cw, h: maxH || 12, asc: maxA || 9, br: force }); cur = []; cw = 0; maxH = 0; maxA = 0; avail = width; };
    for (const pc of pieces) {
      if (pc.page) { if (cur.length) push(true); lines.push({ page: true }); continue; }
      if (pc.br) { push(true); continue; }
      if (pc.img) {
        let w = pc.w, h = pc.h; if (w > width) { h *= width / w; w = width; }
        if (cw + w > avail && cur.length) push();
        cur.push({ img: pc.img, w, h }); cw += w; maxH = Math.max(maxH, h); maxA = Math.max(maxA, h); continue;
      }
      const r = pc.r, size = r.va && r.va !== 'baseline' ? r.size * 0.65 : r.size, fo = await getFont(r.font || docDef.font, r.bold, r.ital);
      const lh = size * 1.17, asc = size * 0.9;
      if (pc.tab) { const tw = 36 - ((width - avail + cw) % 36) || 36; cur.push({ sp: true, w: tw, tab: true }); cw += tw; continue; }
      for (const tok of safe(fo, pc.t).split(/( +)/)) {
        if (!tok) continue;
        const w = fo.font.widthOfTextAtSize(tok, size);
        if (/^ +$/.test(tok)) { if (cur.length) { cur.push({ sp: true, w, t: tok, fo, size, r }); cw += w; } continue; }
        if (cw + w > avail && cur.length) { while (cur.length && cur.at(-1).sp && !cur.at(-1).tab) cw -= cur.pop().w; push(); }
        cur.push({ t: tok, w, fo, size, r }); cw += w; maxH = Math.max(maxH, lh); maxA = Math.max(maxA, asc);
      }
    }
    if (cur.length || !lines.length) push(true);
    return lines;
  };
  const drawLine = (ln, x0, base, width, align, last) => {
    let x = x0, gap = 0;
    const trail = ln.items.length && ln.items.at(-1).sp ? ln.items.at(-1).w : 0, w = ln.w - trail;
    if (align === 'center') x += (width - w) / 2; else if (align === 'right') x += width - w;
    else if (align === 'justify' && !last && !ln.br) { const n = ln.items.filter(i => i.sp && !i.tab).length; if (n) gap = (width - w) / n; }
    // neighbouring words in the same style are written as one piece of text (better copy/edit later)
    const items = [];
    for (const it of ln.items) {
      const prev = items.at(-1);
      if (!gap && prev && !prev.img && !it.img && !it.tab && !prev.tab && prev.r === it.r && (it.t || it.sp) && prev.t != null) { prev.t += it.t ?? it.t0 ?? ' '.repeat(Math.max(1, Math.round(it.w / (prev.fo.font.widthOfTextAtSize(' ', prev.size) || 3)))); prev.w += it.w; prev.sp = false; continue; }
      items.push({ ...it });
    }
    for (const it of items) {
      if (it.img) { page.drawImage(it.img, { x, y: PH - base, width: it.w, height: it.h }); x += it.w; continue; }
      if (it.sp && it.t == null) { x += it.w; continue; }
      if (it.sp) { if (it.r?.under) page.drawLine({ start: { x, y: PH - base - 1.5 }, end: { x: x + it.w + gap, y: PH - base - 1.5 }, thickness: 0.6, color: rgb(it.r.color) }); x += it.w + (it.tab ? 0 : gap); continue; }
      const r = it.r, rise = r.va === 'superscript' ? r.size * 0.35 : r.va === 'subscript' ? -r.size * 0.15 : 0;
      if (r.hl && r.hl !== 'none') page.drawRectangle({ x, y: PH - base - it.size * 0.22, width: it.w, height: it.size * 1.12, color: rgb({ yellow: 'ffff00', green: '00ff00', cyan: '00ffff', lightGray: 'd3d3d3' }[r.hl] || 'ffff00') });
      page.drawText(it.t, { x, y: PH - base + rise, size: it.size, font: it.fo.font, color: rgb(r.color) });
      if (r.under) page.drawLine({ start: { x, y: PH - base - 1.5 }, end: { x: x + it.w, y: PH - base - 1.5 }, thickness: 0.6, color: rgb(r.color) });
      if (r.strike) page.drawLine({ start: { x, y: PH - base + it.size * 0.3 }, end: { x: x + it.w, y: PH - base + it.size * 0.3 }, thickness: 0.6, color: rgb(r.color) });
      x += it.w;
    }
  };
  const lineH = (ln, ps) => ps.line < 0 ? -ps.line : ln.h * ps.line;

  // a paragraph → prepared block { ps, label, lines } (layout only, so tables can measure first)
  const prepPara = async (p, width) => {
    const pPr = kid(p, 'pPr'), ps = paraStyle(at(kid(pPr, 'pStyle'), 'val'));
    readPara(pPr, ps.p);
    if (ps.p.numId) { const L = listLabel(ps.p.numId, ps.p.ilvl); if (L) { readPara(L.pPr, ps.p); readPara(pPr, ps.p); if (ps.p.left === 0) ps.p.left = 36 * (ps.p.ilvl + 1); if (!ps.p.first) ps.p.first = -18; ps.label = L.text; } }
    readRun(kid(pPr, 'rPr'), {}); // paragraph mark formatting does not apply to the text
    const pieces = await runsOf(p, ps);
    const inner = width - ps.p.left - ps.p.right;
    const lines = await layoutPara(pieces, inner, ps.p.first);
    return { ps: ps.p, r: ps.r, label: ps.label, lines, inner };
  };
  const paraHeight = b => b.ps.before + b.lines.reduce((s, l) => s + (l.page ? 0 : lineH(l, b.ps)), 0) + b.ps.after;
  // draw a prepared paragraph at (x, y top); flows onto new pages when `flow`
  const drawPara = async (b, x, flow) => {
    const ps = b.ps; y += ps.before;
    let firstLine = true;
    for (let i = 0; i < b.lines.length; i++) {
      const ln = b.lines[i];
      if (ln.page) { newPage(); continue; }
      const h = lineH(ln, ps);
      if (flow && y + h > area.bottom && y > area.top) newPage();
      const base = y + (ps.line < 0 ? h * 0.8 : ln.asc + (h - ln.h) * 0.5);
      const lx = x + ps.left + (firstLine ? Math.max(0, ps.first) : 0);
      if (ps.shade && flow) page.drawRectangle({ x: x + ps.left, y: PH - y - h, width: b.inner, height: h, color: rgb(ps.shade) });
      if (firstLine && b.label != null && b.label !== '') {
        const fo = await getFont(b.r.font || docDef.font, b.r.bold, false);
        page.drawText(safe(fo, b.label), { x: x + ps.left + ps.first, y: PH - base, size: b.r.size, font: fo.font, color: rgb(b.r.color) });
      }
      drawLine(ln, lx, base, b.inner - (firstLine ? Math.max(0, ps.first) : 0), ps.align, i === b.lines.length - 1);
      y += h; firstLine = false;
    }
    y += ps.after;
  };

  const drawTable = async tbl => {
    const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map(g => num(at(g, 'w'), 0) / 20);
    const total = grid.reduce((a, b) => a + b, 0) || area.w, k = total > area.w ? area.w / total : 1;
    const cols = grid.length ? grid.map(w => w * k) : null;
    const tPr = kid(tbl, 'tblPr'), tStyle = at(kid(tPr, 'tblStyle'), 'val') || '';
    const bordersEl = kid(tPr, 'tblBorders') || kid(kid(styleById[tStyle], 'tblPr'), 'tblBorders');
    const borders = bordersEl ? kids(bordersEl).some(b => !/^(nil|none)$/.test(at(b, 'val') || '')) : /grid/i.test(tStyle);
    const pad = 5.4;
    for (const tr of kids(tbl, 'tr')) {
      const cells = kids(tr, 'tc');
      const n = cols ? cols.length : cells.length, cw = cols || Array(n).fill(area.w / n);
      let ci = 0; const prepared = [];
      for (const tc of cells) {
        const span = num(at(kid(kid(tc, 'tcPr'), 'gridSpan'), 'val'), 1);
        const w = cw.slice(ci, ci + span).reduce((a, b) => a + b, 0) || area.w / cells.length;
        const shd = at(kid(kid(tc, 'tcPr'), 'shd'), 'fill');
        const blocks = [];
        for (const c of tc.children) if (c.localName === 'p') blocks.push(await prepPara(c, w - pad * 2));
        prepared.push({ x: area.x + cw.slice(0, ci).reduce((a, b) => a + b, 0), w, blocks, shd: /^[0-9a-f]{6}$/i.test(shd || '') ? shd : null });
        ci += span;
      }
      const rowH = Math.max(14, ...prepared.map(c => c.blocks.reduce((s, b) => s + paraHeight(b), 0) - (c.blocks.at(-1)?.ps.after || 0) + pad));
      if (y + rowH > area.bottom && y > area.top) newPage();
      const top = y;
      for (const c of prepared) {
        if (c.shd) page.drawRectangle({ x: c.x, y: PH - top - rowH, width: c.w, height: rowH, color: rgb(c.shd) });
        y = top + pad / 2;
        for (const [i, b] of c.blocks.entries()) { if (i === c.blocks.length - 1) b.ps = { ...b.ps, after: 0 }; await drawPara(b, c.x + pad, false); }
        if (borders) page.drawRectangle({ x: c.x, y: PH - top - rowH, width: c.w, height: rowH, borderColor: rgb('000000'), borderWidth: 0.5 });
      }
      y = top + rowH;
    }
    y += 6;
  };

  // headers / footers (the default ones), drawn on every page at the end
  const hf = async (type, which) => {
    const ref = kids(sect, type + 'Reference').find(r => at(r, 'type') === 'default') || kids(sect, type + 'Reference')[0];
    const rid = ref && (ref.getAttribute('r:id') || ref.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const d = rid && await xml(relTarget(rid)); if (!d) return null;
    const blocks = [];
    for (const c of d.documentElement.children) if (c.localName === 'p') blocks.push(await prepPara(c, area.w));
    return blocks.length ? { blocks, which } : null;
  };

  newPage();
  let prevStyle = null, prevB = null;
  for (const c of body.children) {
    if (c.localName === 'p') {
      const b = await prepPara(c, area.w), st = at(kid(kid(c, 'pPr'), 'pStyle'), 'val') || '';
      if (b.ps.ctx && prevB && prevStyle === st) { b.ps.before = 0; y -= prevB.ps.ctx ? prevB.ps.after : 0; }
      prevStyle = st; prevB = b;
      if (b.ps.breakBefore && y > area.top) newPage();
      await drawPara(b, area.x, true);
      if (kid(kid(c, 'pPr'), 'sectPr') && c.nextElementSibling) newPage(); // section break → new page
    } else if (c.localName === 'tbl') await drawTable(c);
    else if (c.localName === 'sdt') for (const p of kids(kid(c, 'sdtContent'))) if (p.localName === 'p') await drawPara(await prepPara(p, area.w), area.x, true);
  }
  const [hd, ft] = [await hf('header'), await hf('footer')];
  for (const pg of pages) {
    page = pg;
    if (hd) { y = M.h; for (const b of hd.blocks) await drawPara(b, area.x, false); }
    if (ft) { const h = ft.blocks.reduce((s, b) => s + paraHeight(b), 0); y = PH - M.f - h; for (const b of ft.blocks) await drawPara(b, area.x, false); }
  }
  return pdf.save();
}
