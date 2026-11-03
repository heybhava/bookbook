// Password hashing with scrypt (memory-hard, in Node core: no native build). Format: scrypt$N$r$p$salt$hash (all params stored so they can be raised later).
import crypto from 'node:crypto';

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64, MAXMEM = 128 * 1024 * 1024;
const scrypt = (pw: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> => new Promise((res, rej) => crypto.scrypt(pw.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (e, k) => (e ? rej(e) : res(k))));
const pepper = () => process.env.FOLIO_PASSWORD_PEPPER || '';

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16); const key = await scrypt(pw + pepper(), salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$'); if (alg !== 'scrypt' || !hash) return false;
  const key = await scrypt(pw + pepper(), Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p)); const want = Buffer.from(hash, 'base64');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}
/** Used when the account does not exist so the response time does not reveal it. */
let dummy: Promise<string> | null = null;
export const burnTime = async (pw: string) => { dummy ??= hashPassword('not-a-real-password'); await verifyPassword(pw, await dummy); };

const COMMON = new Set(['password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'iloveyou123', 'letmein1234', 'welcome1234', 'administrator', 'passw0rd123', 'abcdefghij', '0123456789', 'qwerty12345', 'folio123456']);
export function passwordProblem(pw: unknown, email?: string): string | null {
  if (typeof pw !== 'string') return 'Password required.';
  if (pw.length < 10) return 'Use at least 10 characters.'; if (pw.length > 200) return 'Password is too long (max 200).';
  const low = pw.toLowerCase(); if (COMMON.has(low)) return 'That password is too common.';
  if (email && low.includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) return 'The password must not contain your email name.';
  if (/^(.)\1+$/.test(pw)) return 'Use more than one repeated character.';
  if (new Set(pw).size < 5) return 'Use a more varied password.';
  return null;
}
export const emailValid = (e: unknown): e is string => typeof e === 'string' && e.length <= 254 && /^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]{2,}$/.test(e);
