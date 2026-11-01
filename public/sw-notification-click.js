// 通知を押したときの処理。Service Worker（vite-plugin-pwa の generateSW が作る sw.js）が
// `importScripts` で読み込む（vite.config.ts の `workbox.importScripts`）。このファイルの名前を変えたら
// あちらも直すこと（読み込めないと Service Worker のインストールごと失敗する。scripts/swImportScripts.test.ts が見る）。
//
// Service Worker から出した通知は、ここで処理を書かないと押しても閉じるだけになる。
// 押したら、このアプリの画面を前面に出し、無ければアプリを開く。
//
// **探すのは、このスコープのアプリの画面だけ**（URL がスコープで始まる画面）。
// Service Worker が扱っていない画面（強制再読み込みの直後など）も拾う（`includeUncontrolled`）——
// 拾わないと、開いているのに 2 つ目のアプリを開き、DMDATA の同時接続枠を余計に食う。
//
// 失敗はここ（Service Worker のコンソール）にしか残せない。
function isOwnWindow(url, scopePath) {
  return new URL(url).pathname.startsWith(scopePath)
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
