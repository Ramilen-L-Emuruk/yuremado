import * as maplibregl from 'maplibre-gl'
import { log } from '../../../utils/logger'
import { beginCaptureFraming, type CaptureFraming } from './camera'

// 地図キャンバスを画像として取り出す（共有カードの撮影段）。
//
// **WebGL のフレームバッファは合成が済むと捨てられる。** MapLibre は preserveDrawingBuffer を
// 既定の false で初期化しており（JapanMapGL の `new maplibregl.Map`）、`render` イベントの同期
// コールバックを抜けた時点でキャンバスの中身は空になる。実測では render の中で読むと 700KB の
// 画が取れ、300ms 後に読むと「1 色・不透明度 0」の空画像しか返らなかった。
//
// preserveDrawingBuffer を true にすれば時間の制約は消える。**が、これは Map の初期化オプション
// で実行時に切り替えられない**——撮影のたびに地図を作り直すことになり、カスタムレイヤーもデータも
// 全部積み直しになる。同期の窓で 2D キャンバスへ写し取るのが、地図を作り直さずに済む唯一の道。
//
// したがってこのファイルには動かせない制約が 1 つある。
//
//   **`ctx.drawImage(glCanvas, ...)` は `render` コールバックの同期実行中に呼ぶこと。**
//
// `toBlob()` のような非同期 API へ差し替えると、コールバックを抜けたあとに読むことになり空になる。
// 写し取ったあとの加工（ヘッダ・フッタの合成）は 2D キャンバス上の話なので、いくら時間をかけてもよい。

/** タイルの読み込みを待つ上限。超えたら欠けたまま撮る（撮れないより撮る。2026-10-23 ユーザー選択「今のまま記録する (Recommended)」）。 */
const CAPTURE_IDLE_TIMEOUT_MS = 8000
/**
 * 1 フレームの描画を待つ上限。
 *
 * `triggerRepaint()` を呼んでも `render` が来ない状況がある（画面が背面にある・WebGL の
 * コンテキストが失われた直後など）。上限が無いと Promise が解決も棄却もせず、呼び出し側の
 * 「作成中」が永久に解けない＝ボタンが二度と押せなくなる。
 */
const CAPTURE_FRAME_TIMEOUT_MS = 5000

/** 撮影中に地図へ被せる静止画の重なり順。MapLibre のコントロール（z-index 2 前後）より上へ出す。 */
const FREEZE_OVERLAY_Z_INDEX = 5

export interface MapCaptureOptions {
  /**
   * 出力の寸法（カード上の px）。地図はこの寸法の CSS px では描かない —— 画面の地図領域に合わせた
   * 寸法で描き、画素数だけをここまで上げる（`renderSizeFor`）。
   */
  width: number
  height: number
  /**
   * 撮影した 2D キャンバスへの追加描画。**`map.project()` が撮影寸法のまま使える唯一の場所**で、
   * 地図キャンバスに写らない DOM マーカー（津波の観測棒）をここで描き足す。
   * `scale` は `map.project()` が返す px に対する実ピクセルの比で、寸法にはこれを掛けること。
   */
  drawOverlay?: (ctx: CanvasRenderingContext2D, map: maplibregl.Map, scale: number) => void
  /** 撮影中の寸法変更を静止画で隠す（既定 true）。 */
  freeze?: boolean
  idleTimeoutMs?: number
}

export interface MapCaptureResult {
  canvas: HTMLCanvasElement
  /** 出力の寸法（`width`）に対する実ピクセルの比。合成側は寸法にこれを掛ける。 */
  scale: number
  /** タイルを待ちきれずに撮ったか。true なら地形が一部欠けている可能性がある。 */
  timedOut: boolean
}

/**
 * 地図を指定した寸法で撮る。
 *
 * 画面の地図コンテナを一時的に出力寸法へ広げ、その寸法でレンダーさせてから写し取り、元へ戻す。
 * 別の Map インスタンスを立てないのは、このアプリのレイヤーが `Map/` 配下のコンポーネント十数個に
 * 分かれて登録されており、二つ目の地図に同じ絵を再現できないため。
 */
/**
 * 撮影の間だけ見た目を止めたい描画物の登録先（地図ごと）。いまは津波の海岸線の点滅だけ（`TsunamiLinesGL`）。
 * 点滅は消灯の間（周期の 2 割）に撮ると画像から丸ごと消えるので、撮影の間は点灯のまま止める。
 */
const captureHolds = new WeakMap<maplibregl.Map, Set<(held: boolean) => void>>()
/** いま撮影している数（地図ごと）。**0 になったときだけ戻す** —— 撮影が重なっても、先に終わった側で戻さない。 */
const captureDepth = new WeakMap<maplibregl.Map, number>()

/**
 * 撮影の始まりと終わりに呼ばれる関数を登録する。戻り値で外す。**撮影の最中に登録したら、その場で止める**
 * （描画物を作り直したときに、止まっていない新しい点滅で撮らないため）。
 */
export function registerCaptureHold(map: maplibregl.Map, hold: (held: boolean) => void): () => void {
  let set = captureHolds.get(map)
  if (!set) {
    set = new Set()
    captureHolds.set(map, set)
  }
  set.add(hold)
  if ((captureDepth.get(map) ?? 0) > 0) {
    try { hold(true) } catch (e) { log.error('[shareCard] 撮影の間の見た目の固定に失敗しました', e) }
  }
  return () => { captureHolds.get(map)?.delete(hold) }
}

function setCaptureHold(map: maplibregl.Map, held: boolean): void {
  const depth = Math.max(0, (captureDepth.get(map) ?? 0) + (held ? 1 : -1))
  captureDepth.set(map, depth)
  // 止めるのは最初の撮影で、戻すのは最後の撮影が終わったときだけ
  if (held ? depth !== 1 : depth !== 0) return
  for (const hold of captureHolds.get(map) ?? []) {
    // 1 つが投げても撮影と他の描画物を止めない
    try { hold(held) } catch (e) { log.error('[shareCard] 撮影の間の見た目の固定に失敗しました', e) }
  }
}

/** 撮影で重ねる精細さの上限（出力に対する倍率）。端末の解像度がこれより高くても、ここで止める。 */
const MAX_SUPERSAMPLE = 2

/**
 * 地図を描く寸法（CSS px）と画素の比率を決める。
 *
 * 写す範囲は寄せ直し（`beginCaptureFraming`）が決めるので、この寸法が決めるのは**記号の大きさの比**。
 * 震度の点・地名・線の太さは CSS px で描かれるので、出力寸法（16:9 なら幅 1600）の CSS px で描くと、
 * 画面の地図領域が小さい端末ほど記号が画像に対して小さくなる。そこで、出力と同じ縦横比のまま
 * **面積を画面の地図領域に揃えた**寸法で描き、出力に足りない画素は画素の比率で補う。
 *
 * 画面の寸法が取れない（0）ときは出力寸法のまま描く。
 */
export function renderSizeFor(
  out: { width: number; height: number },
  screen: { width: number; height: number },
  devicePixelRatio: number,
): { width: number; height: number; pixelRatio: number } {
  const supersample = Math.min(Math.max(1, devicePixelRatio || 1), MAX_SUPERSAMPLE)
  if (!(screen.width > 0) || !(screen.height > 0) || !(out.width > 0) || !(out.height > 0)) {
    return { width: out.width, height: out.height, pixelRatio: supersample }
  }
  const s = Math.sqrt((screen.width * screen.height) / (out.width * out.height))
  const width = Math.max(1, Math.round(out.width * s))
  const height = Math.max(1, Math.round(out.height * s))
  return { width, height, pixelRatio: (out.width / width) * supersample }
}

export async function captureMapImage(map: maplibregl.Map, opts: MapCaptureOptions): Promise<MapCaptureResult> {
  const { width, height, drawOverlay, freeze = true, idleTimeoutMs = CAPTURE_IDLE_TIMEOUT_MS } = opts
  const container = map.getContainer()
  const parent = container.parentElement
  const savedWidth = container.style.width
  const savedHeight = container.style.height
  const savedParentOverflow = parent?.style.overflow ?? ''
  const render = renderSizeFor(
    { width, height },
    { width: container.clientWidth, height: container.clientHeight },
    window.devicePixelRatio,
  )
  // 点滅などは画面を覆う静止画を撮る前に止める（静止画が消灯の瞬間になると、覆っている間だけ海岸線が消えて見える）。
  // 戻すのは finally の最後なので、静止画の作成が投げても止まったままにはならない。
  setCaptureHold(map, true)
  let freezeEl: HTMLElement | null = null
  let framing: CaptureFraming | null = null
  try {
    freezeEl = freeze ? await createFreezeOverlay(map) : null
    // 撮影の印は寸法を広げる前に張る（広げたときに寸法待ちの寄せが走っても預かれるように）。戻すのは finally
    framing = beginCaptureFraming(map)
    // **出力寸法は画面の地図領域より大きいことが多い。** 親（position:absolute の枠）は overflow を
    // 持たないため、広げた分がそのまま隣のパネルへはみ出して見える。実測では 929×454 の地図領域に
    // 対し 1200×630 で撮ると、下のパネルへ 176px かぶさっていた。被せる静止画も親と同じ大きさ
    // なので、ここで切り抜いておかないと覆いきれない。
    if (parent) parent.style.overflow = 'hidden'
    container.style.width = `${render.width}px`
    container.style.height = `${render.height}px`
    // 自前の描画レイヤーは線の太さ・点の大きさに `map.getPixelRatio()` を掛けるので、ここで変えた比率に追随する
    map.setPixelRatio(render.pixelRatio)
    map.resize()
    // 寸法を広げてから寄せ直す（余白と寄り上限をこの寸法で決めるため）
    framing.refit()
    const idled = await waitForIdle(map, idleTimeoutMs)
    if (!idled) {
      log.warn('[shareCard] タイルの読み込みを待ちきれずに撮影しました', { width, height, render, idleTimeoutMs })
    }
    const { canvas } = await grabFrame(map, render.width, drawOverlay)
    // 合成へは「出力の寸法に対する比」を返す（描いた寸法に対する比は drawOverlay の中でだけ使う）
    return { canvas, scale: width > 0 ? canvas.width / width : 1, timedOut: !idled }
  } finally {
    // **1 つが失敗しても残りを必ず実行する。** 素直に並べると、途中の 1 行が投げた時点で以降が
    // 飛ぶ——とくに静止画の除去に届かないと、地図が撮影直前の画で覆われたままになる。静止画は
    // `pointer-events: none` なので操作は下の地図へ届くが、**その結果が画面に現れない**
    // （リロードするまで戻らない）。加えて finally 内の例外は try で起きていた元の例外を握り潰す
    // ため、失敗の原因も失われる。
    //
    // 順序は見た目の都合で決めてある。寸法と切り抜きを戻してから静止画を外す——先に静止画を外すと、
    // まだ広がったままの地図が一瞬見える。
    restoreQuietly('コンテナ寸法の復元', () => {
      container.style.width = savedWidth
      container.style.height = savedHeight
    })
    restoreQuietly('親要素の切り抜き解除', () => {
      if (parent) parent.style.overflow = savedParentOverflow
    })
    // null で上書きを外し、端末の解像度への追従に戻す（MapLibre の型は number だが、null を受けると定めている）。
    // 地図は初期化で比率を指定していない（JapanMapGL）ので、戻す先は常にこれでよい。
    restoreQuietly('画素の比率の復元', () => map.setPixelRatio(null as unknown as number))
    restoreQuietly('地図の再計測', () => map.resize())
    restoreQuietly('カメラの復元', () => framing?.restore())
    restoreQuietly('静止画の除去', () => freezeEl?.remove())
    restoreQuietly('見た目の固定の解除', () => setCaptureHold(map, false))
  }
}

/** 撮影後の後始末を 1 つずつ実行する。失敗しても他の後始末を止めない。 */
function restoreQuietly(what: string, fn: () => void): void {
  try {
    fn()
  } catch (e) {
    log.error(`[shareCard] 撮影後の復元に失敗しました: ${what}`, e)
  }
}

/**
 * 現在のフレームを 2D キャンバスへ写し取る。
 *
 * `logicalWidth` は倍率を割り出すためだけに使う（実ピクセル ÷ 論理 px）。
 */
function grabFrame(
  map: maplibregl.Map,
  logicalWidth: number,
  drawOverlay?: MapCaptureOptions['drawOverlay'],
): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const claim = (): boolean => {
      if (settled) return false
      settled = true
      window.clearTimeout(timer)
      map.off('render', onRender)
      return true
    }
    const onRender = (): void => {
      if (!claim()) return
      try {
        const glCanvas = map.getCanvas()
        const out = document.createElement('canvas')
        out.width = glCanvas.width
        out.height = glCanvas.height
        const ctx = out.getContext('2d')
        if (!ctx) {
          reject(new Error('共有カードの合成用に 2D コンテキストを取得できませんでした'))
          return
        }
        // ここが同期の窓（冒頭の注記）。この行を非同期の後ろへ動かすと空の画になる。
        ctx.drawImage(glCanvas, 0, 0)
        const scale = logicalWidth > 0 ? glCanvas.width / logicalWidth : 1
        // 追加描画も窓の中で済ませる。復元後に呼ぶと map.project() が画面の寸法で答えてしまい、
        // 描き足した棒だけが別の場所に立つ。
        drawOverlay?.(ctx, map, scale)
        resolve({ canvas: out, scale })
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    // **上限を置かないと解決も棄却もしないまま止まりうる。** `triggerRepaint()` を呼んでも
    // `render` が来ない状況がある（画面が背面にある・WebGL のコンテキストが失われた直後など）。
    // その場合、呼び出し側の「作成中」が永久に解けず、ボタンが二度と押せなくなる。
    const timer = window.setTimeout(() => {
      if (!claim()) return
      reject(new Error('地図の描画を待てませんでした（画面が背面にある可能性があります）'))
    }, CAPTURE_FRAME_TIMEOUT_MS)
    map.on('render', onRender)
    map.triggerRepaint()
  })
}

/**
 * タイルの読み込み完了（`idle`）を待つ。待ちきれなければ false を返す。
 *
 * `once('idle')` ではなく `on`/`off` を使うのは、時間切れのときにリスナーを外す必要があるため。
 */
function waitForIdle(map: maplibregl.Map, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (idled: boolean): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      map.off('idle', onIdle)
      resolve(idled)
    }
    const onIdle = (): void => finish(true)
    const timer = window.setTimeout(() => finish(false), timeoutMs)
    map.on('idle', onIdle)
  })
}

/**
 * 撮影中の寸法変更を隠す静止画を地図の上へ被せる。返り値を呼び出し側が `remove()` する。
 *
 * 覆えなかった場合は null を返し、撮影自体は続ける（画像は作れる方が優先）。**静止画は地図
 * コンテナの親へ入れる**——コンテナ自身へ入れると、この後の寸法変更に巻き込まれて静止画まで
 * 伸び縮みし、隠す役目を果たさない。
 */
async function createFreezeOverlay(map: maplibregl.Map): Promise<HTMLElement | null> {
  const container = map.getContainer()
  const parent = container.parentElement
  if (!parent) {
    log.warn('[shareCard] 地図コンテナの親要素が無く、撮影中の寸法変更を隠せません')
    return null
  }
  try {
    const { canvas } = await grabFrame(map, container.clientWidth)
    canvas.style.cssText = 'width:100%;height:100%;display:block;'
    const el = document.createElement('div')
    el.style.cssText = `position:absolute;inset:0;pointer-events:none;z-index:${FREEZE_OVERLAY_Z_INDEX};`
    el.appendChild(canvas)
    parent.appendChild(el)
    return el
  } catch (e) {
    log.warn('[shareCard] 撮影中に被せる静止画を作れませんでした', e)
    return null
  }
}
