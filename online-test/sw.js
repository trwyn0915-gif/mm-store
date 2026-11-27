const CACHE="mm-world-shell-v211";
const SHELL=["./","./index.html","./manifest.webmanifest"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>{
 const u=new URL(event.request.url);
 if(event.request.method!=="GET"||u.origin!==location.origin)return;
 if(event.request.mode==="navigate"||u.pathname.endsWith("/index.html")){
  event.respondWith(fetch(new Request(event.request,{cache:"no-store"})).then(res=>{
   if(res.ok)caches.open(CACHE).then(c=>c.put(event.request,res.clone()));
   return res;
  }).catch(()=>caches.match(event.request).then(hit=>hit||caches.match("./index.html"))));
  return;
 }
 event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request).then(res=>{
  if(res.ok&&u.pathname.includes("/online-test/"))caches.open(CACHE).then(c=>c.put(event.request,res.clone()));
  return res;
 })));
});