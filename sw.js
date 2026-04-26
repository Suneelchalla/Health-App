/**
 * HealthVault Service Worker v14 — SKIP_WAITING + all previous fixes
 *
 * v13 changes:
 *  - Handle SKIP_WAITING message so new HTML is served immediately on update
 *  - Bumped CACHE_NAME to v13 so old cached index.html is evicted on activate
 *
 * v12 changes (previous):
 *  - Skip taken medicine slots
 *  - Appointment reminders
 *
 * KEY FIX (v8) — Multi-user notification isolation
 * Previous fixes (v6/v7): various alarm and icon fixes
 */

const CACHE_NAME = 'healthvault-v14';
const ASSETS = [
  '/Health-App/', '/Health-App/index.html',
  '/Health-App/manifest.json', '/Health-App/icon-192.png', '/Health-App/icon-512.png'
];

/* ── Per-client schedule store ── */
const clientSchedules = new Map();

function getClientState(clientId) {
  if (!clientSchedules.has(clientId)) {
    clientSchedules.set(clientId, {
      medSchedule: [],
      waterSchedule: null,
      tipsSchedule: null,
      vacReminders: [],
      lastFiredMed: {},
      lastFiredWater: Date.now(),
      lastFiredTips: '',
      lastFiredVac: {},
      apptReminders: [],
      takenSlots: [],
      takenSlotsDate: ''
    });
  }
  return clientSchedules.get(clientId);
}

function dateStr(d) { return d.toISOString().split('T')[0]; }

function iconUrl(name) {
  return self.registration.scope + name;
}

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
      await self.registration.showNotification(title, opts);
    } else {
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
  {t:'Snack on nuts',b:'A handful of almonds or walnuts provides healthy fats, protein and magnesium.'},
  {t:'Stand up every hour',b:'Sitting for long periods increases cardiovascular risk. Move for 2 minutes each hour.'},
  {t:'No screens before bed',b:'Blue light delays melatonin by up to 3 hours. Switch off screens 1 hour before sleep.'},
  {t:'Annual health check-up',b:'A basic blood panel catches silent problems like high sugar or cholesterol early.'},
  {t:'Know your urine colour',b:'Pale yellow = well hydrated. Dark yellow = drink more water.'},
  {t:'Eat fermented foods',b:'Curd, idli, buttermilk provide probiotics that support gut bacteria and immunity.'},
  {t:'Limit sugar in drinks',b:'Replace cola with coconut water, nimbu pani or buttermilk.'},
  {t:'Strength train twice a week',b:'Bodyweight exercises like squats and push-ups maintain muscle mass and protect bones.'},
  {t:'Morning sunlight walk',b:'20 minutes outdoors in morning sun resets your body clock and boosts Vitamin D.'},
  {t:'5 minutes of gratitude',b:'Write 3 things you are grateful for each morning.'},
  {t:'Wash hands properly',b:'20 seconds with soap removes 99% of pathogens.'},
  {t:'Avoid eating late',b:'Finish dinner 2–3 hours before bed to improve digestion and support restful sleep.'},
  {t:'Fixed wake-up time',b:'Same wake time daily — even weekends — strengthens your body clock.'},
  {t:'Nature resets the mind',b:'Just 20 minutes in a park measurably reduces cortisol and improves focus.'},
  {t:'Cook with less salt',b:'Reduce salt gradually — you stop noticing the difference within 3 weeks.'},
  {t:'Celebrate small wins',b:'Acknowledging daily accomplishments activates the brain reward circuit.'},
  {t:'Limit caffeine after 2 PM',b:'Caffeine has a 5–6 hour half-life. Your 3 PM coffee is still active at 8 PM.'},
  {t:'Eat seasonal fruits',b:'Seasonal fruits are fresher, richer in nutrients and far cheaper.'},
  {t:'Dental check every 6 months',b:'Gum disease bacteria are linked to heart disease. Clean teeth = healthier body.'},
  {t:'Include more fibre',b:'25–30g of fibre daily from vegetables and legumes supports gut health.'},
  {t:'Cool room for better sleep',b:'18–20°C is the ideal sleep temperature for deeper sleep.'},
  {t:'Yoga for joint health',b:'Regular yoga reduces cortisol, improves flexibility and protects joints.'},
  {t:'Mindfulness for 10 minutes',b:'10 minutes of daily mindfulness reduces anxiety effectively over time.'},
  {t:'Limit news to once a day',b:'Constant news causes elevated anxiety. Check once at a fixed time and stop.'},
];

function getTodayTipSW() {
  const d = new Date();
  const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  return SW_TIPS[seed % SW_TIPS.length];
}

/* ── checkAlarms ── */
function checkAlarms() {
  const now = new Date();
  const h = now.getHours();
  const t = dateStr(now);
  const labels = { morning: '🌅 Morning', afternoon: '☀️ Afternoon', night: '🌙 Night' };

  for (const [clientId, state] of clientSchedules.entries()) {
    const takenToday = (state.takenSlotsDate === t) ? (state.takenSlots || []) : [];
    for (const entry of state.medSchedule) {
      if (h >= entry.hour && state.lastFiredMed[entry.slot] !== t) {
        if (takenToday.includes(entry.slot)) {
          state.lastFiredMed[entry.slot] = t;
          continue;
        }
        state.lastFiredMed[entry.slot] = t;
        notifyClient(clientId, `${labels[entry.slot] || '💊'} Medicines Due`, entry.names,
          'med-' + entry.slot, [{ action: 'taken', title: '✅ Mark as Taken' }]);
      }
    }

    if (state.waterSchedule && h >= state.waterSchedule.start && h < state.waterSchedule.end) {
      const intMs = state.waterSchedule.interval * 60000;
      if (Date.now() - state.lastFiredWater >= intMs) {
        state.lastFiredWater = Date.now();
        notifyClient(clientId, '💧 Time to Drink Water!',
          `Stay hydrated — aim for ${state.waterSchedule.goal} glasses today.`,
          'water-reminder', [{ action: 'drank', title: '✅ I Drank!' }]);
      }
    }

    if (state.tipsSchedule && state.lastFiredTips !== t) {
      if (h > state.tipsSchedule.hour ||
          (h === state.tipsSchedule.hour && now.getMinutes() >= (state.tipsSchedule.minute || 0))) {
        state.lastFiredTips = t;
        const tip = getTodayTipSW();
        notifyClient(clientId, '💡 ' + tip.t, tip.b, 'tips-daily', []);
      }
    }

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

    if (state.vacReminders && state.vacReminders.length > 0 && h >= 9) {
      for (const rem of state.vacReminders) {
        if (rem.reminderDate !== t) continue;
        const firedKey = rem.memberId + '_' + rem.vacId;
        if (state.lastFiredVac[firedKey] === t) continue;
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
  // SKIP_WAITING on install so the new SW activates immediately
  // without waiting for old tabs to close
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS).catch(() => {}))
  );
});

/* ── Activate ── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim()) // take control of all open tabs immediately
      .then(() => checkAlarms())
  );
});

/* ── Fetch — network-first for HTML so new index.html is always served ── */
self.addEventListener('fetch', e => {
  checkAlarms();
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;

  // Network-first for HTML files so updates are always picked up
  if (e.request.headers.get('accept')?.includes('text/html') ||
      e.request.url.endsWith('.html') || e.request.url.endsWith('/')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const c = res.clone();
          caches.open(CACHE_NAME).then(ca => ca.put(e.request, c));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for other assets (icons, manifests, etc.)
  e.respondWith(
    caches.match(e.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(e.request)
          .then(res => {
            const c = res.clone();
            caches.open(CACHE_NAME).then(ca => ca.put(e.request, c));
            return res;
          });
      })
      .catch(() => caches.match(e.request))
  );
});

/* ── Message ── */
self.addEventListener('message', e => {
  if (!e.data) return;

  // Handle SKIP_WAITING so page can trigger immediate SW update
  if (e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  checkAlarms();
  const clientId = e.data.clientId;
  const state = clientId ? getClientState(clientId) : null;

  if (e.data.type === 'SET_MED_SCHEDULE' && state) {
    state.medSchedule = e.data.schedule || [];
    state.lastFiredMed = {};
  }
  if (e.data.type === 'SET_WATER_SCHEDULE' && state) {
    state.waterSchedule = { interval: e.data.interval || 60, start: e.data.start || 8, end: e.data.end || 22, goal: e.data.goal || 8 };
    state.lastFiredWater = Date.now();
  }
  if (e.data.type === 'CLEAR_MED_SCHEDULE' && state) { state.medSchedule = []; state.lastFiredMed = {}; }
  if (e.data.type === 'SET_TIPS_SCHEDULE' && state) { state.tipsSchedule = { hour: e.data.hour || 8, minute: e.data.minute || 0 }; state.lastFiredTips = ''; }
  if (e.data.type === 'CLEAR_TIPS_SCHEDULE' && state) { state.tipsSchedule = null; state.lastFiredTips = ''; }
  if (e.data.type === 'CLEAR_WATER_SCHEDULE' && state) { state.waterSchedule = null; }
  if (e.data.type === 'SET_VAC_REMINDERS' && state) {
    state.vacReminders = e.data.reminders || [];
    state.lastFiredVac = {};
  }
  if (e.data.type === 'CLEAR_VAC_REMINDERS' && state) {
    state.vacReminders = [];
    state.lastFiredVac = {};
  }
  if (e.data.type === 'SET_TAKEN_SLOTS' && state) {
    state.takenSlotsDate = e.data.date || '';
    state.takenSlots = e.data.takenSlots || [];
    checkAlarms();
  }
  if (e.data.type === 'SET_APPT_REMINDER' && state) {
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
    const tag = e.notification.tag || '';
    const slot = tag.replace('med-', '');
    if (clientId && slot && ['morning','afternoon','night'].includes(slot)) {
      const state = getClientState(clientId);
      const t = dateStr(new Date());
      if (state.takenSlotsDate !== t) { state.takenSlotsDate = t; state.takenSlots = []; }
      if (!state.takenSlots.includes(slot)) state.takenSlots.push(slot);
      state.lastFiredMed[slot] = t;
    }
    broadcastToClient(clientId, { type: 'MED_TAKEN', tag: e.notification.tag });
    e.waitUntil(focusApp(url));
    return;
  }
  if (e.action === 'drank') { broadcastToClient(clientId, { type: 'WATER_DRUNK' }); e.waitUntil(focusApp(url)); return; }
  e.waitUntil(focusApp(url));
});
