#!/usr/bin/env node

import { createHash } from "node:crypto";

const BASE_URL = "https://gate.chip-in.asia/api/v1";

function help() {
  console.log(`CHIP read-only diagnostics

Usage:
  node --env-file=.env chip-doctor.mjs [options]

Options:
  --amount <sen>          Query payment methods for this MYR amount (default: 1000)
  --purchase <id>         Retrieve and print a sanitized Purchase summary
  --print-public-key      Print the company callback public key after its fingerprint
  --help                  Show this help

Required environment:
  CHIP_SECRET_KEY
  CHIP_BRAND_ID           Required unless only --purchase is used

This script performs GET requests only.`);
}

function parseArgs(argv) {
  const args = { amount: 1000, purchaseId: null, printPublicKey: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { ...args, help: true };
    if (arg === "--print-public-key") {
      args.printPublicKey = true;
      continue;
    }
    if (arg === "--amount") {
      const value = argv[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) <= 0)
        throw new Error("--amount must be a positive integer in sen");
      args.amount = Number(value);
      continue;
    }
    if (arg === "--purchase") {
      const value = argv[++i];
      if (!value) throw new Error("--purchase requires a Purchase ID");
      args.purchaseId = value;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function chipGet(path, secretKey) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${secretKey}`,
      Accept: "application/json",
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const nested = body && typeof body === "object" ? body.__all__ : null;
    const code = nested?.code ?? body?.code ?? `http_${response.status}`;
    const message = nested?.message ?? body?.message ?? "CHIP request failed";
    throw new Error(`${code}: ${message}`);
  }
  return body;
}

function publicKeyFrom(body) {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return null;
  for (const key of ["public_key", "key"]) {
    if (typeof body[key] === "string") return body[key];
  }
  return null;
}

function sanitizedAttempts(value) {
  const attempts = value?.transaction_data?.attempts;
  if (!Array.isArray(attempts)) return [];
  return attempts.map((attempt) => {
    const error = attempt?.error;
    return {
      paymentMethod: typeof attempt?.payment_method === "string" ? attempt.payment_method : null,
      successful: typeof attempt?.successful === "boolean" ? attempt.successful : null,
      error: typeof error === "string"
        ? { message: error }
        : error && typeof error === "object"
          ? {
              code: typeof error.code === "string" ? error.code : null,
              message: typeof error.message === "string"
                ? error.message
                : typeof error.description === "string"
                  ? error.description
                  : null,
            }
          : null,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }

  const secretKey = required("CHIP_SECRET_KEY");
  const brandId = process.env.CHIP_BRAND_ID?.trim() ?? "";

  const keyBody = await chipGet("/public_key/", secretKey);
  const publicKey = publicKeyFrom(keyBody);
  if (!publicKey) throw new Error("CHIP public-key response did not contain a public key");
  console.log(JSON.stringify({
    publicKeySha256: createHash("sha256").update(publicKey).digest("hex"),
  }, null, 2));
  if (args.printPublicKey) console.log(publicKey);

  if (brandId) {
    const query = new URLSearchParams({
      brand_id: brandId,
      currency: "MYR",
      amount: String(args.amount),
    });
    const methods = await chipGet(`/payment_methods/?${query}`, secretKey);
    console.log(JSON.stringify({
      brandId,
      currency: "MYR",
      amount: args.amount,
      availablePaymentMethods: Array.isArray(methods?.available_payment_methods)
        ? methods.available_payment_methods
        : [],
      cardMethods: Array.isArray(methods?.card_methods) ? methods.card_methods : [],
      byCountry: methods?.by_country && typeof methods.by_country === "object"
        ? methods.by_country
        : {},
    }, null, 2));
  } else if (!args.purchaseId) {
    throw new Error("CHIP_BRAND_ID is required to query payment methods");
  }

  if (args.purchaseId) {
    const purchase = await chipGet(`/purchases/${encodeURIComponent(args.purchaseId)}/`, secretKey);
    console.log(JSON.stringify({
      id: purchase?.id ?? null,
      status: purchase?.status ?? null,
      isTest: purchase?.is_test ?? null,
      brandId: purchase?.brand_id ?? null,
      reference: purchase?.reference ?? null,
      currency: purchase?.purchase?.currency ?? null,
      total: purchase?.purchase?.total ?? null,
      checkoutUrl: purchase?.checkout_url ?? null,
      attempts: sanitizedAttempts(purchase),
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
