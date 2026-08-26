# Official sources and retrieval rules

Use current CHIP sources before implementing. These URLs are authoritative for API shape; the local references in this skill are architecture guidance.

## Source order

1. **AI documentation index:** https://docs.chip-in.asia/llms.txt
2. **CHIP Collect OpenAPI:** https://docs.chip-in.asia/openapi/chip-collect.yaml
3. **Rendered API reference:** https://docs.chip-in.asia/chip-collect/api-reference/purchases/create
4. **Authentication:** https://docs.chip-in.asia/chip-collect/overview/authentication
5. **Webhook signatures:** https://docs.chip-in.asia/chip-collect/overview/webhook-signatures
6. **Callbacks and delivery:** https://docs.chip-in.asia/chip-collect/overview/callbacks
7. **Errors and idempotency:** https://docs.chip-in.asia/chip-collect/overview/errors
8. **Retrieve Purchase:** https://docs.chip-in.asia/chip-collect/api-reference/purchases/retrieve
9. **Payment methods:** https://docs.chip-in.asia/chip-collect/api-reference/payment-methods/list
10. **Public key:** https://docs.chip-in.asia/chip-collect/api-reference/public-key/retrieve
11. **Official agent skill:** https://github.com/CHIPAsia/skill
12. **Status:** https://status.chip-in.asia
13. **Brand assets:** https://www.chip-in.asia/brand

Do not substitute the legacy monolithic page at `developer.chip-in.asia/api.html` when the newer OpenAPI and rendered reference are available.

## Current contract facts to re-check

- CHIP Collect base URL is `https://gate.chip-in.asia/api/v1`.
- Resource paths are plural and end with a trailing slash, such as `/purchases/{id}/`.
- Collect requests use `Authorization: Bearer <secret_key>` and must originate server-side.
- Purchase product prices and totals use the currency's smallest indivisible unit; `100` is RM1.00.
- Create Purchase returns a `checkout_url`.
- Payment state can be checked through a Purchase `success_callback`, authenticated Purchase retrieval, or global Webhooks.
- Success callbacks send a signed Purchase snapshot. Global Webhooks send an event envelope and have their own Webhook public key.
- `X-Signature` is a base64 RSA PKCS#1 v1.5 signature over the SHA-256 digest of the exact raw request body.
- The company-wide success-callback key comes from `GET /public_key/`; a global Webhook's key comes from `Webhook.public_key`.
- Unsuccessful callback delivery is retried up to eight additional times with increasing intervals and stops after 36 hours. Valid duplicate delivery remains possible after the receiver sent 2xx.
- Write operations support a server-generated `Idempotency-Key`.
- A 502 is ambiguous and should not be retried immediately; wait for asynchronous evidence or retrieve state.
- Payment-method lookup must include the same API key, Brand ID and currency used for the Purchase. Include `amount` in minor units or FPX/DuitNow/e-wallet methods may be omitted because of minimums.

If any item differs in current docs or OpenAPI, update the implementation to current official behavior and record the discrepancy.

## Purchase success callback versus Webhook

Choose deliberately:

| Concern | Purchase `success_callback` | Global Webhook |
|---|---|---|
| Configuration | URL included when creating the Purchase | Separate Webhook resource or portal configuration |
| Payload | Purchase snapshot with `event_type` | Event envelope containing an object |
| Public key | Company-wide `GET /public_key/` | `Webhook.public_key` |
| Typical use | Straightforward paid confirmation for one Purchase | Broader event coverage including failures and lifecycle events |

Never parse both with one unchecked schema.

## Branding

Fetch assets from the official brand page rather than redrawing the mark. Respect the horizontal lockup, clear space, approved colors and background variants. Use a provided "Pay with CHIP" or "Powered by CHIP" badge only where payment-provider identification is useful; do not imply CHIP endorses the merchant.

Do not bundle CHIP logos into this skill. The brand owner may update assets or usage terms.

## Reference implementation checklist

Resolve the active application through Mavis project routing; do not hardcode a machine path. Inspect the equivalent durable source symbols:

- `src/lib/chip.ts`
- `src/lib/chip-signature.ts`
- `src/lib/chip-payments.ts`
- `src/app/api/webhooks/chip/route.ts`
- `src/app/api/events/[slug]/manage/payment/{checkout,reconcile}/route.ts`
- `src/db/schema.ts` payments and payment-events tables
- `src/db/queries.ts` `saveChipPurchase`, `confirmChipPayment` and reminder claims
- `drizzle/0012_abandoned_triathlon.sql`
- `drizzle/0014_dear_kree.sql`
- `drizzle/0016_confused_dragon_man.sql`

Consult these for proven patterns, then adapt names and lifecycle behavior to the target project.
