import { ABSOLUTE_MAX_ZOOM } from '../components/Map/gl/viewSpan'
import { JAPAN_WIDE_BOUNDS } from '../components/Map/gl/bounds'
import { mercatorBoxForCamera, type CameraView } from '../components/Map/gl/cameraViewBounds'
import { log } from './logger'
import { fetchWithTimeout, API_FETCH_TIMEOUT_MS } from './fetchWithTimeout'

// GEBCO 海底地形タイル（BaseMapGL.tsx の背景ラスタソースと同一 URL）の先読み。
// 低ズーム優先でバックグラウンド fetch し、ブラウザの HTTP キャッシュへ温めておく。
// 実際にフィットした瞬間の暗転（タイル未取得による raster 未描画）を短縮するのが目的。
//
// 範囲は 3 段構え。沖縄（先島諸島）〜択捉島相当の枠は自動フィットの最深まで（MAX_TILE_ZOOM）、
// その周りの帯（BAND_BOUNDS）は中くらいの深さまで（BAND_MAX_TILE_ZOOM）、世界全体は低ズームだけ
// （GLOBAL_MAX_TILE_ZOOM）。帯と全球は遠地地震のフィットと引いた画に備えるもので、深さの決め方は
// それぞれの定数のコメントにある。温めた HTTP キャッシュは配信元の指定で 1 時間で失効するため、
// 同じ間隔で取り直す（PREFETCH_REFRESH_MS）。本番では Service Worker の控えにも残る
// （範囲は scripts/offlineBathymetry.ts。この 3 段と同じ範囲を控える）。
//
// ArcGIS Online 側のサービスメタデータ（?f=json）で exportTilesAllowed:false となっており、
// タイルの一括エクスポート・静的同梱は許可されていない。そのため通常の表示リクエストと同形の
// fetch を間引いて投げるだけに留め、失敗（404/通信エラー）は無視する（best-effort。実フィット時に
// 通常どおり再取得されるだけで実害はない）。
export const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'

/**
 * GEBCO ソースのタイルサイズ（px）。BaseMapGL の addSource と MAX_TILE_ZOOM の算出で共有する。
 * MapLibre の基準は 512px なので、256px のソースはマップズーム z のときタイル z+1 を要求する。
 */
export const GEBCO_TILE_SIZE = 256
/** GEBCO タイルセットに実在する最大タイル z（これを超えるズームはオーバーズーム扱いで新規取得されない）。 */
export const GEBCO_SOURCE_MAX_ZOOM = 10
/**
 * 常時下地として敷くオーバービュー層（BaseMapGL）の最大タイル z。
 * 日本全体を眺める縮尺帯に相当する低ズームを常時カバーする値で、遠距離フィットの直後にもこの精細さの
 * 下地が必ず残る（下げればボケが増え、上げれば保持タイル数が増えるトレードオフ）。fitJapan の着地ズームは
 * ビューポートの大きさで変わるため、その値と厳密に一致させる必要はない。この z のタイルは先読み（下記）にも
 * 含まれるため初回表示から即描画できる。
 */
export const GEBCO_OVERVIEW_MAX_ZOOM = 5
/**
 * MapLibre（512px タイル基準）がマップズーム z のときに要求するタイル z を返す
 * （ラスタソースは丸め方式が round のため `Math.round`）。マップズーム基準とタイル座標系の変換は
 * 混同事故が起きやすいので、両方を扱う箇所はこの関数を通す。
 */
export function desiredTileZoom(mapZoom: number): number {
  return Math.round(mapZoom + Math.log2(512 / GEBCO_TILE_SIZE))
}

/**
 * 高解像度層（BaseMapGL の上層）を描画し始めるマップズーム。**マップズーム基準（512px タイル）** の値で、
 * このファイルの他の定数（タイル座標系の z）とは別の座標系。混同しないこと。
 *
 * 上層が下層より深いタイルを要求し始めるのは `desiredTileZoom(z) > GEBCO_OVERVIEW_MAX_ZOOM` のとき。
 * `Math.round` の境界から、その最小の z は `GEBCO_OVERVIEW_MAX_ZOOM + 0.5 - log2(512 / タイルサイズ)`
 * （256px タイルなら 4.5）。これ未満のズームでは 2 層が同一タイルを要求するだけで見た目は変わらないため
 * （実測: マップズーム 3 で 20 タイルすべてが二重取得）、上層の minzoom に指定して描画対象から外す。
 * 非表示のレイヤーはソースの更新対象にならないため、タイル取得ごと止まる。
 *
 * タイルサイズから導出しているので `GEBCO_TILE_SIZE` を変えてもズレない。境界のタイトさは
 * `src/components/Map/gl/zoomConstants.test.ts` が両側から固定している。
 */
export const GEBCO_HIRES_MIN_ZOOM = GEBCO_OVERVIEW_MAX_ZOOM + 0.5 - Math.log2(512 / GEBCO_TILE_SIZE)

// 高解像度まで先読みする枠は、離島まで含めた日本全体の枠（JAPAN_WIDE_BOUNDS）と同一にする。
// 寄った画で高解像度のタイルを使うのは国内の地震・津波を追うときで、その寄り先はこの枠に収まる。
// 枠を広げたら先読み範囲も追従すべきという関係にあり、値を二重に持たない。
// この枠の外は GLOBAL_MAX_TILE_ZOOM が低ズームだけを受け持つ。
const [[PREFETCH_WEST, PREFETCH_SOUTH], [PREFETCH_EAST, PREFETCH_NORTH]] = JAPAN_WIDE_BOUNDS

// 同時 fetch 数（外部タイルサーバー・他の通信への負荷を抑える）。
const CONCURRENCY = 3

export interface TileXYZ {
  x: number
  y: number
  z: number
}

/** 緯度経度から Web Mercator タイル座標を算出する（範囲外の値は 0〜(2^z-1) にクランプ）。 */
export function lngLatToTile(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return [Math.min(Math.max(x, 0), n - 1), Math.min(Math.max(y, 0), n - 1)]
}

// 先読みする最大タイルズーム。GEBCO_TILE_SIZE が MapLibre 基準の 512px より小さいため、MapLibre は
// 「マップズーム z のとき タイル z+1」を要求する（実測: マップ zoom 8 で /tile/9/... を取得）。
// マップズーム基準の値をそのままタイル z として使うと、自動フィットの上限で実際に使うタイルが
// 先読み対象から 1 段漏れるため desiredTileZoom を通す。タイルセットに実在しない z を叩いても
// 意味が無いので GEBCO_SOURCE_MAX_ZOOM でクランプする（fetch 失敗は握りつぶすため、超過しても
// 無症状で先読みだけが空回りする。テストで境界を固定している）。
//
// 基準にするのは**どの画面でも越えない寄り上限**（ABSOLUTE_MAX_ZOOM）で、基準ペインの寄り上限では
// ない。寄り上限は画面が大きいほど深くなり、録画で使う 2K・4K の画面ではこの上限まで届く
// （実測: 1920x1080 で地図ズーム 7.5・3840x2160 で 8 に着地し、どちらもタイル z9 を要求した）。
// 基準ペインで決めていたときは z9 が先読みから漏れ、着地のたびに z9 を 38〜144 枚取りに行って
// 海底地形が 0.4〜2.2 秒抜けていた。z9 まで含めると日本の枠は 569 枚から 2,090 枚になる。
export const MAX_TILE_ZOOM = Math.min(desiredTileZoom(ABSOLUTE_MAX_ZOOM), GEBCO_SOURCE_MAX_ZOOM)

/**
 * 日本の枠の外まで含めて先読みする最大タイル z（全球）。
 *
 * **遠地地震のカメラフィットは日本の枠へ収まらない。** 寄り先は「震源 ∪ 日本全体」で
 * （`useQuakeLayerData` の `quakeFitPositions`）、震源が地球のどこにあってもその矩形へ寄る。
 * 上の日本枠だけを先読みしていると、寄った先の海底地形が未取得のまま数秒描かれない
 * （実測: メキシコ沖の遠地地震で z3 のタイル 17 枚が不足し、取得に 1〜1.5 秒）。
 *
 * **一方で「日本全体が必ず画に入る」ことが、先読みする深さの上限を決める。** どれだけ震源が
 * 離れても着地は日本全体を収める画より引いた側にしかならないため、自動フィットが要求する
 * タイル z は「その画面で日本全体へ寄せたときの z」を超えない。基準ペインではそれがこの値で、
 * 前提が崩れていないことは gebcoPrefetch.test.ts が固定する。
 *
 * **画面が大きいとその z は深くなる**（実測: 3840x2160 で「震源＋日本全体」へ寄せると z6）。
 * 全球は z が 1 段深くなるごとに枚数が 4 倍になる（z6 なら 5,461 枚）ので全球では追わず、
 * 日本の周りの帯（`BAND_BOUNDS`）だけを `BAND_MAX_TILE_ZOOM` まで深くする。帯の外で深い z が
 * 要る寄せは、寄せ始めに着地先のタイルを取る先読み（`buildCameraTargetTiles` / `prefetchTileList`）が受け持つ。
 *
 * **値は `GEBCO_OVERVIEW_MAX_ZOOM` から導く。** 全球で温めたいのは常時下地（オーバービュー層）の
 * ぶんだけで、高解像度層は日本の枠が受け持つ。同じ数字を 2 箇所に書くと、下地の解像度を調整した
 * ときに全球側の深さだけ取り残される。上の「日本全体 fit の z を超えない」という上限も、
 * 元をたどれば `GEBCO_OVERVIEW_MAX_ZOOM` が「日本全体を眺める縮尺帯をカバーする値」として
 * 選ばれていることと同じ根拠にある。
 */
export const GLOBAL_MAX_TILE_ZOOM = GEBCO_OVERVIEW_MAX_ZOOM

/**
 * 全球より深く先読みする、日本の周りの帯（[[西, 南], [東, 北]]）。
 *
 * 大きい画面で「震源＋日本全体」へ寄せたときに全球の深さ（`GLOBAL_MAX_TILE_ZOOM`）では足りない
 * 範囲を受け持つ。カムチャツカ・千島・マリアナ・フィリピンを含み、日本周辺で起きる遠地地震の寄せは
 * おおむねこの中へ着地する。帯は全球と違って広さが限られるので、z6・z7 でも 958 枚で済む
 * （z6 が 208 枚・z7 が 750 枚）。範囲と深さは 2026-10-28 ユーザー承認（「帯も温めて保存する (Recommended)」）。
 */
export const BAND_BOUNDS: [[number, number], [number, number]] = [[110, 0], [180, 62]]

/**
 * 帯を先読みする最大タイル z。録画で想定する最も大きい画面（3840x2160）で日本全体へ寄せたときの
 * タイル z（実測で地図ズーム 5.7・タイル z7）。日本全体を含む寄せはこれより引いた側にしかならない
 * ので、帯の中ではこの深さで足りる。浅い側（全球が受け持つ z）は帯で取り直さない。
 */
export const BAND_MAX_TILE_ZOOM = 7

/**
 * 配信元がタイルへ付ける有効期限（`Cache-Control: max-age=3600`）に合わせた、先読みの取り直し間隔。
 *
 * 先読みで温まるのはブラウザの HTTP キャッシュなので、この時間が過ぎると効果が切れる。据え置きで
 * 動かし続ける端末では起動直後の 1 時間しか効かないため、同じ間隔で温め直す。
 *
 * **2 巡目以降はほぼ無料。** 期限切れのエントリに対してブラウザは `If-None-Match` を付けて
 * 再検証し、タイルが変わっていなければ 304 が返って本体は転送されない（実測: 0 バイト）。
 * 期限内に走った場合はキャッシュヒットで完結し、ネットワークへも出ない。
 * **`fetch` にキャッシュモードを渡さないこと** —— `no-cache` / `reload` を指定すると
 * この再検証が強制再取得に化け、1 時間ごとに全量を取り直すことになる。
 */
export const PREFETCH_REFRESH_MS = 60 * 60 * 1000

/** [[西, 南], [東, 北]] の枠を覆うタイルを、低ズーム優先（minTileZoom→maxTileZoom）で並べて返す。 */
export function buildBoxTiles(
  [[west, south], [east, north]]: [[number, number], [number, number]],
  minTileZoom: number,
  maxTileZoom: number,
): TileXYZ[] {
  const tiles: TileXYZ[] = []
  for (let z = Math.max(0, minTileZoom); z <= maxTileZoom; z++) {
    const [x0, y0] = lngLatToTile(west, north, z)
    const [x1, y1] = lngLatToTile(east, south, z)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        tiles.push({ x, y, z })
      }
    }
  }
  return tiles
}

/** 先読み対象範囲（日本の枠）・ズームのタイル一覧を、低ズーム優先（0→maxTileZoom）で並べて返す。 */
export function buildPrefetchTiles(maxTileZoom: number = MAX_TILE_ZOOM): TileXYZ[] {
  return buildBoxTiles([[PREFETCH_WEST, PREFETCH_SOUTH], [PREFETCH_EAST, PREFETCH_NORTH]], 0, maxTileZoom)
}

/** 日本の周りの帯で、全球より深い z（`GLOBAL_MAX_TILE_ZOOM` + 1 〜 `BAND_MAX_TILE_ZOOM`）のタイル一覧。 */
export function buildBandPrefetchTiles(): TileXYZ[] {
  return buildBoxTiles(BAND_BOUNDS, GLOBAL_MAX_TILE_ZOOM + 1, BAND_MAX_TILE_ZOOM)
}

/** 全球のタイル一覧を、低ズーム優先（0→maxTileZoom）で並べて返す。 */
export function buildGlobalPrefetchTiles(maxTileZoom: number = GLOBAL_MAX_TILE_ZOOM): TileXYZ[] {
  const tiles: TileXYZ[] = []
  for (let z = 0; z <= maxTileZoom; z++) {
    const n = 2 ** z
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        tiles.push({ x, y, z })
      }
    }
  }
  return tiles
}

function tileKey(tile: TileXYZ): string {
  return `${tile.z}/${tile.x}/${tile.y}`
}

/** 先読みキューと、その前半（日本の枠）と後半（日本の外＝全球と帯）の境界。 */
export interface PrefetchQueue {
  /** 投げる順に並んだタイル。前半が日本の枠、後半が日本の外（全球の低ズーム → 帯）。 */
  tiles: TileXYZ[]
  /** 前半（日本の枠）の枚数。これ以降の添字が日本の外のぶん。 */
  japanCount: number
}

/**
 * 実際に投げる順に並べた先読みキュー。**日本の枠を出し切ってから日本の外へ移る。**
 *
 * 起動直後に映っているのは日本なので、そこで使うタイル（下地から高解像度まで）を先に温める。
 * 日本の外は全球の低ズームを先に、帯の深い z を後に置く。引いた画（半球が見える画）は全球の
 * 低ズームだけで描けるので、帯より先に温まっているほうが効く。
 * 先に出し切った範囲と重なるタイルは後ろから取り除く。
 *
 * 境界（`japanCount`）を返すのは、**どちらの範囲が取れなかったかを別々に数える**ため。
 * 合算した 1 本のカウンタだと、先に走る日本枠が 1 枚でも成功した時点で「取れている」と見なされ、
 * 後半の日本の外のぶんが丸ごと落ちていても気づけない（遠地地震のときだけ効く範囲なので、画面にも出ない）。
 */
export function buildPrefetchQueue(): PrefetchQueue {
  const japan = buildPrefetchTiles()
  const queued = new Set(japan.map(tileKey))
  const outside: TileXYZ[] = []
  for (const t of [...buildGlobalPrefetchTiles(), ...buildBandPrefetchTiles()]) {
    const key = tileKey(t)
    if (queued.has(key)) continue
    queued.add(key)
    outside.push(t)
  }
  return { tiles: [...japan, ...outside], japanCount: japan.length }
}

/**
 * 先読みの要求に付ける印。Service Worker の海底地形の控え（`scripts/offlineBathymetry.ts` の
 * `offlineBathymetryCachedResponseWillBeUsed`）は、この印の付いた要求には控えを渡さず、配信元の応答を待って
 * 返す（その応答で控えも書き直す）。
 *
 * 地図の表示の要求は控えを先に返す（StaleWhileRevalidate）。印が無いと、先読みの 1 本が控えから即座に返って
 * 同時に投げる本数の枠がすぐ空き、Service Worker の裏の取り直しだけが上限なく配信元へ出る。配信元が止まって
 * いても控えの 200 を成功に数えるので、巡回の全滅の記録も出なくなる。
 *
 * 印に `referrerPolicy` を使うのは、Service Worker から読めて、配信元へ届く要求の違いがリファラの有無だけで
 * 済むため（地図ライブラリの要求はこの値を空のまま出す）。値を変えるなら Service Worker 側の照合も揃えること
 * （`scripts/offlineBathymetry.test.ts` が突き合わせる）。
 */
export const PREFETCH_REQUEST_INIT: RequestInit = { referrerPolicy: 'no-referrer' }

function tileUrl(tile: TileXYZ): string {
  return BATHYMETRY_URL.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y))
}

/**
 * 着地先の画 1 枚ぶんで取りに行くタイルの上限。
 *
 * 3840x2160 の画をタイル z9（256px）で覆うと 16×10 枚前後で、向きを変えた画の外接矩形と外周 1 枚の余白を
 * 足しても 300 枚に収まる。傾けた画は奥が広がって枚数が膨らむので、そこを上限で止める（止めたぶんは
 * 着地してから地図が取りに行く。今までどおりで、失われるものは無い）。
 */
export const CAMERA_TARGET_MAX_TILES = 400

/**
 * 着地先のタイルを同時に取りに行く本数。地図が画像を同時に取る上限（MapLibre 6.10.0 の
 * `MAX_PARALLEL_IMAGE_REQUESTS` = 16）に揃える。取るのは着地したら地図が自分で取りに行くタイルなので、
 * 配信元へ届く数はほとんど増えず、取り始めが 1 秒早まる（見積もりの余白のぶんと、寄せの途中で打ち切られた
 * ぶんは余計に届きうる。1 回の寄せで多くて `CAMERA_TARGET_MAX_TILES` 枚）。6 本では 1 秒の寄せで取り切れず、4K の画で
 * 着地後に揃うまでの時間が 3.2 秒 → 2.8 秒にしか縮まなかった（実測）。
 */
export const CAMERA_TARGET_CONCURRENCY = 16

/**
 * 着地先の画（中心・ズーム・向き・傾き）と画面の寸法から、地図が着地して要求する海底地形タイルを並べて返す。
 *
 * 2 層（`BaseMapGL`）のぶんを両方返す。下地（`GEBCO_OVERVIEW_MAX_ZOOM` まで）を先に、高解像度層を後に並べ、
 * それぞれ画の中心に近いものから並べる。高解像度層は `GEBCO_HIRES_MIN_ZOOM` 未満のズームでは描かないので返さない。
 *
 * 見える範囲の見積もりは `gl/cameraViewBounds.ts`（大きめに外れる側の近似。取りすぎた分は上限
 * `CAMERA_TARGET_MAX_TILES` で止まる）。
 */
export function buildCameraTargetTiles(view: CameraView, widthPx: number, heightPx: number): TileXYZ[] {
  const box = mercatorBoxForCamera(view, widthPx, heightPx)
  if (!box) return []
  const mx = (box.x0 + box.x1) / 2
  const my = (box.y0 + box.y1) / 2

  const ring = (z: number): TileXYZ[] => {
    const n = 2 ** z
    const out: TileXYZ[] = []
    const cx = mx * n
    const cy = my * n
    const xFrom = Math.floor(box.x0 * n) - 1
    const xTo = Math.floor(box.x1 * n) + 1
    const yFrom = Math.max(0, Math.floor(box.y0 * n) - 1)
    const yTo = Math.min(n - 1, Math.floor(box.y1 * n) + 1)
    // 経度は回り込むので、全周を越えたら全周に切る
    const xs: number[] = []
    if (xTo - xFrom + 1 >= n) for (let x = 0; x < n; x++) xs.push(x)
    else for (let x = xFrom; x <= xTo; x++) xs.push(((x % n) + n) % n)
    for (const x of xs) for (let y = yFrom; y <= yTo; y++) out.push({ x, y, z })
    // 中心に近い順（回り込みを考えて x の差は短い側で測る）
    const dist = (t: TileXYZ) => {
      const dxRaw = Math.abs(t.x + 0.5 - cx)
      const dx = Math.min(dxRaw, n - dxRaw)
      const dy = t.y + 0.5 - cy
      return dx * dx + dy * dy
    }
    return out.sort((a, b) => dist(a) - dist(b))
  }

  const wanted = desiredTileZoom(view.zoom)
  const overviewZ = Math.max(0, Math.min(wanted, GEBCO_OVERVIEW_MAX_ZOOM))
  const tiles = ring(overviewZ)
  if (view.zoom >= GEBCO_HIRES_MIN_ZOOM) {
    const hiresZ = Math.max(0, Math.min(wanted, GEBCO_SOURCE_MAX_ZOOM))
    if (hiresZ !== overviewZ) tiles.push(...ring(hiresZ))
  }
  return tiles.slice(0, CAMERA_TARGET_MAX_TILES)
}

/**
 * 着地先のタイルを取りに行く。**HTTP の控えを温めるだけで、中身は読まない**（巡回の先読みと同じ取り方）。
 *
 * signal を打ち切ると、まだ投げていないものは投げず、投げたものも打ち切る。次の寄せが来たら呼び出し側が
 * 前のぶんを打ち切ってから呼ぶ（行き先の変わった寄せのタイルを取り続けない）。
 *
 * 警告は出さない。配信元が止まっているかどうかは巡回の先読み（`startBathymetryPrefetch`）が 1 巡ごとに
 * 記録するので、ここで同じことを寄せのたびに書かない。取れなかった枚数だけ、効いているかを後から確かめられる
 * よう debug に 1 行残す（打ち切った寄せは数えない。次の寄せへ譲っただけ）。
 */
export function prefetchTileList(tiles: TileXYZ[], signal: AbortSignal): void {
  let index = 0
  let active = 0
  let failed = 0
  let settled = 0
  const fill = () => {
    while (!signal.aborted && active < CAMERA_TARGET_CONCURRENCY && index < tiles.length) {
      const tile = tiles[index++]
      active++
      fetchWithTimeout(tileUrl(tile), { timeoutMs: API_FETCH_TIMEOUT_MS, signal, init: PREFETCH_REQUEST_INIT }, async (res) => res.ok)
        .then((ok) => {
          if (!ok) failed++
        })
        .catch(() => {
          if (!signal.aborted) failed++
        })
        .finally(() => {
          active--
          settled++
          if (settled === tiles.length && failed > 0 && !signal.aborted) {
            log.debug(`[gebco] 寄せ先の海底地形タイルの先読み: ${tiles.length} 枚中 ${failed} 枚を取れなかった`)
          }
          fill()
        })
    }
  }
  fill()
}

/** データセーバー・低速回線（2g/slow-2g）が有効な環境では先読みしない。 */
export function shouldSkipPrefetch(): boolean {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const conn = (nav as unknown as { connection?: { saveData?: boolean; effectiveType?: string } } | undefined)
    ?.connection
  if (!conn) return false
  if (conn.saveData) return true
  return conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g'
}

/** 1 巡の結果。次の巡の再開位置と、全滅を記録するかどうかの判断に使う。 */
export interface PrefetchPassResult {
  /** 実際に投げたタイル数。 */
  attempted: number
  /** 応答が返り、かつ成功ステータスだった数。 */
  succeeded: number
  /** そのうち全球ぶん（キュー後半）の試行数。 */
  globalAttempted: number
  /** そのうち全球ぶんの成功数。 */
  globalSucceeded: number
  /** 中断で終わったか（この場合の全滅は異常ではない）。 */
  aborted: boolean
}

/** 走っている巡の進み具合を、外から**同期的に**読むための取っ手。 */
export interface PrefetchPassHandle {
  /**
   * 次の巡が再開すべき添字。配り切っていれば 0（先頭へ戻る）。
   *
   * **`onSettled` ではなくこちらで渡すのは、完了通知が非同期にしか届かないため。**
   * 次の巡を起動する時点では、前の巡の `onSettled` はまだ走っていない。同期的に読めるここから
   * 取れば、確実に続きから再開できる（`abort()` の呼び出しとの前後は、`index` が同期ループの
   * 中でしか動かないため結果を変えない）。
   *
   * **返すのは「配った添字」。** 打ち切りの直前に投げて、打ち切りで取得が止まったタイル
   * （最大 `CONCURRENCY` 枚）は次の巡で投げ直されない。キューを配り切って 0 へ折り返す巡が来れば
   * 回収されるので、ベストエフォートの範囲として受け入れている（塞ぐには取得が終わった位置を別に
   * 持つ必要があり、そのぶん再開位置が後ろへ下がる）。
   */
  readonly resumeIndex: number
}

/**
 * キューの `startIndex` から 1 巡ぶんを投げる。配り切ったか中断された時点で onSettled を 1 度だけ呼ぶ。
 *
 * **途中から始められることが要点。** 打ち切られた巡の続きを次の巡が引き継ぐためで、理由は
 * `startBathymetryPrefetch` のコメントにある。
 */
function runPrefetchPass(
  signal: AbortSignal,
  startIndex: number,
  onSettled: (result: PrefetchPassResult) => void,
): PrefetchPassHandle {
  const { tiles, japanCount } = buildPrefetchQueue()
  // 範囲外（キューの長さが変わった場合を含む）は先頭へ倒す。
  let index = startIndex >= 0 && startIndex < tiles.length ? startIndex : 0
  let active = 0
  let attempted = 0
  let succeeded = 0
  let globalAttempted = 0
  let globalSucceeded = 0
  let settled = false

  const settle = () => {
    if (settled) return
    settled = true
    onSettled({ attempted, succeeded, globalAttempted, globalSucceeded, aborted: signal.aborted })
  }

  const fillSlots = () => {
    while (!signal.aborted && active < CONCURRENCY && index < tiles.length) {
      active++
      const at = index++
      const tile = tiles[at]
      const isGlobal = at >= japanCount
      attempted++
      if (isGlobal) globalAttempted++
      // **ブラウザの暇（requestIdleCallback）を待たない。** 先読みは録画モードのときだけ走り、
      // 録画中の地図は描き続けているので暇がほとんど来ない（実測: 1 分に 45 枚。1 巡が 1,911 枚だった頃で
      // 温め切るのに約 40 分、いまの 4,244 枚なら約 94 分）。それでは録画を始めてからしばらく、寄せた先が
      // 温まっていない。同時に投げる数は CONCURRENCY のまま。1 巡の枚数は変わらないが、暇を待つ形では
      // 1 時間で 1 巡を回り切れていなかったので、時間あたりに配信元へ届く数は増える（1 時間に 1 巡まで）
      // （2026-10-28 ユーザー承認「録画モードは待たない (Recommended)」）。
      //
      // キャッシュモードは既定のまま渡さない（理由は PREFETCH_REFRESH_MS）。
      // **失敗は握りつぶすが、成否は数える。** 1 枚も取れなかった巡は呼び出し側が記録する
      // （先読みは画面に何も出さないので、数えないと全滅しても誰も気づけない）。
      // **上限も掛ける。** 合図（地図の寿命）だけだと、黙った 1 枚が並列の枠を地図が生きている
      // 間ずっと塞ぐ。中身は読まない（従来どおり。HTTP の控えに載せるための取得で、枠は応答の
      // 見出しが返った時点で次へ譲る）。
      fetchWithTimeout(tileUrl(tile), { timeoutMs: API_FETCH_TIMEOUT_MS, signal, init: PREFETCH_REQUEST_INIT }, async (res) => res.ok)
        .then((ok) => {
          if (!ok) return
          succeeded++
          if (isGlobal) globalSucceeded++
        })
        .catch(() => {})
        .finally(() => {
          active--
          fillSlots()
        })
    }
    // 中断されたか、配り切って走っているものが無くなったら 1 巡の終わり。
    if (active === 0 && (signal.aborted || index >= tiles.length)) settle()
  }

  fillSlots()
  return {
    get resumeIndex() {
      return index >= tiles.length ? 0 : index
    },
  }
}

/**
 * 海底地形タイルの先読みを始める。日本の枠・全球の低ズーム・日本の周りの帯（`buildPrefetchQueue`）を、
 * 低ズーム優先・同時 CONCURRENCY 本まででバックグラウンド fetch し、以後 `PREFETCH_REFRESH_MS` ごとに
 * 温め直す。signal を abort すると、進行中のキューも次回以降の取り直しも止まる。
 *
 * **前の巡が終わっていなければ打ち切ってから始める。「終わるまで待つ」形にしないこと。**
 * `fetch` には時間切れが無いため、応答も失敗も返らないまま吊られた 1 本があるとその巡は永久に
 * 終わらない（`CONCURRENCY` 本が吊られれば全体が止まる）。完了を待つ設計だと、そこで先読みが
 * **恒久的に**止まる —— 画面にもログにも出ず、地図が常時表示のこのアプリでは再マウントによる
 * 自然回復も起きない。打ち切って始め直せば、どう詰まっても 1 周期で回復する。
 *
 * **打ち切った巡の続きは次の巡が引き継ぐ。キューを毎回先頭から作り直さないこと。** 作り直すと、
 * 1 巡が 1 周期で終わらない回線（`shouldSkipPrefetch` が拾わない程度に遅いだけの環境）では前半の
 * 日本の枠を延々と取り直し、**後半の日本の外のぶんへ一度も到達しない**。しかも日本の枠は成功している
 * ので全滅の記録にも掛からず、遠地地震への備えが恒久的に無進捗のまま黙って残る。位置を引き継げば、
 * 遅い回線でも少しずつ全体を回り切れる。
 */
export function startBathymetryPrefetch(signal: AbortSignal): void {
  if (signal.aborted) return
  let passAbort: AbortController | null = null
  let passHandle: PrefetchPassHandle | null = null
  let resumeIndex = 0
  let skipping = false

  const runPass = () => {
    if (signal.aborted) return
    // 節約設定・低速回線は巡ごとに見る（外出先へ移った端末で取り直しを続けない）。
    // 記録するのは状態が変わったときだけ——毎周期出すと本物の警告を埋める。
    const skip = shouldSkipPrefetch()
    if (skip !== skipping) {
      skipping = skip
      log.info(
        skip
          ? '[gebco] 通信節約の設定か低速回線のため、海底地形の先読みを止める'
          : '[gebco] 回線の条件が戻ったので、海底地形の先読みを再開する',
      )
    }
    // **打ち切りは skip の判定より先に置く。** 節約設定・低速回線へ切り替わった巡もここを通るので、
    // 走りかけの巡（最大でキュー全部）をそのまま投げ切ってしまうことがない。
    // **位置は完了通知ではなく、同期的に読める取っ手から取る**（理由は PrefetchPassHandle）。
    if (passHandle) resumeIndex = passHandle.resumeIndex
    passAbort?.abort()
    if (skip) return

    const pass = new AbortController()
    passAbort = pass
    passHandle = runPrefetchPass(
      pass.signal,
      resumeIndex,
      ({ attempted, succeeded, globalAttempted, globalSucceeded, aborted }) => {
        // 中断された巡の全滅は異常ではない（次の巡へ譲っただけ）。
        // `attempted === 0` はキューが空のときだけで、現状の `buildPrefetchQueue` では起こらない。
        if (aborted || attempted === 0) return
        // **範囲ごとに独立して判定する。** 進行位置を引き継ぐので、巡によっては日本の枠と全球の
        // どちらか一方しか触らない。**触っていない範囲について「壊れている」と言う根拠は無い** ——
        // 合算した成否で全体を語ると、全球ぶんだけの巡で全滅したときに「配信元の停止」と書いて
        // しまい、実際には取れている日本周辺まで巻き込んだ過大な診断になる。
        const japanAttempted = attempted - globalAttempted
        const japanFailed = japanAttempted > 0 && succeeded - globalSucceeded === 0
        const globalFailed = globalAttempted > 0 && globalSucceeded === 0
        if (japanFailed && globalFailed) {
          log.warn(
            `[gebco] 海底地形タイルの先読みが 1 枚も取得できなかった（${attempted} 枚を試行）。` +
              '配信元の停止・URL の変更・回線の遮断が疑われる。寄せた先の海底地形が描かれないことがある',
          )
        } else if (globalFailed) {
          log.warn(
            `[gebco] 日本の外の海底地形タイルだけ 1 枚も取得できなかった（${globalAttempted} 枚を試行）。` +
              '遠い震源へ寄せたときに海底地形が描かれないことがある',
          )
        } else if (japanFailed) {
          log.warn(
            `[gebco] 日本周辺の海底地形タイルだけ 1 枚も取得できなかった（${japanAttempted} 枚を試行）。` +
              '寄せた先の海底地形が描かれないことがある',
          )
        }
      },
    )
  }

  runPass()
  const timer = setInterval(runPass, PREFETCH_REFRESH_MS)
  signal.addEventListener(
    'abort',
    () => {
      clearInterval(timer)
      passAbort?.abort()
    },
    { once: true },
  )
}
