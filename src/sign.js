'use strict';
/* Mark's Render PDF Editor – request & collect signatures (DocuSign-style, free, no server).
   The request travels inside the PDF itself (an incremental update of the file's Info dictionary),
   email carries the file between people, and the signing page is the web version on GitHub Pages. */

const SIGN_URL = 'https://sttechnllc.github.io/render_pdf/?sign';
// Document host (cloud/worker.js). Empty = email attachments only.
const SIGN_HOST = 'https://render-pdf-sign.mpeters-44f.workers.dev';
const SIGNER_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899'];
const FIELD_TYPES = {
  signature: { label: 'Signature', icon: '✍', w: 170, h: 44 },
  initials: { label: 'Initials', icon: '✒', w: 64, h: 34 },
  date: { label: 'Date signed', icon: '📅', w: 110, h: 22 },
  name: { label: 'Full name', icon: '👤', w: 170, h: 22 },
  text: { label: 'Text', icon: '𝐓', w: 170, h: 22 },
  check: { label: 'Checkbox', icon: '☑', w: 18, h: 18 },
};
const CONSENT = 'I agree that my electronic signature is the legal equivalent of my handwritten signature, and I consent to doing business electronically for this document.';
const SG = { req: null, mode: null, me: null, received: '', ok: null, method: '', active: null, ftype: null, draft: null };

/* ---------------- small helpers ---------------- */
const sha256 = async b => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('');
const latin1 = b => { let s = ''; for (let i = 0; i < b.length; i += 65536) s += String.fromCharCode.apply(null, b.subarray(i, i + 65536)); return s; };
const b64u = s => btoa(unescape(encodeURIComponent(s))), unb64u = s => decodeURIComponent(escape(atob(s)));
const pdfHexStr = s => '<FEFF' + [...s].map(c => { const n = c.codePointAt(0); const h = x => x.toString(16).padStart(4, '0'); if (n < 0x10000) return h(n); const m = n - 0x10000; return h(0xD800 + (m >> 10)) + h(0xDC00 + (m & 1023)); }).join('') + '>';
const signerOf = (req, id) => req.signers.find(s => s.id === id);
const sameEmail = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
const isSender = (req, s) => !!s && sameEmail(s.email, req.from?.email); // this signer sent the request
const isMe = s => !!s && sameEmail(s.email, senderProfile.get().email);   // this signer is whoever uses this app
const nextSigner = req =>req.signers.find(s => !req.steps.some(st => st.signer === s.id)) || null;
const fmtWhen = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const senderProfile = { get() { try { return JSON.parse(localStorage.getItem('pdfeditor.sender')) || {}; } catch { return {}; } }, set(v) { try { localStorage.setItem('pdfeditor.sender', JSON.stringify(v)); } catch { } } };

/* ---------------- the request inside the PDF ---------------- */
// Append the request as a tiny incremental update: everything before it stays byte-for-byte identical,
// so a fingerprint of that part proves the document hasn't been changed since it was signed.
function appendSignInfo(A, req) {
  const tail = latin1(A.subarray(Math.max(0, A.length - 4096)));
  const sx = +tail.match(/startxref\s+(\d+)\s+%%EOF\s*$/)[1];
  const tr = tail.slice(tail.lastIndexOf('trailer'));
  const root = tr.match(/\/Root\s+(\d+\s+\d+\s+R)/)[1], size = +tr.match(/\/Size\s+(\d+)/)[1], id = (tr.match(/\/ID\s*(\[[^\]]*\])/) || [])[1];
  const n = size;
  let s = A[A.length - 1] === 10 ? '' : '\n';
  const objOff = A.length + s.length;
  s += `${n} 0 obj\n<< /Producer (Mark's Render PDF Editor) /Title ${pdfHexStr(req.title)} /MRPDFSign (${b64u(JSON.stringify(req))}) >>\nendobj\n`;
  const xrefOff = A.length + s.length; // ASCII only → characters = bytes
  s += `xref\n${n} 1\n${String(objOff).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${n + 1} /Root ${root} /Info ${n} 0 R /Prev ${sx}${id ? ' /ID ' + id : ''} >>\nstartxref\n${xrefOff}\n%%EOF\n`;
  const out = new Uint8Array(A.length + s.length); out.set(A); for (let i = 0; i < s.length; i++) out[A.length + i] = s.charCodeAt(i);
  return out;
}
async function readSignInfo(bytes) {
  const s = latin1(bytes), i = s.lastIndexOf('/MRPDFSign (');
  if (i < 0) return null;
  let req;
  try { req = JSON.parse(unb64u(s.slice(i + 12, s.indexOf(')', i)))); } catch { return null; }
  if (!req || req.v !== 1 || !Array.isArray(req.signers)) return null;
  let ok = null;
  if (req.integrity) {
    const { len, sha } = req.integrity;
    ok = len < bytes.length && (s.slice(len).match(/%%EOF/g) || []).length === 1 && await sha256(bytes.subarray(0, len)) === sha;
  }
  return { req, ok };
}
// Certificate of completion (rebuilt each time someone signs)
function certPages(req) {
  if (!req.steps.length) return [];
  const pages = [], W = 612, H = 792, M = 64;
  let p, y;
  const newPage = () => { p = { id: nid(), src: -1, idx: 0, baseRot: 0, rot: 0, w: W, h: H, annots: [] }; pages.push(p); y = 70; };
  const line = (text, size = 10, opt = {}) => {
    if (y > H - 70) newPage();
    p.annots.push({ id: nid(), type: 'text', x: M + (opt.indent || 0), y, text, size, font: opt.mono ? 'Courier' : 'Helvetica', bold: !!opt.bold, color: opt.color || '#1f2329' });
    y += size * (opt.gap || 1.55);
  };
  newPage();
  p.annots.push({ id: nid(), type: 'rect', x: M, y: 112, w: W - 2 * M, h: 1.2, color: '#2563eb', op: 1 });
  line('Certificate of completion', 20, { bold: true, color: '#1e3a8a' });
  line("Electronic signature record – Mark's Render PDF Editor", 9, { color: '#6b7280', gap: 2.6 });
  line('Document: ' + req.title, 11, { bold: true });
  line('Request ID: ' + req.id, 8.5, { mono: true, color: '#6b7280' });
  line(`Sent by: ${req.from.name} <${req.from.email}> on ${fmtWhen(req.created)}`, 9.5, { gap: 2.4 });
  req.steps.forEach((st, k) => {
    line(`${k + 1}.  Signed by ${st.name} <${st.email}>`, 11, { bold: true });
    line(`Date & time: ${fmtWhen(st.at)}  (${st.tz})  ·  UTC ${st.at.replace('T', ' ').slice(0, 19)}`, 9, { indent: 16 });
    line(`Signature: ${{ draw: 'drawn by hand', type: 'typed name', upload: 'uploaded image', saved: 'saved signature' }[st.method] || 'electronic'}  ·  Consent to sign electronically: given`, 9, { indent: 16 });
    line('Fingerprint of the document received (SHA-256):', 8.5, { indent: 16, color: '#6b7280', gap: 1.4 });
    line(st.received, 7.5, { indent: 16, mono: true, color: '#6b7280', gap: 2.6 });
  });
  const waiting = req.signers.filter(s => !req.steps.some(st => st.signer === s.id));
  if (waiting.length) line('Still to sign: ' + waiting.map(s => `${s.name} <${s.email}>`).join(', '), 10, { bold: true, color: '#b45309', gap: 2.4 });
  else line('✔ All signers have signed.', 11, { bold: true, color: '#15803d', gap: 2.4 });
  line('Consent text shown to each signer:', 8.5, { color: '#6b7280', gap: 1.4 });
  for (const part of CONSENT.match(/.{1,105}(\s|$)/g)) line(part.trim(), 8.5, { color: '#6b7280', gap: 1.4 });
  y += 10;
  line("To verify: open this PDF in Mark's Render PDF Editor (free) – it checks that nothing has been changed since the last signature.", 8, { color: '#6b7280' });
  return pages;
}
async function buildSignedPdf(req) {
  const cert = certPages(req);
  req.certPages = cert.length; delete req.integrity;
  const A = await buildPdf([...S.pages, ...cert], { classic: true });
  req.integrity = { len: A.length, sha: await sha256(A) };
  return appendSignInfo(A, req);
}

/* ---------------- email: attach automatically where possible ---------------- */
async function sendMail({ to, cc, subject, body, name, bytes }) {
  if (!bytes) { mailto(to, cc, subject, body); return 'link'; } // hosted: the email only carries the link
  const payload = async () => ({ to, cc: cc || '', subject, body, name, b64: await toB64(bytes) });
  const u = helperUrl('mail');
  if (u) { try { const r = await (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await payload()) })).json(); if (r.ok) return 'attached'; } catch { } }
  if (NATIVE) { try { if (await nativeCall('mail', await payload())) return 'attached'; } catch { } }
  mailto(to, cc, subject, body);
  return 'manual';
}
function mailto(to, cc, subject, body) {
  const a = el('a');
  a.href = `mailto:${encodeURIComponent(to)}?${cc ? 'cc=' + encodeURIComponent(cc) + '&' : ''}subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  document.body.append(a); a.click(); a.remove();
}
function mailDone(how, name) {
  if (how === 'link') toast('Your email is ready with the signing link – press Send.', 6000);
  else if (how === 'attached') toast('Your email is ready with the PDF attached – press Send.', 6000);
  else infoBox('📧 One more step', `Your email program opened with the message ready.<br><br><b>Attach the file "${escHtml(name)}"</b> (you just saved it) and press Send.<br><br><span class="muted">Tip: with classic Outlook, Thunderbird or Apple Mail the file is attached for you automatically.</span>`);
}
function infoBox(title, html) {
  $('#tmodal').hidden = false; $('#tProg').hidden = true; $('#tMsg').textContent = '';
  $('#tTitle').textContent = title; $('#tBack').hidden = true; $('#tRun').hidden = true;
  $('#tBody').innerHTML = `<div class="signinfo">${html}</div>`;
}

/* ---------------- hosted documents (end-to-end encrypted) ---------------- */
// The PDF is encrypted here with a random key that only travels after the # in the link,
// so the host stores a file it cannot read. Anyone with the link can open and sign it.
const u64 = a => btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const un64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const rnd = n => u64(crypto.getRandomValues(new Uint8Array(n)));
const newCloud = () => SIGN_HOST ? { id: rnd(16), k: rnd(32), w: rnd(24) } : null;
const cloudLink = c => `${SIGN_URL}&d=${c.id}#${c.k}`;
const cloudKey = k => crypto.subtle.importKey('raw', un64(k), 'AES-GCM', false, ['encrypt', 'decrypt']);
async function cloudPut(c, bytes) {
  if (!SIGN_HOST || !c) return false;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cloudKey(c.k), bytes));
    const body = new Uint8Array(12 + ct.length); body.set(iv); body.set(ct, 12);
    return (await fetch(`${SIGN_HOST}/d/${c.id}`, { method: 'PUT', headers: { 'X-Write': c.w }, body })).ok;
  } catch { return false; }
}
async function cloudGet(id, k) {
  const r = await fetch(`${SIGN_HOST}/d/${id}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status === 404 ? 'This document has expired or was removed.' : 'Could not download the document.');
  const b = new Uint8Array(await r.arrayBuffer());
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, await cloudKey(k), b.slice(12))); }
  catch { throw new Error('This link is incomplete – open it exactly as it appears in the email.'); }
}
const mailText = (to, how, from) => `Hi ${to},\n\n${how}\n\n${from}`;
const linkSteps = (link, title) => `Click this link to open "${title}" and sign it in your browser – nothing to install, no account needed:\n${link}\n\nFollow the yellow fields and click Finish.`;
const fileSteps = name => `1. Save the attached PDF ("${name}").
2. Open this link to sign it in your browser – nothing to install, no account needed:
   ${SIGN_URL}
3. Drop the PDF onto the page, click "Start signing", follow the yellow fields, and click Finish.`;

/* ---------------- preparing a request (sender) ---------------- */
function draft() {
  if (!SG.draft) {
    const me = senderProfile.get();
    SG.draft = { title: baseName(), from: { name: me.name || '', email: me.email || '' }, signers: [{ id: nid(), name: '', email: '', color: SIGNER_COLORS[0] }] };
    SG.active = SG.draft.signers[0].id;
  }
  return SG.draft;
}
function fieldAnnots() { const out = []; S.pages.forEach((p, pi) => p.annots.forEach(a => { if (a.type === 'field') out.push({ p, pi, a }); })); return out; }
function relabelFields() {
  const d = SG.draft; if (!d) return;
  for (const { p, a } of fieldAnnots()) {
    if (SG.mode === 'sign') continue;
    const s = d.signers.find(x => x.id === a.signer);
    if (!s) { p.annots = p.annots.filter(x => x !== a); continue; }
    a.color = s.color; a.label = `${FIELD_TYPES[a.ftype].icon} ${FIELD_TYPES[a.ftype].label}${s.name ? ' · ' + s.name : ''}`;
  }
  S.pages.forEach(p => renderAnnots(p));
}
function renderSignPane() {
  const box = $('#signPane'); if (!box) return;
  if (SG.req) return renderSignStatus(box);
  if (!S.pages.length) { box.innerHTML = '<p class="muted">Open the PDF you want people to sign.</p>'; return; }
  const d = draft(), counts = {};
  for (const { a } of fieldAnnots()) counts[a.signer] = (counts[a.signer] || 0) + 1;
  box.innerHTML = `
    <div class="sg-h">📨 Get signatures</div>
    <p class="muted small">Add the people who need to sign, put their fields on the page, then press Send. Free – no accounts needed for anyone.</p>
    <label class="sg-l">Document name<input id="sgTitle"></label>
    <div class="sg-sub">You (the sender)</div>
    <div class="row tight"><input id="sgFromName" placeholder="Your name"><input id="sgFromEmail" placeholder="Your email" type="email"></div>
    <div class="sg-sub">Signers <span class="muted small">(sign in this order)</span></div>
    <div id="sgSigners"></div>
    <button id="sgAdd" class="chip">＋ Add signer</button> <button id="sgMe" class="chip" title="Add yourself – you sign right here in the app, no email to yourself">＋ Add me</button>
    <div class="sg-sub">Fields for <select id="sgActive"></select></div>
    <div class="sg-fields">${Object.entries(FIELD_TYPES).map(([k, f]) => `<button data-f="${k}" class="${S.tool === 'field' && SG.ftype === k ? 'on' : ''}">${f.icon} ${f.label}</button>`).join('')}</div>
    <p class="muted small">Pick a field, then click on the page where it goes. Drag to move, corner to resize, Del to remove.</p>
    <button id="sgSend" class="pri sg-send">📧 Send for signing</button>`;
  $('#sgTitle').value = d.title; $('#sgFromName').value = d.from.name; $('#sgFromEmail').value = d.from.email;
  $('#sgTitle').oninput = e => d.title = e.target.value;
  $('#sgFromName').oninput = e => { d.from.name = e.target.value; senderProfile.set(d.from); };
  $('#sgFromEmail').oninput = e => { d.from.email = e.target.value.trim(); senderProfile.set(d.from); };
  const list = $('#sgSigners');
  d.signers.forEach((s, i) => {
    const row = el('div', 'sg-signer');
    row.innerHTML = `<span class="sg-dot" style="background:${s.color}">${i + 1}</span><input placeholder="Name"><input placeholder="Email" type="email"><span class="muted small">${counts[s.id] || 0} field${counts[s.id] === 1 ? '' : 's'}</span><button title="Remove">✕</button>`;
    const [nIn, eIn] = row.querySelectorAll('input'); nIn.value = s.name; eIn.value = s.email;
    nIn.oninput = () => { s.name = nIn.value; relabelFields(); fillActive(); };
    eIn.oninput = () => { s.email = eIn.value.trim(); };
    row.querySelector('button').onclick = () => {
      if (d.signers.length === 1) return toast('At least one signer is needed.');
      if (counts[s.id] && !confirm(`Remove ${s.name || 'this signer'} and their ${counts[s.id]} field(s)?`)) return;
      d.signers = d.signers.filter(x => x !== s); if (SG.active === s.id) SG.active = d.signers[0].id;
      relabelFields(); renderSignPane();
    };
    list.append(row);
  });
  const fillActive = () => {
    const sel = $('#sgActive'); sel.innerHTML = '';
    d.signers.forEach((s, i) => { const o = el('option'); o.value = s.id; o.textContent = `${i + 1}. ${s.name || 'Signer ' + (i + 1)}`; sel.append(o); });
    sel.value = SG.active;
  };
  fillActive();
  $('#sgActive').onchange = e => { SG.active = e.target.value; };
  $('#sgAdd').onclick = () => { const s = { id: nid(), name: '', email: '', color: SIGNER_COLORS[d.signers.length % SIGNER_COLORS.length] }; d.signers.push(s); SG.active = s.id; renderSignPane(); $$('#sgSigners input')[d.signers.length * 2 - 2]?.focus(); };
  $('#sgMe').onclick = () => {
    const me = d.from.email && d.signers.find(s => s.email.toLowerCase() === d.from.email.toLowerCase());
    if (me) { SG.active = me.id; return renderSignPane(); }
    const blank = d.signers.find(s => !s.name && !s.email);
    const s = blank || { id: nid(), color: SIGNER_COLORS[d.signers.length % SIGNER_COLORS.length] };
    s.name = d.from.name; s.email = d.from.email;
    if (!blank) d.signers.push(s);
    SG.active = s.id; relabelFields(); renderSignPane();
    if (!d.from.name || !d.from.email) toast('Fill in your name and email above first.');
  };
  $$('.sg-fields button').forEach(b => b.onclick = () => { SG.ftype = b.dataset.f; setTool('field'); renderSignPane(); });
  $('#sgSend').onclick = sendForSigning;
}
// place a field (called by the page click handler while the "field" tool is active)
function placeField(p, s) {
  const d = draft(), f = FIELD_TYPES[SG.ftype || 'signature'], signer = d.signers.find(x => x.id === SG.active) || d.signers[0];
  const a = { id: nid(), type: 'field', ftype: SG.ftype || 'signature', signer: signer.id, x: s.x - f.w / 2, y: s.y - f.h / 2, w: f.w, h: f.h, color: signer.color };
  a.label = `${f.icon} ${f.label}${signer.name ? ' · ' + signer.name : ''}`;
  addAnnot(p, a, true); renderSignPane();
}
async function sendForSigning() {
  const d = draft();
  if (!d.from.name || !/\S+@\S+\.\S+/.test(d.from.email)) return toast('Please enter your name and email (signers send the signed copy back to it).', 5000);
  const bad = d.signers.find(s => !s.name.trim() || !/\S+@\S+\.\S+/.test(s.email));
  if (bad) return toast('Every signer needs a name and a valid email.', 5000);
  const fields = fieldAnnots();
  const none = d.signers.filter(s => !fields.some(f => f.a.signer === s.id));
  if (none.length && !confirm(`${none.map(s => s.name).join(', ')} ha${none.length > 1 ? 've' : 's'} no fields to sign. Send anyway?`)) return;
  commitEditing();
  const req = {
    v: 1, id: crypto.randomUUID ? crypto.randomUUID() : nid(), title: (d.title || baseName()).trim(), created: new Date().toISOString(),
    from: { ...d.from }, signers: d.signers.map(s => ({ id: s.id, name: s.name.trim(), email: s.email, color: s.color })),
    fields: fields.map(({ pi, a }) => ({ id: a.id, signer: a.signer, page: pi, type: a.ftype, x: +a.x.toFixed(2), y: +a.y.toFixed(2), w: +a.w.toFixed(2), h: +a.h.toFixed(2) })),
    steps: [], cloud: newCloud(),
  };
  toast('Preparing the document…');
  const bytes = await buildSignedPdf(req), name = `${req.title} - please sign.pdf`;
  const first = req.signers[0];
  if (isSender(req, first)) {
    // the sender signs first: do it right here instead of emailing themselves
    S.dirty = false;
    await openFiles([new File([bytes], name, { type: 'application/pdf' })], { replace: true });
    for (let i = 0; i < 50 && !SG.req; i++) await new Promise(r => setTimeout(r, 100)); // the request is read just after the file opens
    if (SG.req && nextSigner(SG.req)?.id === first.id) { startSigning(); toast('Your turn – fill in your fields, then press Finish.', 5000); }
    return;
  }
  const hosted = await cloudPut(req.cloud, bytes);
  if (!hosted) { if (req.cloud) toast('Could not upload – sending the PDF as an attachment instead.', 5000); if (!(await saveAny(bytes, name))) return; }
  const how = await sendMail({ to: first.email, subject: `Please sign: ${req.title}`, name, bytes: hosted ? null : bytes,
    body: mailText(first.name, `${req.from.name} has sent you "${req.title}" to sign.\n\n` + (hosted ? linkSteps(cloudLink(req.cloud), req.title)
      : fileSteps(name) + '\n\nWhen you finish, your email opens with the signed copy ready to send back.'), `Thank you,\n${req.from.name}`) });
  mailDone(how, name);
  S.dirty = false; updateTitle();
}

/* ---------------- opening a request (sender or signer) ---------------- */
async function signOnOpen() {
  SG.req = null; SG.mode = null; SG.draft = null;
  const p0 = S.pages[0], src = p0 && S.sources[p0.src];
  if (src) {
    const r = await readSignInfo(src.bytes);
    if (r) {
      SG.req = r.req; SG.ok = r.ok; SG.received = await sha256(src.bytes);
      if (r.req.certPages) { S.pages.splice(S.pages.length - r.req.certPages, r.req.certPages); refreshAll(); } // rebuilt when signing
      if (!(innerWidth <= 760)) showSideTab('sign'); // phones: the bottom bar is enough
    }
  }
  renderSignBar(); renderSignPane();
}
function renderSignStatus(box) {
  const r = SG.req, next = nextSigner(r);
  box.innerHTML = `<div class="sg-h">✍ ${escHtml(r.title)}</div>
    <p class="small">From <b>${escHtml(r.from.name)}</b> &lt;${escHtml(r.from.email)}&gt; · ${fmtWhen(r.created)}</p>
    <div class="sg-steps">${r.signers.map((s, i) => { const st = r.steps.find(x => x.signer === s.id);
      return `<div class="sg-step ${st ? 'done' : s === next ? 'now' : ''}"><span class="sg-dot" style="background:${s.color}">${st ? '✔' : i + 1}</span><div><b>${escHtml(s.name)}</b><br><span class="muted small">${st ? 'Signed ' + fmtWhen(st.at) : s === next ? 'Waiting to sign' : 'Not yet'}</span></div></div>`; }).join('')}</div>
    <p class="${SG.ok === false ? 'sg-bad' : 'sg-good'} small">${SG.ok === false ? '⚠ This file was changed after the last signature.' : SG.ok ? '✔ Not changed since the last signature.' : ''}</p>`;
}
function renderSignBar() {
  let bar = $('#signBar');
  const r = SG.req;
  if (!r) { bar?.remove(); return; }
  if (!bar) { bar = el('div'); bar.id = 'signBar'; $('#props').after(bar); }
  const next = nextSigner(r), done = r.steps.length, n = r.signers.length;
  const integrity = SG.ok === false ? '<span class="sg-bad">⚠ changed after signing</span>' : SG.ok ? '<span class="sg-good">✔ unchanged since signed</span>' : '';
  if (SG.mode === 'sign') {
    const left = myFields().length, total = r.fields.filter(f => f.signer === SG.me && !f.done).length;
    bar.className = 'signing';
    bar.innerHTML = `<b>✍ Signing as ${escHtml(signerOf(r, SG.me).name)}</b><span>${total - left} of ${total} fields done</span><span class="sp"></span>
      <button id="sbPrev">◀ Back</button><button id="sbNext" class="pri">${left ? 'Next field ▶' : '✔ Finish'}</button><button id="sbCancel" title="Stop without signing">Cancel</button>`;
    $('#sbPrev').onclick = () => gotoField(-1);
    $('#sbNext').onclick = () => left ? gotoField(1) : finishSigning();
    $('#sbCancel').onclick = cancelSigning;
    return;
  }
  bar.className = next ? 'pending' : 'complete';
  if (!next) {
    bar.innerHTML = `<b>✔ Completed</b><span>“${escHtml(r.title)}” – signed by ${r.steps.map(s => escHtml(s.name)).join(', ')}</span>${integrity}<span class="sp"></span><button id="sbCert">📜 View certificate</button>`;
    $('#sbCert').onclick = () => setCurrent(S.pages.length - 1, true);
    return;
  }
  bar.innerHTML = `<b>📝 Signature request</b><span>“${escHtml(r.title)}” from ${escHtml(r.from.name)} · ${done} of ${n} signed · next: <b>${escHtml(next.name)}</b></span>${integrity}<span class="sp"></span>
    <button id="sbStart" class="pri">${isMe(next) ? '✍ Sign now (it\'s your turn)' : `✍ I'm ${escHtml(next.name)} – start signing`}</button>${done && !isMe(next) ?`<button id="sbMail" title="Send this copy to ${escHtml(next.name)}">📧 Email to ${escHtml(next.name)}</button>` : ''}`;
  $('#sbStart').onclick = startSigning;
  $('#sbMail') && ($('#sbMail').onclick = () => forwardTo(next));
}

/* ---------------- signing ---------------- */
function myFields() { const out = []; S.pages.forEach(p => p.annots.forEach(a => { if (a.type === 'field' && a.signer === SG.me) out.push({ p, a }); })); return out; }
function startSigning() {
  const r = SG.req, me = nextSigner(r); if (!me) return;
  SG.mode = 'sign'; SG.me = me.id; SG.method = '';
  if (innerWidth <= 760) setSide(false); // phones: room for the document
  for (const f of r.fields) {
    if (f.signer !== me.id || f.done) continue;
    const p = S.pages[f.page]; if (!p) continue;
    p.annots.push({ id: 'f_' + f.id, fid: f.id, type: 'field', ftype: f.type, signer: me.id, x: f.x, y: f.y, w: f.w, h: f.h, color: '#eab308', label: `${FIELD_TYPES[f.type].icon} ${f.type === 'check' ? '' : FIELD_TYPES[f.type].label}`, mine: true });
  }
  S.pages.forEach(p => renderAnnots(p)); setTool('select');
  renderSignBar(); gotoField(1);
  if (!myFields().length) toast('There is nothing for you to fill in – press Finish to sign.', 5000);
}
let fieldCursor = -1;
function gotoField(dir) {
  const list = myFields(); if (!list.length) return renderSignBar();
  fieldCursor = (fieldCursor + dir + list.length) % list.length;
  if (dir > 0 && fieldCursor >= list.length) fieldCursor = 0;
  const { p, a } = list[Math.max(0, fieldCursor)];
  const w = pageEl(p); if (!w) return;
  setCurrent(S.pages.indexOf(p));
  $('#view').scrollTo({ top: w.offsetTop + a.y * S.zoom - $('#view').clientHeight / 3, behavior: 'smooth' });
  $$('.an.field.pulse').forEach(e => e.classList.remove('pulse'));
  setTimeout(() => document.querySelector(`.an[data-id="${a.id}"]`)?.classList.add('pulse'), 300);
}
// fill a field the signer clicked
async function fillField(p, a) {
  const me = signerOf(SG.req, SG.me), box = { x: a.x, y: a.y, w: a.w, h: a.h };
  const putText = text => {
    if (!text) return;
    const size = Math.max(6, Math.min(box.h * 0.72, 13));
    snap(); p.annots = p.annots.filter(x => x !== a);
    p.annots.push({ id: nid(), type: 'text', fid: a.fid, x: box.x + 2, y: box.y + (box.h - size * 1.2) / 2, text, size, font: 'Helvetica', bold: false, color: '#111827' });
    afterFill(p);
  };
  if (a.ftype === 'date') return putText(new Date().toLocaleDateString());
  if (a.ftype === 'name') return putText(prompt('Your full name:', me.name));
  if (a.ftype === 'text') return putText(prompt('Please type the text for this field:', ''));
  if (a.ftype === 'check') {
    snap(); p.annots = p.annots.filter(x => x !== a);
    p.annots.push({ id: nid(), type: 'ink', fid: a.fid, x: box.x, y: box.y, w: box.w, h: box.h, strokes: INK.check, color: '#111827', lw: 2 });
    return afterFill(p);
  }
  // signature / initials: the normal signature dialog, then fit the result into the field
  window.onSignatureChosen = async (url, method) => {
    SG.method = SG.method || method;
    const img = await loadImg(url), k = Math.min(box.w / img.naturalWidth, box.h / img.naturalHeight);
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    snap(); p.annots = p.annots.filter(x => x !== a);
    p.annots.push({ id: nid(), type: 'image', fid: a.fid, img: registerImage(url), x: box.x, y: box.y + (box.h - h) / 2, w, h });
    afterFill(p);
  };
  openSig();
  if (a.ftype === 'initials' && !$('#sigText').value) { $('#sigText').value = me.name.split(/\s+/).map(w => w[0] || '').join('').toUpperCase(); }
  else if (!$('#sigText').value) $('#sigText').value = me.name;
  renderSigFonts();
}
function afterFill(p) {
  renderAnnots(p); renderSignBar();
  const left = myFields().length;
  if (left) { fieldCursor = -1; gotoField(1); } else toast('All fields done – press ✔ Finish to sign.', 4000);
}
function cancelSigning() {
  if (!confirm('Stop signing? Your entries so far will be removed.')) return;
  SG.mode = null;
  S.pages.forEach(p => { p.annots = p.annots.filter(a => !(a.type === 'field' && a.mine) && !(a.fid && SG.req.fields.some(f => f.id === a.fid && f.signer === SG.me))); renderAnnots(p); });
  renderSignBar();
}
function finishSigning() {
  if (myFields().length) { fieldCursor = -1; gotoField(1); return toast('Please fill in the highlighted field first.'); }
  const me = signerOf(SG.req, SG.me);
  infoBox('✍ Sign and finish', `
    <p>You are signing <b>“${escHtml(SG.req.title)}”</b> as <b>${escHtml(me.name)}</b> (${escHtml(me.email)}).</p>
    <label class="sg-consent"><input type="checkbox" id="sgAgree"> ${escHtml(CONSENT)}</label>`);
  $('#tRun').hidden = false; $('#tRun').textContent = '✔ Sign & finish'; $('#tRun').disabled = true;
  $('#sgAgree').onchange = e => { $('#tRun').disabled = !e.target.checked; };
  $('#tRun').onclick = async () => { $('#tRun').textContent = '▶ Run'; $('#tmodal').hidden = true; await completeSigning(); };
}
async function completeSigning() {
  const r = SG.req, me = signerOf(r, SG.me);
  r.steps.push({ signer: me.id, name: me.name, email: me.email, at: new Date().toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    method: SG.method || 'type', consent: true, received: SG.received, agent: navigator.userAgent.slice(0, 160) });
  r.fields.forEach(f => { if (f.signer === me.id) f.done = true; });
  // the field placeholders are not part of the document; only the filled-in content is
  S.pages.forEach(p => { p.annots = p.annots.filter(a => a.type !== 'field'); });
  SG.mode = null;
  toast('Signing…');
  const bytes = await buildSignedPdf(r), next = nextSigner(r);
  const name = `${r.title} - signed by ${me.name}.pdf`;
  const hosted = await cloudPut(r.cloud, bytes), link = hosted && cloudLink(r.cloud);
  if (r.cloud && !hosted) toast('Could not upload – the signed PDF will be attached instead.', 5000);
  // hosted: the next signer gets the link, so a local copy is only saved once everyone has signed
  if ((!hosted || !next) && !(await saveAny(bytes, name)) && !hosted) { toast('Not saved – you can press Finish again.'); r.steps.pop(); return; }
  S.dirty = false; updateTitle(); SG.received = await sha256(bytes); SG.ok = true;
  if (!next && isSender(r, me)) { renderSignBar(); renderSignPane(); return toast('✔ Signed & saved – everyone has signed.', 5000); }
  if (next && isMe(next) && isSender(r, next)) { renderSignBar(); renderSignPane(); return toast('Saved – it\'s your turn next: press "Sign now".', 5000); }
  const how = next
    ? await sendMail({ to: next.email, cc: r.from.email, subject: `Please sign: ${r.title}`, name, bytes: hosted ? null : bytes,
        body: mailText(next.name, `${me.name} has signed "${r.title}" and it's your turn.\n\n` + (hosted ? linkSteps(link, r.title) : fileSteps(name)), `Thank you,\n${me.name} (on behalf of ${r.from.name})`) })
    : await sendMail({ to: r.from.email, cc: r.signers.filter(s => s.id !== me.id).map(s => s.email).join(','), subject: `Completed: ${r.title}`, name, bytes: hosted ? null : bytes,
        body: mailText(r.from.name, `"${r.title}" has now been signed by everyone (${r.steps.map(s => s.name).join(', ')}).\n` + (hosted
          ? `Download the completed PDF (with its certificate page) here – the link works for 30 days:\n${link}\n\nOpen it and press Save.`
          : 'The completed PDF is attached – it includes a certificate page with the signing details.'), me.name) });
  renderSignBar(); renderSignPane();
  mailDone(how, name);
}
async function forwardTo(next) {
  const r = SG.req, bytes = S.sources[S.pages[0].src].bytes, name = `${r.title} - please sign.pdf`;
  const hosted = await cloudPut(r.cloud, bytes);
  if (!hosted && !(await saveAny(bytes, name))) return;
  mailDone(await sendMail({ to: next.email, subject: `Please sign: ${r.title}`, name, bytes: hosted ? null : bytes,
    body: mailText(next.name, `Please sign "${r.title}".\n\n` + (hosted ? linkSteps(cloudLink(r.cloud), r.title) : fileSteps(name)), `Thank you,\n${r.from.name}`) }), name);
}

/* ---------------- wiring ---------------- */
$('#bRequest').onclick = () => { if (!S.pages.length) return toast('Open the PDF you want signed first.'); showSideTab('sign'); renderSignPane(); };
// signers arriving from the email link see a simple "open the document" page
if (/[?&]sign\b/.test(location.search)) {
  const h = $('#empty h1'); if (h) h.textContent = 'Sign a document';
  const p = $('#empty .drop p'); if (p) p.innerHTML = '<b>Drop the PDF you were asked to sign here</b><br><span class="muted">(the file attached to the email)</span>';
  $('#eOpen').textContent = 'Choose the PDF…';
  // opened from a signing link: download and open the document straight away
  const id = new URLSearchParams(location.search).get('d'), k = location.hash.slice(1);
  if (id && SIGN_HOST) {
    if (p) p.innerHTML = '<b>Opening your document…</b>';
    cloudGet(id, k).then(b => openFiles([new File([b], 'Document to sign.pdf', { type: 'application/pdf' })]))
      .catch(e => { if (p) p.innerHTML = `<b>${escHtml(e.message)}</b><br><span class="muted">If the PDF was attached to the email, you can drop it here instead.</span>`; });
  }
}
