const CACHE = 'focusflow-v15';
const ASSETS = ['./index.html','./manifest.json'];
self.addEventListener('install', e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate', e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
// index.html はネットワーク優先（常に最新を取得）、失敗時のみキャッシュ
self.addEventListener('fetch', e=>{
  if(e.request.mode==='navigate'||e.request.url.endsWith('index.html')){
    e.respondWith(fetch(e.request).then(r=>{caches.open(CACHE).then(c=>c.put(e.request,r.clone()));return r;}).catch(()=>caches.match(e.request)));
  } else {
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
  }
});
