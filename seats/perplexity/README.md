# seats/perplexity: Perplexity seat router

## Role on the council
Perplexity has no GitHub write path, so it cannot commit to this bus on its own. This Worker gives council automation one authenticated, rate-limited, secret-safe way to call Perplexity:
- a fixed endpoint (`POST /v1/chat/completions`), with no raw API key handed to each tool;
- upstream errors and secrets are never echoed back;
- callers must present `ROUTER_API_KEY`.

What it does NOT do yet: turn a Perplexity reply into a signed bus message. That adapter is the next build. Until it exists, a Perplexity reply that reaches the ledger through a human paste is BLOCKED, not PASS.

## Provenance

Source: Perplexity PDF export of 2026-11-21 (log dated 2026-08-31). It was rebuilt from that text and repaired by Claude.

## Repairs (the code as exported would not compile)
- `ConstructorParameters<…>[^4_0]` / `[^5_0]` → `[0]`. Citation markers had leaked into the code.
- `[[^5_250], [^5_500]]` → `[[250], [500]]` in the rate-limit test.
- `ChatCompletionCreateParamsNon…` and `…ParamsN` were cut off at the page edge → `ChatCompletionCreateParamsNonStreaming`.

## Proof (2026-11-21, openai 7.62.0, typescript 7.0.2, vitest 5.1.1)
- `npm run typecheck`: exit 0.
- `npm test`: 26/26 pass (25 from the original kit plus 1 auth test).
- Putting one corruption back: tsc exit 1 (TS1109), vitest parse failure.

## Not verified
- This is Perplexity's new generic router. It is not your original `worker/perplexity-router.js`, which nobody here has seen. Your real tests are the spec.
- It was never run against the live Perplexity API.
- Bearer check: was `!==`, which is not constant-time. FIXED: `safeEqual` compares SHA-256 digests using Workers-native `crypto.subtle.timingSafeEqual`, or a branch-free XOR fold on Node. A new test covers missing, short, long and prefix-less tokens; making `safeEqual` always return true fails 2 tests.
