# Council-Bus — ONE Cloudflare Worker for five AI seats

The founder-approved architecture uses one authenticated Worker, **council-router**, with **multi-router.js** and **wrangler.council.jsonc**. The five seats are chatgpt, claude, deepseek, muse and perplexity. Older per-seat Worker configurations remain for compatibility and must not be deployed as part of this single-Worker launch.

## Contract

**POST /v1/chat/completions** with:
- Header **x-council-seat**: one canonical seat name.
- Header **Authorization**: Bearer token scoped to that seat.
- JSON body: **{"messages":[{"role":"user","content":"..."}]}**.

The model is selected server-side; the caller cannot override it. The adapter sets the x-council-seat header based on its --seat argument. The adapter's ROUTER_API_KEY environment variable must contain the token for the selected seat.

Use distinct Worker secrets **ROUTER_API_KEY_CHATGPT**, **ROUTER_API_KEY_CLAUDE**, **ROUTER_API_KEY_DEEPSEEK**, **ROUTER_API_KEY_MUSE**, and **ROUTER_API_KEY_PERPLEXITY**. The old shared ROUTER_API_KEY is **ignored** by this Worker so it cannot authorize access to other seats.

Provider credentials are stored only as Worker secrets: OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, MUSE_API_KEY, PERPLEXITY_API_KEY. Approved model names are configured through SEAT_MODEL_CHATGPT, SEAT_MODEL_CLAUDE, SEAT_MODEL_DEEPSEEK, SEAT_MODEL_MUSE, SEAT_MODEL_PERPLEXITY.

## Safety contract

Missing/unknown seat returns 400; wrong token returns 401; missing seat token, provider key or approved model returns 503. Errors from providers are redacted. Never substitute another provider or choose the model from the request. The health response reveals neither configured secrets nor provider readiness.

## Provider spending and rate limit gate

The consolidated Worker requires Cloudflare's bound **COUNCIL_RATE_LIMITER** for every authenticated provider request. Missing, failing or malformed limiter decisions return 503; over-limit requests return 429. Invalid/unauthenticated requests do not consume the provider allowance. The Wrangler binding uses namespace 71302401 and an **approximate 20 requests per 60 seconds per seat per Cloudflare location**. This is a safety throttle, **not a globally strict billing cap**; Cloudflare notes counters are eventually consistent. For strict account-wide cost control, use provider spending limits or Durable Objects.

The limiter runs only after the router has authenticated the selected seat and validated request messages, and before any provider call. The five seats share one Worker and one binding but have separate per-seat counter keys. The old per-seat Workers remain unchanged.

## Setup and launch

1. Verify provider endpoints and approved models before setting the SEAT_MODEL variables in wrangler.council.jsonc (the initial values are intentionally blank).
2. Configure every seat's router token and provider key as independent Worker secrets, never in Git:

~~~sh
npx wrangler secret put ROUTER_API_KEY_CHATGPT -c seats/router/wrangler.council.jsonc
npx wrangler secret put OPENAI_API_KEY -c seats/router/wrangler.council.jsonc
# Repeat for the other four seats with their matching secret names.
~~~

3. In the router directory run: **node --test**. At repository root run: **python3 -m unittest tests.test_seat_adapter**. Require green CI and a founder-authorized merge.
4. Deploy exactly once: **npx wrangler deploy -c seats/router/wrangler.council.jsonc**.
5. Test each seat with its own token and verified model, then verify its ledger response and the cross-seat denial cases. A deployed Worker with missing credentials is **not** operational.

This Worker is parallel to FCR's existing operator relay. Provider endpoint definitions copied from FCR are not proof of live provider availability. The original Perplexity Worker uses a different upstream endpoint; resolve that discrepancy with a real provider test.

The Council ledger records evidence. It does not grant execution authority.


## Durable production flow (one Worker)

The production main module is **workflow-entry.js**. It exports **CouncilApprovalWorkflow**, plus one Worker with HTTP, Queue, and Cron handlers. The original multi-router.js is an internal helper. The production entrypoint rejects legacy synchronous POST /v1/chat/completions (HTTP 409); clients must migrate to the reviewed durable intake.

1. **Submit** POST /v1/council/workflows using x-council-seat, the seat-scoped bearer token, an idempotency-key (8–80 URL-safe characters) and JSON messages. HTTP 202 returns a deterministic Workflow ID. Authentication, request validation, and intake rate limiting must pass before enqueuing.
2. **Queue** council-intake delivers the job to the same Worker, which starts council-approval-flow with the immutable instance ID. Duplicate deliveries are acknowledged only on a confirmed existing ID; other failures retry into council-intake-dlq.
3. **Approve** from a founder-authenticated Cloudflare Access session using the seat token: POST /v1/council/workflows/{id}/approve with JSON {"decision":"approve"}. The Workflow otherwise waits up to 24 hours before expiring. The approval endpoint must remain founder-only.
4. **Execute** only after the approval event. The Workflow uses the rate-limited provider router with zero automatic provider retries to avoid duplicate spending; persisted output omits raw provider response data and credentials.
5. **Inspect** GET /v1/council/workflows/{id} with matching seat and token for status.
6. **Cron** runs 0 12 * * * daily at 12:00 UTC and logs configuration health only. It never triggers AI calls or sends prompts.

The same council-router Worker serves all Council seats; it binds one council-approval-flow Workflow, one council-intake Queue and one council-intake-dlq dead-letter Queue. Queue messages contain private prompts and must have tightly scoped permissions and bounded retention.

### Logpush

The logpush flag in wrangler.council.jsonc enables eligible Worker trace-event delivery, but it does NOT create a Logpush job or export data by itself. Configure a dedicated, approved destination with verified ownership and the required Logpush entitlement before enabling an export job. Do not export all account Workers' logs without a filter scoped to council-router. Never log bearer tokens, prompts or provider raw responses.

### Release and migration gates

Run node --test in seats/router and python3 -m unittest tests.test_seat_adapter from repository root. Require exact-head CI and green checks on main prior to deployment. Preserve existing OPENAI_API_KEY, ROUTER_API_KEY_CHATGPT, SEAT_MODEL_CHATGPT, COUNCIL_RATE_LIMITER and observability bindings; an incomplete Cloudflare bindings upload can remove secrets. Independently verify production Queue, Workflow, Cron, Access and authenticated provider execution before declaring operational status.

The existing scripts/seat_adapter.py client is synchronous and is not yet a Workflow status-polling client. Migrate and test it before claiming end-to-end compatibility.
