# seats/router: one router, one Worker per seat

`seat-router.js` is a dependency-free Cloudflare Worker. It is deployed once per council seat, so each Worker holds only that seat's provider key. Founder decision (2026-11-22): this runs **in parallel with** Founder Control Room's operator relay. It does not replace it.

| Seat | Worker | Provider endpoint | Key secret | Allowed `SEAT_MODEL` |
|---|---|---|---|---|
| claude | `council-seat-claude` | `https://api.anthropic.com/v1/messages` | `ANTHROPIC_API_KEY` | `[A-Za-z0-9._-]{1,160}` |
| chatgpt | `council-seat-chatgpt` | `https://api.openai.com/v1/responses` | `OPENAI_API_KEY` | `[A-Za-z0-9._-]{1,160}` |
| deepseek | `council-seat-deepseek` | `https://api.deepseek.com/responses` | `DEEPSEEK_API_KEY` | `deepseek-flash`, `deepseek-v4-pro` |
| muse | `council-seat-muse` | `https://api.meta.ai/v1/responses` | `MUSE_API_KEY` | `muse-spark-1.1`–`1.3` |
| perplexity | `council-seat-perplexity` | `https://api.perplexity.ai/v1/agent` (web search on) | `PERPLEXITY_API_KEY` | `sonar` or `vendor/model` |

Endpoints, request bodies, model allowlists and reply parsing mirror FCR's `src/lib/operatorRelayModelProviders.ts` and `operatorRelayMuseProvider.ts` (FCR `main` `b8e0c3b`). When FCR changes a provider, change it here too.

## Contract
`POST /v1/chat/completions` with `Authorization: Bearer <ROUTER_API_KEY>` and `{"messages": [{"role", "content"}]}`.

The reply is a `chat.completion` envelope plus `seat` and `provider: {name, endpoint, status, raw}`. `raw` is the provider's exact response text, so `scripts/seat_adapter.py` attaches it to the bus message for audit, bound by sha256.

Fails closed: an unknown `SEAT`, a missing key, a missing or disallowed `SEAT_MODEL`, a bad token, a provider error, a non-completed or oversized (>64 KiB) reply. Provider error bodies are never echoed. The caller cannot choose the model, and the router never falls back to another seat.

## Deploy (founder)
```sh
npx wrangler secret put ROUTER_API_KEY -c seats/router/wrangler.deepseek.jsonc
npx wrangler secret put DEEPSEEK_API_KEY -c seats/router/wrangler.deepseek.jsonc
npx wrangler deploy -c seats/router/wrangler.deepseek.jsonc --var SEAT_MODEL:deepseek-flash
```
Then answer a bus message:
`ROUTER_API_KEY=... python3 scripts/seat_adapter.py --seat deepseek --thread <t> --router-url https://council-seat-deepseek.<account>.workers.dev`

## Proof (local)
`node --test`: 13 tests. Each seat's endpoint, auth header, model and parsing, plus every refusal path. Seven guard mutations were tried, and each one fails the suite.

## Not verified
- No provider has been called live from this router.
- Endpoints are copied from FCR source, which has not been observed working live either (FCR's own next gate is a live round trip).
- `seats/perplexity/` (PR #9) calls `https://api.perplexity.ai/orchestrator/v1/chat/completions`, which disagrees with FCR's `/v1/agent`. At most one of them is right, and a live call decides which. Until then, prefer this router for Perplexity.
