// プッシュ通知を受けたときの処理（docs/relay-server-design.md §6.7）。Service Worker（vite-plugin-pwa の generateSW が作る sw.js）が
// `importScripts` で読み込む（vite.config.ts の `workbox.importScripts`）。名前を変えたらあちらも直すこと
// （読み込めないと Service Worker のインストールごと失敗する。scripts/swImportScripts.test.ts が見る）。
//
// 中継が送るのは題・本文・tag・閉じるまで残すか・押したときの開き先（`open`。URL の問い合わせの形）。判定と文面は中継がアプリと同じ部品で作っている。
// **出し方は画面内の通知（src/utils/notifications.ts の showBrowserNotification）と揃える** —— 同じ tag で置き換え、
// 置き換えでも知らせ直す（renotify）。アプリを開いている端末では画面内の通知と同じ tag なので、1 つにまとまる。
//
// **届いたら必ず通知を出す。** Web Push は「届いたら通知を出す」約束で購読している（userVisibleOnly）ので、
// 中身が読めなくても黙って捨てない。失敗はここ（Service Worker のコンソール）にしか残せない。
const PUSH_ICON = new URL('icons/icon.svg', self.registration.scope).href

// 設定「アプリを開いている間は通知しない」（src/services/notifyQuietWhileOpen.ts）。ふだんは中継が送る前に尋ねて送らないので、
// ここへ届くのは尋ねる前に送られていた分（切り替わりの瞬間・中継との接続が切れていた間）だけ。
// **捨ててよいのは Chromium 系だけ** —— Chromium はそのサイトのタブが見えていれば、通知を出さないプッシュを咎めない。
// iPhone・Safari（WebKit）は窓が見えていても数えて 3 回で購読を打ち切り、Firefox も回数の枠から引くので、必ず出す。
// 見分けは navigator.userAgentData（Chromium 系にだけある）
const QUIET_ANSWER_TIMEOUT_MS = 500

async function quietWhileOpen() {
  try {
    const visible = await visibleWindowsOnChromium()
    if (visible.length === 0) return false
    const answers = await Promise.all(visible.map(askQuiet))
    return answers.some((a) => a)
  } catch (err) {
    console.error('[push] アプリを開いている間の扱いを確かめられなかったので、通知を出す', err)
    return false
  }
}

// 通知を出さずに済ませても咎められない窓（Chromium 系で、そのサイトの窓が見えている）。それ以外の環境では空
async function visibleWindowsOnChromium() {
  if (!self.navigator || !self.navigator.userAgentData) return []
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  return windows.filter((c) => c.visibilityState === 'visible')
}

// 鳴らさずに差し替える報（`quiet`。緊急地震速報の、格上げも引き上げも無い続報）で、同じ tag の前の通知が閉じられていたら
// 出さずに済ませてよいか。アプリの画面内の差し替え（src/utils/notifications.ts の replaceBrowserNotificationQuietly）は、閉じた通知を出し直さない。
// **プッシュは捨てられる場面が限られる**（上の quietWhileOpen と同じ理由）ので、出さずに済ませるのは Chromium 系で窓が見えているときだけ。
// それ以外は鳴らさずに出し直す（2026-11-10 ユーザー選択「鳴らさずに出し直す (Recommended)」）
async function skipQuietReplace(tag) {
  try {
    const still = await self.registration.getNotifications({ tag })
    if (still.length > 0) return false
    const visible = await visibleWindowsOnChromium()
    return visible.length > 0
  } catch (err) {
    console.error('[push] 前の通知が残っているかを確かめられなかったので、鳴らさずに出す', err)
    return false
  }
}

// 見えている窓に止めるかを尋ねる。返事が無ければ止めない（出す側へ倒す）
function askQuiet(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => {
      console.warn('[push] 見えているアプリの窓から返事が無いので、通知を出す')
      resolve(false)
    }, QUIET_ANSWER_TIMEOUT_MS)
    channel.port1.onmessage = (ev) => {
      clearTimeout(timer)
      resolve(!!(ev.data && ev.data.quiet === true))
    }
    client.postMessage({ type: 'push-quiet-query' }, [channel.port2])
  })
}

self.addEventListener('push', (event) => {
  let data = null
  try {
    data = event.data ? event.data.json() : null
  } catch (err) {
    console.error('[push] プッシュ通知の中身を読めなかった', err)
  }
  const title = data && typeof data.title === 'string' && data.title ? data.title : '揺れ窓'
  // 鳴らさずに差し替える報。知らせ直さず（renotify なし）、音も振動も出さない（silent）
  const quiet = !!(data && data.quiet === true)
  const hasTag = !!(data && typeof data.tag === 'string' && data.tag)
  const options = {
    body: data && typeof data.body === 'string' ? data.body : '',
    icon: PUSH_ICON,
    tag: hasTag ? data.tag : 'push',
    requireInteraction: !!(data && data.requireInteraction),
    renotify: !quiet,
    silent: quiet,
    // 押したときの開き先。読むのは sw-notification-click.js（画面内の通知も同じ形で data に入れる）
    data: { open: data && typeof data.open === 'string' ? data.open : '' },
  }
  event.waitUntil((async () => {
    if (await quietWhileOpen()) {
      console.info('[push] 設定によりアプリが画面に出ている間は通知を出さない', options.tag)
      return
    }
    // tag が無い報は、差し替える相手を tag で引けない（既定の 'push' は別の報の通知にも当たる）ので、見ずに鳴らさずに出す
    if (quiet && !hasTag) {
      console.warn('[push] 鳴らさずに差し替える報に tag が無いので、前の通知を見ずに鳴らさずに出す')
    } else if (quiet && await skipQuietReplace(options.tag)) {
      console.info('[push] 差し替える通知がもう閉じられていて、アプリが画面に出ているので出し直さない', options.tag)
      return
    }
    try {
      await self.registration.showNotification(title, options)
    } catch (err) {
      // renotify を受け付けない環境がある（tag 無しで renotify を付けたときなど）。外して出し直す
      console.error('[push] プッシュ通知を出せなかったので、知らせ直しを外して出し直す', options.tag, quiet ? '（鳴らさずに差し替える報）' : '', err)
      const { renotify: _renotify, ...rest } = options
      try {
        await self.registration.showNotification(title, rest)
      } catch (retryErr) {
        console.error('[push] 出し直しても通知を出せなかった', options.tag, retryErr)
        throw retryErr
      }
    }
  })())
})
