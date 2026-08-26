# Next.js, TypeScript and Postgres blueprint

Use this reference for a server-rendered TypeScript application. Adapt names to the target product; do not copy Kenangan-specific lifecycle coupling blindly.

## Framework preflight

For Next.js, read the installed version's local documentation before editing. Confirm Route Handler request APIs, runtimes, caching and async route parameters from `node_modules/next/dist/docs/`.

Use Node runtime for RSA verification:

```ts
export const runtime = "nodejs";
```

Keep provider modules server-only:

```ts
import "server-only";
```

## Suggested module boundaries

```text
src/lib/chip.ts                 typed HTTP client, payload builder, parser
src/lib/chip-signature.ts       pure raw-byte verifier
src/lib/chip-payments.ts        create/reuse, validate, reconcile, notify
src/lib/env.ts                  lazy server-only configuration
src/app/api/webhooks/chip/route.ts
src/app/api/.../payment/checkout/route.ts
src/app/api/.../payment/reconcile/route.ts
src/db/schema.ts
src/db/queries.ts               provider persistence + atomic confirmation
```

Keep parsing, signature verification and database transitions independently testable.

## Typed Purchase boundary

Do not trust `response.json()`:

```ts
interface ChipPurchase {
  id: string;
  status: string;
  is_test: boolean;
  brand_id: string;
  reference: string | null;
  checkout_url: string | null;
  purchase: { currency: string; total: number };
}
```

Parse `unknown` and reject missing or wrong-typed required fields. Accept extra provider fields without depending on them.

## Server client

Use native `fetch` with:

```ts
fetch(`${baseUrl}${path}`, {
  ...init,
  cache: "no-store",
  signal: AbortSignal.timeout(8_000),
  headers: {
    Authorization: `Bearer ${secretKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...init.headers,
  },
});
```

Normalize CHIP error shapes, including nested `__all__.code/message`. Never return provider internals or keys directly to the browser.

For Purchase creation, attach a stable `Idempotency-Key`. Do not retry an ambiguous 502.

## Purchase payload

Build from server data:

```ts
{
  brand_id: brandId,
  client: { email, ...(phone ? { phone } : {}) },
  purchase: {
    currency: "MYR",
    products: [{ name: boundedProductName, price: amountCents }],
    metadata: { order_id: orderId, payment_id: paymentId },
  },
  reference: `APP-${paymentId}`,
  success_callback: `${baseUrl}/api/webhooks/chip`,
  success_redirect: `${returnUrl}?payment=success`,
  failure_redirect: `${returnUrl}?payment=failed`,
  cancel_redirect: `${returnUrl}?payment=cancelled`,
  skip_capture: false,
  send_receipt: false,
}
```

Check current OpenAPI before using optional fields. Kenangan omitted `purchase.language` after CHIP rejected Malay `ms`; omitting it let the Brand's checkout language apply. Do not assume the provider supports every application locale.

## Exact signature helper

```ts
import { constants, verify } from "node:crypto";

export function verifyChipSignature(
  rawBody: Uint8Array,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  try {
    return verify(
      "RSA-SHA256",
      rawBody,
      { key: publicKeyPem, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}
```

Validate base64 strictly before decoding. Keep this function pure and test it with a generated RSA pair, the exact body, a modified body, wrong key and malformed signature.

## Route Handler ordering

```ts
export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-signature");
  if (!signature || !callbackPublicKey) return jsonError(503);

  rejectOversizedContentLength(req.headers);
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.byteLength > MAX_BYTES) return jsonError(413);
  if (!verifyChipSignature(raw, signature, callbackPublicKey)) return jsonError(401);

  const purchase = parseChipPurchase(JSON.parse(raw.toString("utf8")));
  const result = await processPaidPurchase(purchase, "chip_callback");
  return NextResponse.json({ ok: true, duplicate: !result.changed });
}
```

Do not call `req.json()` first. Do not put session authentication on the public provider callback. Authenticate it cryptographically instead.

Checkout and reconciliation routes are different: protect them with the application's owner/admin session and same-origin/CSRF policy.

## Drizzle/Postgres patterns

Use unique indexes on provider Purchase ID and idempotency key. Use guarded updates:

```ts
await tx
  .update(payments)
  .set({ status: "paid", paidAt: sql`now()` })
  .where(and(eq(payments.id, id), eq(payments.status, "pending")))
  .returning({ id: payments.id });
```

Use `is distinct from` when updating nullable provider evidence so repeated reconciliation does not rewrite timestamps or append duplicate events.

For concurrency-safe reminder batches:

```ts
await tx
  .select(...)
  .from(payments)
  .where(duePredicate)
  .for("update", { skipLocked: true });
```

Never hold this transaction while calling CHIP or the email provider.

## Reference implementation symbols

When adapting an existing implementation, resolve the active project through Mavis and inspect the equivalent symbols:

- `src/lib/chip.ts`: client, exact-sen payload, retries, payment-method lookup.
- `src/lib/chip-signature.ts`: strict base64 and RSA verification.
- `src/lib/chip-payments.ts`: identity validation, checkout reuse, error evidence, reconciliation.
- `src/app/api/webhooks/chip/route.ts`: raw-body ordering and response codes.
- `src/db/queries.ts`: `createEventWithPayment`, `saveChipPurchase`, `updateChipPurchaseStatus`, `confirmChipPayment`, reminder claims.
- `src/db/schema.ts`: provider evidence, event history and reminder leases.
- `drizzle/0012_abandoned_triathlon.sql`: exact-sen/provider backfill.
- `drizzle/0014_dear_kree.sql`: operational event history.
- `drizzle/0016_confused_dragon_man.sql`: one-shot reminder scheduling.

## Focused tests

At minimum add:

- payload and idempotency-key unit tests;
- 502 no-immediate-retry test;
- valid and modified-body RSA tests;
- callback invalid-signature-before-parse test;
- duplicate callback no-op test;
- every financial mismatch test;
- reconciliation paid/non-paid/error tests;
- concurrent checkout persistence test;
- real Postgres transaction test with rollback for money and entitlement transitions.

Money-path confidence requires a real database transaction exercise, not mocks alone.
