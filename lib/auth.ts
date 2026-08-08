// Edge-runtime-safe hashing (middleware runs on the edge, no Node crypto)
export async function hashPassword(password: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(password + secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}