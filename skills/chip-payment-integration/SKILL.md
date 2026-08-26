---
name: chip-payment-integration
description: Integrate, review, harden, test, deploy, or troubleshoot CHIP Collect (chip-in.asia) payment flows. Use for CHIP API or hosted checkout, Purchase creation/retrieval, FPX/card/e-wallet/DuitNow availability, Brand ID and test/live credentials, success callbacks or webhooks, X-Signature and public-key verification, exact-sen charging, idempotency, reconciliation, payment records, refunds, or errors such as no_matching_terminal. Trigger on "integrate CHIP", "add CHIP payments", "CHIP Collect", "CHIP checkout", "CHIP callback/webhook", "gate.chip-in.asia", or an existing CHIP integration review. Do not use for CHIP Send/payouts or an unrelated payment provider unless CHIP Collect is explicitly selected.
---

# CHIP Payment Integration

Build CHIP Collect as a money-safe server integration. Treat the hosted browser redirect as user experience, not payment authority. Derive every financial transition from a verified success callback or an authenticated Purchase retrieval.

## Route the task

Classify the request before editing:

- **Credential or checkout probe:** run the read-only doctor and guide sandbox setup. Do not create a live Purchase without explicit approval.
- **New integration:** implement the complete order, Purchase, callback, reconciliation, state-transition and operations flow below.
- **Existing integration review:** trace every path from local order creation to paid state. Prove which input authorizes money or entitlement changes.
- **Incident or troubleshooting:** preserve evidence first, retrieve the Purchase server-side, and use the failure ladder in [testing-rollout-troubleshooting.md](references/testing-rollout-troubleshooting.md).
- **Refund request:** keep refunds in the CHIP portal unless the application already has an explicit refund state machine, authorization policy, idempotency and reconciliation.

## Load only the references needed

- Always read [official-sources.md](references/official-sources.md) before writing endpoint paths, request fields, statuses, callback behavior or signature code.
- Read [production-architecture.md](references/production-architecture.md) for schema, state machine, concurrency, retries, audit history, reminders and refunds.
- Read [nextjs-typescript-postgres.md](references/nextjs-typescript-postgres.md) only for Next.js, TypeScript, Node crypto, Drizzle or Postgres work, or when consulting Kenangan as the reference implementation.
- Read [testing-rollout-troubleshooting.md](references/testing-rollout-troubleshooting.md) for test planning, go-live, deployments, diagnostics or payment-method activation.

The official OpenAPI specification wins over this skill and memory. Re-fetch it when implementing. Never invent a remembered CHIP path.

## Apply the production workflow

### 1. Establish scope and approval gates

Determine:

1. Sandbox probe or full application integration.
2. Hosted checkout, Purchase success callback, global webhook, or a deliberate combination.
3. Currency, products, exact amount source, order lifecycle and the entitlement unlocked by payment.
4. Test or live credentials, Brand ID, callback key and reachable HTTPS base URL.
5. Whether manual payment remains an operational fallback.

Require a fresh explicit approval before using live credentials, creating a real-money test, refunding, deploying, migrating production data or changing live payment state.

Prefer CHIP hosted checkout for a first integration. It keeps payment data off the application and minimizes PCI scope. Do not choose Direct Post merely to restyle checkout.

### 2. Inspect the application before designing

Find:

- the authoritative order/payment tables and status transitions;
- how prices, taxes, discounts and coupons are frozen;
- authentication and authorization for checkout retry and reconciliation;
- existing callbacks, jobs, email and admin audit surfaces;
- framework raw-body behavior and server runtime;
- current environment loading, deploy process and database migration rules.

Do not bolt CHIP directly onto a UI button. Design the local financial record first.

### 3. Preserve the local order before contacting CHIP

Commit the local order and payment atomically. Store money as integer minor units; for MYR, RM9.60 is `960` sen. Freeze the price and discount inputs used to calculate that value.

Call CHIP only after the local transaction commits. Never hold a database transaction open across provider network I/O. A CHIP outage must not erase a valid local order; an authenticated user must be able to retry checkout later.

Use a payment-attempt table when one local payment may require multiple Purchases after expiry or cancellation. A one-Purchase-per-payment design is acceptable only when the product intentionally never renews a terminal Purchase.

### 4. Keep credentials server-only and environment-matched

Use server-only variables such as:

```text
PAYMENT_MODE=manual|chip
CHIP_MODE=test|live
CHIP_SECRET_KEY=
CHIP_BRAND_ID=
CHIP_CALLBACK_PUBLIC_KEY=
APP_BASE_URL=https://example.com
```

Never use a `NEXT_PUBLIC_`, browser-exposed, mobile-bundled or client-readable secret. Treat Secret Key, Brand ID, callback public key and expected `is_test` value as one environment-matched bundle. Never assume test and live values are interchangeable.

For a Purchase `success_callback`, retrieve the company-wide public key from the authenticated `GET /public_key/` endpoint. For a configured global Webhook, use that Webhook object's own `public_key`. Do not mix the two.

### 5. Build a narrow server client

Implement only documented paths and fields. Centralize:

- base URL and plural trailing-slash paths;
- Bearer authentication;
- JSON response validation;
- explicit timeout;
- bounded retry policy;
- normalized safe errors;
- secret-safe structured logging.

Generate a stable server-side `Idempotency-Key` from the local payment or attempt ID for Purchase creation. Reuse the same key and same request body for retries.

Retry 429 with jitter and respect `Retry-After`; retry 500/503 or network failure only when the same idempotency key makes the write safe. Treat 502 as ambiguous: do not immediately create another Purchase; wait for callback or retrieve/reconcile the existing result.

### 6. Create and persist the Purchase safely

Send:

- `brand_id`;
- customer email and only necessary customer fields;
- `purchase.currency`;
- products with integer minor-unit prices;
- a stable merchant reference and minimal metadata containing local IDs;
- `success_callback` for server delivery;
- separate success, failure and cancel redirects for presentation;
- explicit capture and receipt behavior.

Validate the returned Purchase before persisting it. Cross-check Brand ID, currency, total and `is_test`; require an HTTPS `checkout_url`. Persist Purchase ID, reference, checkout URL, status, idempotency key, mode and update time before exposing the URL.

Concurrent checkout requests must converge on the same stored Purchase or payment attempt. Enforce unique provider Purchase IDs and idempotency keys in the database.

### 7. Verify callbacks over exact raw bytes

Run callback verification on a server runtime with RSA support:

1. Bound `Content-Length` and actual body size.
2. Read exact raw bytes before JSON parsing.
3. Require a well-formed base64 `X-Signature`.
4. Verify RSA PKCS#1 v1.5 with SHA-256 using the correct public key.
5. Reject invalid signatures before parsing JSON or querying payment state.
6. Parse and schema-validate only after signature verification.

Do not verify a re-serialized JSON object. Whitespace or key ordering changes the signed bytes.

Distinguish payload shapes: a Purchase success callback sends a Purchase snapshot; a global Webhook sends an event envelope. Do not feed one shape into the other's parser.

Return 2xx for a valid duplicate. Return a non-2xx for an invalid signature, unknown Purchase or financial mismatch unless the application has a deliberate durable-quarantine policy. Expect CHIP to retry unsuccessful deliveries.

Use `scripts/verify-chip-signature.mjs` for offline exact-byte verification.

### 8. Cross-check financial identity

Resolve the local payment by the unique provider Purchase ID. Metadata is supporting evidence, never the lookup authority.

Before changing state, require:

- exact Purchase ID;
- expected Brand ID;
- expected currency;
- exact stored minor-unit total;
- expected test/live mode;
- expected merchant reference when stored;
- an authoritative paid state.

Fail closed on every mismatch and record a bounded, sanitized operational event. Never store Secret Keys, signatures, complete callback bodies, unmasked payment details or unnecessary customer data.

### 9. Converge callback and reconciliation

Implement one shared confirmation service. Both paths must call it:

- verified success callback;
- authenticated server-side `GET /purchases/{id}/` reconciliation.

Browser return parameters may trigger a visual "verifying" state or authenticated reconciliation, but must never mark the payment paid directly. Reconciliation repairs closed browsers, delayed callbacks and lost delivery acknowledgements.

### 10. Make confirmation atomic and duplicate-safe

In one database transaction:

1. Guard the payment transition from pending to paid.
2. Set provider status, confirmation source and `paid_at` only on the fresh transition.
3. Apply the paid entitlement or order transition only when its current state allows it.
4. Append bounded operational evidence.
5. Return whether the payment and entitlement changed.

Send email, analytics or other external effects only after commit and only for a fresh transition. A replay must not reset timestamps, resend mail, double-credit an account or restart a subscription/lifecycle clock.

Keep payment confirmation separate from later product-controlled lifecycle transitions when the product requires it. Kenangan correctly approves a gallery after payment but lets the host start its validity period later.

### 11. Build operational surfaces

Expose enough evidence to support customers without leaking sensitive data:

- local payment/order ID;
- exact amount and currency;
- provider Purchase ID/reference;
- provider and local statuses;
- test/live marker;
- confirmation source;
- created, paid and provider-updated timestamps;
- bounded event history with status, safe code, message and source.

Provide authenticated checkout retry and reconciliation. Keep manual overrides explicit and audited. Do not present "mark unpaid" as a refund for a provider-confirmed payment.

If payment reminders are required, schedule them from a persisted due time, claim rows with locking or an atomic lease, send once, release failed claims and keep pre-rollout rows unenrolled unless intentionally backfilled.

### 12. Verify before live enablement

Run the complete matrix in [testing-rollout-troubleshooting.md](references/testing-rollout-troubleshooting.md). At minimum prove:

- exact sen and discounts;
- correct Purchase payload and stable idempotency;
- valid, invalid and modified-body signatures;
- success, failure and cancel flows;
- closed-browser callback;
- delayed callback and reconciliation;
- duplicate callback timestamp stability;
- Brand, currency, amount, reference and mode mismatch rejection;
- provider timeout/502 without duplicate Purchase;
- concurrent checkout convergence;
- local order survival during provider failure;
- no entitlement start from browser redirects;
- test/live isolation and actual payment-method availability.

Query `GET /payment_methods/` with the real Brand ID, API key, currency and amount for every price point. An empty list or `no_matching_terminal` usually means the merchant's payment terminal/method is not active for that environment; changing application code will not activate it.

## Use the bundled diagnostics

Run read-only API checks with Node 20 or newer:

```bash
node --env-file=.env skills/chip-payment-integration/scripts/chip-doctor.mjs --amount 1500
node --env-file=.env skills/chip-payment-integration/scripts/chip-doctor.mjs --purchase <purchase-id>
```

Run the offline verifier:

```bash
node skills/chip-payment-integration/scripts/verify-chip-signature.mjs \
  --body callback.raw --signature-file signature.txt --public-key chip-public.pem
```

The doctor performs GET requests only. It never creates, captures, refunds, cancels or marks a Purchase paid.

## Leave behind

Deliver:

- implemented server code and additive migrations;
- focused automated tests plus the full project verification;
- `.env.example` placeholders without credentials;
- callback and reconciliation URLs;
- sandbox and live enablement checklist;
- payment-method probe result;
- explicit remaining portal/provider activation dependencies;
- rollback or manual-fallback instructions;
- no commit, push, migration, deploy or live-money action without current approval.
