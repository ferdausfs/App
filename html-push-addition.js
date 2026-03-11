/* ══════════════════════════════════════════════
   FTT Signal HTML — Push Subscription Code
   Paste this INSIDE your <script> tag, after
   the existing code (before closing </script>)
   ══════════════════════════════════════════════ */

/* ── VAPID PUBLIC KEY (from your generated keys) ── */
var VAPID_PUBLIC_KEY = 'YOUR_VAPID_PUBLIC_KEY_HERE'; // ← replace this

var _swReg = null;

/* ── Register Service Worker ── */
async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('[Push] Not supported in this browser');
    return;
  }

  try {
    /* sw.js must be at the ROOT of your GitHub Pages site */
    _swReg = await navigator.serviceWorker.register('/sw.js');
    console.log('[Push] SW registered:', _swReg.scope);

    /* Check existing subscription */
    const existing = await _swReg.pushManager.getSubscription();
    if (existing) {
      console.log('[Push] Already subscribed');
      _swReg._sub = existing;
      return;
    }

    /* Auto-subscribe on first load (user already enabled) */
    await subscribePush();
  } catch (e) {
    console.error('[Push] SW registration failed:', e);
  }
}

async function subscribePush() {
  if (!_swReg) return;

  /* Request notification permission */
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast('🔕 Notification permission denied');
    return;
  }

  try {
    const sub = await _swReg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    /* Send subscription to Cloudflare Worker */
    const resp = await fetch(API + '/api/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(sub.toJSON()),
    });

    if (resp.ok) {
      toast('🔔 Background alerts ON!');
      console.log('[Push] Subscribed & saved to Worker KV');
    } else {
      toast('⚠ Subscribe failed: ' + resp.status);
    }
  } catch (e) {
    console.error('[Push] Subscribe error:', e);
    toast('⚠ Push subscribe failed');
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function unsubscribePush() {
  if (!_swReg) return;
  const sub = await _swReg.pushManager.getSubscription();
  if (sub) { await sub.unsubscribe(); toast('🔕 Push alerts off'); }
}

/* ── Update the existing toggleWLScan / renderWL to use subscribePush ──
   In renderWL(), replace the notification button section with:

   var notifBtn =
     perm === 'granted'
       ? '<button class="wlbtn notif-on" onclick="unsubscribePush()">🔔 BG Alerts ON</button>'
       : '<button class="wlbtn" onclick="subscribePush()">🔔 Enable BG Alerts</button>';
*/

/* ── AUTO-INIT on page load ── */
window.addEventListener('load', function () {
  initPush();
});
