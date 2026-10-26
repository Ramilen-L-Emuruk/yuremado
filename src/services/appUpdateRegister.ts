import { API_FETCH_TIMEOUT_MS, fetchWithTimeout } from '../utils/fetchWithTimeout'
import { log } from '../utils/logger'
import { createAppUpdater, installAppUpdater, type ApplyFailureMemo, type SwPlatform } from './appUpdate'

/**
 * 本物の更新の係を作って据え、サービスワーカーを登録する。`main.tsx` から 1 回だけ呼ぶ。
 *
 * **登録は vite-plugin-pwa の `registerSW` に任せず、ブラウザの口で自分で行う。** あちらは待っている版が
 * 現れるたびに「受け持ちが替わったら読み直す」受け手を足すので、別のタブが適用した瞬間にこのタブまで
 * 待つ条件（発表中・入力中）を通らずに読み直される。
 *
 * **サービスワーカーを使えないブラウザでも係は据える。** 配信されている版の番号を比べて新しい版に気づき、
 * 読み直しで取り込む。
 *
 * 開発時（`npm run dev`）は据えない（`sw.js` はビルドのときにしか作られない）。
 */
export function startAppUpdate(): void {
  if (!import.meta.env.PROD) return
  const platform = browserSwPlatform()
  const updater = createAppUpdater({
    platform,
    applyFailureMemo: sessionApplyFailureMemo,
    currentVersion: __APP_VERSION__,
    fetchVersion: fetchDeployedVersion,
    isOnline: () => navigator.onLine,
    isVisible: () => document.visibilityState === 'visible',
    onWake: (listener) => {
      document.addEventListener('visibilitychange', listener)
      window.addEventListener('online', listener)
    },
    now: () => performance.now(),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    reload: () => window.location.reload(),
  })
  installAppUpdater(updater)
  updater.start()
}

function browserSwPlatform(): SwPlatform | null {
  if (!('serviceWorker' in navigator)) {
    log.warn('[sw] このブラウザはサービスワーカーを使えない（オフラインでは開けない。新しい版は番号を比べて確かめる）')
    return null
  }
  const sw = navigator.serviceWorker
  return {
    register: () => sw.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }),
    onControllerChange: (listener) => sw.addEventListener('controllerchange', listener),
    controlledAtStart: sw.controller !== null,
  }
}

const APPLY_FAILED_KEY = 'yuremado-apply-failed'

/**
 * 新しい版へ移るつもりで読み直したとき、読み直す前の版の番号を、そのタブの読み直しをまたいで覚える。タブを閉じれば消える（次に開いたときは
 * また自動で適用を試してよい）。読み書きできなければ覚えない（自動の適用を続けるだけ）。
 */
const sessionApplyFailureMemo: ApplyFailureMemo = {
  takePrevious() {
    try {
      const from = sessionStorage.getItem(APPLY_FAILED_KEY)
      if (from !== null) sessionStorage.removeItem(APPLY_FAILED_KEY)
      return from
    } catch (err) {
      log.warn('[sw] 前回の適用の結果を読めなかった（自動の適用を続ける）', err)
      return null
    }
  },
  remember(fromVersion) {
    try {
      sessionStorage.setItem(APPLY_FAILED_KEY, fromVersion)
    } catch (err) {
      log.warn('[sw] 適用が効かなかったことを覚えられなかった（次も自動で適用を試す）', err)
    }
  },
}

/**
 * 配信されている版の番号を `version.json`（ビルドのときに書き出す。`vite.config.ts`）から取る。
 *
 * **事前キャッシュにも実行時キャッシュにも載らない**（`json` は事前キャッシュの拡張子に無く、
 * 実行時キャッシュの規則は `data/` の下だけを見る）。だから Service Worker が古い版を返すことは無く、
 * HTTP のキャッシュも `no-store` で避ける。
 */
async function fetchDeployedVersion(): Promise<string | null> {
  return fetchWithTimeout(
    `${import.meta.env.BASE_URL}version.json`,
    { timeoutMs: API_FETCH_TIMEOUT_MS, signal: null, init: { cache: 'no-store' } },
    async (res) => {
      if (!res.ok) {
        log.warn(`[sw] 配信されている版の番号を読めなかった（version.json が ${res.status}）`)
        return null
      }
      const body: unknown = await res.json()
      const version = typeof body === 'object' && body !== null ? (body as { version?: unknown }).version : undefined
      if (typeof version === 'string' && version !== '') return version
      log.warn('[sw] version.json に版の番号が無かった')
      return null
    },
  )
}
