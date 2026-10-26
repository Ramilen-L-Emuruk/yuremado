import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// MapLibre の既定スタイルは index.css より先に読む。CSS は同じ詳細度なら後勝ちのため、
// 逆順（地図コンポーネント側で import）だと index.css のポップアップのダーク化が
// MapLibre 既定の白背景に上書きされて効かなくなる。
import 'maplibre-gl/dist/maplibre-gl.css'
import './index.css'
import { App } from './App'
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

// 最後の受け皿。**`App` 自身のレンダー例外はここでしか拾えない** —— `App` は 1700 行超の単一
// コンポーネントで、メモ化していない裸の計算式を本体に多数持つ。その中で投げられた例外は、React が
// 子の照合に入る前に `App()` の呼び出しそのものの中で起きるため、`App` の内側へ境界を置いても届かない。
//
// ここまで落ちると `App` の state は失われ、副作用の後始末で WebSocket も切れる。地図・各タブには
// 別に境界を置いてあり（`App.tsx`）、そちらで受け止められるものはここまで来ない。
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary variant="root">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
