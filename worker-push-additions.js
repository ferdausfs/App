/* ════════════════════════════════════════════════════════
   FTT Signal Worker — Web Push additions
   Paste these sections into your existing Worker code
   ════════════════════════════════════════════════════════

   SECRETS to add via Cloudflare Dashboard → Worker → Settings → Variables:
     VAPID_PUBLIC_KEY   = your generated public key
     VAPID_PRIVATE_KEY  = your generated private key
     VAPID_SUBJECT      = mailto:you@example.com

   KV Namespace:
     Binding name: SIGNAL_KV   (you likely already have this)
     Key used:     "push_subscriptions"  →  JSON array of subscription objects
                   "last_signal_{PAIR}"  →  last seen signal direction+confidence
*/


/* ── VAPID HELPER FUNCTIONS ── */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

function uint8ArrayToBase64Url(arr) {
  let binary = '';
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function buildVapidJwt(endpoint, env) {
  const origin   = new URL(endpoint).origin;
  const now      = Math.floor(Date.now() / 1000);
  const exp      = now + 12 * 3600; // 12h

  const header  = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: origin, exp, sub: env.VAPID_SUBJECT };

  const enc = s => uint8ArrayToBase64Url(new TextEncoder().encode(JSON.stringify(s)));
  const sigInput = `${enc(header)}.${enc(payload)}`;

  // Import private key (VAPID private key is base64url-encoded raw P-256)
  const privBytes = urlBase64ToUint8Array(env.VAPID_PRIVATE_KEY);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    privBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(sigInput)
  );

  const sig = uint8ArrayToBase64Url(new Uint8Array(sigBuf));
  return `${sigInput}.${sig}`;
}

async function sendWebPush(subscription, payload, env) {
  const jwt    = await buildVapidJwt(subscription.endpoint, env);
  const vapidH = `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`;

  // Encrypt payload using browser public key
  // For simplicity we send as plaintext JSON (most browsers accept this)
  const body = JSON.stringify(payload);

  const resp = await fetch(subscription.endpoint, {
    method:  'POST',
    headers: {
      'Authorization': vapidH,
      'Content-Type':  'application/json',
      'TTL':           '300',
    },
    body,
  });

  return resp.status;
}

async function broadcastPush(payload, env) {
  const raw  = await env.SIGNAL_KV.get('push_subscriptions');
  if (!raw) return;

  let subs;
  try { subs = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(subs) || subs.length === 0) return;

  const valid = [];
  for (const sub of subs) {
    try {
      const status = await sendWebPush(sub, payload, env);
      if (status === 410 || status === 404) continue; // expired — drop
      valid.push(sub);
    } catch (e) {
      valid.push(sub); // keep on error
    }
  }

  // Save pruned list
  await env.SIGNAL_KV.put('push_subscriptions', JSON.stringify(valid));
}


/* ── SUBSCRIBE ENDPOINT  POST /api/subscribe ── */

async function handleSubscribe(request, env) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST')   return new Response('Method not allowed', { status: 405 });

  let sub;
  try { sub = await request.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

  if (!sub?.endpoint) return new Response('Missing endpoint', { status: 400 });

  const raw  = await env.SIGNAL_KV.get('push_subscriptions');
  let subs   = [];
  try { subs = JSON.parse(raw || '[]'); } catch {}

  // Upsert by endpoint
  const idx = subs.findIndex(s => s.endpoint === sub.endpoint);
  if (idx === -1) subs.push(sub);
  else            subs[idx] = sub;

  await env.SIGNAL_KV.put('push_subscriptions', JSON.stringify(subs));

  return new Response(JSON.stringify({ ok: true, total: subs.length }), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}


/* ── CRON: check signal and push if new ── */
/* Call this inside your existing scheduled() handler */

const PAIRS_TO_WATCH = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'BTC/USD', 'ETH/USD',
  // add more pairs as needed
];

async function cronPushCheck(env) {
  for (const pair of PAIRS_TO_WATCH) {
    try {
      // Fetch signal from your own API endpoint
      const url  = `https://signal-engine-ftt-v.umuhammadiswa.workers.dev/api/signal?pair=${encodeURIComponent(pair)}`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'FTT-Cron/1.0' } });
      if (!resp.ok) continue;

      const j = await resp.json();
      const s = j?.signal;
      if (!s) continue;

      const direction   = s.finalSignal;
      const confidence  = parseInt((s.confidence || '0').replace('%', '')) || 0;
      const grade       = s.grade?.grade || s.grade || '';
      const timestamp   = s.generatedAt  || j.timestamp || '';

      // Only push BUY or SELL
      if (direction !== 'BUY' && direction !== 'SELL') continue;
      // Only push Grade A+, A, B
      if (!['A+', 'A', 'B'].includes(grade)) continue;

      // De-duplicate: check if already pushed this signal
      const cacheKey = `last_push_${pair.replace('/', '')}`;
      const cached   = await env.SIGNAL_KV.get(cacheKey);
      const thisKey  = `${direction}-${confidence}-${timestamp}`;
      if (cached === thisKey) continue; // already pushed

      // New signal! Send push
      await broadcastPush({
        pair,
        direction,
        confidence,
        grade,
        expiry:    s.recommendations?.['5min']?.expiry?.humanReadable || '5m',
        timestamp,
      }, env);

      // Mark as pushed
      await env.SIGNAL_KV.put(cacheKey, thisKey, { expirationTtl: 600 }); // 10min TTL

      console.log(`[PUSH] ${pair} ${direction} ${confidence}% Grade:${grade}`);

      // Small delay between pairs to avoid rate limits
      await new Promise(r => setTimeout(r, 500));

    } catch (e) {
      console.error(`[PUSH ERR] ${pair}:`, e.message);
    }
  }
}


/* ════════════════════════════════════════════
   HOW TO WIRE INTO YOUR EXISTING WORKER
   ════════════════════════════════════════════

   In your main fetch handler, add:

   if (url.pathname === '/api/subscribe') {
     return handleSubscribe(request, env);
   }

   In your scheduled() handler, add:

   export default {
     async fetch(request, env, ctx) {
       // ... your existing code ...
     },

     async scheduled(event, env, ctx) {
       ctx.waitUntil(cronPushCheck(env));
       // ... your other cron tasks ...
     }
   }
*/


/* ════════════════════════════════════════════
   NOTE on VAPID private key format:
   web-push tool generates base64url raw keys.
   If crypto.subtle.importKey fails with 'pkcs8',
   try 'raw' format instead:

   const key = await crypto.subtle.importKey(
     'raw',          // ← change this
     privBytes,
     { name: 'ECDSA', namedCurve: 'P-256' },
     false,
     ['sign']
   );
   ════════════════════════════════════════════ */
