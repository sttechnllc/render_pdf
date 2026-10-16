'use strict';
/* Mark's Render PDF Editor – 🗂 Smart organize: classify, extract, rename, file into folders, find duplicates, check signatures,
   link amendments to their parent, export an index, make a binder, and keep a shared data-room folder organized in place.
   Deterministic rules only – no AI, no network. The pure part (top half) also runs in Node for tests. */

/* ================= pure logic (strings in, data out) ================= */
const ORG_TYPES = [ // [type, title regex (tested on the title lines, at their start), title bonus, [[body regex, weight]…]]
  ['Invoice', /^(tax |commercial |proforma )?invoice\b/, 18, [[/\binvoice\b/, 3], [/invoice (no|number|#|date)/, 4], [/bill(ed)? to/, 3], [/amount due|balance due/, 3], [/payment terms|net \d+\b|due date/, 2], [/subtotal/, 2], [/\b(qty|quantity|unit price)\b/, 1]]],
  ['Receipt', /^(payment |sales |cash )?receipt\b/, 18, [[/\breceipt\b/, 4], [/payment received|thank you for your (purchase|payment)|\bpaid\b/, 2], [/change due|card ending|visa|mastercard|\bcash\b/, 2], [/transaction/, 1]]],
  ['Quote', /^(quot(e|ation)|estimate|price proposal)\b/, 18, [[/\bquot(e|ation)\b/, 4], [/\bestimate\b/, 4], [/valid (until|for)|this quote expires/, 3], [/proposed price/, 1]]],
  ['Purchase Order', /^purchase order\b/, 20, [[/purchase order/, 5], [/\bp\.?o\.? ?(no|number|#)/, 4], [/ship to/, 2], [/\bvendor\b/, 2], [/delivery date/, 1]]],
  ['Contract', /\b(agreement|contract)\b/, 10, [[/\bagreement\b/, 2], [/\bpart(y|ies)\b/, 2], [/hereby agree|agree as follows|in consideration of/, 3], [/governing law/, 2], [/terminat(e|ion)/, 1], [/indemnif/, 2], [/warrant(y|ies)/, 1], [/in witness whereof/, 3], [/\bwhereas\b/, 2]]],
  ['NDA', /^(mutual |unilateral |one-way )?(non-?disclosure|confidentiality)( and non-?use)?( agreement)?\b|^nda\b/, 20, [[/non-?disclosure/, 6], [/confidential information/, 5], [/disclosing party|receiving party/, 5], [/\bnda\b/, 4], [/trade secret/, 2]]],
  ['Lease', /^(\w+ )?(lease|rental agreement|tenancy agreement)\b/, 20, [[/\blease\b/, 4], [/landlord|lessor/, 4], [/tenant|lessee/, 4], [/premises/, 3], [/security deposit|monthly rent|\brent\b/, 3]]],
  ['Amendment', /^(first |second |third |fourth |fifth |\w+ )?(amendment|addendum)\b|^amendment no/, 28, [[/\bamendment\b/, 4], [/hereby amended|is amended|amended and restated|shall be amended/, 5], [/\baddendum\b/, 4], [/remain(s)? in full force and effect/, 4]]],
  ['Board Consent', /(written|unanimous) consent|action by (unanimous )?(written )?consent/, 20, [[/written consent/, 6], [/board of directors/, 3], [/shareholders|stockholders/, 3], [/in lieu of a meeting|without a meeting/, 5], [/the undersigned/, 2]]],
  ['Resolution', /^(board |corporate )?resolutions?\b/, 18, [[/\bresolved\b/, 5], [/\bresolution\b/, 4], [/be it (further )?resolved/, 5], [/board of directors/, 2]]],
  ['Minutes', /\bminutes\b/, 20, [[/minutes of/, 6], [/called to order/, 5], [/\bpresent:|in attendance|\bquorum\b/, 4], [/\badjourned\b/, 4], [/\bmotion\b|\bseconded\b/, 3]]],
  ['Letter', null, 0, [[/^dear\b/m, 7], [/\b(sincerely|best regards|kind regards|yours (truly|faithfully|sincerely))\b/, 7], [/^re:/m, 2], [/\benclos(ed|ure)\b/, 1]]],
  ['Memo', /^(memo|memorandum)\b/, 20, [[/\bmemorandum\b/, 4], [/^to:/m, 3], [/^from:/m, 3], [/^(subject|re):/m, 3], [/^cc:/m, 1]]],
  ['Resume', /^(resume|résumé|curriculum vitae|cv)\b/, 20, [[/\bexperience\b/, 3], [/\beducation\b/, 3], [/\bskills\b/, 3], [/references available/, 3], [/linkedin/, 2], [/\b(bachelor|master|b\.s\.|m\.b\.a|ph\.d)/, 2]]],
  ['Bank Statement', /(bank |account |checking |savings )statement/, 20, [[/statement (period|date)/, 5], [/(opening|beginning) balance/, 5], [/(closing|ending) balance/, 5], [/\bdeposits\b|\bwithdrawals\b/, 3], [/account (number|no)/, 2], [/\brouting\b/, 2]]],
  ['Tax Form', /^(form )?(w-?9|w-?2|1099|1040|w-?4)\b/, 22, [[/\bw-?9\b/, 6], [/\b1099(-[a-z]+)?\b/, 6], [/\bw-?2\b/, 6], [/internal revenue service|\birs\b/, 4], [/taxpayer identification|employer identification/, 4], [/wages, tips/, 4], [/federal income tax withheld/, 4]]],
  ['Pay Stub', /^(pay ?(stub|slip)|earnings statement|payroll)\b/, 20, [[/gross pay/, 5], [/net pay/, 5], [/pay period/, 4], [/\bytd\b|year to date/, 3], [/deductions/, 3], [/\bfica\b|social security|medicare/, 3]]],
  ['Insurance', /insurance|^certificate of (liability )?insurance|^policy\b/, 16, [[/policy (number|no|holder|period)/, 5], [/\binsured\b/, 4], [/\bpremium\b/, 4], [/\bcoverage\b/, 3], [/\bdeductible\b/, 3], [/\binsurer\b|underwrit/, 2]]],
  ['Report', /\breport\b/, 14, [[/executive summary/, 4], [/\breport\b/, 2], [/\bfindings\b|\bconclusions?\b|\brecommendations\b/, 3], [/methodology|\banalysis\b/, 2], [/table of contents/, 2]]],
  ['Form', /\b(form|application)\b/, 10, [[/please (print|complete|fill)/, 4], [/check (one|all that apply)/, 4], [/signature of applicant/, 3], [/\bapplicant\b/, 2], [/[☐□]/, 2]]],
].map(([type, title, tb, rules]) => ({ type, title, tb, rules: rules.map(([re, w]) => [new RegExp(re.source, 'g' + re.flags), w]) }));
const orgFolderOf = t => ({ Minutes: 1, Insurance: 1, Other: 1 })[t] ? t : t + 's'; // Invoice → Invoices …

function classifyText(text, titles = []) {
  const body = text.slice(0, 15000).toLowerCase(), tt = titles.join('\n').toLowerCase();
  const sc = ORG_TYPES.map(T => {
    let s = T.title && titles.some(x => T.title.test(x.toLowerCase().trim())) ? T.tb : 0;
    for (const [re, w] of T.rules) {
      const c = (body.match(re) || []).length; if (c) s += w * (1 + 0.5 * (Math.min(c, 3) - 1));
      if (tt && re.test(tt)) s += w * 2; // title lines count extra
      re.lastIndex = 0;
    }
    return { type: T.type, s: Math.round(s * 10) / 10 };
  }).sort((a, b) => b.s - a.s);
  const [a, b] = sc, m = a.s ? (a.s - b.s) / a.s : 0;
  if (a.s < 6) return { type: 'Other', conf: 'Low', scores: sc.slice(0, 3) };
  return { type: a.type, conf: m >= 0.4 && a.s >= 12 ? 'High' : m >= 0.2 ? 'Medium' : 'Low', scores: sc.slice(0, 3) };
}

/* ---- dates: one table row per format; the letters say what each group holds ---- */
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?', YR = '(\\d{4})';
const DATE_FMT = [ // d = day, m = month name, n = month number, y = year, a = day or month (US unless > 12); 3rd item = score penalty
  [`\\b${DAY}\\s+day\\s+of\\s+${MON},?\\s+${YR}`, 'dmy'],
  [`\\b${MON}\\s+${DAY},?\\s+${YR}`, 'mdy'],
  [`\\b${DAY}\\s+(?:of\\s+)?${MON},?\\s+${YR}`, 'dmy'],
  ['\\b(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})\\b', 'ynd'],
  ['\\b(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4}|\\d{2})\\b', 'aay'],
  [`\\b${MON}\\s+${YR}\\b`, 'my', -2],
].map(([src, ord, pen = 0]) => ({ re: new RegExp(src, 'gi'), ord, pen }));
const monNum = s => 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(s.slice(0, 3).toLowerCase()) / 3 + 1;
function dateParts(m, ord) {
  const v = { d: 1, a: [] };
  [...ord].forEach((k, i) => { const s = m[i + 1]; if (k === 'a') v.a.push(+s); else v[k === 'm' ? 'n' : k] = k === 'm' ? monNum(s) : +s; });
  if (v.a.length) [v.n, v.d] = v.a[0] > 12 ? [v.a[1], v.a[0]] : v.a;
  if (v.y < 100) v.y += v.y < 70 ? 2000 : 1900;
  return [v.y, v.n, v.d];
}
function findDates(text) {
  const out = [], used = [];
  for (const { re, ord, pen } of DATE_FMT) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(text))) {
      const i = m.index, j = i + m[0].length;
      if (used.some(([a, b]) => i < b && j > a)) continue;
      const [y, mo, d] = dateParts(m, ord), dt = new Date(Date.UTC(y, mo - 1, d));
      if (!(y >= 1950 && y <= 2100 && mo >= 1 && mo <= 12 && dt.getUTCDate() === d)) continue;
      used.push([i, j]); out.push({ i, raw: m[0], iso: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, pen });
    }
  }
  return out.sort((a, b) => a.i - b.i);
}
const parseDate = s => (findDates(s)[0] || {}).iso || '';
function extractDate(text) {
  let best = null;
  for (const d of findDates(text.slice(0, 20000))) {
    const ctx = text.slice(Math.max(0, d.i - 45), d.i).toLowerCase(), near = ctx.slice(-25);
    let s = 1 + d.pen + 2 * (1 - d.i / Math.max(1, text.length));
    if (/(dated|effective|as of|date\s*:|date of issue|issue date|invoice date|statement date|made (and entered into )?on|entered into on|this|signed on)[^a-z]{0,6}$/.test(ctx) || /date[d]?\s*:?\s*$/.test(near)) s += 5;
    if (/(agreement|contract|lease|nda)[^a-z]{0,4}dated[^a-z]{0,4}$/.test(ctx)) s -= 4; // "…to the Agreement dated X" is the parent's date
    if (/(due|expir|birth|dob|terminat|until|through|thru|ending|end date|valid)[^\n]{0,12}$/.test(near)) s -= 4;
    if (!best || s > best.s) best = { ...d, s };
  }
  return best ? best.iso : '';
}

/* ---- parties, amounts, numbers, emails ---- */
const CO_SUFFIX = '(?:Inc|LLC|L\\.L\\.C|Ltd|Limited|Corp|Corporation|Company|Co|LLP|LP|PLC|GmbH|AG|S\\.A|SAS|BV|N\\.V|Pty|PC)\\.?';
const CO_RE = new RegExp(`\\b((?:[A-Z][A-Za-z0-9&'’.-]*|&|of)(?:\\s+(?:[A-Z][A-Za-z0-9&'’.-]*|&|of)){0,5},?\\s+${CO_SUFFIX})(?![A-Za-z])`, 'g');
const CO_LEAD = /^(?:(?:This|The|Between|And|By|To|From|Dear|Bill|Billed|Ship|Sold|Re|Agreement|Amendment|Invoice|Customer|Vendor|Client)\s+)+/i;
const cleanParty = s => s.replace(CO_LEAD, '').replace(/[\s,;:]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
const companies = s => [...new Set([...s.matchAll(CO_RE)].map(m => cleanParty(m[1])).filter(c => c.split(' ').length > 1))];
function extractParties(text, lines = []) {
  const out = [], add = s => { s = s && cleanParty(s.replace(/\(.*$/, '')); if (s && s.length > 1 && /[A-Za-z]/.test(s) && !out.some(o => o.toLowerCase() === s.toLowerCase())) out.push(s); };
  const bi = text.slice(0, 4000).search(/\b(?:by and )?between\b/i);
  if (bi >= 0) {
    const win = text.slice(bi, bi + 600).replace(/^(by and )?between\s*/i, ''), cs = companies(win);
    if (cs.length >= 2) cs.slice(0, 2).forEach(add);
    else { const m = win.match(/^(.{2,80}?)\s*(?:\(|,)[\s\S]{0,250}?\band\s+(.{2,80}?)\s*(?:\(|,|\.\s|;|$)/); if (m) { add(m[1]); add(m[2]); } else cs.forEach(add); }
  }
  const L = lines.length ? lines.map(l => l.text) : text.split('\n');
  companies(L.slice(0, 10).join('\n')).slice(0, 1).forEach(add); // letterhead / issuer
  L.forEach((t, i) => {
    let m = t.match(/^(?:bill(?:ed)? to|sold to|customer|client)\b\s*:?\s*(.*)$/i); if (m) add(m[1] || L[i + 1]);
    m = t.match(/^(?:from|to)\s*:\s*(.+)$/i); if (m && !/@/.test(m[1])) add(m[1]);
    m = t.match(/^dear\s+(.+?)[,:]?$/i); if (m) add(m[1]);
  });
  if (!out.length) companies(text.slice(0, 5000)).slice(0, 2).forEach(add);
  return out.slice(0, 4);
}
const AMT_LABELS = ['amount due', 'balance due', 'total due', 'grand total', 'invoice total', 'total amount', 'amount paid', 'total'];
const AMT_LABELED = new RegExp(`(${AMT_LABELS.join('|')})\\b[^\\n\\d$€£¥]{0,25}([$€£¥]|USD|EUR|GBP|CAD|AUD)?\\s?(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?|\\d+\\.\\d{2})`, 'gi');
const AMT_ANY = /([$€£¥]|USD|EUR|GBP)\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;
function extractAmount(text) {
  let best = null;
  for (const m of text.matchAll(AMT_LABELED)) { // best-ranked label wins; the last one of that rank
    const rank = AMT_LABELS.indexOf(m[1].toLowerCase());
    if (!/sub\s*$/i.test(text.slice(Math.max(0, m.index - 4), m.index)) && (!best || rank <= best.rank)) best = { rank, cur: m[2] || '', v: m[3] };
  }
  if (!best) for (const m of text.matchAll(AMT_ANY)) { const n = +m[2].replace(/,/g, ''); if (!best || n > best.n) best = { cur: m[1], v: m[2], n }; }
  if (!best) return '';
  const cur = { USD: '$', EUR: '€', GBP: '£' }[best.cur] || best.cur || '';
  return (/^[A-Z]/.test(cur) ? cur + ' ' : cur) + (+best.v.replace(/,/g, '')).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function extractNumber(text) {
  const m = text.slice(0, 6000).match(/\b(?:invoice|inv|receipt|quote|quotation|estimate|order|p\.?o\.?|purchase order|reference|ref|policy|contract|statement)\s*(?:no\.?|number|num|#|id)\s*[:.#]?\s*([A-Z0-9][A-Z0-9\-\/.]*\d[A-Z0-9\-\/]*)/i)
    || text.slice(0, 3000).match(/(?:^|\s)(?:no\.|#)\s*:?\s*([A-Z]{0,5}-?\d{3,}[A-Z0-9-]*)/);
  return m ? m[1].replace(/[.\-\/]+$/, '') : '';
}
const extractEmails = text => [...new Set((text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map(e => e.toLowerCase()))].slice(0, 5);

/* ---- titles and relationships ---- */
const orgPageText = p => p.lines.map(l => l.text).join('\n');
function titleLines(pages) {
  const p = pages[0]; if (!p || !p.lines.length) return [];
  const sizes = pages.flatMap(q => q.lines.map(l => l.size)).sort((a, b) => a - b), body = sizes[Math.floor(sizes.length / 2)] || 11;
  const top = p.lines.filter(l => !p.h || l.base < p.h * 0.45);
  const big = top.filter(l => l.size >= body * 1.18 && l.text.length > 2 && l.text.length < 140).sort((a, b) => b.size - a.size || a.base - b.base);
  return (big.length ? big : top.slice(0, 2)).slice(0, 4).map(l => l.text);
}
const CHILD_RE = /^(?:(?:first|second|third|fourth|fifth|\w+)\s+)?(amendment|addendum|exhibit|schedule|annex|appendix|supplement|rider)\b/i;
const STOP = new Set('the a an of to and this that certain no nr number dated by between for in on its as'.split(' '));
const normTitle = s => (s || '').toLowerCase().replace(/non[-\s]?disclosure/g, 'nondisclosure').replace(/\bnda\b/g, 'nondisclosure agreement')
  .replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w && !STOP.has(w) && !/^\d+$/.test(w));
function parentRef(title, text) {
  const m = (title + '\n' + text.slice(0, 1200)).replace(/\s+/g, ' ')
    .match(/\b(?:amendment|addendum|exhibit|schedule|annex|appendix|supplement|rider)\b.{0,40}?\b(?:to|of)\s+(?:the\s+|that\s+certain\s+)?(.{3,120}?(?:agreement|contract|lease|plan|nda|terms))(?:\s+dated\s+(.{6,30}?\d{4}))?/i);
  return m ? { title: m[1], date: m[2] ? parseDate(m[2]) : '' } : null;
}
function analyzeText(pages) { // pages: the pages that were read (first two first); classification and extraction use pages 1–2
  const first = pages.slice(0, 2).map(orgPageText).join('\n'), titles = titleLines(pages), title = titles[0] || '', cls = classifyText(first, titles);
  const isChild = CHILD_RE.test(title.trim()) || cls.type === 'Amendment', text = pages.map(orgPageText).join('\n\f\n');
  return { ...cls, title, titles, date: extractDate(first), parties: extractParties(first, pages[0] ? pages[0].lines : []), amount: extractAmount(first),
    number: extractNumber(first), emails: extractEmails(first), isChild, ref: isChild ? parentRef(title, first) : null, shingles: shingles(text), words: text.length };
}
function linkRelations(items) { // sets item.parent = index of the parent document
  items.forEach((r, i) => {
    r.parent = -1; const want = r.isChild && r.ref ? normTitle(r.ref.title) : []; if (!want.length) return;
    let best = null;
    items.forEach((c, j) => {
      if (j === i || c.isChild || (c.dupOf != null && c.dupOf !== j)) return;
      const have = new Set(normTitle(c.title).concat(c.type === 'NDA' ? ['nondisclosure', 'agreement'] : []));
      const s = want.filter(w => have.has(w)).length / want.length + (r.ref.date && r.ref.date === c.date ? 0.3 : 0)
        + ((r.parties || []).some(p => (c.parties || []).some(q => q.toLowerCase() === p.toLowerCase())) ? 0.15 : 0);
      if (s >= 0.6 && (!best || s > best.s)) best = { j, s };
    });
    if (best) r.parent = best.j;
  });
  return items;
}

/* ---- duplicates: exact = same SHA-256; near = MinHash + LSH banding finds candidates, exact Jaccard confirms ---- */
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function shingles(text, k = 5) {
  const w = text.toLowerCase().slice(0, 300000).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean), set = new Set();
  for (let i = 0; i + k <= w.length; i++) set.add(fnv(w.slice(i, i + k).join(' ')));
  return set;
}
function jaccard(a, b) { if (!a.size || !b.size) return 0; let n = 0; const [s, l] = a.size < b.size ? [a, b] : [b, a]; for (const x of s) if (l.has(x)) n++; return n / (a.size + b.size - n); }
const MH_SEEDS = Array.from({ length: 96 }, (_, i) => fnv('seed' + i)), MH_BANDS = 24; // 24 bands × 4 rows: pairs ≥ 0.85 similar collide with > 99.9 % odds
function minhash(set) {
  const sig = new Uint32Array(MH_SEEDS.length).fill(0xffffffff);
  for (const x of set) for (let i = 0; i < MH_SEEDS.length; i++) { let h = Math.imul(x ^ MH_SEEDS[i], 0x9e3779b1); h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b) >>> 0; if (h < sig[i]) sig[i] = h; }
  return sig;
}
const mhSim = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) n++; return n / a.length; };
const differ = (a, b) => !!(a && b && a.length && b.length && a.map(x => x.toLowerCase()).sort().join('|') !== b.map(x => x.toLowerCase()).sort().join('|'));
function groupDuplicates(items, thr = 0.85) { // items: {sha, shingles, mod, size}; sets dupGroup, dupKind, dupKeep, dupOf, dupSim
  const n = items.length, P = items.map((_, i) => i), find = i => P[i] === i ? i : (P[i] = find(P[i])), sim = {}, bySha = {}, buckets = new Map(), pairs = new Set();
  const join = (i, j, s) => { P[find(i)] = find(j); sim[i] = Math.max(sim[i] || 0, s); sim[j] = Math.max(sim[j] || 0, s); };
  items.forEach((r, i) => { if (r.sha) r.sha in bySha ? join(bySha[r.sha], i, 1) : bySha[r.sha] = i; });
  const R = MH_SEEDS.length / MH_BANDS;
  items.forEach((r, i) => {
    if (!r.shingles || r.shingles.size < 8) return;
    const sig = minhash(r.shingles);
    for (let b = 0; b < MH_BANDS; b++) { const key = b + ':' + sig.subarray(b * R, b * R + R).join(','), L = buckets.get(key); if (!L) buckets.set(key, [i]); else { for (const j of L) pairs.add(j * n + i); L.push(i); } }
  });
  for (const p of [...pairs].sort((x, y) => x - y)) {
    const i = Math.floor(p / n), j = p % n, a = items[i], b = items[j];
    if (find(i) === find(j) || differ(a.parties, b.parties) || (a.amount && b.amount && a.amount !== b.amount) || (a.number && b.number && a.number !== b.number)) continue;
    const s = jaccard(a.shingles, b.shingles); if (s >= thr) join(i, j, s);
  }
  const groups = {}; items.forEach((r, i) => { (groups[find(i)] ||= []).push(i); Object.assign(r, { dupGroup: '', dupKeep: false, dupOf: null, dupKind: '' }); });
  let g = 0;
  for (const m of Object.values(groups)) {
    if (m.length < 2) continue; g++;
    const keep = m.slice().sort((x, y) => (items[y].mod || 0) - (items[x].mod || 0) || (items[y].size || 0) - (items[x].size || 0))[0];
    for (const i of m) Object.assign(items[i], { dupGroup: 'D' + g, dupKeep: i === keep, dupOf: keep, dupSim: sim[i] || 0, dupKind: items[i].sha && items[i].sha === items[keep].sha ? 'exact' : 'near' });
  }
  return items;
}

/* ---- signature blocks (layout) ---- */
const SIG_HINT = /in witness|signature|\bby\s*:/i; // pages worth checking besides the last three
const SIG_LABEL = /^(by\s*:|by\s+_|signature\b|signed\b|sign here|authori[sz]ed signature|signatory)\s*:?/i;
const SIG_NEAR = /^(name|title|date|print(ed)? name|by|its)\s*:/i;
function findSigBlocks(pages) { // page number = p.n when only some pages were read, else the array position
  const out = [];
  pages.forEach((p, pi) => {
    const L = p.lines, witness = L.some(l => /in witness whereof/i.test(l.text)), page = p.n ?? pi;
    L.forEach((l, i) => {
      const t = l.text, lab = t.match(SIG_LABEL), us = /_{6,}/.test(t);
      if (SIG_NEAR.test(t) && !/^by\s*:/i.test(t)) return;
      const near = L.slice(Math.max(0, i - 2), i + 4).some(m => m !== l && SIG_NEAR.test(m.text) && Math.abs(m.base - l.base) < 70);
      if (!(lab && t.length < 70 && (us || near || t.length < 25)) && !(us && (near || witness))) return;
      const parts = l.parts || [{ x: l.x || 72, w: t.length * l.size * 0.5, s: t }];
      let x0 = null, x1 = null;
      for (const q of parts) { const m = q.s.match(/_{4,}/); if (m) { const cw = q.w / Math.max(1, q.s.length); x0 = q.x + m.index * cw; x1 = x0 + m[0].length * cw; break; } }
      if (x0 === null) { const q = parts[parts.length - 1]; x0 = q.x + q.w + 2; x1 = Math.min(x0 + 220, (p.w || 612) - 30); }
      const rest = t.replace(SIG_LABEL, '').replace(/\b(date|name|title)\s*:.*$/i, '').replace(/_+/g, ' ').trim();
      const typed = rest.length >= 2 && /[A-Za-z]{2}/.test(rest) && !/^(of|by|here|below|above|line)\b/i.test(rest);
      out.push({ page, base: l.base, typed, us, text: t, rect: { x: x0, y: l.base - 30, w: Math.max(40, x1 - x0), h: 34 } });
    });
  });
  return out.filter(b => b.us || !out.some(o => o !== b && o.us && o.page === b.page && Math.abs(o.base - b.base) < 22));
}
function sigVerdict(blocks, fields = []) { // blocks carry .ink (bool) once checked; fields: [{page, signed}]
  const all = blocks.map(b => ({ page: b.page, signed: !!(b.typed || b.ink) })).concat(fields);
  if (!all.length) return { status: 'No signature block', pages: [], unsigned: [] };
  const un = [...new Set(all.filter(b => !b.signed).map(b => b.page + 1))], pg = [...new Set(all.map(b => b.page + 1))];
  return { status: !un.length ? 'Signed' : un.length === pg.length && all.every(b => !b.signed) ? 'Unsigned' : 'Partly signed', pages: pg, unsigned: un };
}

/* ---- one file: bytes → analysis. io supplies the PDF reader so the same code runs in the browser and in Node ---- */
const textLen = pages => pages.reduce((t, p) => t + p.lines.reduce((u, l) => u + l.text.length, 0), 0);
async function analyzeBytes(bytes, io, cache) { // io: {hash, open, lines(pdf, from, to), signatures(pdf, bytes, pages, blocks), ocr?(pdf)}
  const sha = await io.hash(bytes), hit = cache && cache.get(sha);
  if (hit) return hit;
  const r = { sha, type: 'Other', conf: 'Low', parties: [], sig: null, err: '' };
  let pdf;
  try {
    pdf = await io.open(bytes); r.pages = pdf.numPages;
    const n = Math.min(pdf.numPages, 40), lines = async i => (await io.lines(pdf, i, i + 1)).map(p => ({ ...p, n: i }));
    let pages = [];
    for (let i = 0; i < Math.min(2, n); i++) pages.push(...await lines(i));
    if (textLen(pages) < 30) {
      const o = io.ocr && await io.ocr(pdf).catch(e => { console.warn(e); return null; });
      if (o) { pages = [{ ...o, n: 0 }]; r.ocr = true; } else r.scan = true;
    }
    if (!r.scan) {
      for (let i = 2; i < n; i++) { // later pages: only the ones likely to hold signatures
        if (i >= n - 3) { pages.push(...await lines(i)); continue; }
        const tc = await (await pdf.getPage(i + 1)).getTextContent();
        if (SIG_HINT.test(tc.items.map(x => x.str).join(' '))) pages.push(...await lines(i));
      }
      Object.assign(r, analyzeText(pages));
      r.sig = await io.signatures(pdf, bytes, pages, findSigBlocks(pages.filter(p => p.n >= n - 3 || SIG_HINT.test(orgPageText(p)))));
    }
  } catch (e) { r.err = e.name === 'PasswordException' ? 'password-protected' : (e.message || String(e)); }
  finally { if (pdf) pdf.destroy(); }
  if (cache && (!r.err || r.err === 'password-protected')) cache.set(sha, r);
  return r;
}
async function orgPool(list, fn, onDone, max = 4) { // run fn over list, max at a time, results in order
  const out = new Array(list.length); let next = 0, done = 0;
  const work = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); done++; if (onDone) await onDone(done, list.length, list[i]); } };
  await Promise.all(Array.from({ length: Math.min(max, list.length) }, work));
  return out;
}
// cache entries go into index.json: shingles packed as base64 uint32s
const packSet = s => { const v = new Uint8Array(Uint32Array.from(s || []).buffer); let b = ''; for (let i = 0; i < v.length; i += 32768) b += String.fromCharCode(...v.subarray(i, i + 32768)); return btoa(b); };
const unpackSet = s => { const b = atob(s || ''), v = new Uint8Array(b.length & ~3); for (let i = 0; i < v.length; i++) v[i] = b.charCodeAt(i); return new Set(new Uint32Array(v.buffer)); };
const packResult = r => { const { shingles: s, ...o } = r; return { ...o, sh: packSet(s) }; };
const unpackResult = o => { const { sh, ...r } = o; return { ...r, shingles: unpackSet(sh) }; };

/* ---- naming ---- */
function chooseParty(items) { // {party} = the other side: skip "our" company that appears in most documents
  const cnt = {}; items.forEach(r => new Set((r.parties || []).map(p => p.toLowerCase())).forEach(p => cnt[p] = (cnt[p] || 0) + 1));
  const home = items.length >= 3 ? Object.keys(cnt).filter(p => cnt[p] >= Math.max(3, items.length * 0.5)) : [];
  items.forEach(r => { const ps = r.parties || []; r.party = ps.find(p => !home.includes(p.toLowerCase())) || ps[0] || ''; });
  return items;
}
const safeName = s => s.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120);
function renderName(pattern, r) {
  const tok = { date: r.date, type: r.type, party: r.party || (r.parties || [])[0], title: (r.title || '').slice(0, 60), number: r.number, amount: r.amount, original: (r.name || '').replace(/\.pdf$/i, '') };
  const s = pattern.replace(/\{(\w+)\}/g, (_, k) => (tok[k.toLowerCase()] || '').replace(/[\\/:*?"<>|]/g, ' '))
    .replace(/(\s*[-_–,]\s*){2,}/g, ' - ').replace(/^\s*[-_–,]\s*|\s*[-_–,]\s*$/g, '').replace(/\(\s*\)|\[\s*\]/g, '');
  return (safeName(s) || safeName(tok.original) || 'document') + '.pdf';
}
const withNum = (p, n) => p.replace(/^(.*?)(\.[^./]+)?$/, (_, a, b) => `${a} (${n})${b || ''}`);
function uniquePaths(paths, taken = new Set()) { // ["a/b.pdf", "a/b.pdf"] → ["a/b.pdf", "a/b (2).pdf"]; taken = lower-case paths already used
  return paths.map(p => { let q = p, n = 1; while (taken.has(q.toLowerCase())) q = withNum(p, ++n); taken.add(q.toLowerCase()); return q; });
}
const csvCell = v => { v = v == null ? '' : String(v); const f = /^[=+\-@]/.test(v); return f || /[",\n\r;]/.test(v) ? '"' + (f ? "'" : '') + v.replace(/"/g, '""') + '"' : v; };
const ORG_COLS = ['Original name', 'New name', 'Type', 'Confidence', 'Date', 'Parties', 'Amount', 'Number', 'Pages', 'Signature status', 'Duplicate group', 'Related to', 'Status'];
const indexRows = items => items.map(r => [r.path || r.name, r.out || r.newName, r.scan ? 'Scan – no text' : r.err ? 'Error: ' + r.err : r.type, r.conf, r.date, (r.parties || []).join('; '), r.amount, r.number,
  r.pages || '', r.sig ? r.sig.status + (r.sig.pages.length ? ` (p. ${(r.sig.unsigned.length ? r.sig.unsigned : r.sig.pages).join(', ')})` : '') : '',
  r.dupGroup ? `${r.dupGroup} ${r.dupKeep ? 'keep' : r.dupKind + ' duplicate'}` : '', r.parent >= 0 ? items[r.parent].newName : '', [r.status, r.conflict && 'conflict copy'].filter(Boolean).join(', ')]);
const toCsv = items => '﻿' + [ORG_COLS, ...indexRows(items)].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/* ---- data room: a shared (synced) folder with <folder>/_dataroom/index.json. ad = {list, read, write, move, remove, exists, rmdir?} ---- */
const ROOM_DIR = '_dataroom', ROOM_INDEX = ROOM_DIR + '/index.json', LOCK_MS = 120000;
const CONFLICT_RE = /conflicted copy|\(1\)(\.[^.]*)?$|-DESKTOP-[A-Z0-9]{4,}| \(Conflict|-Copy\b| - Copy\b/i;
const isConflictName = p => CONFLICT_RE.test(p.split('/').pop());
const roomFile = p => /\.pdf$/i.test(p) && !p.split('/').some((s, i) => s.startsWith('.') || s.startsWith('~$') || (!i && s === ROOM_DIR));
async function roomLoad(ad) { try { return JSON.parse(new TextDecoder().decode(await ad.read(ROOM_INDEX))); } catch { return null; } }
const freshLock = (idx, me, now) => idx && idx.lock && idx.lock.by !== me && now - idx.lock.at < LOCK_MS ? idx.lock : null;
async function roomOpen(ad, { analyze, me = 'Someone', now = Date.now(), force = false, onDone } = {}) { // analyze(bytes, cache) → result
  const idx = await roomLoad(ad) || { version: 1, files: {} }, lock = force ? null : freshLock(idx, me, now), stats = { processed: 0, cached: 0, new: 0, changed: 0, removed: 0 };
  if (!lock) { idx.lock = { by: me, at: now }; await roomWrite(ad, idx); }
  const bySha = new Map(Object.values(idx.files).filter(f => f.result).map(f => [f.sha256, f])), cache = { get: s => bySha.has(s) ? unpackResult(bySha.get(s).result) : null, set() { } };
  const disk = (await ad.list()).filter(f => roomFile(f.path)), seen = new Set(disk.map(f => f.path));
  const items = await orgPool(disk, async f => { // unchanged size + date → cached; otherwise SHA-256 decides whether it really changed
    const rec = idx.files[f.path], same = rec && rec.result && rec.size === f.size && rec.lastModified === f.lastModified;
    const res = same ? unpackResult(rec.result) : await analyze(await ad.read(f.path), cache);
    stats[same || bySha.has(res.sha) ? 'cached' : 'processed']++;
    const status = !rec || (rec.status === 'removed' && rec.sha256 !== res.sha) ? 'new' : rec.sha256 !== res.sha ? 'changed' : 'ok';
    if (status !== 'ok') stats[status]++;
    return { res, item: { ...res, path: f.path, name: f.path.split('/').pop(), size: f.size, mod: f.lastModified, file: f.file, status, conflict: isConflictName(f.path), prevBy: rec && rec.by } };
  }, onDone);
  for (const [p, rec] of Object.entries(idx.files)) if (!seen.has(p) && rec.status !== 'removed') { rec.status = 'removed'; stats.removed++; }
  return { idx, lock, me, stats, items: items.map(x => (x.item._res = x.res, x.item)) };
}
function roomRecord(idx, items, me, now) { // copy the current analysis into the index
  for (const r of items) {
    const old = idx.files[r.path] || {};
    idx.files[r.path] = { path: r.path, size: r.size, lastModified: r.mod, sha256: r.sha, result: packResult(r._res || {}), newName: r.out || r.newName || '', status: r.status,
      conflict: !!r.conflict, by: old.sha256 === r.sha && old.by ? old.by : me, at: old.sha256 === r.sha && old.at ? old.at : now };
  }
}
async function roomWrite(ad, idx) { // atomic-ish: write index.tmp.json, then replace index.json
  const tmp = ROOM_DIR + '/index.tmp.json', data = JSON.stringify(idx);
  await ad.write(tmp, data);
  if (await ad.exists(ROOM_INDEX)) await ad.remove(ROOM_INDEX);
  await ad.move(tmp, ROOM_INDEX);
}
async function roomSave(ad, room, items, { now = Date.now(), release = true, xlsx } = {}) {
  const { idx, me } = room;
  roomRecord(idx, items, me, now);
  Object.assign(idx, { updated: now, by: me, lock: release ? null : { by: me, at: now } });
  await roomWrite(ad, idx);
  await ad.write(ROOM_DIR + '/index.csv', toCsv(items));
  if (xlsx) await ad.write(ROOM_DIR + '/index.xlsx', await xlsx(items));
}
async function roomLock(ad, room, now = Date.now()) { // before changing anything: nobody else busy, and nobody saved since we opened
  const cur = await roomLoad(ad), lock = freshLock(cur, room.me, now);
  if (lock) throw new Error(`${lock.by} is organizing this folder right now (since ${new Date(lock.at).toLocaleTimeString()}). Try again in a couple of minutes.`);
  if (cur && cur.updated !== room.idx.updated && cur.by !== room.me) throw new Error(`${cur.by || 'Someone'} changed this data room since you opened it. Press Rescan first.`);
  room.idx.lock = { by: room.me, at: now }; await roomWrite(ad, room.idx);
}
function roomPlan(items) { // dry run: [{from, to, r}] – never onto a file that stays where it is
  const moving = items.filter(r => r.out && r.out !== r.path && !r.err), stay = new Set(items.filter(r => !moving.includes(r)).map(r => r.path.toLowerCase()));
  const to = uniquePaths(moving.map(r => r.out), stay);
  return moving.map((r, i) => ({ from: r.path, to: to[i], r }));
}
async function freePath(ad, p) { let q = p, n = 1; while (await ad.exists(q)) q = withNum(p, ++n); return q; }
async function roomMove(ad, room, moves, items, now = Date.now()) { // moves [{from, to}] → actual moves done (targets get (2), (3)… when taken)
  const done = [];
  for (const m of moves) {
    const to = await freePath(ad, m.to); await ad.move(m.from, to); done.push({ from: m.from, to });
    const r = items.find(x => x.path === m.from); if (r) Object.assign(r, { path: to, name: to.split('/').pop(), status: 'moved' });
    const rec = room.idx.files[m.from]; delete room.idx.files[m.from];
    if (rec) room.idx.files[to] = { ...rec, path: to, status: 'moved', by: room.me, at: now };
    if (r) { r.prevBy = room.me; const f = await ad.stat?.(to); if (f) Object.assign(r, { mod: f.lastModified, size: f.size }); }
  }
  return done;
}
async function roomOrganize(ad, room, items, opts = {}) {
  await roomLock(ad, room, opts.now);
  const plan = opts.plan || roomPlan(items), done = await roomMove(ad, room, plan, items, opts.now);
  room.idx.last = { by: room.me, at: opts.now || Date.now(), moves: done };
  await roomSave(ad, room, items, opts);
  return done;
}
async function roomUndo(ad, room, items, opts = {}) {
  const last = room.idx.last; if (!last || !last.moves.length) throw new Error('Nothing to undo.');
  await roomLock(ad, room, opts.now);
  const back = last.moves.slice().reverse().filter(m => items.some(r => r.path === m.to)).map(m => ({ from: m.to, to: m.from }));
  const done = await roomMove(ad, room, back, items, opts.now);
  for (const d of new Set(last.moves.flatMap(m => m.to.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/')))))
    if (ad.rmdir) await ad.rmdir(d).catch(() => { }); // empty folders left behind (fails harmlessly when not empty)
  room.idx.last = null;
  await roomSave(ad, room, items, opts);
  return done;
}

if (typeof module === 'object' && module.exports) module.exports = { classifyText, extractDate, findDates, parseDate, extractParties, extractAmount, extractNumber, extractEmails,
  titleLines, analyzeText, analyzeBytes, linkRelations, groupDuplicates, shingles, jaccard, minhash, mhSim, findSigBlocks, sigVerdict, chooseParty, renderName, uniquePaths, safeName,
  toCsv, indexRows, ORG_COLS, orgPool, packResult, unpackResult, isConflictName, roomOpen, roomSave, roomPlan, roomOrganize, roomUndo, roomLoad, ROOM_INDEX, LOCK_MS };

/* ================= browser part ================= */
const ORG = { files: [], items: [], pattern: '{date} - {type} - {party}', folders: 'type', filter: 'all', q: '', room: null };
const ORG_CACHE = new Map(); // sha256 → analysis, so unchanged files are never read twice
const esc = v => escHtml(String(v == null ? '' : v));
const plural = (n, w) => `${n} ${w}${n !== 1 ? 's' : ''}`;
const orgMe = () => (typeof senderProfile !== 'undefined' && senderProfile.get().name) || 'Someone';
const ORG_IO = {
  hash: b => sha256(b), open: b => openPdfjs(b), lines: (pdf, a, b) => readLines(pdf, null, a, b),
  ocr: pdf => helperUrl('ocr') || NATIVE ? orgOcrPage(pdf) : null, signatures: (...a) => orgSignatures(...a),
};
const orgAnalyzeBytes = (bytes, cache) => analyzeBytes(bytes, ORG_IO, { get: s => ORG_CACHE.get(s) || (cache && cache.get(s)), set: (s, r) => ORG_CACHE.set(s, r) });

async function orgRenderPage(pdf, n, k, y0 = 0, h) { // page n (0-based) → white canvas at scale k; optionally only a strip from y0, h points high
  const pg = await pdf.getPage(n + 1), vp = pg.getViewport({ scale: k }), c = el('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.max(1, Math.ceil((h ?? vp.height / k) * k));
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, 0, -y0 * k], intent: 'print', annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
  pg.cleanup(); return { c, ctx, w: vp.width / k, h: vp.height / k };
}
async function orgOcrPage(pdf) { // scanned page 1 → lines via the desktop helper (Windows) or Apple Vision (Mac)
  const k = 2, { c, w, h } = await orgRenderPage(pdf, 0, k), blob = await canvasBlob(c);
  const res = NATIVE ? await nativeCall('ocr', { png: await toB64(blob) }) : await (await fetch(helperUrl('ocr'), { method: 'POST', body: blob, headers: { 'Content-Type': 'image/png' } })).json();
  if (res.error) throw new Error(res.error);
  return { w, h, lines: res.lines.map(l => ({ text: l.text, size: l.h / k, base: (l.y + l.h) / k, x: l.x / k, parts: [{ x: l.x / k, w: l.w / k, s: l.text }] })).sort((a, b) => a.base - b.base) };
}
function inkIn(ctx, r, k, y0) { // dark pixels in the box, ignoring rows that are a straight rule (signature line)
  const x = Math.max(0, Math.round(r.x * k)), y = Math.max(0, Math.round((r.y - y0) * k)), w = Math.min(ctx.canvas.width - x, Math.round(r.w * k)), h = Math.min(ctx.canvas.height - y, Math.round(r.h * k));
  if (w < 2 || h < 2) return false;
  const d = ctx.getImageData(x, y, w, h).data; let n = 0;
  for (let row = 0; row < h; row++) {
    let c = 0; for (let col = 0; col < w; col++) { const o = (row * w + col) * 4; if (d[o] + d[o + 1] + d[o + 2] < 420) c++; }
    if (c < w * 0.6) n += c;
  }
  return n >= Math.max(6 * k * k, w * h * 0.004); // = 24 px at scale 2
}
async function orgSignatures(pdf, bytes, pages, blocks) { // render only the strip around each page's signature blocks, at a modest scale
  const fields = [], byPage = {}, k = 1.25;
  for (const b of blocks) (byPage[b.page] ||= []).push(b);
  for (const [pi, bs] of Object.entries(byPage)) {
    const y0 = Math.max(0, Math.min(...bs.map(b => b.rect.y)) - 4), y1 = Math.max(...bs.map(b => b.rect.y + b.rect.h)) + 4;
    const { ctx } = await orgRenderPage(pdf, +pi, k, y0, y1 - y0);
    ctx.fillStyle = '#fff'; // blank out printed text so only ink / drawn signatures remain
    for (const l of pages.find(p => p.n === +pi).lines) for (const q of l.parts || []) ctx.fillRect((q.x - 1) * k, (l.base - l.size * 0.92 - y0) * k, (q.w + 2) * k, l.size * 1.25 * k);
    for (const b of bs) b.ink = inkIn(ctx, b.rect, k, y0);
  }
  for (let i = 0; i < Math.min(pdf.numPages, 40); i++)
    for (const a of await (await pdf.getPage(i + 1)).getAnnotations().catch(() => [])) if (a.fieldType === 'Sig') fields.push({ page: i, name: a.fieldName, signed: false });
  if (fields.length) try { // pdf.js hides signature values; ask pdf-lib whether the field has a /V
    const form = (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getForm();
    for (const f of fields) { const fl = form.getFields().find(x => x.getName() === f.name); f.signed = !!(fl && fl.acroField.dict.get(PDFLib.PDFName.of('V'))); }
  } catch (e) { console.warn(e); }
  return sigVerdict(blocks, fields);
}
async function orgAnalyze(f) {
  const base = { name: f.name, path: f.path, size: f.file.size, mod: f.file.lastModified || 0, file: f.file, conflict: isConflictName(f.path) };
  try { const res = await orgAnalyzeBytes(new Uint8Array(await f.file.arrayBuffer())); return { ...res, ...base, _res: res }; }
  catch (e) { return { ...base, type: 'Other', parties: [], err: String(e.message || e) }; }
}
function orgNames() {
  for (const r of ORG.items) if (!r.custom) r.newName = r.scan || r.err ? r.name : renderName(ORG.pattern, r);
  // files that will really be saved get the plain names first; left-out duplicates only get (2), (3)…
  const pri = orgOrder().sort((a, b) => (ORG.items[a].dupGroup && !ORG.items[a].dupKeep) - (ORG.items[b].dupGroup && !ORG.items[b].dupKeep));
  const uniq = uniquePaths(pri.map(i => orgFolder(ORG.items[i]) + ORG.items[i].newName));
  pri.forEach((i, k) => { ORG.items[i].out = uniq[k]; });
}
const orgPost = () => { chooseParty(ORG.items); groupDuplicates(ORG.items); linkRelations(ORG.items); orgNames(); };
function orgFolder(r) {
  if (ORG.folders === 'none') return '';
  const t = r.scan ? 'Scans' : r.err ? 'Could not read' : orgFolderOf((r.parent >= 0 ? ORG.items[r.parent] : r).type || 'Other');
  return t + '/' + (ORG.folders === 'year' && r.date ? r.date.slice(0, 4) + '/' : '');
}
function orgOrder() { // parents, each followed by its amendments / exhibits
  const it = ORG.items, out = new Set(), kids = {};
  it.forEach((r, i) => { if (r.parent >= 0) (kids[r.parent] ||= []).push(i); });
  const put = (i, d) => { if (out.has(i)) return; out.add(i); it[i].depth = d; (kids[i] || []).sort((a, b) => (it[a].date || '').localeCompare(it[b].date || '')).forEach(k => put(k, d + 1)); };
  it.forEach((r, i) => { if (r.parent < 0) put(i, 0); }); it.forEach((r, i) => put(i, 0));
  return [...out];
}
const orgSelected = () => orgOrder().map(i => ORG.items[i]).filter(r => r.sel !== false && !($('#oSkipDup')?.checked && r.dupGroup && !r.dupKeep));
const ORG_FILTERS = { all: ['All', () => true], unsigned: ['Unsigned', r => r.sig && /Unsigned|Partly/.test(r.sig.status)], dup: ['Duplicates', r => r.dupGroup],
  conflict: ['⚠ Conflicts', r => r.conflict || r.status === 'changed'], new: ['New since last time', r => r.status === 'new'] };
const orgShown = r => ORG_FILTERS[ORG.filter][1](r) && (!ORG.q || [r.path, r.newName, r.type, r.date, r.amount, r.number, ...(r.parties || [])].join(' ').toLowerCase().includes(ORG.q));

function orgUI() {
  $('#tTitle').textContent = '🗂 Smart organize'; $('#tBack').hidden = false; $('#tRun').hidden = true;
  $('#tBody').innerHTML = `
    <p class="muted">Sorts a pile of PDFs: finds what each one is, its date, parties and total, gives it a clear name, files it into folders,
      spots duplicates and missing signatures, and links amendments to their agreement. Everything stays on this computer.</p>
    <div class="zdrop" id="oDrop">Drag PDFs or whole folders here<div class="row" style="justify-content:center">
      <button id="oAdd">➕ Add PDFs…</button><button id="oAddDir">📁 Add a folder…</button><button id="oAddCur">📄 Add the open PDF</button>
      <button id="oGo" class="pri">🔍 Analyze</button></div>
      <div class="row" style="justify-content:center"><button id="oRoom" title="A shared folder synced by OneDrive, Google Drive, Dropbox, SharePoint or a network drive – organized in place, with a shared index">📁 Open data room folder</button></div>
      <div id="oCount" class="small"></div></div>
    <div id="oRoomBar" class="oroom" hidden></div>
    <div class="row owrapopts"><label>Name pattern <input id="oPat" spellcheck="false"></label>
      <span class="otoks">${['date', 'type', 'party', 'title', 'number', 'amount', 'original'].map(t => `<button data-tok="${t}">{${t}}</button>`).join('')}</span></div>
    <div class="row"><span class="muted small">Example:</span> <code id="oPrev" class="small"></code><span class="sp"></span>
      <label>Folders <select id="oFold"><option value="type">By type</option><option value="year">By type, then year</option><option value="none">No folders</option></select></label></div>
    <div class="row ofilter">${Object.entries(ORG_FILTERS).map(([k, [t]]) => `<button data-f="${k}">${t}</button>`).join('')}<input id="oFind" type="search" placeholder="🔎 Search names, parties, numbers…"></div>
    <div class="zwrap owrap"><table class="ztable otable"><thead><tr><th><input type="checkbox" id="oAll" checked></th><th>Document → new name</th><th>Type</th><th>Date</th><th>Party</th><th>Amount</th><th title="Signatures">✍</th><th>Dup</th></tr></thead>
      <tbody id="oRows"></tbody></table></div>
    <div class="row obtns"><label><input type="checkbox" id="oSkipDup" checked> Leave out duplicates</label><span id="oSum" class="muted small"></span><span class="sp"></span>
      <button id="oCsv">📊 Index (CSV)</button><button id="oXlsx">📗 Index (Excel)</button><button id="oBinder">📚 Make binder</button>
      <button id="oDir" ${window.showDirectoryPicker ? '' : 'hidden'}>📁 Save to folder…</button><button id="oZip" class="pri">💾 Download ZIP</button></div>`;
  const count = () => { $('#oCount').textContent = ORG.files.length ? plural(ORG.files.length, 'PDF') + ' added' : ''; };
  const pick = (dir, cb) => { const i = el('input'); i.type = 'file'; i.multiple = true; i.accept = '.pdf,application/pdf'; if (dir) i.webkitdirectory = true; i.onchange = () => cb([...i.files]); i.click(); };
  const add = list => {
    if (ORG.room) { ORG.room = null; ORG.items = []; orgRoomBar(); orgRender(); } // leaving data-room mode
    for (const x of list) if (/\.pdf$/i.test(x.path) && !ORG.files.some(y => y.path === x.path && y.file.size === x.file.size)) ORG.files.push({ ...x, name: x.path.split('/').pop() });
    count();
  };
  $('#oAdd').onclick = () => pick(false, fs => add(fs.map(f => ({ path: f.name, file: f }))));
  $('#oAddDir').onclick = () => pick(true, fs => add(fs.map(f => ({ path: f.webkitRelativePath || f.name, file: f }))));
  $('#oAddCur').onclick = async () => { if (!S.pages.length) return toast('No PDF is open.'); add([{ path: S.name.replace(/(\.pdf)?$/i, '.pdf'), file: new File([await currentBytes()], S.name, { lastModified: Date.now() }) }]); };
  $('#oRoom').onclick = orgOpenRoom;
  const d = $('#oDrop');
  d.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); d.classList.add('over'); });
  d.addEventListener('dragleave', () => d.classList.remove('over'));
  d.addEventListener('drop', async e => { e.preventDefault(); e.stopPropagation(); d.classList.remove('over'); document.body.classList.remove('dragging'); add(await filesFromDrop(e.dataTransfer)); });
  $('#oGo').onclick = () => {
    if (ORG.room) return orgScanRoom();
    if (!ORG.files.length) return toast('Add some PDFs first.');
    const todo = ORG.files.filter(f => !f.r), t0 = performance.now();
    runZipJob(async prog => {
      (await orgPool(todo, orgAnalyze, (n, all, f) => prog(n / all * 0.95, `Read ${n} of ${all}: ${f.name}`))).forEach((r, i) => { todo[i].r = r; });
      ORG.items = ORG.files.map(f => f.r); orgPost(); orgRender();
      const sc = ORG.items.filter(r => r.scan).length;
      return `Analyzed ${plural(ORG.items.length, 'document')} in ${((performance.now() - t0) / 1000).toFixed(1)} s${sc ? ` (${plural(sc, 'scan')} without text)` : ''}.`;
    });
  };
  const pat = $('#oPat'); pat.value = ORG.pattern;
  const upd = () => { ORG.pattern = pat.value || '{original}'; orgPreview(); if (ORG.items.length) { orgNames(); orgRender(); } };
  pat.oninput = upd;
  $$('[data-tok]').forEach(b => b.onclick = () => { const s = pat.selectionStart ?? pat.value.length; pat.value = pat.value.slice(0, s) + `{${b.dataset.tok}}` + pat.value.slice(pat.selectionEnd ?? s); pat.focus(); upd(); });
  $('#oFold').value = ORG.folders; $('#oFold').onchange = e => { ORG.folders = e.target.value; upd(); };
  $$('[data-f]').forEach(b => b.onclick = () => { ORG.filter = b.dataset.f; orgRender(); });
  $('#oFind').value = ORG.q; $('#oFind').oninput = e => { ORG.q = e.target.value.trim().toLowerCase(); orgRender(); };
  $('#oAll').onchange = e => { ORG.items.filter(orgShown).forEach(r => r.sel = e.target.checked); orgRender(); };
  $('#oSkipDup').onchange = orgSummary;
  const need = () => { if (!ORG.items.length) { toast('Analyze some PDFs first.'); return false; } return true; };
  const ordered = () => orgOrder().map(i => ORG.items[i]), fileOf = async r => r.file || await ORG.room.ad.file(r.path);
  $('#oCsv').onclick = () => need() && saveAny(new Blob([toCsv(ordered())], { type: 'text/csv' }), 'Document index.csv');
  $('#oXlsx').onclick = async () => need() && saveAny(await orgXlsx(ordered()), 'Document index.xlsx');
  $('#oZip').onclick = () => need() && runZipJob(async prog => {
    const sel = orgSelected(), files = [];
    for (let i = 0; i < sel.length; i++) { await prog(i / sel.length * 0.8, `Packing ${sel[i].out}`); files.push({ name: sel[i].out, data: await fileOf(sel[i]), store: true }); }
    files.push({ name: 'Document index.csv', data: toCsv(sel) });
    if (await saveAny(await makeZip(files), 'Organized documents.zip')) return `Saved ${plural(sel.length, 'file')} in ${new Set(sel.map(r => r.out.split('/')[0])).size} folder(s).`;
  });
  $('#oDir').onclick = () => need() && runZipJob(async prog => {
    let root; try { root = await showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { if (e.name === 'AbortError') return; throw e; }
    const ad = fsaAdapter(root), sel = orgSelected();
    for (let i = 0; i < sel.length; i++) { await prog(i / sel.length, `Saving ${sel[i].out}`); await ad.write(await freePath(ad, sel[i].out), await fileOf(sel[i])); } // never overwrite
    await ad.write('Document index.csv', toCsv(sel));
    return `Saved ${plural(sel.length, 'file')} into “${root.name}”.`;
  });
  $('#oBinder').onclick = () => need() && runZipJob(async prog => {
    const sel = orgSelected().filter(r => !r.err); if (!sel.length) throw new Error('Nothing selected.');
    for (const r of sel) r.file = await fileOf(r);
    if (await saveAny(await orgBinder(sel, prog), 'Binder.pdf')) return `Binder with ${plural(sel.length, 'document')}.`;
  });
  count(); orgRoomBar(); orgRender();
}
function orgPreview() {
  const r = ORG.items.find(x => !x.scan && !x.err) || { name: 'scan001.pdf', date: '2026-10-15', type: 'Invoice', parties: ['Acme Corp.'], title: 'INVOICE', number: 'INV-1001', amount: '$1,250.00' };
  $('#oPrev').textContent = renderName(ORG.pattern, r);
}
const ORG_GROUP = t => /Invoice|Receipt|Quote|Purchase|Bank|Pay|Tax/.test(t) ? 'money' : /Contract|NDA|Lease|Amendment|Consent|Resolution|Minutes/.test(t) ? 'legal' : /Letter|Memo/.test(t) ? 'mail' : 'other';
function orgRender() {
  const tb = $('#oRows'); if (!tb) return; tb.innerHTML = '';
  $$('[data-f]').forEach(b => b.classList.toggle('on', b.dataset.f === ORG.filter));
  for (const i of orgOrder()) {
    const r = ORG.items[i], sg = r.sig; if (!orgShown(r)) continue;
    const tr = el('tr'), type = r.scan ? 'Scan' : r.err ? 'Error' : r.type;
    const sig = r.scan ? ['📷', 'Scan – no text'] : r.err ? ['⚠', r.err] : !sg ? ['', ''] : sg.status === 'Signed' ? ['✅', 'Signed (p. ' + sg.pages.join(', ') + ')'] :
      sg.status === 'No signature block' ? ['–', 'No signature block'] : [sg.status === 'Unsigned' ? '❌' : '◐', `${sg.status} – unsigned on p. ${sg.unsigned.join(', ')}`];
    const warn = [r.conflict && 'Looks like a sync conflict copy', r.status === 'changed' && `Changed since the last index${r.prevBy ? ` (last organized by ${r.prevBy})` : ''}`].filter(Boolean).join('. ');
    tr.innerHTML = `<td><input type="checkbox" ${r.sel !== false ? 'checked' : ''}></td>
      <td class="odoc" style="padding-left:${8 + (r.depth || 0) * 18}px"><div class="oorig">${r.depth ? '↳ ' : ''}${warn ? `<span class="owarn" title="${esc(warn)}">⚠</span> ` : ''}${r.status === 'new' ? '<span class="onewb">new</span> ' : ''}${esc(r.path || r.name)}${r.pages ? ` <span class="muted">· ${r.pages} p.</span>` : ''}</div>
        <div class="onew"><span class="muted">${esc(orgFolder(r))}</span><input value="${esc(r.newName)}" spellcheck="false"></div></td>
      <td><span class="ochip" data-g="${ORG_GROUP(type)}">${esc(type)}</span>${r.scan || r.err ? '' : `<div class="oconf c${r.conf}">${r.conf}</div>`}</td>
      <td>${esc(r.date)}</td><td class="opty" title="${esc((r.parties || []).join('\n'))}">${esc((r.parties || [])[0])}</td>
      <td>${esc(r.amount)}</td><td title="${esc(sig[1])}" class="osig">${sig[0]}</td>
      <td>${r.dupGroup ? `<span class="obadge${r.dupKeep ? ' keep' : ''}" title="${r.dupKind === 'exact' ? 'Identical file' : `Almost identical (${Math.round(r.dupSim * 100)}% same text)`}">${r.dupGroup} ${r.dupKeep ? 'keep' : r.dupKind}</span>` : ''}</td>`;
    tr.querySelector('input[type=checkbox]').onchange = e => { r.sel = e.target.checked; orgSummary(); };
    const ni = tr.querySelector('.onew input');
    ni.onchange = () => { r.custom = true; r.newName = (safeName(ni.value.replace(/\.pdf$/i, '')) || 'document') + '.pdf'; orgNames(); orgRender(); };
    tb.append(tr);
  }
  if (!tb.children.length) tb.innerHTML = `<tr><td colspan="8" class="muted">${ORG.items.length ? 'Nothing matches this filter.' : 'Add some PDFs, then press Analyze.'}</td></tr>`;
  orgSummary(); orgPreview();
}
function orgSummary() {
  const it = ORG.items, s = $('#oSum'); if (!s) return;
  const n = f => it.filter(ORG_FILTERS[f][1]).length, du = it.filter(r => r.dupGroup && !r.dupKeep).length, un = n('unsigned'), cf = n('conflict');
  s.textContent = `${orgSelected().length} to save · ${plural(du, 'duplicate')} · ${plural(un, 'missing signature')}${cf ? ` · ⚠ ${cf} to check` : ''}`;
}

/* ---- data-room folder through the File System Access API (same adapter shape as the Node test's fs adapter) ---- */
function fsaAdapter(root) {
  const split = p => p.split('/').filter(Boolean);
  const dir = async (p, create) => { let d = root; for (const s of split(p).slice(0, -1)) d = await d.getDirectoryHandle(s, { create }); return d; };
  const fh = async (p, create) => (await dir(p, create)).getFileHandle(split(p).pop(), { create });
  const ad = {
    async list() {
      const out = [], walk = async (d, pre) => { for await (const [n, h] of d.entries()) {
        if (n.startsWith('.') || (!pre && n === ROOM_DIR)) continue;
        if (h.kind === 'directory') await walk(h, pre + n + '/'); else if (/\.pdf$/i.test(n)) { const f = await h.getFile(); out.push({ path: pre + n, size: f.size, lastModified: f.lastModified, file: f }); }
      } };
      await walk(root, ''); return out;
    },
    file: async p => (await fh(p)).getFile(),
    read: async p => new Uint8Array(await (await ad.file(p)).arrayBuffer()),
    stat: p => ad.file(p).catch(() => null),
    async write(p, data) { const w = await (await fh(p, true)).createWritable(); await w.write(data); await w.close(); },
    exists: p => fh(p).then(() => true, () => false),
    async move(a, b) { // create the destination, write, then remove the old entry (FileSystemHandle.move() when the browser has it)
      const h = await fh(a);
      if (await ad.exists(b)) throw new Error('Refusing to replace an existing file: ' + b); // never overwrite anything
      const size = (await h.getFile()).size;
      let moved = false;
      if (h.move) try { await h.move(await dir(b, true), split(b).pop()); moved = true; } catch (e) { console.warn('move() failed – copying instead', e); }
      if (!moved) { await ad.write(b, await h.getFile()); if ((await ad.file(b)).size !== size) throw new Error('Copy check failed for ' + b); await ad.remove(a); }
      else if ((await ad.file(b)).size !== size) throw new Error('Move check failed for ' + b);
    },
    remove: async p => (await dir(p)).removeEntry(split(p).pop()),
    rmdir: async p => (await dir(p)).removeEntry(split(p).pop()), // throws when not empty – that is the point
  };
  return ad;
}
async function orgOpenRoom() {
  if (!window.showDirectoryPicker) return infoBox('📁 Data room folders', NATIVE
    ? 'The Mac app cannot open a folder to change files in place yet. Use <b>📁 Add a folder…</b> to analyze it and save a ZIP, or open the editor in Chrome or Edge.'
    : 'Organizing a shared folder in place needs the Windows app, or Chrome or Edge on a computer. You can still use <b>📁 Add a folder…</b> and download a ZIP.');
  let root; try { root = await showDirectoryPicker({ mode: 'readwrite', id: 'dataroom' }); } catch (e) { if (e.name !== 'AbortError') toast('Could not open that folder: ' + e.message); return; }
  ORG.room = { ad: fsaAdapter(root), name: root.name }; ORG.files = []; $('#oCount').textContent = ''; orgScanRoom();
}
function orgScanRoom(force) {
  const R = ORG.room, t0 = performance.now();
  runZipJob(async prog => {
    const room = await roomOpen(R.ad, { analyze: orgAnalyzeBytes, me: orgMe(), force, onDone: (n, all, f) => prog(n / all * 0.9, `Checked ${n} of ${all}: ${f.path}`) });
    Object.assign(R, room, { readOnly: !!room.lock }); ORG.items = room.items; orgPost();
    if (!R.readOnly) { await prog(0.95, 'Writing the index…'); await roomSave(R.ad, R, ORG.items, { xlsx: orgXlsx }); }
    orgRender(); orgRoomBar();
    const s = room.stats;
    return `${R.name}: ${plural(ORG.items.length, 'PDF')} – ${s.processed} read, ${s.cached} unchanged, ${s.new} new, ${s.changed} changed, ${s.removed} removed (${((performance.now() - t0) / 1000).toFixed(1)} s).`;
  });
}
function orgRoomBar(plan) {
  const bar = $('#oRoomBar'), R = ORG.room; if (!bar) return; bar.hidden = !R; if (!R || !R.idx) return;
  const last = R.idx.last;
  bar.innerHTML = `<div class="row"><b>📁 ${esc(R.name)}</b><span class="muted small">${ROOM_INDEX}${R.idx.updated ? ` · saved by ${esc(R.idx.by)}, ${new Date(R.idx.updated).toLocaleString()}` : ''}</span><span class="sp"></span>
    <button id="oRescan">🔄 Rescan</button><button id="oPlace" ${R.readOnly ? 'disabled' : ''}>🗂 Organize in place…</button>
    <button id="oUndo" ${R.readOnly || !last ? 'disabled' : ''} title="${last ? esc(`${plural(last.moves.length, 'move')} by ${last.by}`) : ''}">↩ Undo last organize</button></div>
    ${R.readOnly ? `<div class="owarnbox">⚠ <b>${esc(R.lock.by)}</b> is organizing this folder (since ${new Date(R.lock.at).toLocaleTimeString()}), so it is open <b>read-only</b>. <button id="oTake">Open anyway</button></div>` : ''}
    ${plan ? `<div class="oplan"><b>Preview – nothing has been moved yet.</b> ${plural(plan.length, 'file')} would move:<ol>${plan.map(m => `<li><span class="muted">${esc(m.from)}</span> → ${esc(m.to)}</li>`).join('') || '<li>Everything is already in place.</li>'}</ol>
      <div class="row"><button id="oApply" class="pri" ${plan.length ? '' : 'disabled'}>✔ Move ${plural(plan.length, 'file')}</button><button id="oCancel">Cancel</button></div></div>` : ''}`;
  const on = (id, f) => { const b = $('#' + id); if (b) b.onclick = f; };
  const act = (fn, verb) => runZipJob(async prog => { await prog(0.1, verb + '…'); const done = await fn(R.ad, R, ORG.items, { xlsx: orgXlsx, plan }); orgNames(); orgRender(); orgRoomBar(); return `${verb} ${plural(done.length, 'file')}.`; });
  on('oRescan', () => orgScanRoom()); on('oTake', () => orgScanRoom(true)); on('oCancel', () => orgRoomBar());
  on('oPlace', () => orgRoomBar(roomPlan(orgSelected()))); on('oApply', () => act(roomOrganize, 'Moved')); on('oUndo', () => act(roomUndo, 'Moved back'));
}

/* ---- Excel index (minimal .xlsx written by hand) ---- */
async function orgXlsx(items) {
  const rows = [ORG_COLS, ...indexRows(items)], col = n => { let s = ''; for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', NS = 'http://schemas.openxmlformats.org/', SM = NS + 'spreadsheetml/2006/main', RL = NS + 'package/2006/relationships';
  const OR = NS + 'officeDocument/2006/relationships', CT = 'application/vnd.openxmlformats-', lc = col(ORG_COLS.length - 1), rel = (id, t, to) => `<Relationship Id="${id}" Type="${OR}/${t}" Target="${to}"/>`;
  const sheet = `${X}<worksheet xmlns="${SM}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<cols>${[34, 44, 16, 12, 12, 36, 14, 16, 8, 30, 18, 40, 16].map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>`
    + rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`
      : `<c r="${col(ci)}${ri + 1}" t="inlineStr"${ri ? '' : ' s="1"'}><is><t xml:space="preserve">${xmlEsc(String(v ?? ''))}</t></is></c>`).join('')}</row>`).join('')
    + `</sheetData><autoFilter ref="A1:${lc}${rows.length}"/></worksheet>`;
  const files = {
    '[Content_Types].xml': `${X}<Types xmlns="${NS}package/2006/content-types"><Default Extension="rels" ContentType="${CT}package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + [['workbook', 'sheet.main'], ['worksheets/sheet1', 'worksheet'], ['styles', 'styles']].map(([p, t]) => `<Override PartName="/xl/${p}.xml" ContentType="${CT}officedocument.spreadsheetml.${t}+xml"/>`).join('') + '</Types>',
    '_rels/.rels': `${X}<Relationships xmlns="${RL}">${rel('rId1', 'officeDocument', 'xl/workbook.xml')}</Relationships>`,
    'xl/workbook.xml': `${X}<workbook xmlns="${SM}" xmlns:r="${OR}"><sheets><sheet name="Documents" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Documents!$A$1:$${lc}$${rows.length}</definedName></definedNames></workbook>`,
    'xl/_rels/workbook.xml.rels': `${X}<Relationships xmlns="${RL}">${rel('rId1', 'worksheet', 'worksheets/sheet1.xml')}${rel('rId2', 'styles', 'styles.xml')}</Relationships>`,
    'xl/styles.xml': `${X}<styleSheet xmlns="${SM}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': sheet,
  };
  return new Blob([await makeZip(Object.entries(files).map(([name, data]) => ({ name, data })))], { type: CT + 'officedocument.spreadsheetml.sheet' });
}

/* ---- binder: index page(s) + every document + clickable index + PDF bookmarks ---- */
const winAnsi = s => String(s || '').replace(/[^\x20-\x7e\xa0-\xff–—‘’“”•…€]/g, '?');
async function orgBinder(items, prog) {
  const { PDFName: N, PDFHexString: HS } = PDFLib, doc = await PDFDocument.create(), ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const per = 30, idxPages = Array.from({ length: Math.max(1, Math.ceil(items.length / per)) }, () => doc.addPage([612, 792])), entries = [];
  for (let i = 0; i < items.length; i++) {
    await prog(i / items.length * 0.9, `Adding ${items[i].name}`);
    try {
      const src = await PDFDocument.load(await items[i].file.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
      const start = doc.getPageCount(); (await doc.copyPages(src, src.getPageIndices())).forEach(p => doc.addPage(p));
      entries.push({ r: items[i], start, n: doc.getPageCount() - start });
    } catch (e) { console.warn(e); }
  }
  const fit = (s, f, sz, w) => { s = winAnsi(s); while (s.length > 3 && f.widthOfTextAtSize(s, sz) > w) s = s.slice(0, -2); return s; };
  const dest = e => ctx.obj([doc.getPage(e.start).ref, 'XYZ', null, null, null]);
  entries.forEach((e, k) => {
    const pg = idxPages[Math.floor(k / per)], row = k % per, y = 690 - row * 21;
    if (!row) { pg.drawText('Binder – index', { x: 54, y: 730, size: 20, font: bold }); pg.drawText(winAnsi(`${entries.length} documents · made ${new Date().toISOString().slice(0, 10)}`), { x: 54, y: 712, size: 9, font, color: rgb(0.45, 0.45, 0.5) }); }
    const label = e.r.newName.replace(/\.pdf$/i, ''), meta = [e.r.type, e.r.sig && e.r.sig.status !== 'No signature block' ? e.r.sig.status : ''].filter(Boolean).join(' · ');
    pg.drawText(`${k + 1}.`, { x: 54, y, size: 10, font: bold });
    pg.drawText(fit((e.r.depth ? '   ' : '') + label, font, 10, 360), { x: 78, y, size: 10, font, color: rgb(0.1, 0.25, 0.65) });
    pg.drawText(fit(meta, font, 8, 110), { x: 444, y, size: 8, font, color: rgb(0.45, 0.45, 0.5) });
    const pn = String(e.start + 1); pg.drawText(pn, { x: 558 - font.widthOfTextAtSize(pn, 10), y, size: 10, font });
    const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [54, y - 5, 560, y + 13], Border: [0, 0, 0], Dest: dest(e) }));
    pg.node.addAnnot(link);
  });
  const outline = ctx.nextRef(), refs = entries.map(() => ctx.nextRef());
  entries.forEach((e, k) => ctx.assign(refs[k], ctx.obj({ Title: HS.fromText(e.r.newName.replace(/\.pdf$/i, '')), Parent: outline, Dest: dest(e),
    ...(k ? { Prev: refs[k - 1] } : {}), ...(k < entries.length - 1 ? { Next: refs[k + 1] } : {}) })));
  ctx.assign(outline, ctx.obj({ Type: 'Outlines', ...(entries.length ? { First: refs[0], Last: refs[refs.length - 1] } : {}), Count: entries.length }));
  doc.catalog.set(N.of('Outlines'), outline); doc.catalog.set(N.of('PageMode'), N.of('UseOutlines'));
  doc.setTitle('Binder');
  await prog(0.95, 'Saving binder…');
  return doc.save();
}

if (typeof TOOLS !== 'undefined') {
  const at = TOOLS.findIndex(t => t.id === 'batch');
  TOOLS.splice(at < 0 ? TOOLS.length : at + 1, 0, { id: 'smartorg', icon: '🗂', name: 'Smart organize', noDoc: true, custom: orgUI,
    desc: 'Sort a pile of PDFs: type, date, parties, smart names, folders, duplicates, missing signatures, index and binder.' });
}
