// Makes the key pair web push needs ("VAPID" keys). Run once, from the py folder:
//   node setup/make_vapid_keys.mjs
// It writes the public key into wrangler.toml (VAPID_PUBLIC_KEY; not secret) and the private key
// to vapid-private.json, which you then store as a secret and delete:
//   npx wrangler secret put VAPID_PRIVATE_KEY < vapid-private.json && rm vapid-private.json
// Running it again makes a new pair: store the new secret too, and every device turns push on again.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = publicKey.export({ format: "jwk" });
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);

const toml = readFileSync("wrangler.toml", "utf8");
if (!/^VAPID_PUBLIC_KEY = ".*"$/m.test(toml)) throw new Error('wrangler.toml has no line VAPID_PUBLIC_KEY = "..."');
writeFileSync("wrangler.toml", toml.replace(/^VAPID_PUBLIC_KEY = ".*"$/m, `VAPID_PUBLIC_KEY = "${raw.toString("base64url")}"`));
writeFileSync("vapid-private.json", JSON.stringify(privateKey.export({ format: "jwk" })), { mode: 0o600 });

console.log("Public key written into wrangler.toml (VAPID_PUBLIC_KEY).");
console.log("Private key written to vapid-private.json. Now store it and delete the file:");
console.log("  npx wrangler secret put VAPID_PRIVATE_KEY < vapid-private.json && rm vapid-private.json");
