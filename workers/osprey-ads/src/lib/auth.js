import { b64, now, sha256Hex, randomId, HttpError, DAY } from "./util.js";

const ITER = 100_000;            // Workers' PBKDF2 maximum
const SESSION_TTL = 12 * 3600_000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

async function pbkdf2(password, salt, iter) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, k, 256);
  return new Uint8Array(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITER);
  return { password_hash: b64.enc(hash), password_salt: b64.enc(salt), password_iter: ITER };
}

export function checkPasswordStrength(pw) {
  if (typeof pw !== "string" || pw.length < 12) throw new HttpError(400, "Use a password of at least 12 characters.");
}

export async function createAdmin(db, username, password) {
  checkPasswordStrength(password);
  if (!/^[a-z0-9_.-]{3,32}$/i.test(username || "")) throw new HttpError(400, "Usernames are 3–32 letters, numbers, dots, dashes or underscores.");
  const h = await hashPassword(password);
  await db.prepare("INSERT INTO admin_users (username, password_hash, password_salt, password_iter, created_at) VALUES (?,?,?,?,?)")
    .bind(username, h.password_hash, h.password_salt, h.password_iter, now()).run();
}

export async function login(db, username, password) {
  const u = await db.prepare("SELECT * FROM admin_users WHERE username = ?").bind(username || "").first();
  // Always do the PBKDF2 work so response time doesn't reveal whether the user exists.
  const salt = u ? b64.dec(u.password_salt) : new Uint8Array(16);
  const calc = await pbkdf2(String(password || ""), salt, u ? u.password_iter : ITER);
  if (!u || u.disabled) throw new HttpError(401, "Wrong username or password.");
  if (u.locked_until && u.locked_until > now()) throw new HttpError(429, "Too many failed attempts. Try again in a few minutes.");
  if (!timingSafeEqual(calc, b64.dec(u.password_hash))) {
    const fails = (u.failed_logins || 0) + 1;
    await db.prepare("UPDATE admin_users SET failed_logins = ?, locked_until = ? WHERE id = ?")
      .bind(fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? now() + LOCK_MS : null, u.id).run();
    throw new HttpError(401, "Wrong username or password.");
  }
  const token = randomId(32);
  const t = now();
  await db.batch([
    db.prepare("UPDATE admin_users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?").bind(t, u.id),
    db.prepare("INSERT INTO sessions (token_hash, admin_id, created_at, expires_at) VALUES (?,?,?,?)").bind(await sha256Hex(token), u.id, t, t + SESSION_TTL),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t - DAY),
  ]);
  return { token, expires_at: t + SESSION_TTL, admin: { id: u.id, username: u.username } };
}

export async function requireAdmin(request, db) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/);
  if (!m) throw new HttpError(401, "Sign in required.");
  const row = await db.prepare(
    "SELECT a.id, a.username, a.disabled, s.expires_at FROM sessions s JOIN admin_users a ON a.id = s.admin_id WHERE s.token_hash = ?"
  ).bind(await sha256Hex(m[1])).first();
  if (!row || row.disabled || row.expires_at < now()) throw new HttpError(401, "Your session has ended. Sign in again.");
  return { id: row.id, username: row.username, tokenHash: await sha256Hex(m[1]) };
}

export async function logout(db, tokenHash) {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}
