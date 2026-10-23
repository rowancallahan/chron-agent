// Who is asking. Cloudflare Access does the signing in (your site is behind it) and then adds a signed
// token to every request: the Cf-Access-Jwt-Assertion header. We check that token's signature with
// Access's public keys, so the email in it can be trusted. Each email gets its own data (index.js).
//
// Settings in wrangler.toml [vars]:
//   ACCESS_TEAM  needed: your sign-in address, e.g. "https://yourteam.cloudflareaccess.com"
//   ACCESS_AUD   optional: the Access application's "Application Audience (AUD) Tag". Only matters once
//                more than one site uses your Access sign-in: it stops a token for another site working here.
// For local testing only, .dev.vars can set DEV_USER (e.g. "me") to skip this -- it only works when
// ACCESS_TEAM is blank (.dev.vars blanks it), so it can never skip sign-in on the live site.

const keys = {}; // Access's public keys by key id, kept while this copy of the Worker runs

const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function publicKey(team, kid) {
  if (!(kid in keys)) { // a new key id: Access has rotated its keys, so fetch them again
    for (const jwk of (await (await fetch(`${team}/cdn-cgi/access/certs`)).json()).keys)
      keys[jwk.kid] = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  return keys[kid];
}

// The signed-in person's email (lowercase), or null if the request isn't properly signed in.
export async function user(request, env) {
  if (env.DEV_USER && !env.ACCESS_TEAM) return env.DEV_USER; // local only (.dev.vars blanks ACCESS_TEAM)
  const team = env.ACCESS_TEAM, aud = env.ACCESS_AUD, token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!team || !token) return null;
  try {
    const [head, body, sig] = token.split(".");
    const header = JSON.parse(new TextDecoder().decode(unb64(head)));
    const claims = JSON.parse(new TextDecoder().decode(unb64(body)));
    const key = await publicKey(team, header.kid);
    const signed = key && await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64(sig), new TextEncoder().encode(`${head}.${body}`));
    const audiences = [claims.aud].flat();
    const ok = signed && header.alg === "RS256" && claims.iss === team && (!aud || audiences.includes(aud))
      && (claims.exp ?? 0) > Date.now() / 1000 && claims.email;
    return ok ? claims.email.trim().toLowerCase() : null;
  } catch { // a malformed token is simply not signed in
    return null;
  }
}
