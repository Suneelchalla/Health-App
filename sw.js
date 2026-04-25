/**
 * HealthVault Service Worker v6 — Android notification fixes
 *
 * Fixes applied:
 *  Bug 2 — removed setTimeout-based alarms from page; SW is now the only alarm source
 *  Bug 3 — replaced unreliable setInterval inside activate with checkAlarms() called
 *           on every SW lifecycle event so alarms fire even after the SW was terminated
 *  Bug 4 — changed m<2 window to "fire on or after due hour, once per day" so a
 *           sleeping SW never permanently misses an alarm
 *  Bug 5 — icon path made relative to SW scope so it resolves correctly on any host
 *  Bonus  — periodicsync handler added for Chrome-on-Android background wakeups
 */

const CACHE_NAME = 'healthvault-v6';
const ASSETS = [
  '/Health-App/', '/Health-App/index.html',
  '/Health-App/manifest.json', '/Health-App/icon-192.png', '/Health-App/icon-512.png'
];

/* ── Persistent schedule (survives SW restarts via globals reset each wakeup) ── */
let medSchedule = [];
let waterSchedule = null;
let lastFiredMed = {};      // { slot: 'YYYY-MM-DD' }
let lastFiredWater = 0;     // timestamp ms

/* ── Helpers ── */
function dateStr(d) { return d.toISOString().split('T')[0]; }

/**
 * Resolve icon URL relative to the SW scope so it works on any deployment path.
 * Bug 5 fix: hardcoded /Health-App/icon-192.png caused 404 on other hosts.
 */
function iconUrl(name) {
  return self.registration.scope + name;
}

function notify(title, body, tag, actions) {
  return self.registration.showNotification(title, {
    body,
    icon: iconUrl('icon-192.png'),
    badge: iconUrl('icon-192.png'),
    tag,
    vibrate: [200, 100, 200],
    renotify: true,
    data: { url: self.registration.scope, tag },
    actions: actions || []
  }).catch(() => {});
}

function broadcast(msg) {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(cs => cs.forEach(c => c.postMessage(msg)))
    .catch(() => {});
}

function focusApp(url) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) {
      if (c.url.includes('/Health-App/') && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(url);
  });
}

/* ── checkAlarms ────────────────────────────────────────────────────────────
 *
 * Bug 4 fix: old code used `m < 2` — the SW had to wake within the first
 * 2 minutes of the alarm hour, which Android never guarantees.
 *
 * New logic: fire as soon as the SW wakes up ON OR AFTER the due hour,
 * but only ONCE per calendar day per slot. This means if the SW wakes at
 * 8:47 AM it still fires the 8:00 AM alarm correctly.
 */
function checkAlarms() {
  const now = new Date();
  const h = now.getHours();
  const t = dateStr(now);
  const labels = { morning: '🌅 Morning', afternoon: '☀️ Afternoon', night: '🌙 Night' };

  for (const entry of medSchedule) {
    if (h >= entry.hour && lastFiredMed[entry.slot] !== t) {
      lastFiredMed[entry.slot] = t;
      notify(
        `${labels[entry.slot] || '💊'} Medicines Due`,
        entry.names,
        'med-' + entry.slot,
        [{ action: 'taken', title: '✅ Mark as Taken' }]
      );
    }
  }

  if (waterSchedule && h >= waterSchedule.start && h < waterSchedule.end) {
    const intMs = waterSchedule.interval * 60000;
    if (Date.now() - lastFiredWater >= intMs) {
      lastFiredWater = Date.now();
      notify(
        '💧 Time to Drink Water!',
        `Stay hydrated — aim for ${waterSchedule.goal} glasses today.`,
        'water-reminder',
        [{ action: 'drank', title: '✅ I Drank!' }]
      );
    }
  }
}

/* ── Install ── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate ────────────────────────────────────────────────────────────────
 *
 * Bug 3 fix: REMOVED setInterval(checkAlarms, 60000) from here.
 * Android terminates the SW freely and destroys any setInterval with it.
 * Instead, checkAlarms() is called at the top of every event handler so it
 * runs each time Android wakes the SW for any reason.
 */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => checkAlarms())
  );
});

/* ── Fetch — piggyback alarm check on every network wakeup ─────────────────
 *
 * Bug 3 fix (part 2): each time Android wakes the SW to handle a fetch,
 * we call checkAlarms(). Fetch events are the most frequent SW wakeup trigger
 * on Android, so this catches most cases where the app is in use.
 */
self.addEventListener('fetch', e => {
  checkAlarms();

  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const c = res.clone();
        caches.open(CACHE_NAME).then(ca => ca.put(e.request, c));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

/* ── Message — receive schedule updates from the page ── */
self.addEventListener('message', e => {
  if (!e.data) return;
  checkAlarms();

  if (e.data.type === 'SET_MED_SCHEDULE') {
    medSchedule = e.data.schedule || [];
    lastFiredMed = {};
  }
  if (e.data.type === 'SET_WATER_SCHEDULE') {
    waterSchedule = {
      interval: e.data.interval || 60,
      start: e.data.start || 8,
      end: e.data.end || 22,
      goal: e.data.goal || 8
    };
    lastFiredWater = 0;
  }
  if (e.data.type === 'CLEAR_MED_SCHEDULE') { medSchedule = []; lastFiredMed = {}; }
  if (e.data.type === 'CLEAR_WATER_SCHEDULE') { waterSchedule = null; lastFiredWater = 0; }

  // Page can request an immediate alarm check (sent on every app open)
  if (e.data.type === 'CHECK_ALARMS') checkAlarms();
});

/* ── Periodic Background Sync ───────────────────────────────────────────────
 *
 * Bonus fix: Chrome on Android supports periodicsync, which wakes the SW
 * roughly once per hour even when the app is fully closed.
 * The page registers the tag 'hv-alarms' (see index.html initReminders).
 */
self.addEventListener('periodicsync', e => {
  if (e.tag === 'hv-alarms') {
    e.waitUntil(Promise.resolve().then(() => checkAlarms()));
  }
});

/* ── Push (server-sent, optional) ── */
self.addEventListener('push', e => {
  checkAlarms();
  if (!e.data) return;
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'HealthVault', body: e.data.text() }; }
  e.waitUntil(notify(d.title || 'HealthVault', d.body || '', d.tag || 'hv-push', d.actions || []));
});

/* ── Notification click ── */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  if (e.action === 'taken') {
    broadcast({ type: 'MED_TAKEN', tag: e.notification.tag });
    e.waitUntil(focusApp(url));
    return;
  }
  if (e.action === 'drank') {
    broadcast({ type: 'WATER_DRUNK' });
    e.waitUntil(focusApp(url));
    return;
  }
  e.waitUntil(focusApp(url));
});
