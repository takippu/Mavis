# Testing, rollout and troubleshooting

## Contents

1. Test matrix
2. Credential and method probes
3. Sandbox flow
4. Live gate
5. Deployment sequence
6. Failure ladder
7. Operational monitoring

## Test matrix

### Money and request construction

- Whole and fractional MYR totals are integer sen.
- Fixed and percentage discounts match frozen local values.
- Zero/null or non-chargeable legacy records do not create Purchases.
- Product name is package-specific and bounded.
- Idempotency key is stable per payment attempt.
- Reference and metadata contain only required local identifiers.

### Callback security

- Valid raw body and correct key verifies.
- One whitespace change fails verification.
- Wrong public key fails.
- Missing, malformed and non-canonical base64 fail without throwing.
- Oversized declared or actual body is rejected.
- Invalid signature is rejected before JSON parsing or database lookup.
- Purchase success callback and global Webhook payload schemas are not conflated.

### Financial validation

- Unknown Purchase ID fails closed.
- Brand mismatch fails closed.
- Currency mismatch fails closed.
- Exact total mismatch fails closed.
- test/live mismatch fails closed.
- stored reference mismatch fails closed.
- non-paid Purchase never confirms locally.

### Idempotency and lifecycle

- First paid callback changes payment and entitlement once.
- Replayed callback returns 2xx and preserves timestamps.
- Concurrent callbacks converge.
- Reconciliation invokes the same confirmation service.
- Manual pre-approval can be upgraded with provider evidence without restarting lifecycle timestamps.
- Browser `?payment=success` cannot authorize payment.
- Email/provisioning runs only after commit and only on a fresh transition.

### Availability

- Provider failure after local commit preserves the order.
- Authenticated checkout retry creates or reuses the Purchase.
- Network timeout retries only with the same idempotency key.
- 502 does not create a second Purchase.
- Concurrent checkout clicks converge on one stored attempt.

## Read-only doctor

Use Node 20 or newer and load environment variables without adding dependencies:

```bash
node --env-file=.env skills/chip-payment-integration/scripts/chip-doctor.mjs --amount 1500
```

It checks:

- authenticated company public-key retrieval and SHA-256 fingerprint;
- payment methods for the configured Brand ID, MYR and exact amount;
- optional stored Purchase retrieval with sanitized output.

Retrieve a Purchase:

```bash
node --env-file=.env skills/chip-payment-integration/scripts/chip-doctor.mjs \
  --purchase 00000000-0000-0000-0000-000000000000
```

Print the callback public key only when deliberately configuring a secret store:

```bash
node --env-file=.env skills/chip-payment-integration/scripts/chip-doctor.mjs --print-public-key
```

The doctor performs GET requests only.

## Sandbox flow

1. Obtain test Secret Key, Brand ID and the matching callback public key.
2. Keep the customer flow disabled/manual while installing configuration.
3. Confirm the callback URL is public HTTPS and reaches the application.
4. Query payment methods with every real amount in sen.
5. Enable CHIP checkout in test mode.
6. Create a disposable local order through the real application flow.
7. Complete successful test payment.
8. Confirm callback signature, exact amount, local paid state and entitlement transition.
9. Replay the same signed callback and prove timestamps and mail do not repeat.
10. Test failure and cancel redirects; confirm local state remains pending.
11. Close the browser before return and prove callback still confirms.
12. Delay/block callback and prove authenticated reconciliation confirms.
13. Test wrong key, modified raw body and each identity mismatch.
14. Test provider outage after local order commit.
15. Remove disposable records through the application's approved cleanup path.

Do not use production credentials for sandbox testing.

## Live gate

Before switching to live:

- merchant onboarding and intended methods are active;
- live API key, Brand ID and public key are installed as one verified bundle;
- `CHIP_MODE=live` is explicit;
- payment-method lookup returns the intended methods for each amount;
- callback URL, DNS, TLS and proxy rules are correct;
- local migration and rollback paths are tested;
- support, refund and manual-fallback procedures are documented;
- admin clearly labels test versus live records;
- one low-value real-money smoke has separate explicit approval;
- reconciliation and logs can identify the test Purchase without exposing PII.

Never infer readiness from the checkout page merely loading. An account can create a Purchase while having no matching active terminal.

## Deployment sequence

Adapt to the project's documented deployment process. A typical VPS sequence is:

1. Pull the approved revision.
2. Install locked dependencies.
3. Load the intended production environment for migration tooling.
4. Apply additive migrations before starting code that queries new columns.
5. Build completely before replacing the running process.
6. Reload/restart with updated environment.
7. Check the local origin port.
8. Check the public callback and customer routes through the proxy.
9. Inspect process logs and database migration state.
10. Save the process manager state only after health checks pass.

Avoid deleting the existing production build before the new build succeeds. A transient local-port refusal immediately after reload can be startup timing; inspect process status and logs before repeating deployment commands.

For reminder jobs, call a protected POST endpoint with a strong Bearer secret. Use a scheduler interval shorter than the due-time precision, while persisted claims enforce one delivery.

## Failure ladder

### `401 unauthorized`

- Check the Bearer header and whitespace.
- Confirm the key belongs to the intended test/live environment and Brand.
- Confirm the app process actually loaded the updated environment.
- Never print the Secret Key.

### `400 invalid_request` or nested `__all__`

- Compare the request with current OpenAPI.
- Verify required client, product and Brand fields.
- Verify minor-unit integers.
- Remove unsupported locale values; Kenangan found `ms` was rejected and safely omitted the language field.
- Log only safe code/message in production.

### Empty `available_payment_methods`

- Include `brand_id`, `currency=MYR` and `amount` in sen.
- Use the same API key/environment as Purchase creation.
- Check merchant portal activation for FPX/cards/e-wallets/DuitNow.
- If still empty, contact CHIP; application code cannot activate a terminal.

### `no_matching_terminal`

- Treat it as merchant/payment-method provisioning until proven otherwise.
- Confirm available methods for the exact Brand, key, currency and amount.
- Do not mark the order failed permanently; allow retry after provider activation.
- Preserve the provider attempt's error code/message in the operational timeline.

### 502 or uncertain Purchase creation

- Do not create another Purchase with a new idempotency key.
- Check whether local evidence was persisted.
- Reuse the original key and identical request if retrying.
- Wait for asynchronous callback or retrieve a known Purchase.
- Escalate with Purchase ID, timestamp and sanitized response when persistent.

### Callback signature mismatch

- Confirm the exact raw bytes were captured before JSON middleware.
- Confirm base64 decoding and RSA PKCS#1 v1.5 SHA-256.
- Confirm the correct key type: company key for success callback, Webhook key for global Webhook.
- Confirm secret-store PEM newlines were restored from literal `\n`.
- Use the offline verifier against a saved raw body and signature.
- Never "fix" it by trusting the payload without verification.

### Paid at CHIP, pending locally

- Retrieve the stored Purchase server-side.
- Validate Purchase ID, Brand, currency, total, mode and reference.
- Run authenticated reconciliation through the same confirmation transaction.
- Inspect callback response logs for non-2xx and repeated delivery.
- Check database constraints or migration mismatch before manual state edits.

### Duplicate callback

- Return 2xx after validating it.
- Confirm guarded updates preserve original `paid_at` and entitlement timestamps.
- Confirm external effects are keyed to a fresh transition or outbox record.

### Reminder duplicate or early send

- Confirm `reminder_due_at` is persisted at creation rather than recomputed from changing data.
- Confirm overlapping workers claim rows under a lock/lease.
- Confirm pre-rollout rows have no due time unless intentionally enrolled.
- Confirm failed email releases the claim and successful email stamps sent time atomically.

## Monitoring

Track at least:

- Purchase-create success/error count by safe code;
- callback valid/invalid/duplicate count;
- callback-to-confirmation latency;
- reconciliation attempts and recoveries;
- pending payments older than expected;
- payment-method probe during live rollout;
- mode mismatches;
- reminder claimed/sent/failed counts.

Alert on financial mismatches, sustained 5xx, unexpected empty payment methods and paid-at-provider/pending-locally cases. Never alert with raw callback bodies or credentials.
