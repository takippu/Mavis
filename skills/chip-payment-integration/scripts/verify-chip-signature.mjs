#!/usr/bin/env node

import { constants, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

function help() {
  console.log(`Verify a CHIP callback signature over exact raw bytes

Usage:
  node verify-chip-signature.mjs --body <file> --signature-file <file> --public-key <pem-file>
  node verify-chip-signature.mjs --self-test

The signature file must contain the base64 X-Signature value. The body file is
read as bytes and is never parsed or printed.`);
}

function parseArgs(argv) {
  const args = { body: null, signatureFile: null, publicKey: null, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { ...args, help: true };
    if (arg === "--self-test") {
      args.selfTest = true;
      continue;
    }
    if (arg === "--body") args.body = argv[++i] ?? null;
    else if (arg === "--signature-file") args.signatureFile = argv[++i] ?? null;
    else if (arg === "--public-key") args.publicKey = argv[++i] ?? null;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function validBase64(value) {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

function verifySignature(rawBody, signatureBase64, publicKeyPem) {
  const compact = signatureBase64.trim();
  if (!validBase64(compact)) return false;
  try {
    return verify(
      "RSA-SHA256",
      rawBody,
      { key: publicKeyPem, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(compact, "base64"),
    );
  } catch {
    return false;
  }
}

function selfTest() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const raw = Buffer.from('{"id":"purchase-1","status":"paid"}', "utf8");
  const signature = sign("RSA-SHA256", raw, {
    key: privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  }).toString("base64");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  if (!verifySignature(raw, signature, pem)) throw new Error("valid signature failed");
  if (verifySignature(Buffer.concat([raw, Buffer.from(" ")]), signature, pem))
    throw new Error("modified body incorrectly verified");
  console.log("Self-test passed");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }
  if (args.selfTest) {
    selfTest();
    return;
  }
  if (!args.body || !args.signatureFile || !args.publicKey) {
    help();
    throw new Error("--body, --signature-file and --public-key are required");
  }

  const [rawBody, signature, publicKey] = await Promise.all([
    readFile(args.body),
    readFile(args.signatureFile, "utf8"),
    readFile(args.publicKey, "utf8"),
  ]);
  const ok = verifySignature(rawBody, signature, publicKey);
  console.log(ok ? "VERIFIED" : "INVALID");
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
