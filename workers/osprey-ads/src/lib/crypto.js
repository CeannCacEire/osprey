import { b64 } from "./util.js";

/* AES-GCM for Reddit tokens at rest. TOKEN_ENC_KEY is a base64 32-byte secret. */
async function key(env) {
  if (!env.TOKEN_ENC_KEY) throw new Error("TOKEN_ENC_KEY secret is not set");
  const raw = b64.dec(env.TOKEN_ENC_KEY);
  if (raw.length !== 32) throw new Error("TOKEN_ENC_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(env, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(plaintext)));
  return b64.enc(iv) + "." + b64.enc(ct);
}

export async function decrypt(env, blob) {
  const [iv, ct] = String(blob).split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.dec(iv) }, await key(env), b64.dec(ct));
  return new TextDecoder().decode(pt);
}
