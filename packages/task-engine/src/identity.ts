import { randomBytes } from "node:crypto";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newId(now = Date.now()): string {
  const bytes = randomBytes(10);
  let value = BigInt(Math.max(0, now));
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let id = "";
  for (let index = 0; index < 26; index++) {
    id = alphabet[Number(value & 31n)] + id;
    value >>= 5n;
  }
  return id;
}
