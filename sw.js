/**
 * HealthVault Service Worker v5
 * Handles: cache-first serving, background medicine reminders, background water reminders
 */
const CACHE_NAME = 'healthvault-v5';
const ASSETS = [
  '/Health-App/','/Health-App/index.html',
  '/Health-App/manifest.json','/Health-App/icon-192.png','/Health-App/icon-512.png'
];

let medSchedule=[],waterSchedule=null,lastFiredMed={},lastFiredWater=0;

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(ASSETS).catch(()=>{})).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()).then(()=>{ setInterval(checkAlarms,60000); checkAlarms(); })
  );
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(fetch(e.request).then(res=>{const c=res.clone();caches.open(CACHE_NAME).then(ca=>ca.put(e.request,c));return res;}).catch(()=>caches.match(e.request)));
});
self.addEventListener('message',e=>{
  if(!e.data) return;
  if(e.data.type==='SET_MED_SCHEDULE'){medSchedule=e.data.schedule||[];lastFiredMed={};}
  if(e.data.type==='SET_WATER_SCHEDULE'){waterSchedule={interval:e.data.interval||60,start:e.data.start||8,end:e.data.end||22,goal:e.data.goal||8};lastFiredWater=0;}
  if(e.data.type==='CLEAR_MED_SCHEDULE') medSchedule=[];
  if(e.data.type==='CLEAR_WATER_SCHEDULE') waterSchedule=null;
});

function dateStr(d){ return d.toISOString().split('T')[0]; }
function notify(title,body,tag,actions){
  return self.registration.showNotification(title,{body,icon:'/Health-App/icon-192.png',badge:'/Health-App/icon-192.png',tag,vibrate:[200,100,200],renotify:true,data:{url:'/Health-App/index.html',tag},actions:actions||[]}).catch(()=>{});
}
function broadcast(msg){
  self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>cs.forEach(c=>c.postMessage(msg))).catch(()=>{});
}
function focusApp(url,e){
  return self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
    for(const c of cs){ if(c.url.includes('/Health-App/')&&'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  });
}

function checkAlarms(){
  const now=new Date(),h=now.getHours(),m=now.getMinutes(),t=dateStr(now);
  const labels={morning:'🌅 Morning',afternoon:'☀️ Afternoon',night:'🌙 Night'};
  for(const entry of medSchedule){
    if(h===entry.hour&&m<2&&lastFiredMed[entry.slot]!==t){
      lastFiredMed[entry.slot]=t;
      notify(`${labels[entry.slot]||'💊'} Medicines Due`,entry.names,'med-'+entry.slot,[{action:'taken',title:'✅ Mark as Taken'}]);
    }
  }
  if(waterSchedule&&h>=waterSchedule.start&&h<waterSchedule.end){
    const intMs=waterSchedule.interval*60000;
    if(Date.now()-lastFiredWater>=intMs){
      lastFiredWater=Date.now();
      notify('💧 Time to Drink Water!',`Stay hydrated — aim for ${waterSchedule.goal} glasses today.`,'water-reminder',[{action:'drank',title:'✅ I Drank!'}]);
    }
  }
}

self.addEventListener('push',e=>{
  if(!e.data) return;
  let d={};try{d=e.data.json();}catch{d={title:'HealthVault',body:e.data.text()};}
  e.waitUntil(notify(d.title||'HealthVault',d.body||'',d.tag||'hv-push',d.actions||[]));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=(e.notification.data&&e.notification.data.url)||'/Health-App/index.html';
  if(e.action==='taken'){ broadcast({type:'MED_TAKEN',tag:e.notification.tag}); e.waitUntil(focusApp(url)); return; }
  if(e.action==='drank'){ broadcast({type:'WATER_DRUNK'}); e.waitUntil(focusApp(url)); return; }
  e.waitUntil(focusApp(url));
});
