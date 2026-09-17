# Cross-Store Stylist

**One agent. A dozen independent Shopify stores. One outfit no single store could sell you.**

Built in one hour at the Tel Aviv Claude Code Build Day (track: Breakthrough) by OpsAgents AI.

Tell it where you're going ("rooftop dinner in Tel Aviv in September, woman, under $500").
It plans the outfit, searches the **live** catalogs of 27 unrelated stores at once,
and assembles one coherent look across brands, in budget, with a reason for every piece and a buy link.

No store integration, no API keys from the stores, no partnership: every Shopify storefront
already publishes `/products.json`. The agent is the integration.

**Live:** https://cross-store-stylist-611895754140.us-central1.run.app (hosted copy runs on Vertex AI Gemini; the laptop demo runs on Claude Fable 5.1)

## How it works

1. **Plan** (Claude Haiku 4.5): brief → garment slots, search keywords, budget, palette.
2. **Search** (plain code): ~15,000 in-stock products pulled live from 27 stores, scored per slot, shelf kept diverse across stores.
3. **Curate** (Claude Fable 5.1): ~60 real candidates → one product per slot. Rules: pieces must work together, at least 3 stores, total inside budget, never invent a product.
4. **Re-search**: if a shelf has nothing acceptable, the stylist refuses to force it, writes new keywords, and the search runs again.

5. **Refine by talking**: "swap the shoes for flats", "add a hat", "get it under $350". The stylist keeps what you liked, changes what you didn't, and goes back to the stores if it needs something new.
6. **The budget is enforced in code**, not trusted to the model: an over-budget look gets its priciest piece swapped down before you see it.

Everything streams to the page, so you watch the agent work. A look takes about 20 seconds; a refinement about 10.

## Run it

```bash
node server.js          # Node 20+, zero dependencies
open http://localhost:4747
```

Model access, either one:
- `ANTHROPIC_API_KEY=...` uses the Messages API.
- No key: it drives the Claude Code CLI already logged in on your machine, headless (`claude -p`). Set `CLAUDE_BIN` if `claude` is not on your PATH.

Options: `STYLIST_MODEL` (default `claude-fable-5-1`), `STYLIST_PLAN_MODEL`, `STYLIST_PAGES` (catalog depth per store, default 4).

## Host it (Cloud Run)

Hosted, there is no Claude Code login, so it needs `ANTHROPIC_API_KEY` (kept in Secret Manager, never in the image):

```bash
printf '%s' "$ANTHROPIC_API_KEY" | gcloud secrets create stylist-anthropic-key --data-file=- --project=$P
gcloud run deploy cross-store-stylist --source . --project=$P --region=me-west1 \
  --allow-unauthenticated --max-instances=2 --timeout=300 \
  --update-secrets=ANTHROPIC_API_KEY=stylist-anthropic-key:latest
```

Add a store: one line in `STORES` in `server.js`. Any Shopify domain works.

## The prompt that built it

> Build a one-page web app: one stylist agent that assembles a complete outfit across several
> independent public Shopify stores. Live catalogs from `/products.json`, no integrations.
> The agent plans the slots, searches every store, picks one product per slot so the pieces
> work together, uses at least 3 stores, respects the budget, explains each pick, and re-searches
> when a shelf is empty. Stream the steps to the page. Zero dependencies.

## Notes

Catalog data is read from each store's public storefront endpoint at request time and cached in memory for 30 minutes. Nothing is stored. Product names and images belong to their brands; this is a demo and is not affiliated with any of them.

MIT licence.
