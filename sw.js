/**
 * HealthVault Service Worker v11 — Skip taken medicine slots — Appointment reminders + all previous fixes
 *
 * KEY FIX (v8) — Multi-user notification isolation:
 *  Schedules are stored per-clientId so User A's medicine/water/tips reminders
 *  never fire on User B's device even when both use the same hosted URL.
 *  Each browser session generates a unique clientId (stored in localStorage)
 *  which is sent with every SET_* message and stored in a per-client Map in
 *  the SW. checkAlarms() targets notifications to the originating client only.
 *
 * Previous fixes (v6/v7):
 *  Bug 2 — removed setTimeout-based alarms from page
 *  Bug 3 — checkAlarms() called on every SW lifecycle event
 *  Bug 4 — medicine alarms: "on or after due hour, once per day"
 *  Bug 5 — icon path relative to SW scope (any hostname)
 *  Bug 6 — tips alarm: "on or after due hour" (not exact-hour match)
 *  Bug 7 — lastFiredWater = Date.now() on init (not 0) — prevents post-restart spam
 *  Bonus — periodicsync handler for Chrome-on-Android background wakeups
 */

const CACHE_NAME = 'healthvault-v12';
const ASSETS = [
  '/Health-App/', '/Health-App/index.html',
  '/Health-App/manifest.json', '/Health-App/icon-192.png', '/Health-App/icon-512.png'
];

/* ── Per-client schedule store ──────────────────────────────────────────────
 * Map<clientId, { medSchedule, waterSchedule, tipsSchedule,
 *                 lastFiredMed, lastFiredWater, lastFiredTips }>
 * This is the core of the multi-user fix: each user's browser gets a unique
 * clientId and their schedules are stored separately.
 */
const clientSchedules = new Map();

function getClientState(clientId) {
  if (!clientSchedules.has(clientId)) {
    clientSchedules.set(clientId, {
      medSchedule: [],
      waterSchedule: null,
      tipsSchedule: null,
      vacReminders: [],       // [{ memberId, memberName, vacId, vacName, dueDate, reminderDate }]
      lastFiredMed: {},
      lastFiredWater: Date.now(), // Bug 7: not 0
      lastFiredTips: '',
      lastFiredVac: {},       // { 'memberId_vacId': 'YYYY-MM-DD' } — prevent double-fire per day
      apptReminders: [],      // [{ id, fireAt, title, body }] -- one-time appointment alarms
      takenSlots: [],         // ['morning','afternoon','night'] -- slots fully taken today
      takenSlotsDate: ''      // YYYY-MM-DD for takenSlots
    });
  }
  return clientSchedules.get(clientId);
}

/* ── Helpers ── */
function dateStr(d) { return d.toISOString().split('T')[0]; }

function iconUrl(name) {
  return self.registration.scope + name; // Bug 5: relative to scope
}

/**
 * Fire notification to a specific client's user only.
 * When the target tab is open we postMessage it to show its own notification
 * (avoiding cross-user leakage). When no tab is open we use showNotification
 * which is safe because background sync only runs for the scheduled user.
 */
async function notifyClient(clientId, title, body, tag, actions) {
  const opts = {
    body,
    icon: iconUrl('icon-192.png'),
    badge: iconUrl('icon-192.png'),
    tag,
    vibrate: [200, 100, 200],
    renotify: true,
    data: { url: self.registration.scope, tag, clientId },
    actions: actions || []
  };
  try {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const appClients = allClients.filter(c => c.url.includes('/Health-App/'));
    if (appClients.length === 0) {
      // No tab open — show system notification (background wakeup)
      await self.registration.showNotification(title, opts);
    } else {
      // Tab(s) open — ask each app client to show via postMessage;
      // the page only shows it if clientId matches its own
      appClients.forEach(c => c.postMessage({ type: 'SHOW_NOTIFICATION', clientId, title, body, tag, actions: actions || [] }));
    }
  } catch (_) {
    self.registration.showNotification(title, opts).catch(() => {});
  }
}

function broadcastToClient(clientId, msg) {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(cs => cs.forEach(c => c.postMessage({ ...msg, clientId })))
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

/* ── Health tips data ── */
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

function getTodayTipSW() {
  const d = new Date();
  const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  return SW_TIPS[seed % SW_TIPS.length];
}

/* ── checkAlarms — iterates all per-client schedules ── */
function checkAlarms() {
  const now = new Date();
  const h = now.getHours();
  const t = dateStr(now);
  const labels = { morning: '🌅 Morning', afternoon: '☀️ Afternoon', night: '🌙 Night' };

  for (const [clientId, state] of clientSchedules.entries()) {
    // Medicine alarms (Bug 4: on-or-after, once per day)
    // Skip slots that the user has already marked as taken today
    const takenToday = (state.takenSlotsDate === t) ? (state.takenSlots || []) : [];
    for (const entry of state.medSchedule) {
      if (h >= entry.hour && state.lastFiredMed[entry.slot] !== t) {
        // Don't fire if user already marked this entire slot as taken
        if (takenToday.includes(entry.slot)) {
          state.lastFiredMed[entry.slot] = t; // mark fired so it doesn't retry
          continue;
        }
        state.lastFiredMed[entry.slot] = t;
        notifyClient(clientId, `${labels[entry.slot] || '💊'} Medicines Due`, entry.names,
          'med-' + entry.slot, [{ action: 'taken', title: '✅ Mark as Taken' }]);
      }
    }

    // Water reminders
    if (state.waterSchedule && h >= state.waterSchedule.start && h < state.waterSchedule.end) {
      const intMs = state.waterSchedule.interval * 60000;
      if (Date.now() - state.lastFiredWater >= intMs) {
        state.lastFiredWater = Date.now();
        notifyClient(clientId, '💧 Time to Drink Water!',
          `Stay hydrated — aim for ${state.waterSchedule.goal} glasses today.`,
          'water-reminder', [{ action: 'drank', title: '✅ I Drank!' }]);
      }
    }

    // Tips of the day (Bug 6: on-or-after, once per day)
    if (state.tipsSchedule && state.lastFiredTips !== t) {
      if (h > state.tipsSchedule.hour ||
          (h === state.tipsSchedule.hour && now.getMinutes() >= (state.tipsSchedule.minute || 0))) {
        state.lastFiredTips = t;
        const tip = getTodayTipSW();
        notifyClient(clientId, '💡 ' + tip.t, tip.b, 'tips-daily', []);
      }
    }

    // Appointment reminders — one-time alarms (fire when fireAt <= now)
    if (state.apptReminders && state.apptReminders.length > 0) {
      const nowMs = Date.now();
      const fired = [];
      state.apptReminders.forEach(rem => {
        if (nowMs >= rem.fireAt) {
          notifyClient(clientId, rem.title, rem.body, 'appt-' + rem.id, []);
          fired.push(rem.id);
        }
      });
      if (fired.length) {
        state.apptReminders = state.apptReminders.filter(r => !fired.includes(r.id));
      }
    }

    // Vaccine reminders — fire at 9 AM on the reminderDate (3 days before due)
    if (state.vacReminders && state.vacReminders.length > 0 && h >= 9) {
      for (const rem of state.vacReminders) {
        if (rem.reminderDate !== t) continue;         // not today
        const firedKey = rem.memberId + '_' + rem.vacId;
        if (state.lastFiredVac[firedKey] === t) continue; // already fired today
        state.lastFiredVac[firedKey] = t;
        notifyClient(
          clientId,
          '💉 Vaccine Due in 3 Days',
          `${rem.memberName}: ${rem.vacName} is due on ${rem.dueDate}`,
          'vac-' + rem.memberId + '-' + rem.vacId,
          []
        );
      }
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

/* ── Activate ── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => checkAlarms())
  );
});

/* ── Fetch ── */
self.addEventListener('fetch', e => {
  checkAlarms();
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const c = res.clone(); caches.open(CACHE_NAME).then(ca => ca.put(e.request, c)); return res; })
      .catch(() => caches.match(e.request))
  );
});

/* ── Message ── */
self.addEventListener('message', e => {
  if (!e.data) return;
  checkAlarms();
  const clientId = e.data.clientId;
  const state = clientId ? getClientState(clientId) : null;

  if (e.data.type === 'SET_MED_SCHEDULE' && state) {
    state.medSchedule = e.data.schedule || [];
    state.lastFiredMed = {};
  }
  if (e.data.type === 'SET_WATER_SCHEDULE' && state) {
    state.waterSchedule = { interval: e.data.interval || 60, start: e.data.start || 8, end: e.data.end || 22, goal: e.data.goal || 8 };
    state.lastFiredWater = Date.now(); // Bug 7: not 0
  }
  if (e.data.type === 'CLEAR_MED_SCHEDULE' && state) { state.medSchedule = []; state.lastFiredMed = {}; }
  if (e.data.type === 'SET_TIPS_SCHEDULE' && state) { state.tipsSchedule = { hour: e.data.hour || 8, minute: e.data.minute || 0 }; state.lastFiredTips = ''; }
  if (e.data.type === 'CLEAR_TIPS_SCHEDULE' && state) { state.tipsSchedule = null; state.lastFiredTips = ''; }
  if (e.data.type === 'CLEAR_WATER_SCHEDULE' && state) { state.waterSchedule = null; }
  if (e.data.type === 'SET_VAC_REMINDERS' && state) {
    state.vacReminders = e.data.reminders || [];
    // Clear fired cache for any reminders that have new dates
    state.lastFiredVac = {};
  }
  if (e.data.type === 'CLEAR_VAC_REMINDERS' && state) {
    state.vacReminders = [];
    state.lastFiredVac = {};
  }
  if (e.data.type === 'SET_TAKEN_SLOTS' && state) {
    // Store which slots are fully taken today so checkAlarms can skip them
    state.takenSlotsDate = e.data.date || '';
    state.takenSlots = e.data.takenSlots || [];
    // If a slot is now taken and we previously fired it, no action needed
    // If a slot is taken before firing time, it will be skipped in checkAlarms
    checkAlarms(); // re-run immediately in case we should cancel a pending notification
  }
  if (e.data.type === 'SET_APPT_REMINDER' && state) {
    // Remove any existing reminder for this appt id, then add the new one
    state.apptReminders = (state.apptReminders || []).filter(r => r.id !== e.data.id);
    if (e.data.fireAt > Date.now()) {
      state.apptReminders.push({ id: e.data.id, fireAt: e.data.fireAt, title: e.data.title, body: e.data.body });
    }
  }
  if (e.data.type === 'CLEAR_APPT_REMINDER' && state) {
    state.apptReminders = (state.apptReminders || []).filter(r => r.id !== e.data.id);
  }
  if (e.data.type === 'CHECK_ALARMS') checkAlarms();
});

/* ── Periodic Background Sync ── */
self.addEventListener('periodicsync', e => {
  if (e.tag === 'hv-alarms') e.waitUntil(Promise.resolve().then(() => checkAlarms()));
});

/* ── Push ── */
self.addEventListener('push', e => {
  checkAlarms();
  if (!e.data) return;
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'HealthVault', body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'HealthVault', {
    body: d.body || '', icon: iconUrl('icon-192.png'), tag: d.tag || 'hv-push', actions: d.actions || []
  }));
});

/* ── Notification click ── */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  const clientId = e.notification.data && e.notification.data.clientId;
  if (e.action === 'taken') {
    // Extract slot from tag (e.g. 'med-morning' -> 'morning')
    const tag = e.notification.tag || '';
    const slot = tag.replace('med-', '');
    // Mark this slot as taken in the SW state so it won't fire again today
    if (clientId && slot && ['morning','afternoon','night'].includes(slot)) {
      const state = getClientState(clientId);
      const t = dateStr(new Date());
      if (state.takenSlotsDate !== t) { state.takenSlotsDate = t; state.takenSlots = []; }
      if (!state.takenSlots.includes(slot)) state.takenSlots.push(slot);
      state.lastFiredMed[slot] = t; // prevent re-fire
    }
    broadcastToClient(clientId, { type: 'MED_TAKEN', tag: e.notification.tag });
    e.waitUntil(focusApp(url));
    return;
  }
  if (e.action === 'drank') { broadcastToClient(clientId, { type: 'WATER_DRUNK' }); e.waitUntil(focusApp(url)); return; }
  e.waitUntil(focusApp(url));
});
