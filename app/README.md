# Council-Bus founder workspace — release-gated implementation

This package introduces **real, server-verified identity gates** and a **private, append-only D1 draft ledger** without changing the approved visual prototype (`site/preview.html`). The new `site/founder.html` uses the approved scenery and colored-glass language, but is a separate functional workspace.

## Security / separation

- `functions/api/[[path]].js` is the Cloudflare Pages Functions server-side API. All `/api/*` calls validate the **RS256-signed Cloudflare Access JWT** from the `Cf-Access-Jwt-Assertion` header, checking the exact team issuer, application audience, expiration and single founder email against Cloudflare's JWKS. Client-supplied email or password never authenticate.
- All reads and writes are scoped to the signed identity's `email`. Without verified Access, or without the private D1 binding, the API fails closed. POST rejects cross-origin requests. Only HTTPS evidence links are stored; no remote URL is fetched.
- `COUNCIL_DB` is a private D1 binding. `db/0001_founder_app.sql` creates immutable drafts, workflow links, and append-only events. These are **UNSEALED, UNKNOWN** until the existing GitHub ledger review/sealing pipeline verifies them. A D1 record is not a signed GitHub council message.
- Five seats have configuration/readiness states; **configured does not mean live-verified**. Server-to-server `COUNCIL_ROUTER` service binding uses per-seat tokens stored **only as Cloudflare secrets**, not browser code.
- All queue operations require valid founder identity, known owner draft, and server-generated idempotency. No provider is called until founder approval is independently verified. The router's `/approve` endpoint must separately validate Access JWT; seat-token-only approval is forbidden.
- Provider error text, tokens and raw responses never go to the browser logs. No admin/bypass endpoints or implicit approval.

## Required Cloudflare setup before launch (fail closed otherwise)

1. Create a **separate founder-only Access application** for the private workspace host, with the existing founder-only identity policy. Do not make the public marketing site private. Record its **Access audience** and organization domain in the following server-only settings.
2. Configure `COUNCIL_ACCESS_TEAM_DOMAIN` (e.g. `https://team.cloudflareaccess.com`), `COUNCIL_ACCESS_AUD`, and `COUNCIL_FOUNDER_EMAIL` **in server-side Pages Functions AND the Council Worker**. Do not commit their actual values to GitHub or expose them to browser code. The Worker must validate the **same signed founder assertion** before approval.
3. Provision D1 database separately, migrate `db/0001_founder_app.sql`, and bind it to Pages as `COUNCIL_DB`.
4. Bind the existing protected `council-router` as Pages Functions service binding `COUNCIL_ROUTER`, and provision per-seat router keys on the Pages project only for founder-authorized seats. **Do not** enable any unverified provider keys or models.
5. Enforce Access on the entire **private** hostname. Public design preview can remain accessible; it does not have permission to query the private D1 DB, and cannot authenticate with fake passwords.
6. Verify same-origin Pages API requests, D1 persistency, denial to non-founder identity, cross-seat denial, queue receipt, explicit approval, sanitized completion, and GitHub seal before enabling marketing links to founder workspace. Review immutable ledger retention and deletion requirements before storing actual customer data.

## Testing

`node --test app/*.test.mjs` runs local identity, authorization, evidence, seat, and queue security tests. `python3` + SQLite may validate migration triggers. GitHub checks must run on exact PR head; a green CI status does **not** establish production authentication, D1 binding, or real provider readiness.

## Release truth

**Auth API:** authored/tested, must be configured and verified behind Access. **Database:** schema authored/tested, provisioning and migration required. **Router:** existing approval-gated Workflow, add independent founder check before deployment. **Sealing:** remains via existing GitHub ledger PR process. **Deployment:** no production claim until Cloudflare live smoke tests pass.
