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
