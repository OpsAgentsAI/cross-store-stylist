// Cross-Store Stylist — one agent, many independent Shopify stores, one outfit.
// Zero dependencies. Node 20+.  Run: node server.js  → http://localhost:4747
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 4747;
const MODEL = process.env.STYLIST_MODEL || 'claude-fable-5-1';
const PAGES = Number(process.env.STYLIST_PAGES || 4);
const PLAN_MODEL = process.env.STYLIST_PLAN_MODEL || 'claude-haiku-4-5-20251001';

// Any Shopify storefront exposes /products.json. No keys, no integration, no partnership.
const STORES = [
  { id: 'everlane', name: 'Everlane', host: 'www.everlane.com' },
  { id: 'staud', name: 'Staud', host: 'staud.clothing' },
  { id: 'cuyana', name: 'Cuyana', host: 'cuyana.com' },
  { id: 'aninebing', name: 'Anine Bing', host: 'www.aninebing.com' },
  { id: 'faherty', name: 'Faherty', host: 'fahertybrand.com' },
  { id: 'marinelayer', name: 'Marine Layer', host: 'www.marinelayer.com' },
  { id: 'birdies', name: 'Birdies', host: 'www.birdies.com' },
  { id: 'gorjana', name: 'Gorjana', host: 'www.gorjana.com' },
  { id: 'birdygrey', name: 'Birdy Grey', host: 'birdygrey.com' },
  { id: 'petalandpup', name: 'Petal & Pup', host: 'www.petalandpup.com' },
  { id: 'princesspolly', name: 'Princess Polly', host: 'us.princesspolly.com' },
  { id: 'hillhouse', name: 'Hill House Home', host: 'hillhousehome.com' },
  { id: 'universalstandard', name: 'Universal Standard', host: 'www.universalstandard.com' },
  { id: 'stateandliberty', name: 'State & Liberty', host: 'www.stateandliberty.com' },
  { id: 'twillory', name: 'Twillory', host: 'www.twillory.com' },
  { id: 'ministryofsupply', name: 'Ministry of Supply', host: 'www.ministryofsupply.com' },
  { id: 'taft', name: 'Taft', host: 'taftclothing.com' },
  { id: 'thursday', name: 'Thursday Boot Co.', host: 'thursdayboots.com' },
  { id: 'halfdays', name: 'Halfdays', host: 'halfdays.com' },
  { id: 'cotopaxi', name: 'Cotopaxi', host: 'www.cotopaxi.com' },
  { id: 'outerknown', name: 'Outerknown', host: 'www.outerknown.com' },
  { id: 'girlfriend', name: 'Girlfriend Collective', host: 'www.girlfriend.com' },
  { id: 'kith', name: 'Kith', host: 'kith.com' },
  { id: 'taylorstitch', name: 'Taylor Stitch', host: 'www.taylorstitch.com' },
  { id: 'allbirds', name: 'Allbirds', host: 'www.allbirds.com' },
  { id: 'rothys', name: "Rothy's", host: 'rothys.com' },
  { id: 'outdoorvoices', name: 'Outdoor Voices', host: 'www.outdoorvoices.com' },
];

// ---------- live catalog ----------
const cache = new Map(); // storeId -> { at, products }
const TTL = 30 * 60 * 1000;
const JUNK = /gift card|e-gift|returns? coverage|package protection|shipping protection|kids|toddler|baby|sample|swatch/i;

async function loadStore(store) {
  const hit = cache.get(store.id);
  if (hit && Date.now() - hit.at < TTL) return hit.products;
  const products = [];
  const pages = await Promise.all(Array.from({ length: PAGES }, (_, i) =>
    fetch(`https://${store.host}/products.json?limit=250&page=${i + 1}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (cross-store-stylist demo)' },
      signal: AbortSignal.timeout(25000),
    }).then((r) => (r.ok ? r.json() : { products: [] })).then((j) => j.products || []).catch(() => [])));
  for (const p of pages.flat()) {
    const v = (p.variants || []).find((x) => x.available) || null;
    if (!v || !p.images?.length) continue;
    const price = Number(v.price);
    if (!(price >= 8) || JUNK.test(p.title) || JUNK.test(p.product_type || '')) continue;
    products.push({
      store: store.id, storeName: store.name,
      title: p.title, type: p.product_type || '', tags: (Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',')).map((t) => t.trim()).filter(Boolean).slice(0, 8),
      price, image: p.images[0].src, url: `https://${store.host}/products/${p.handle}`,
    });
  }
  cache.set(store.id, { at: Date.now(), products });
  return products;
}

function searchSlot(all, slot, maxPrice = Infinity) {
  const kws = (slot.keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  const excl = (slot.exclude || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  const scored = [];
  for (const p of all) {
    const title = p.title.toLowerCase(), type = p.type.toLowerCase(), tags = p.tags.join(' ').toLowerCase();
    if (p.price > maxPrice) continue;
    if (excl.some((e) => title.includes(e) || type.includes(e))) continue;
    let score = 0;
    for (const k of kws) {
      if (title.includes(k)) score += 4;           // whole phrase in the title
      if (type.includes(k)) score += 3;
      if (tags.includes(k)) score += 1;
      for (const w of k.split(/\s+/)) {            // and each word of it
        if (w.length < 3) continue;
        const re = new RegExp('\\b' + w.replace(/[^a-z0-9]/g, '') + 's?\\b');
        if (re.test(title)) score += 2;
        if (re.test(type)) score += 2;
      }
    }
    if (score > 0) scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // keep the shelf diverse: at most 4 per store, 18 total
  const perStore = {}, out = [];
  for (const s of scored) {
    perStore[s.p.store] = (perStore[s.p.store] || 0) + 1;
    if (perStore[s.p.store] > 2) continue;
    out.push(s.p);
    if (out.length >= 10) break;
  }
  return out;
}

// ---------- the model ----------
function findClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const found = [];
  for (const dir of ['.vscode-insiders/extensions', '.vscode/extensions']) {
    const root = path.join(os.homedir(), dir);
    try {
      for (const d of fs.readdirSync(root)) {
        if (!d.startsWith('anthropic.claude-code-')) continue;
        const bin = path.join(root, d, 'resources/native-binary/claude');
        if (fs.existsSync(bin)) found.push({ bin, v: d.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number) });
      }
    } catch {}
  }
  found.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return found[0]?.bin || 'claude';
}
const CLAUDE_BIN = findClaudeBin();
const EMPTY_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'stylist-'));

// Hosted on Google Cloud: Vertex AI with the service's own identity (no keys anywhere).
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || '';
const VERTEX_PLAN = process.env.VERTEX_PLAN_MODEL || 'gemini-2.5-flash';
const VERTEX_CURATE = process.env.VERTEX_CURATE_MODEL || 'gemini-2.5-flash';
let vtok = { v: '', exp: 0 };
async function vertexToken() {
  if (Date.now() < vtok.exp) return vtok.v;
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  const j = await r.json();
  vtok = { v: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return vtok.v;
}
async function askVertex(prompt, model) {
  const res = await fetch(`https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/global/publishers/google/models/${model}:generateContent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await vertexToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } } }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || `Vertex ${res.status}`);
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

async function askModel(prompt, model = MODEL) {
  if (VERTEX_PROJECT && !process.env.ANTHROPIC_API_KEY) return askVertex(prompt, model === PLAN_MODEL ? VERTEX_PLAN : VERTEX_CURATE);
  if (process.env.ANTHROPIC_API_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error?.message || `API ${res.status}`);
    return j.content.map((c) => c.text || '').join('');
  }
  // No key? Use the Claude Code login already on this machine, headless.
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MAX_THINKING_TOKENS: process.env.STYLIST_THINKING || '0' }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = spawn(CLAUDE_BIN, ['-p', '--model', model, '--output-format', 'text', '--max-turns', '1', '--tools', '', '--setting-sources', '', '--system-prompt', 'You are a personal stylist. Reply with JSON only, no code fences.'], { cwd: EMPTY_CWD, env });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 && out.trim() ? resolve(out) : reject(new Error((out || err || `claude exited ${code}`).slice(0, 300)))));
    child.stdin.end(prompt);
  });
}

function parseJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('model returned no JSON');
  return JSON.parse(text.slice(a, b + 1));
}

const PLAN_PROMPT = (brief) => `You are a personal stylist planning a shopping search across several independent clothing stores.
The shopper says: """${brief}"""

Decide which garment slots a complete outfit for this needs (3 to 5 slots, e.g. top, bottom, dress, outerwear, shoes, bag, jewelry).
For each slot give 6-10 lowercase search keywords. They are matched literally against product titles and product types, so lead with plain garment nouns (dress, blazer, sandal, tote, necklace, trouser, loafer) and add a few fabric or cut words. Do not use colours as keywords. Also give words to exclude.
Return ONLY JSON:
{"who":"women|men|unisex","budget":number|null,"vibe":"one short sentence","palette":["colour",...],"slots":[{"slot":"top","keywords":["..."],"exclude":["..."]}]}`;

const CURATE_PROMPT = (brief, plan, shelves, canRetry) => `You are a personal stylist. The shopper says: """${brief}"""
Your plan: ${JSON.stringify({ who: plan.who, budget: plan.budget, vibe: plan.vibe, palette: plan.palette })}

Below are LIVE, in-stock products pulled seconds ago from ${STORES.length} independent stores. Each line: id | store | title | type | price USD | tags.
${shelves}

Build ONE complete outfit: exactly one product per slot. Rules:
- The pieces must work TOGETHER (palette, formality, season) and suit the shopper (${plan.who}). Never pick an item made for a different gender than the shopper.
- Use at least 3 different stores across the outfit. That is the point: no single store could sell this look.
- BUDGET IS A HARD LIMIT${plan.budget ? ` of $${plan.budget}` : ''}: add up the prices of your picks before answering; if the sum is over, swap in cheaper pieces until it fits.
- Only use ids from the lists. Never invent a product.
${canRetry ? '- Only if a slot list is EMPTY, put it in "research" with better keywords and I will search again. Otherwise pick the best available and leave "research" empty.' : '- If a slot truly has nothing acceptable, omit it and say so in "note".'}
Return ONLY JSON:
{"title":"name of the look, max 6 words","note":"ONE sentence, max 25 words, on why the look works","picks":[{"slot":"top","id":"...","why":"max 12 words, say what it pairs with"}],"research":[{"slot":"shoes","keywords":["..."],"exclude":["..."]}]}`;

function shelfText(shelfBySlot) {
  return Object.entries(shelfBySlot).map(([slot, items]) =>
    `## ${slot}\n` + (items.length ? items.map((p) => `${p.id} | ${p.storeName} | ${p.title} | ${p.type} | $${p.price} | ${p.tags.slice(0, 5).join(', ')}`).join('\n') : '(nothing found)')).join('\n\n');
}

// ---------- the agent loop ----------
const sessions = new Map(); // id -> { brief, plan, shelves, byId, all, picks, title, history }

function makeFill(sess, say) {
  return (slot) => {
    const found = searchSlot(sess.all, slot, sess.plan.budget ? sess.plan.budget * 0.5 : Infinity);
    if (!found.length && sess.shelves[slot.slot]?.length) return; // a retry never makes a shelf worse
    sess.shelves[slot.slot] = found.map((p) => { const id = `${slot.slot.replace(/\W/g, '')}-${sess.byId.size + 1}`; const item = { ...p, id }; sess.byId.set(id, item); return item; });
    say('shelf', { slot: slot.slot, count: sess.shelves[slot.slot].length, stores: [...new Set(sess.shelves[slot.slot].map((p) => p.storeName))] });
  };
}

function finish(sess, look, say, t0) {
  const { plan, shelves, byId } = sess;
  const picks = (look.picks || []).map((k) => ({ ...k, product: byId.get(k.id) })).filter((k) => k.product);
  // The budget is enforced in code, not trusted to the model: swap the priciest piece down until it fits.
  const sum = () => picks.reduce((s, k) => s + k.product.price, 0);
  for (let guard = 0; plan.budget && sum() > plan.budget && guard < 6; guard++) {
    const over = sum() - plan.budget;
    const worst = [...picks].sort((a, b) => b.product.price - a.product.price)
      .map((k) => ({ k, alt: (shelves[k.slot] || []).filter((p) => p.price < k.product.price && !picks.some((x) => x.product.id === p.id)).sort((a, b) => (a.price <= k.product.price - over ? 0 : 1) - (b.price <= k.product.price - over ? 0 : 1) || b.price - a.price)[0] }))
      .find((x) => x.alt);
    if (!worst) break;
    say('step', { text: `Over budget by $${over.toFixed(0)}: swapping the ${worst.k.slot} for a cheaper match…` });
    worst.k.why = `Swapped in to keep the look inside $${plan.budget}.`;
    worst.k.product = worst.alt; worst.k.id = worst.alt.id;
  }
  sess.picks = picks; sess.title = look.title;
  say('look', { id: sess.id, title: look.title, note: look.note, picks, total: sum(), stores: [...new Set(picks.map((k) => k.product.storeName))], budget: plan.budget, seconds: Math.round((Date.now() - t0) / 1000) });
}

async function style(brief, say) {
  const t0 = Date.now();
  say('step', { text: 'Reading the brief and planning the search…' });
  const loading = Promise.all(STORES.map((s) => loadStore(s).then((p) => { say('store', { store: s.name, count: p.length }); return p; }).catch(() => { say('store', { store: s.name, count: 0 }); return []; })));
  const plan = parseJson(await askModel(PLAN_PROMPT(brief), PLAN_MODEL));
  say('plan', plan);
  const all = (await loading).flat();
  say('step', { text: `Searching ${all.length.toLocaleString()} live products across ${STORES.length} stores…` });
  const sess = { id: Math.random().toString(36).slice(2, 10), brief, plan, all, shelves: {}, byId: new Map(), picks: [], history: [] };
  sessions.set(sess.id, sess); if (sessions.size > 50) sessions.delete(sessions.keys().next().value);
  const fill = makeFill(sess, say);
  plan.slots.forEach(fill);

  say('step', { text: 'Putting the look together…' });
  const cp = CURATE_PROMPT(brief, plan, shelfText(sess.shelves), true);
  if (process.env.STYLIST_DEBUG) fs.writeFileSync('/tmp/stylist-curate-prompt.txt', cp);
  let look = parseJson(await askModel(cp));
  if (look.research?.length) {
    say('step', { text: `Nothing on the shelf for ${look.research.map((r) => r.slot).join(', ')}: searching again with new keywords…` });
    look.research.forEach(fill);
    look = parseJson(await askModel(CURATE_PROMPT(brief, plan, shelfText(sess.shelves), false)));
  }
  finish(sess, look, say, t0);
}

const REFINE_PROMPT = (sess, feedback, canSearch) => `You are a personal stylist. The shopper's brief: """${sess.brief}"""
${sess.history.length ? 'Earlier feedback you already applied: ' + sess.history.map((h) => `"${h}"`).join('; ') + '\n' : ''}You proposed this look ("${sess.title}"):
${sess.picks.map((k) => `- ${k.slot}: ${k.id} | ${k.product.storeName} | ${k.product.title} | $${k.product.price}`).join('\n')}

The shopper now says: """${feedback}"""

Revise the look to do what they asked. Keep every piece they did not complain about. Change only what the feedback needs, then make sure the pieces still work together.
LIVE, in-stock products you can choose from. Each line: id | store | title | type | price USD | tags.
${shelfText(sess.shelves)}

Rules: one product per slot; only ids from the lists; never invent a product; at least 3 different stores; ${sess.plan.budget ? `hard budget $${sess.plan.budget} unless the shopper just changed it (then put the new number in "budget")` : 'no budget unless the shopper just gave one (then put it in "budget")'}; never pick an item made for a different gender than the shopper (${sess.plan.who}).
${canSearch ? 'If the feedback needs a product that is NOT on the lists (a new slot like a hat, or a different kind of item for an existing slot), put that slot in "research" with 6-10 plain garment-noun keywords and I will search the stores again. Otherwise leave "research" empty.' : 'Work with what is on the lists.'}
Return ONLY JSON:
{"title":"max 6 words","note":"ONE sentence, max 25 words, saying what you changed and why it works","budget":number|null,"picks":[{"slot":"top","id":"...","why":"max 12 words"}],"research":[{"slot":"hat","keywords":["..."],"exclude":["..."]}]}`;

async function refine(id, feedback, say) {
  const t0 = Date.now();
  const sess = sessions.get(id);
  if (!sess) throw new Error('That look has expired. Start a new one.');
  say('step', { text: 'Rethinking the look with your note…' });
  let look = parseJson(await askModel(REFINE_PROMPT(sess, feedback, true)));
  if (typeof look.budget === 'number' && look.budget > 0) sess.plan.budget = look.budget;
  if (look.research?.length) {
    say('step', { text: `Going back to the stores for ${look.research.map((r) => r.slot).join(', ')}…` });
    const fill = makeFill(sess, say);
    look.research.forEach((r) => { delete sess.shelves[r.slot]; fill(r); });
    look = parseJson(await askModel(REFINE_PROMPT(sess, feedback, false)));
  }
  sess.history.push(feedback);
  finish(sess, look, say, t0);
}

// ---------- http ----------
const DAILY_CAP = Number(process.env.STYLIST_DAILY_CAP || 300);
let runs = { day: '', n: 0 };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/style' || url.pathname === '/api/refine') {
    const day = new Date().toISOString().slice(0, 10);
    if (runs.day !== day) runs = { day, n: 0 };
    if (++runs.n > DAILY_CAP) { res.writeHead(429); return res.end('daily demo limit reached'); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const say = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const q = (url.searchParams.get('q') || '').slice(0, 600);
    try { await (url.pathname === '/api/refine' ? refine(url.searchParams.get('id'), q, say) : style(q, say)); }
    catch (e) { say('fail', { text: String(e.message || e) }); }
    return res.end();
  }
  if (url.pathname === '/deck') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'public/deck.html'))); }
  if (url.pathname === '/api/stores') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(STORES)); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'public/index.html')));
}).listen(PORT, () => {
  console.log(`Cross-Store Stylist → http://localhost:${PORT}   model=${MODEL}   via=${process.env.ANTHROPIC_API_KEY ? 'Anthropic API' : VERTEX_PROJECT ? 'Vertex AI ' + VERTEX_CURATE : CLAUDE_BIN}`);
  STORES.forEach((s) => loadStore(s).catch(() => {})); // warm the catalog
});
