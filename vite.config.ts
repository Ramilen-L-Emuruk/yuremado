import { defineConfig, loadEnv, type ConfigEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { perfReportPlugin } from './scripts/perf/vite-plugin-perf-report'
import { shouldInjectDevApiKey, shouldInjectDevArrivalToken } from './scripts/dev-api-key-gate'
import { isInsideClaudeDir } from './scripts/dev-watch-ignore'
import { devServerLockPlugin } from './scripts/dev-server-lock'
import { BUILD_OUT_DIR } from './scripts/buildOutDir'
import { PRECACHE_GLOB_PATTERNS, PRECACHE_MAX_FILE_BYTES } from './scripts/precacheBudget'
import { offlineDataRuntimeCaching } from './scripts/offlineData'
import { offlineBathymetryRuntimeCaching } from './scripts/offlineBathymetry'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
)

// 配信パス。版を 1 つにまとめたアプリは独自ドメインの直下（https://yuremado.com/）から配る
// （docs/relay-server-design.md §0 の 2026-10-30 の行）。github.io の `/yuremado/`・`/yuremado/dmdss/` には
// 橋渡しのページだけを置く。
const base = '/'

// 実行時キャッシュの名前の末尾（`generated-data-<これ>` など）。版を分けていた頃は版の名前を入れていた。
// 新しいドメインには前の名前のキャッシュが無いので、どの名前でもよい。
const RUNTIME_CACHE_SUFFIX = 'app'

// dev サーバーの門（`scripts/dev-server-lock.ts`）の記録の鍵。版を分けていた頃は版の名前（standard・dmdss）だった
const DEV_SERVER_LOCK_KEY = 'app'

// manifest の文言。タイトル・説明は index.html の側にも同じものが書いてある（版が 1 つになったので書き換えない）。
// タイトルは「揺れ窓」（docs/relay-server-design.md §0 の 2026-10-31 の行）。
const strings = {
  title: '揺れ窓',
  shortName: '揺れ窓',
  description: '気象庁の地震情報・緊急地震速報・津波情報をリアルタイムに表示します。',
} as const

// dev サーバーの監視対象から外す `.claude/` の絶対パス。
//
// ここに置かれるのはワークツリー（別ブランチの作業コピー）・エージェントやスキルの定義・
// スクリーンショット・ログ等で、いま動かしている dev サーバーが読み込むものは無い（ワークツリーの中にも
// `src/` はあるが、それはそのワークツリーで起動した別の dev サーバーが扱う）。外さないと、並行して動く
// 別セッションがワークツリー内のファイルを触るたびに、こちらのブラウザがページ全体をリロードする
// （index.html の変更で page reload、tsconfig.json の変更ではキャッシュ破棄を伴う full-reload）。
// 設定の窓「テスト時刻設定」のリプレイは実時間で進むため、途中でリロードされると窓の最初から
// やり直しになる。
//
// 判定の中身（glob で書けない理由・パス区切りの吸収・ディレクトリ自身を含める理由）は
// `isInsideClaudeDir` 側のコメントにある。
const CLAUDE_DIR = fileURLToPath(new URL('./.claude/', import.meta.url))

// 同じく監視から外す `.cache/`（生成・調査スクリプトの控え。→ `scripts/lib/cacheDir.mjs`）。
// dev サーバーが読み込むものは無く、メインの checkout では数 GB になるので、張る監視ハンドルが無駄に増える。
// 判定は `.claude/` と同じ関数を使う（名前は `.claude/` 用だが、中身は「渡した 1 つのディレクトリの中か」を見るだけ）。
const CACHE_DIR = fileURLToPath(new URL('./.cache/', import.meta.url))

/**
 * この設定ファイルが置かれているディレクトリ。dev サーバーの記録（`.dev-server.json`）の置き場所。
 * **`process.cwd()` ではなくここから取る** —— 呼び出し元のディレクトリに左右されず、
 * ワークツリーごとに 1 つの記録になるようにするため。
 */
const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url))

/**
 * dev サーバー限定で `.env.local` の DMDATA_API_KEY を import.meta.env へ注入する。
 * 予報（鍵の経路）の検証のたびに設定の窓へ API キーを貼り直す手間を省くための措置。
 *
 * 露出を最小にするため、envPrefix は既定（VITE_ のみ）から広げず、このキー 1 本だけを
 * define で渡す。接頭辞を開放すると、将来 `.env.local` に置かれた別の DMDATA_ 系の秘密が
 * レビューを経ずにクライアントへ載ってしまう。
 *
 * 渡してよい状況の判定は `scripts/dev-api-key-gate.ts` の `shouldInjectDevApiKey`（build・preview・
 * `--host` を除く）。ユニットテストで固定するため別ファイルに置いている。
 *
 * `server.host` を本ファイルで設定するようになったら、argv だけでは LAN 公開を判定できなく
 * なるので判定側も見直すこと。
 */
function devApiKeyDefine(configEnv: ConfigEnv): Record<string, string> {
  if (!shouldInjectDevApiKey(configEnv, process.argv)) return {}
  const key = loadEnv(configEnv.mode, process.cwd(), 'DMDATA_').DMDATA_API_KEY
  return key ? { 'import.meta.env.DMDATA_API_KEY': JSON.stringify(key) } : {}
}

/**
 * dev サーバーへ到達予想トークンを流し込む（→ `shouldInjectDevArrivalToken`）。
 *
 * **`ARRIVAL_` プレフィクスでしか読まない。** 署名用の秘密鍵は `TOKEN_SIGNING_PRIVATE_KEY` という
 * 別の頭文字にしてあり、ここには入ってこない（同じ頭文字にすると秘密鍵までバンドルへ載る）。
 */
function devArrivalTokenDefine(configEnv: ConfigEnv): Record<string, string> {
  if (!shouldInjectDevArrivalToken(configEnv, process.argv)) return {}
  const token = loadEnv(configEnv.mode, process.cwd(), 'ARRIVAL_').ARRIVAL_TOKEN
  return token ? { 'import.meta.env.ARRIVAL_TOKEN': JSON.stringify(token) } : {}
}

/**
 * dev サーバーへ予報キーを流し込む（門は到達予想トークンと同じ `shouldInjectDevArrivalToken`）。
 *
 * **`FORECAST_` プレフィクスでしか読まない。** 予報キーの署名用の秘密鍵は `TOKEN_SIGNING_FORECAST_PRIVATE_KEY`
 * という別の頭文字にしてあり、ここには入ってこない。
 */
function devForecastKeyDefine(configEnv: ConfigEnv): Record<string, string> {
  if (!shouldInjectDevArrivalToken(configEnv, process.argv)) return {}
  const key = loadEnv(configEnv.mode, process.cwd(), 'FORECAST_').FORECAST_KEY
  return key ? { 'import.meta.env.FORECAST_KEY': JSON.stringify(key) } : {}
}

export default defineConfig(configEnv => ({
  base,
  server: {
    // 監視から .claude/ と .cache/ の配下を外す（理由は CLAUDE_DIR・CACHE_DIR の説明）。
    // ここで渡した値は vite の既定（node_modules・.git・test-results・cacheDir・outDir）を
    // 置き換えるのではなく加算される（vite 6 の resolveChokidarOptions）ため、既定値は書かない。
    watch: {
      ignored: [(p: string) => isInsideClaudeDir(CLAUDE_DIR, p) || isInsideClaudeDir(CACHE_DIR, p)],
    },
  },
  build: {
    outDir: BUILD_OUT_DIR,
    rollupOptions: {
      output: {
        // **precache 上限（1 ファイル 2 MiB）に収めるためのチャンク分割。**
        //
        // 超えると vite-plugin-pwa がビルドを exit 1 で止める。ただし本当に困るのは超えた
        // 瞬間ではなく、**上限すれすれで走り続けること** —— main チャンクは 2026-09-25 から
        // 4 日間、上限の 99.9%（余裕 2 kB）で通っていて、次に足した変更でいきなりビルドが
        // 通らなくなった。手前で止める仕組みは `scripts/check-precache-budget.ts`。
        //
        // **`maplibre-gl` と React を切り離す。** main チャンク 2,095 kB のうち `maplibre-gl`
        // だけで 1,039 kB を占めていた（分けると main は 905 kB）。precache の総量は増えず
        // （4,445 → 4,437 KiB）、アプリ側を直しただけのときに地図ライブラリの 1 MB を
        // 配り直さずに済む。
        //
        // **JMA2001 走時表は静的 import のまま分ける。** 動的 import にすると「まだ読み込めて
        // いない」状態が生まれ、電文を受け取った瞬間に同期で走時を引く設計が成り立たなくなる。
        // 静的な import なら ES モジュールの決まりでエントリの実行前に読み込まれるので、
        // アプリから見れば同期のまま（→ `src/utils/travelTime.ts` の冒頭）。
        //
        // 返り値が `undefined` のものは vite の既定の分け方に任せる。
        manualChunks(id: string) {
          const path = id.replace(/\\/g, '/')
          if (path.includes('/src/data/jma2001TravelTime')) return 'travel-time'
          if (path.includes('/node_modules/maplibre-gl/')) return 'maplibre'
          // react と react-dom は同じチャンクへ入れる（分けると初期化の順序に依存する）。
          if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(path)) return 'react'
          return undefined
        },
      },
    },
  },
  // maplibre-gl を依存最適化(pre-bundle)の対象外にする。pre-bundle されると GeoJSON タイル化を
  // 担う web worker のロードが壊れ、line/circle が描画されない（背景 raster は worker 不要なので
  // 描けてしまい切り分けにくい）。PoC で確認済みの既知の罠（MapLibre 移行 F0）。
  optimizeDeps: { exclude: ['maplibre-gl'] },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    ...devApiKeyDefine(configEnv),
    ...devArrivalTokenDefine(configEnv),
    ...devForecastKeyDefine(configEnv),
  },
  plugins: [
    // 同じ場所で二本目が立つのを止める門。**他より先に効かせる**ため先頭に置く。
    // Vite は使用中のポートを避けて勝手にずれるので、二重起動は失敗として現れない（→ そのファイル）
    devServerLockPlugin({ variant: DEV_SERVER_LOCK_KEY, base, root: PROJECT_ROOT }),
    react(),
    // dev サーバー専用: 実機計測の証跡収集（/__perf-script・/__perf-report）。build には含まれない
    perfReportPlugin(),
    // 配信している版の番号（`version.json`）。開いているページが、待っている新しい版の番号を知るために読む
    // （`src/services/appUpdateRegister.ts`）。事前キャッシュにも実行時キャッシュにも載らない名前・場所に置く。
    {
      name: 'emit-version-json',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: pkg.version }) })
      },
    },
    VitePWA({
      // **新しい版は見つけても自分からは有効にしない。** いつ適用するかはアプリが決める（発表中・再生中・
      // 入力中は待つ。→ src/services/appUpdate.ts・src/utils/appUpdateGate.ts）。即座に有効にすると、
      // 開いているページがまだ読んでいない古い版のファイルが片付けられ、後から読みに行って失敗する。
      registerType: 'prompt',
      // 登録は `src/services/appUpdateRegister.ts` がブラウザの口で自分で行う（`virtual:pwa-register` は使わない。
      // 理由はそのファイルの冒頭）。
      injectRegister: false,
      includeAssets: ['icons/*.svg', 'icons/*.png'],
      manifest: {
        name: strings.title,
        short_name: strings.shortName,
        description: strings.description,
        theme_color: '#12151a',
        background_color: '#0a0c10',
        display: 'standalone',
        lang: 'ja',
        start_url: base,
        scope: base,
        // 元の絵は icon.svg 1 枚。PNG は scripts/build-app-icons.mjs がそこから焼く（描き直したら焼き直す）。
        // - 192・512 の PNG（any）: SVG を読まないランチャー向け。角丸のまま
        // - maskable の 512: 角を端末が切るので、背景を全面に塗った版を別に置く。角丸の絵を maskable に
        //   兼用すると、切り抜きの外へ透明の角が残る
        icons: [
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        screenshots: [],
      },
      workbox: {
        // 拾う拡張子と 1 ファイルの上限は `scripts/precacheBudget.ts` が持つ（ビルド後の
        // 検査スクリプトと同じ値を見るため。片方だけ書き換えると検査がすり抜ける）。
        globPatterns: [...PRECACHE_GLOB_PATTERNS],
        maximumFileSizeToCacheInBytes: PRECACHE_MAX_FILE_BYTES,
        // 通知を押したときの処理（`public/sw-notification-click.js`）と、プッシュ通知を受けたときの処理（`public/sw-push.js`）。
        // sw.js と同じ場所に置かれるので相対で書く
        importScripts: ['sw-notification-click.js', 'sw-push.js'],
        // 古い版の事前キャッシュを SW の入れ替えで片付ける。版を分けていた頃は standard 版のスコープが
        // DMDSS 版のスコープを包んでいて、片付けが DMDSS 版の事前キャッシュまで消すため standard 版だけ切っていた。
        // 独自ドメインの直下には包まれるスコープが無いので、既定どおり片付ける。
        cleanupOutdatedCaches: true,
        // **ここへ追記するときは、URL を正規表現リテラルで書くことに注意。**
        // ソース上は `https:\/\/...` とエスケープされるため、`https://` を素の文字列として
        // 探す走査には掛からない（外部への通信経路を数え上げる調査で実際に取りこぼした）。
        //
        // 地図タイルの CacheFirst 規則（`basemaps.cartocdn.com`）は初期実装の
        // React-Leaflet + Carto Dark 時代の残りで、MapLibre へ移ったあとは叩く側が無かった
        // ため外した（`package.json` に leaflet 依存は無く、地図は自前の GeoJSON 描画と
        // GEBCO ラスタだけ）。GEBCO のタイルは日本周辺の z8 までだけ下の規則で控え、それ以外は配信元の
        // `Cache-Control` に任せている。
        //
        // **既にあの規則でキャッシュを作った端末には `map-tiles` が残る。** `cleanupOutdatedCaches`
        // が消すのはプリキャッシュだけで、`runtimeCaching` が作った独自の cacheName は誰も
        // 消さない。ただし**読む側がもう居ないので実害は無い**（ディスクに残るだけ）ため、
        // 後始末は入れていない。入れるなら Service Worker の `activate` で名指しで
        // `caches.delete('map-tiles')` する形になる。
        runtimeCaching: [
          // 地図の生成データ 7 本と読み上げ辞書 3 本をオフラインでも使えるよう控える。
          // 対象のファイル名・規則・キャッシュ名は `scripts/offlineData.ts`（事前キャッシュに
          // 載せられない理由もそちら）。
          offlineDataRuntimeCaching(base, RUNTIME_CACHE_SUFFIX),
          // 海底地形のタイルを、録画モードの先読みと同じ範囲だけ控え、控えを先に返す（範囲と理由は `scripts/offlineBathymetry.ts`）。
          offlineBathymetryRuntimeCaching(RUNTIME_CACHE_SUFFIX),
          // 中継の一覧・束・札の口は載せない。一覧を控えから返すと、張り直したときの取り戻しが
          // 取れていないのに「取れた」に化ける（束と電文本体はアプリが IndexedDB に控える）。
        ],
      },
    }),
  ],
}))
