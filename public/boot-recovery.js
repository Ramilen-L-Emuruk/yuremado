// 起動の途中で自分のファイルが読めなかったとき、1 回だけ読み直す。index.html から、アプリ本体より先に読む。
//
// 起きる形: 新しい版を配った直後、古い index.html（ブラウザの控え・配信の途中）が、もう配っていない
// 古い入口のファイルを読みに行って 404 になる。入口が読めないとアプリは 1 行も動かず、画面は白いまま残る。
// 読み直せば新しい index.html が来るので、たいていは 1 回で直る。
//
// - 読み直すのは**起動が終わるまで**だけ。終わった後（`markBooted` の後）の失敗では読み直さない ——
//   発表の最中に画面を消すことになる。代わりに `onLateFailure` で知らせる（main.tsx が新しい版の確認を前倒しする）
// - 読み直したことは sessionStorage に印を残し、起動が終わったら消す。印が残ったまま 2 回目の失敗が来たら、
//   読み直さずに index.html の `#boot-failed` の文面を出す（読み直しを繰り返さない）
// - 印を書けない（sessionStorage が使えない）ときも読み直さない。数えられないまま読み直すと止まらない
// - 文面を出したことも印に残す。利用者が［再読み込み］で起動できたら、main.tsx がそれを記録に残す
// - 画面の文面はここに書かない。この JS は文字コードの指定なしで配られうるので、画面に出す日本語は UTF-8 と宣言した
//   index.html に置く。コンソールへ出す文字列も \u で逃がし、実行される部分を ASCII だけにする（コメントは化けても動きに関わらない）
;(function (root) {
  'use strict'
  var KEY = 'yuremado-boot-recovery'
  var booted = false
  var handled = false
  var lateListener = null

  function storage() {
    try {
      return root.sessionStorage
    } catch (e) {
      return null
    }
  }

  function readStamp(s) {
    try {
      var raw = s.getItem(KEY)
      if (raw === null) return null
      var v = JSON.parse(raw)
      if (v === null || typeof v !== 'object') return { reason: '', failedShown: false }
      return { reason: typeof v.reason === 'string' ? v.reason : '', failedShown: v.failedShown === true }
    } catch (e) {
      return { reason: '', failedShown: false }
    }
  }

  function writeStamp(s, stamp) {
    try {
      s.setItem(KEY, JSON.stringify(stamp))
      return s.getItem(KEY) !== null
    } catch (e) {
      return false
    }
  }

  // 開発者ツールのコンソールへ残す（アプリの記録の仕組みはまだ読めていない）
  function warn(msg) {
    try { root.console.warn(msg) } catch (e) { /* コンソールが無くても動きは変えない */ }
  }
  function error(msg) {
    try { root.console.error(msg) } catch (e) { /* 同上 */ }
  }

  function showFailed() {
    var doc = root.document
    var put = function () {
      var host = doc.getElementById('root')
      var tpl = doc.getElementById('boot-failed')
      if (host === null || tpl === null) return
      host.replaceChildren(tpl.content.cloneNode(true))
      var button = host.querySelector('button')
      if (button !== null) button.addEventListener('click', function () { root.location.reload() })
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', put)
    else put()
  }

  function onFailure(reason) {
    if (booted) {
      if (lateListener !== null) lateListener(reason)
      return
    }
    if (handled) return
    handled = true
    var s = storage()
    var stamp = s !== null ? readStamp(s) : null
    if (s !== null && stamp === null && writeStamp(s, { reason: reason, failedShown: false })) {
      // ファイルを読めなかったので 1 回読み直す
      warn('[\u8d77\u52d5] \u30d5\u30a1\u30a4\u30eb\u3092\u8aad\u3081\u306a\u304b\u3063\u305f\u306e\u3067 1 \u56de\u8aad\u307f\u76f4\u3059\uff08' + reason + '\uff09')
      root.location.reload()
      return
    }
    if (s !== null && stamp !== null) {
      writeStamp(s, { reason: stamp.reason + ' / ' + reason, failedShown: true })
      // 読み直してもファイルを読めなかった
      error('[\u8d77\u52d5] \u8aad\u307f\u76f4\u3057\u3066\u3082\u30d5\u30a1\u30a4\u30eb\u3092\u8aad\u3081\u306a\u304b\u3063\u305f\uff08' + stamp.reason + ' / ' + reason + '\uff09')
    } else {
      // 印を残せないので読み直さない
      error('[\u8d77\u52d5] \u30d5\u30a1\u30a4\u30eb\u3092\u8aad\u3081\u306a\u304b\u3063\u305f\u304c\u3001\u8aad\u307f\u76f4\u3057\u305f\u5370\u3092\u6b8b\u305b\u306a\u3044\u306e\u3067\u8aad\u307f\u76f4\u3055\u306a\u3044\uff08' + reason + '\uff09')
    }
    showFailed()
  }

  // 自分の配信元のビルド成果物だけを数える（拡張機能や外の配信元のファイルが読めなくても、起動とは関係が無い）
  function isOwnAsset(url) {
    if (typeof url !== 'string' || url === '') return false
    try {
      var u = new URL(url, root.location.href)
      return u.origin === root.location.origin && u.pathname.indexOf('/assets/') !== -1
    } catch (e) {
      return false
    }
  }

  // 読めなかった <script>・<link>（入口・modulepreload・スタイルシート）。error は泡立たないので捕捉の段で受ける。
  // 入口のモジュールが静的に読む先のどれかが読めなくても、入口の <script> に error が来る
  root.addEventListener(
    'error',
    function (e) {
      var t = e.target
      if (t === null || t === root || (t.tagName !== 'SCRIPT' && t.tagName !== 'LINK')) return
      var url = t.tagName === 'SCRIPT' ? t.src : t.href
      if (isOwnAsset(url)) onFailure('load ' + url)
    },
    true,
  )

  // 動的 import が読めなかった（Vite が投げる合図。既定の動作は止めない —— 呼び出し側へ例外を返す）
  root.addEventListener('vite:preloadError', function (e) {
    var err = e.payload
    onFailure('import ' + (err && err.message ? err.message : String(err)))
  })

  root.__bootRecovery = {
    /** 起動が終わった。読み直したことがあれば、そのきっかけ（と、読めませんでしたの文面を出したか）を返して印を消す */
    markBooted: function () {
      booted = true
      var s = storage()
      if (s === null) return null
      var stamp = readStamp(s)
      if (stamp === null) return null
      try {
        s.removeItem(KEY)
      } catch (e) {
        /* 消せなくても次の起動で読み直さないだけ */
      }
      return stamp
    },
    /** 起動が終わった後に読めなかったときの知らせ先 */
    onLateFailure: function (fn) {
      lateListener = fn
    },
  }
})(window)
