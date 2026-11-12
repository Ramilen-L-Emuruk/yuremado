import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// MapLibre の既定スタイルは index.css より先に読む。CSS は同じ詳細度なら後勝ちのため、
// 逆順（地図コンポーネント側で import）だと index.css のポップアップのダーク化が
// MapLibre 既定の白背景に上書きされて効かなくなる。
import 'maplibre-gl/dist/maplibre-gl.css'
import './index.css'
import { App } from './App'
import { I18nProvider } from './i18n/I18nProvider'
import { deviceLanguageTags, loadMessages, resolveLocale, type Locale, type Messages } from './i18n/messages'
import { readStoredLocaleSetting } from './hooks/useSettings'
import { ErrorBoundary } from './components/ErrorBoundary'
import { log } from './utils/logger'
import { installFrameProfiler } from './utils/frameProfiler'
import { installGlobalErrorLog } from './utils/globalErrorLog'
import { installSpeechCacheProbe } from './utils/speechAudioCache'
import { startAppUpdate } from './services/appUpdateRegister'
import { currentAppUpdater } from './services/appUpdate'

// コマ落ちの診断（`window.__frameProfiler`）を使えるようにする。**呼び口を用意するだけで、
// `start()` を呼ぶまで何も記録しない**（utils/frameProfiler.ts の `arm`）。このアプリは地震の
// ときに開かれるので、診断のための仕事を常時載せない。
installFrameProfiler()

// React の外——イベントハンドラ・`setTimeout`・Promise・`requestAnimationFrame` の中——で
// 投げられた例外を、アプリ時計のタイムスタンプ付きで記録に残す。ErrorBoundary はそこへ届かない。
// **画面には何も出さない**（理由は utils/globalErrorLog.ts の冒頭）。
installGlobalErrorLog()

// 合成済みチャンクの控えと投機の効きを外から読めるようにする（`window.__speechCache()`）。
// 呼び口を生やすだけで、何も記録し始めない（統計は控え側が常時数えている）。
installSpeechCacheProbe()

// サービスワーカーを登録し、新しい版の検出と適用を始める。新しい版は見つけても自分からは有効にならず、
// いつ適用するかは App.tsx が決める（発表中・再生中・入力中は待つ。→ services/appUpdate.ts）。
// ここで投げても画面は描く（更新に気づけなくなるだけで、地震の情報は出せる）
try {
  startAppUpdate()
} catch (err) {
  log.error('[sw] 新しい版の見張りを始められなかった（新しい版に気づけない）', err)
}

if ('serviceWorker' in navigator) {
  // 新 SW のインストールが中断されると installing → redundant で終わり、waiting に入らない。つまり上の
  // 更新検知は沈黙し、ユーザーは古い版のまま更新に気づけず、開発側にも痕跡が残らない（DevTools を開かない
  // 限り不可視）。せめてログに残す。
  //
  // 検知できる範囲は限定的で、そこを取り違えないよう明示しておく:
  //   - redundant は「インストール失敗」だけでなく「より新しい SW に正当に置き換えられた」ときにも起きる。
  //     両者をここで区別できないため、断定せず「中断」と表現する。
  //   - ready はアクティブな SW が現れるまで解決しないため、初回インストール自体が失敗した場合はここに
  //     到達しない（その場合オフライン機能が使えないだけで、アプリの通常動作には影響しない）。
  //   - ready は仕様上 reject しない。下の catch は then 内で予期せぬ例外が出たときの保険であって、
  //     登録失敗を捕まえるものではない。
  navigator.serviceWorker.ready
    .then((registration) => {
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'redundant') {
            log.error('[sw] 新バージョンのインストールが中断（失敗、または更に新しい版に置き換えられた）。前者なら古い版のまま動作し続ける')
          }
        })
      })
    })
    .catch((e) => log.error('[sw] 更新失敗の監視を設定できなかった（以後この検知は働かない）', e))
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('描画先の要素（#root）が見つからない')

/**
 * 最初の画面を描く前に辞書を待つ上限 (ms)。日本語以外の辞書は別の束で、ふつうは端末の控えから読むので待ちは短い。
 * 回線が詰まって読めないまま待ち続けると、地震のときに画面が出ない。上限を過ぎたら日本語で描き、読み終えたら差し替える。
 */
const PRELOAD_MESSAGES_TIMEOUT_MS = 3_000

/**
 * 選んだ言語（端末に合わせるなら端末の言語）の辞書を、最初の画面を描く前に読む（2026-11-12 ユーザー選択「辞書を読んでから描く (Recommended)」）。
 * 日本語はすぐ返る。読めない・上限を過ぎたときは辞書を渡さず、配り役が日本語で描いてから読み直す。
 */
async function preloadMessages(): Promise<{ locale: Locale; preloaded: Messages | undefined }> {
  const locale = resolveLocale(readStoredLocaleSetting(), deviceLanguageTags())
  if (locale === 'ja') return { locale, preloaded: undefined }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), PRELOAD_MESSAGES_TIMEOUT_MS) })
  try {
    const result = await Promise.race([loadMessages(locale), timeout])
    if (result === 'timeout') {
      log.warn(`[i18n] 言語「${locale}」の辞書を ${PRELOAD_MESSAGES_TIMEOUT_MS / 1000} 秒で読めず、日本語で描いてから差し替える`)
      return { locale, preloaded: undefined }
    }
    return { locale, preloaded: result }
  } catch (err) {
    // 配り役が同じ言語を読み直し、読めなければ日本語のまま記録を残す
    log.warn(`[i18n] 言語「${locale}」の辞書を起動の前に読めず、日本語で描いてから読み直す`, err)
    return { locale, preloaded: undefined }
  } finally {
    clearTimeout(timer)
  }
}

// 起動の受け皿へ「起動が終わった」と知らせるのは、辞書を待つ前にする。辞書は無くても日本語で描けるので起動に要るファイルに
// 数えない —— 待った後に知らせると、日本語以外の辞書だけが読めないときにページごと読み直し、2 回目には
// 「画面を読み込めませんでした」の文面まで出す。知らせた後に辞書が読めなければ、受け皿は新しい版の確認を前倒しする。
watchBootRecovery()

void preloadMessages().then(({ locale, preloaded }) => {
  // 最後の受け皿。**`App` 自身のレンダー例外はここでしか拾えない** —— `App` は 1700 行超の単一
  // コンポーネントで、メモ化していない裸の計算式を本体に多数持つ。その中で投げられた例外は、React が
  // 子の照合に入る前に `App()` の呼び出しそのものの中で起きるため、`App` の内側へ境界を置いても届かない。
  //
  // ここまで落ちると `App` の state は失われ、副作用の後始末で WebSocket も切れる。地図・各タブには
  // 別に境界を置いてあり（`App.tsx`）、そちらで受け止められるものはここまで来ない。
  //
  // 受け皿は言語の配り役の内側に置く。落ちたときの表示も選んだ言語で出すため（2026-11-12 ユーザー選択「選んだ言語で出す (Recommended)」）。
  // 配り役は辞書を持つだけで、描き方の誤りで落ちる処理を持たない。
  createRoot(rootEl).render(
    <StrictMode>
      <I18nProvider locale={locale} preloaded={preloaded}>
        <ErrorBoundary variant="root">
          <App />
        </ErrorBoundary>
      </I18nProvider>
    </StrictMode>,
  )
})

// 入口のモジュールがここまで動けば、起動に要るファイルは全部読めている。起動の途中で読めずに読み直していたら、そのことを残す。
// 起動した後に読めないファイルが出たら、読み直さずに新しい版を確かめに行く（発表の最中に画面を消さないため。
// 新しい版が見つかれば、いつものとおり待つ条件を見てから適用する）。仕組みは public/boot-recovery.js。
function watchBootRecovery(): void {
  const bootRecovery = (window as Window & { __bootRecovery?: BootRecovery }).__bootRecovery
  if (bootRecovery === undefined) {
    log.warn('[起動] 読み込みの受け皿（boot-recovery.js）が見つからない（読めないファイルがあっても読み直さない）')
    return
  }
  const recovered = bootRecovery.markBooted()
  if (recovered !== null) {
    if (recovered.failedShown) log.warn(`[起動] 読み直してもファイルを読めず「画面を読み込めませんでした」を出していた。再読み込みで起動できた（${recovered.reason}）`)
    else log.warn(`[起動] ファイルを読めなかったので 1 回読み直した（${recovered.reason}）`)
  }
  bootRecovery.onLateFailure((reason) => {
    log.warn(`[起動] 起動した後にファイルを読めなかった。新しい版を確かめに行く（${reason}）`)
    currentAppUpdater().checkNow()
  })
}

interface BootRecovery {
  markBooted(): { reason: string; failedShown: boolean } | null
  onLateFailure(listener: (reason: string) => void): void
}
