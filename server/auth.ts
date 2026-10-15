// Parol xeshlash (scrypt), imzolangan cookie sessiyalari va desktop rejimi uchun token.
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return calc.length === expected.length && crypto.timingSafeEqual(calc, expected);
}

export function randomPassword(len = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// --- Cookie sessiyasi: uid.exp.sig (HMAC) ---

export interface CookieSession {
  uid: string;
  exp: number;
}

function sign(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function makeToken(secret: string, uid: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const payload = `${uid}.${exp}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function parseToken(secret: string, token: string | undefined): CookieSession | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, expS, sig] = parts;
  const payload = `${uid}.${expS}`;
  const expected = sign(secret, payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const exp = Number(expS);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return { uid, exp };
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const COOKIE_NAME = 'tta_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
