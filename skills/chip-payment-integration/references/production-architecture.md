# Production architecture

## Contents

1. Financial model
2. State machine
3. Purchase and attempt model
4. End-to-end flow
5. Idempotency and concurrency
6. Callback security
7. Confirmation transaction
8. Reconciliation
9. Observability and privacy
10. Reminders and refunds

## Financial model

Keep the local database authoritative for what the customer intended to buy. CHIP is authoritative for whether the matching Purchase was paid.

Store integer minor units:

```text
currency = MYR
amount_minor = 960
display = RM9.60
```

Freeze line items, base amount, discounts, taxes and coupon identifiers when the order is created. Never recalculate a historical charge from a current price catalogue. If migrating from whole-RM storage, add a new minor-unit column, backfill with inspected integer-safe SQL and retain the legacy field temporarily for rollback.

## State machine

Separate provider state, local payment state and product entitlement state:

```text
Provider Purchase: created/viewed/.../paid/cancelled/expired/error
Local payment:     pending -> paid -> refunded or partially_refunded if implemented
Product/order:     pending -> approved/fulfilled/active according to product rules
```

Do not collapse all three into one string. A user may close checkout while the local order remains valid; a payment may be paid while a subscription waits for provisioning; a refund may require entitlement reversal.

Define allowed transitions and the effect of manual operations before coding.

## Recommended data model

For a simple one-attempt integration:

```text
payments
  id, order_id
  currency, amount_minor
  status, paid_at
  provider
  provider_purchase_id unique
  provider_reference
  provider_checkout_url
  provider_status
  provider_idempotency_key unique
  provider_is_test
  provider_updated_at
  confirmation_source
  created_at, updated_at
```

For a durable retryable integration, prefer:

```text
payments
  id, order_id, currency, amount_minor, status, paid_at, refunded_minor

payment_attempts
  id, payment_id
  provider
  provider_purchase_id unique
  provider_reference
  checkout_url
  provider_status
  idempotency_key unique
  is_test
  terminal_at
  created_at, updated_at

payment_events
  id, payment_id, attempt_id nullable
  kind, level, provider_status, safe_code, message, source, created_at
```

Use attempts when expired/cancelled Purchases may be replaced. Never overwrite evidence for an earlier attempt with a new Purchase ID.

Add database checks for known local states and provider names. Use partial or nullable unique indexes as supported by the database. Preserve audit logs independently of deletable business records when destructive admin actions must remain provable.

## End-to-end flow

```text
Create order
  -> transaction: order + payment(amount_minor)
  -> commit
  -> create/reuse CHIP Purchase with stable Idempotency-Key
  -> validate returned identity
  -> persist attempt evidence
  -> expose checkout_url

Customer -> CHIP hosted checkout

CHIP success callback
  -> read bounded raw bytes
  -> verify X-Signature
  -> parse Purchase
  -> match provider Purchase ID
  -> validate Brand/currency/amount/mode/reference/paid
  -> atomic confirmation

Browser return
  -> presentation only
  -> optional authenticated reconciliation

Reconciliation
  -> GET stored Purchase ID with Secret Key
  -> same identity validation
  -> same atomic confirmation
```

## Purchase creation

Create the local payment first. Build the CHIP request entirely from server-side records. Use a stable idempotency key such as `<app>-payment-<payment-id>` or `<app>-attempt-<attempt-id>`.

Validate the response before storing it:

- required string ID and status;
- expected Brand ID;
- expected currency and integer total;
- expected `is_test` value;
- HTTPS checkout URL;
- expected reference when CHIP returns one.

Persist before returning the URL. If concurrent callers race, use a guarded update or unique constraint and then reload the winning record.

## Idempotency and concurrency

Idempotency exists at several layers:

1. CHIP `Idempotency-Key` prevents duplicate provider writes.
2. Unique provider Purchase ID/key prevents conflicting local evidence.
3. Guarded local status updates prevent repeated business effects.
4. Outbox/event markers prevent repeated external mail or provisioning.

The provider key does not replace database constraints. The database guard does not replace the provider key.

Retry rules:

| Condition | Default action |
|---|---|
| 400/401/403/404/409/422 | Do not blind-retry; correct the request, credentials or state |
| 429 | Back off with jitter; honor `Retry-After` |
| 500/503 | Retry bounded with the same idempotency key |
| 502 | Do not immediately retry; await callback or retrieve/reconcile |
| Network timeout | Retry only with identical body and idempotency key |

## Callback security

Verify the exact received byte sequence before parsing. Bound both declared and actual body size. Reject absent, malformed or unverifiable signatures.

Pseudocode:

```text
raw = readRawBody(maxBytes)
sig = base64Strict(header[X-Signature])
ok = RSA_PKCS1_V1_5_SHA256_VERIFY(publicKey, raw, sig)
if !ok: reject
payload = parseAndValidate(raw)
```

Public-key choice is payload-specific:

- Purchase success callback: company-wide key from `GET /public_key/`.
- Global Webhook: key stored on that Webhook resource.

Signature verification proves origin and byte integrity. It does not prove the callback belongs to the local order. Financial identity checks remain mandatory.

## Confirmation transaction

Run one transaction shared by callback and reconciliation:

```text
select payment + entitlement by provider_purchase_id
if missing: fail closed

if payment.status == pending:
  update payment to paid where status == pending
  set paid_at, provider_status, confirmation_source
  paymentChanged = rowCount == 1

if provider evidence is stale but payment was manually paid:
  upgrade provider evidence without resetting paid_at

if entitlement is eligible:
  guarded transition
  entitlementChanged = rowCount == 1

append bounded payment event only for a meaningful transition
commit
```

After commit, trigger external effects only when the returned transition flags are true. For high reliability, use a transactional outbox rather than directly sending email.

Duplicate success must be a real no-op: keep original timestamps, do not resend mail and do not re-credit or restart validity.

## Reconciliation

Expose reconciliation only to an authenticated owner/admin or a protected scheduled job. Retrieve the Purchase ID already stored locally; never accept an arbitrary Purchase ID from an unauthenticated browser.

Use the same financial validation and confirmation transaction as the callback. Record non-paid status transitions without converting them into local payment success.

For high-volume systems, add a scheduled reconciliation queue for Purchases stuck in non-terminal states beyond a threshold. Rate-limit and batch it.

## Observability and privacy

Keep the payment row as current truth and an append-only event table as explanation. Store bounded fields:

- local IDs and provider Purchase ID;
- provider status and safe error code;
- sanitized human-readable message;
- source such as API, callback, reconciliation, admin or system;
- timestamps and test/live flag.

Never log or persist Secret Keys, callback signatures, full raw payloads, unmasked card data, bank credentials or unnecessary PII. CHIP's docs may recommend logging a full response for debugging; restrict that to a controlled development environment. Production logs should be sanitized and retention-limited.

## Reminders

Persist `reminder_due_at`, `reminder_claimed_at` and `reminder_sent_at`. Claim due rows inside a transaction with row locks and `skip locked`, or use an atomic compare-and-set lease. Give claims a TTL so crashed workers can retry.

Before sending, re-check that the payment is pending and the destination is valid. Mark sent and append an event atomically after delivery. Release the claim on failure. Do not backfill old rows automatically unless a bulk reminder campaign is explicitly approved.

## Refunds

Portal-only refunds are the safe first release. Do not add an API refund button until the application defines:

- full and partial refund states;
- maximum refundable amount from current provider data;
- authorization and in-app confirmation;
- a stable refund idempotency key;
- a refund/attempt record and audit log;
- entitlement reversal policy;
- callback or retrieval reconciliation;
- customer notification and support procedure.

Never implement refund by changing a paid row to unpaid. That destroys financial history.
