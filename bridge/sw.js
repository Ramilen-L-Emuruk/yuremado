// 旧アプリの Service Worker を外すためだけの Service Worker。
//
// 旧アプリ（github.io の /yuremado/・/yuremado/dmdss/）の端末には、前のアプリを控えから配る Service Worker が残っている。
// それが居る間は、橋渡しのページへ差し替えても控えの古い画面が出続ける。旧アプリは定期的に sw.js を確かめに来るので、
// 同じ場所にこれを置くと入れ替わり、すぐ有効になって控えを消し、自分の登録を外して、開いている画面を読み直させる。
// 読み直した画面は控えを通らずに橋渡しのページを受け取る。
//
// **消すのは旧アプリが作ったキャッシュだけ。** github.io の生成元は利用者ごとのサブドメインで、同じ生成元に別のアプリの
// キャッシュも置かれうるため、全部は消さない。旧アプリが作る名前は次のとおり。
// - Workbox の事前キャッシュ: `workbox-<種類>-<scope>`（scope が `<生成元>/yuremado/` で始まるもの）
// - 実行時キャッシュ（旧アプリの vite.config.ts の runtimeCaching が名付けたもの）: OLD_APP_CACHE_NAMES
const OLD_APP_CACHE_NAMES = [
  'p2pquake-history',
  'map-tiles',
  'generated-data-standard',
  'generated-data-dmdss',
  'bathymetry-tiles-standard',
  'bathymetry-tiles-dmdss',
]

function isOldAppCache(name) {
  if (OLD_APP_CACHE_NAMES.includes(name)) return true
  return name.startsWith('workbox-') && name.includes(`-${self.location.origin}/yuremado/`)
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(isOldAppCache).map(key => caches.delete(key)))
    await self.registration.unregister()
    const windows = await self.clients.matchAll({ type: 'window' })
    await Promise.all(windows.map(client => client.navigate(client.url).catch(() => undefined)))
  })())
})
