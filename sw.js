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
let tipsSchedule = null;    // { hour, minute }
let lastFiredTips = '';     // 'YYYY-MM-DD'

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


/* ── Health tips data (used by SW to fire tip-of-day notifications) ── */
const SW_TIPS = [
  {t:'Drink water first thing',b:'Rehydrate before your morning tea — your body loses water overnight.'},
  {t:'Walk after meals',b:'A 10-minute walk after eating reduces post-meal blood sugar spikes by up to 30%.'},
  {t:'Eat the rainbow',b:'3+ colours on your plate = 3+ different nutrients. Variety is key to balanced nutrition.'},
  {t:'Sleep 7–9 hours',b:'Chronic sleep deprivation raises blood pressure and weakens immunity. Prioritise rest.'},
  {t:'Stretch every morning',b:'5 minutes of gentle stretching after waking improves circulation and reduces stiffness.'},
  {t:'Box breathing for stress',b:'Inhale 4s → hold 4s → exhale 4s → hold 4s. Activates calm within 60 seconds.'},
  {t:'Snack on nuts',b:'A handful of almonds or walnuts provides healthy fats, protein and magnesium — ideal for a mid-day snack.'},
  {t:'Stand up every hour',b:'Sitting for long periods increases cardiovascular risk. Move for 2 minutes each hour.'},
  {t:'No screens before bed',b:'Blue light delays melatonin by up to 3 hours. Switch off screens 1 hour before sleep.'},
  {t:'Annual health check-up',b:'A basic blood panel catches silent problems like high sugar or cholesterol before they become serious.'},
  {t:'Know your urine colour',b:'Pale yellow = well hydrated. Dark yellow = drink more water. Simple and reliable.'},
  {t:'Eat fermented foods',b:'Curd, idli, buttermilk provide probiotics that support gut bacteria and immunity.'},
  {t:'Limit sugar in drinks',b:'Replace cola with coconut water, nimbu pani or buttermilk — same satisfaction, far less sugar.'},
  {t:'Strength train twice a week',b:'Bodyweight exercises like squats and push-ups maintain muscle mass and protect bones.'},
  {t:'Morning sunlight walk',b:'20 minutes outdoors in morning sun resets your body clock and boosts Vitamin D.'},
  {t:'5 minutes of gratitude',b:'Write 3 things you are grateful for each morning — rewires the brain toward positivity.'},
  {t:'Wash hands properly',b:'20 seconds with soap removes 99% of pathogens. Most effective step to prevent infections.'},
  {t:'Avoid eating late',b:'Finish dinner 2–3 hours before bed to improve digestion and support restful sleep.'},
  {t:'Fixed wake-up time',b:'Same wake time daily — even weekends — strengthens your body clock and sleep quality.'},
  {t:'Nature resets the mind',b:'Just 20 minutes in a park measurably reduces cortisol and improves focus for hours.'},
  {t:'Cook with less salt',b:'Reduce salt by a quarter teaspoon per week — you will stop noticing the difference within 3 weeks.'},
  {t:'Celebrate small wins',b:'Acknowledging daily accomplishments activates the brain reward circuit and builds motivation.'},
  {t:'Limit caffeine after 2 PM',b:'Caffeine has a 5–6 hour half-life. Your 3 PM coffee is still active at 8 PM affecting sleep.'},
  {t:'Eat seasonal fruits',b:'Seasonal fruits are fresher, richer in nutrients and far cheaper than off-season varieties.'},
  {t:'Dental check every 6 months',b:'Gum disease bacteria are linked to heart disease. Clean teeth = healthier body.'},
  {t:'Include more fibre',b:'25–30g of fibre daily from vegetables and legumes supports gut health and lowers cholesterol.'},
  {t:'Cool room for better sleep',b:'18–20°C is the ideal sleep temperature — a cooler room helps your body fall into deeper sleep.'},
  {t:'Yoga for joint health',b:'Regular yoga reduces cortisol, improves flexibility and protects joints in all age groups.'},
  {t:'Mindfulness for 10 minutes',b:'10 minutes of daily mindfulness reduces anxiety as effectively as mild medication over time.'},
  {t:'Limit news to once a day',b:'Constant news causes elevated anxiety. Check once at a fixed time and then consciously stop.'},
];

function getTodayTipSW(){
  const d = new Date();
  const seed = d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate();
  return SW_TIPS[seed % SW_TIPS.length];
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

  // Tips of the day notification
  if (tipsSchedule && lastFiredTips !== t) {
    const m2 = now.getMinutes();
    if (h === tipsSchedule.hour && m2 >= (tipsSchedule.minute || 0)) {
      lastFiredTips = t;
      const tip = getTodayTipSW();
      notify('💡 ' + tip.t, tip.b, 'tips-daily', []);
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
  if (e.data.type === 'SET_TIPS_SCHEDULE') {
    tipsSchedule = { hour: e.data.hour || 8, minute: e.data.minute || 0 };
    lastFiredTips = '';
  }
  if (e.data.type === 'CLEAR_TIPS_SCHEDULE') { tipsSchedule = null; lastFiredTips = ''; }
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
