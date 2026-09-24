// Site-wide privacy gate (HTTP Basic Auth at the edge).
// Password comes from the SITE_PASSWORD environment variable — never from
// the repo. Any username is accepted; only the password is checked.
// Runs on every static page; function endpoints (/.netlify/functions/*)
// are excluded so scheduled jobs and API calls keep working.

const REALM = "WANTWATCHER // RESTRICTED";

const DENIED_BODY = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>403 // ACCESS DENIED</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;border-radius:0!important}
  body{background:#000;color:#00FF00;font-family:"Courier New",Courier,monospace;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .box{border:2px solid #00FF00;padding:40px 48px;max-width:560px;width:100%;
    box-shadow:8px 8px 0 #00FF00}
  h1{font-size:clamp(28px,6vw,52px);letter-spacing:-.02em;line-height:1;margin-bottom:16px}
  p{font-size:14px;line-height:1.7;color:#fff}
  .tag{display:inline-block;border:1px solid #FF5C00;color:#FF5C00;
    padding:4px 10px;font-size:12px;letter-spacing:.15em;margin-bottom:20px}
  code{color:#00FF00}
</style></head>
<body><div class="box">
  <div class="tag">STATUS: LOCKED</div>
  <h1>ACCESS<br>DENIED</h1>
  <p>This radar is private. Enter the site password when prompted.<br>
  No password? You are not on the list. <code>SRC: GATE_01</code></p>
</div></body></html>`;

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async (request, context) => {
  const password = Netlify.env.get("SITE_PASSWORD");

  const deny = () =>
    new Response(DENIED_BODY, {
      status: 401,
      headers: {
        "WWW-Authenticate": `Basic realm="${REALM}"`,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });

  // Fail closed: no password configured => nobody gets in.
  if (!password) return deny();

  const header = request.headers.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return deny();

  let supplied = "";
  try {
    const decoded = atob(encoded);
    const idx = decoded.indexOf(":");
    supplied = idx >= 0 ? decoded.slice(idx + 1) : decoded;
  } catch {
    return deny();
  }

  if (!timingSafeEqual(supplied, password)) return deny();
  return context.next();
};
