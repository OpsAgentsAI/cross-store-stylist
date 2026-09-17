# The prompts, and how we used Claude Fable 5.1

Fable 5.1 did two jobs here: it **built** the app, and it **is** the stylist inside it.

## 1. Fable built it (Claude Code, one session, about an hour)

### The build brief

This is the full brief Fable worked to. It was given in six short messages over the hour (table below, as typed); this is what they add up to.

```
Build a one-page web app called Cross-Store Stylist. Zero dependencies, Node 20, one server file + one HTML page.

WHAT IT DOES
One stylist agent that puts together a full outfit from several independent public Shopify stores.
The shopper types an occasion and a budget ("rooftop dinner in Tel Aviv, woman, under $500").
They get one complete look: one real product per garment, from at least 3 different stores, inside
the budget, each with photo, price, a one-line reason, and a link to the real product page.

HOW
- No store integrations and no store API keys. Every Shopify storefront publishes /products.json:
  find stores that expose it, read them live at request time, keep in-stock items only, cache 30 min.
- Agent loop: PLAN (small fast model: brief → garment slots + literal search keywords + budget)
  → SEARCH (plain code, score per slot, keep the shortlist diverse across stores)
  → CURATE (Claude Fable 5.1: pick one product id per slot so the pieces work together)
  → if a shelf is empty, the stylist writes new keywords and the search runs again.
- The model may only return ids from the list it was shown. It can never invent a product or a price.
- Enforce the budget in code, not in the prompt: if a look is over, swap the priciest piece down.
- REFINE: under every look, a box: "swap the shoes for flats", "add a hat", "get it under $350".
  Keep what the shopper liked, change only what they didn't, go back to the stores if needed.
- Stream every step to the page so the room watches the agent work. A look in about 20 seconds.
- No API key on this laptop: drive the local Claude Code login headless (claude -p). Host a copy on Cloud Run.

PROVE IT
Run it end to end yourself, in a real browser, before you tell me it works. Fix what your own run gets wrong.
```

### The six messages, as typed

The whole app was written in a single Claude Code session running `claude-fable-5-1`. No code was typed by hand. These are the human prompts, in order, as typed (typos included):

| # | Prompt | What Fable did |
|---|---|---|
| 1 | "we build it now" + the brief: *"one styling agent that puts together a full outfit from several public Shopify stores"* | Probed which stores expose a public `/products.json`, found there was no API key on the machine, discovered it could drive the local Claude Code login headless (`claude -p`) as the model backend, wrote `server.js` + the page, ran it end to end, fixed a shallow-catalog problem it found in its own first run. |
| 2 | "move server to gcloud and host" | Found Claude models were not enabled on our Vertex AI project, added a second model path, deployed to Cloud Run, fixed two IAM blockers, verified the public URL with a real request. |
| 3 | "lets make a proper ui" · "add opsagents ai logo too" | Rewrote the page: editorial layout, live three-step progress, store chips that light up as catalogs load, a facts strip. Redrew the logo as inline SVG from a pasted image. |
| 4 | "it is very slow demo is 2 minutes" | Measured where the time went, then: thinking off, lean system prompt, shorter shortlists, tighter output. 50-80 s became about 20 s. It then **caught its own regression** (looks going over budget with thinking off) and moved the budget rule out of the prompt and into code. |
| 5 | "add a refinment option if user dont like the look" · "prompting refinment" | Added sessions, a `/api/refine` endpoint and the refine box. The refiner keeps what you liked, changes what you didn't, and goes back to the stores when you ask for something new ("add a hat"). |
| 6 | "lets try to make it reacher" | Added 14 stores chosen to fill gaps (formalwear, men's tailoring, ski, extended sizes), then re-ran the four briefs most likely to fail. |

Every step was verified by running the real thing (curl against the live endpoint, a headless browser clicking the page), not by reading the code.

## 2. Fable is the stylist (runtime)

Each request is a small agent loop. Code does what code is good at (fetching, filtering, arithmetic); the model does what needs judgment.

```
brief ──► PLAN (Haiku 4.5) ──► SEARCH (code, 27 live stores) ──► CURATE (Fable 5.1) ──► budget check (code) ──► look
                                        ▲                              │
                                        └── re-search if a shelf is empty ◄──┘
look + "swap the shoes" ──► REFINE (Fable 5.1) ──► maybe SEARCH again ──► budget check ──► new look
```

**Why Fable for the curate and refine steps:** it has to hold five constraints at once across ~50 real products: the pieces must work *together* (palette, formality, season), at least three different stores, a hard budget, the right gender, and never invent a product. In refinement it also has to keep what the shopper liked and change only what they didn't. That is the part smaller models got wrong in testing.

**How it is called:** with no API key, the server shells out to the Claude Code CLI already logged in on the machine: `claude -p --model claude-fable-5-1 --tools "" --max-turns 1`, prompt on stdin, JSON out. With `ANTHROPIC_API_KEY` set it uses the Messages API instead. (The public hosted copy runs the same prompts on Vertex AI Gemini, because Claude was not enabled on that cloud project.)

### The planner prompt (Haiku 4.5)

```
You are a personal stylist planning a shopping search across several independent clothing stores.
The shopper says: """{brief}"""

Decide which garment slots a complete outfit for this needs (3 to 5 slots, e.g. top, bottom, dress, outerwear, shoes, bag, jewelry).
For each slot give 6-10 lowercase search keywords. They are matched literally against product titles and product types, so lead with plain garment nouns (dress, blazer, sandal, tote, necklace, trouser, loafer) and add a few fabric or cut words. Do not use colours as keywords. Also give words to exclude.
Return ONLY JSON:
{"who":"women|men|unisex","budget":number|null,"vibe":"one short sentence","palette":["colour",...],"slots":[{"slot":"top","keywords":["..."],"exclude":["..."]}]}
```

### The stylist prompt (Fable 5.1)

```
You are a personal stylist. The shopper says: """{brief}"""
Your plan: {who, budget, vibe, palette}

Below are LIVE, in-stock products pulled seconds ago from {N} independent stores. Each line: id | store | title | type | price USD | tags.
{shelves}

Build ONE complete outfit: exactly one product per slot. Rules:
- The pieces must work TOGETHER (palette, formality, season) and suit the shopper. Never pick an item made for a different gender than the shopper.
- Use at least 3 different stores across the outfit. That is the point: no single store could sell this look.
- BUDGET IS A HARD LIMIT of ${budget}: add up the prices of your picks before answering; if the sum is over, swap in cheaper pieces until it fits.
- Only use ids from the lists. Never invent a product.
- Only if a slot list is EMPTY, put it in "research" with better keywords and I will search again.
Return ONLY JSON:
{"title":"name of the look, max 6 words","note":"ONE sentence, max 25 words, on why the look works","picks":[{"slot":"top","id":"...","why":"max 12 words, say what it pairs with"}],"research":[...]}
```

### The refine prompt (Fable 5.1)

```
You are a personal stylist. The shopper's brief: """{brief}"""
Earlier feedback you already applied: {history}
You proposed this look ("{title}"):
{current picks}

The shopper now says: """{feedback}"""

Revise the look to do what they asked. Keep every piece they did not complain about. Change only what the feedback needs, then make sure the pieces still work together.
{shelves}

Rules: one product per slot; only ids from the lists; never invent a product; at least 3 different stores; hard budget unless the shopper just changed it (then put the new number in "budget").
If the feedback needs a product that is NOT on the lists (a new slot like a hat), put that slot in "research" with keywords and I will search the stores again.
Return ONLY JSON: {title, note (what you changed and why), budget, picks, research}
```

The exact, current text of all three lives in `server.js` (`PLAN_PROMPT`, `CURATE_PROMPT`, `REFINE_PROMPT`).

## What we learned about prompting it

- **Don't ask the model to do arithmetic you can do yourself.** With thinking off, Fable went over budget about one run in three. The budget is now enforced in code: over-budget looks get their priciest piece swapped down before anyone sees them.
- **Give it an exit.** "If the shelf is empty, say so and I'll search again" produced better looks than forcing a pick.
- **Short outputs are the speed lever.** Capping `why` at 12 words and `note` at 25 cut latency more than any other change.
- **Ids, not names.** The model only ever returns product ids from the list it was shown, so it cannot invent a product or a price.
