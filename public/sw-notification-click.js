// 通知を押したときの処理。Service Worker（vite-plugin-pwa の generateSW が作る sw.js）が
// `importScripts` で読み込む（vite.config.ts の `workbox.importScripts`）。このファイルの名前を変えたら
// あちらも直すこと（読み込めないと Service Worker のインストールごと失敗する。scripts/swImportScripts.test.ts が見る）。
//
// Service Worker から出した通知は、ここで処理を書かないと押しても閉じるだけになる。
// 押したら、このアプリの画面を前面に出し、無ければアプリを開く。
//
// **探すのは、このスコープのアプリの画面だけ。** standard 版のスコープ（/yuremado/）は DMDSS 版
// （/yuremado/dmdss/。vite.config.ts の `base`）の URL も包むので、URL の前方一致だけで探すと、standard 版の
// 通知を押して DMDSS 版の画面が前に出る。内側のスコープの画面は外す。
// Service Worker が扱っていない画面（強制再読み込みの直後など）も拾う（`includeUncontrolled`）——
// 拾わないと、開いているのに 2 つ目のアプリを開き、DMDATA の同時接続枠を余計に食う。
//
// 失敗はここ（Service Worker のコンソール）にしか残せない。
const NESTED_SCOPE_DIRS = ['dmdss/']

function isOwnWindow(url, scopePath) {
  const path = new URL(url).pathname
  if (!path.startsWith(scopePath)) return false
  // 末尾のスラッシュが無い形（/yuremado/dmdss）も内側として外す（vite.config.ts の navigateFallbackDenylist と揃える）
  return !NESTED_SCOPE_DIRS.some(dir => !scopePath.endsWith(dir)
    && (path.startsWith(scopePath + dir) || path === scopePath + dir.slice(0, -1)))
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const scope = self.registration.scope
    const scopePath = new URL(scope).pathname
    try {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const own = windows.filter(c => isOwnWindow(c.url, scopePath))
      // 前面にあるものを優先し、無ければ最初の 1 つ
      const target = own.find(c => c.focused) ?? own[0]
      if (target) {
        try {
          await target.focus()
          return
        } catch (err) {
          console.error('[notify] 通知を押したが、アプリの画面を前に出せなかったので、開き直す', err)
        }
      }
      const opened = await self.clients.openWindow(scope)
      if (!opened) console.error('[notify] 通知を押したが、アプリを開けなかった', scope)
    } catch (err) {
      console.error('[notify] 通知を押したときの処理に失敗した', err)
    }
  })())
})
