import { useEffect, useRef, useState } from 'react'
import { useLazyRef } from './useLazyRef'
import type { SiteCoords } from '../services/kyoshin'
import { siteKey } from '../utils/kyoshinSiteKeys'
import {
  extractNoiseFloors,
  hydrateNoiseFloors,
  initNoiseFloorState,
  MAX_RESUME_GAP_MS,
  noiseFloorKeys,
  noiseFloorsFor,
  recentOnsetKeys as noiseFloorRecentOnsetKeys,
  stepNoiseFloor,
  type NoiseFloorSnapshot,
  type NoiseFloorState,
} from '../utils/kyoshinNoiseFloor'
import {
  consumeWarmup,
  pushPendingFrame,
  type PendingFrame,
  type WarmupNotice,
} from '../utils/kyoshinWarmupConsumer'
import { LIVE_KYOSHIN_SUPPLY_KEY, type KyoshinBackfill, type KyoshinWarmup } from './useKyoshinRealtime'
import { createQuietLearner, QUIET_LEARNER_DEFAULTS, type QuietLearner } from '../utils/kyoshinQuietLearner'
import { loadQuietLearnerState, saveQuietLearnerState } from '../utils/kyoshinQuietLearnerDb'
import type { KyoshinFrame } from '../services/kyoshinSource'
import { createLogThrottle, log } from '../utils/logger'
import { profileSpan } from '../utils/frameProfiler'
import { createEnsembleDetector } from '../utils/kyoshinEnsembleDetector'
import { createEnsembleWorkerClient, type EnsembleWorkerLike } from '../utils/kyoshinEnsembleWorkerClient'
import type { EnsembleShadow, ShadowDropReason, ShadowFrame } from '../utils/kyoshinEnsembleShadow'
import type { EnsembleDetection } from '../utils/kyoshinEnsembleTracker'
import { getKyoshinQuietTables, loadKyoshinQuietTables, onKyoshinQuietTablesLoaded } from '../utils/kyoshinQuietTablesLoader'
import type { QuietTables } from '../utils/kyoshinQuietTables'

/**
 * 慢性ノイズ床（`utils/kyoshinNoiseFloor`）の localStorage キー。座標から作る観測点キーなので、
 * `siteConfigId` の版差に依らない。中身は `{ floors: { 観測点キー: [平均, ばらつき] } }`
 */
const LEARNED_KEY = 'kyoshin-v3-learned'
/** 床の保存間隔(ms)。毎フレーム書くと無駄なので間を置く。 */
const SAVE_INTERVAL_MS = 60_000
/** 観測点数と震度の件数の食い違いを記録する最小間隔(ms)。毎フレーム出すと埋まる。 */
const PAIR_MISMATCH_LOG_MS = 300_000

/**
 * 主スレッドで組み合わせの検知器を回すとき（Worker が立たなかったとき）、1 回の区切りで使ってよい時間（ms）。
 * 1 フレーム 3〜12 ms かかるので、1 区切りで 1〜2 フレーム
 */
const ENSEMBLE_MAIN_SLICE_MS = 8
/**
 * Worker の中で 1 回の区切りで使ってよい時間（ms）。画面は止めないので主スレッドより長くてよいが、
 * 作り直しの伝言（時間軸の切替）を受け取るまでの遅れになるので長くしすぎない
 */
const ENSEMBLE_WORKER_SLICE_MS = 50
/**
 * 床の係の「今揺れ始めた点」をデータ時刻ごとに覚えておく長さ（ms）。組み合わせの検知器は区切って処理するぶん
 * 遅れて結果を返すので、その結果と同じ時刻の値を組にして渡す
 */
const ONSET_KEEP_MS = 120_000
/** 組み合わせの検知器の例外を記録する最小間隔（ms） */
const ENSEMBLE_ERROR_LOG_MS = 300_000
/**
 * Worker が黙ったとみなす時間（ms・実時間）。返事を待っているのにこれだけ何も届かなければ主スレッドへ切り替える。
 * 助走の最大 900 フレームでも Worker の中の処理は約 3 秒なので、正当な処理を取り違えない長さにしてある
 */
const ENSEMBLE_WORKER_SILENCE_MS = 30_000
/** 平常のゆらぎの表の取得を、共有の規則が諦めた後に取り直すまでの間（ms） */
const QUIET_TABLES_RETRY_MS = 600_000

/** 助走・取り直しの秒。検知器の状態を進めるためだけに食わせ、結果は画面へ出さない */
const toShadowFrame = (f: KyoshinFrame): ShadowFrame => ({ ms: f.time.getTime(), indices: f.indices, sitesKey: f.sitesKey, silent: true })
/**
 * 待たせていた秒。最後の 1 件は今届いたフレームなので結果を画面へ出し、それより前は出さない。
 * 出すと、待っていた間の検知が 1 秒ずつ画面・音・通知へ流れる
 */
const pendingToShadowFrames = (pending: readonly PendingFrame[]): ShadowFrame[] =>
  pending.map((f, i) => ({ ms: f.dataTimeMs, indices: f.indices, sitesKey: f.sitesKey, silent: i < pending.length - 1 }))

// localStorage が壊れた/無効な環境（プライベートモード・dom.storage.enabled=false・
// 一部の iframe サンドボックス等）では、getItem/setItem が呼ばれるたびに例外を投げる。
// 同じ warn を毎回積まないよう、モジュールスコープの一度限りフラグで抑える。
let loadWarned = false
let saveWarned = false

/** localStorage から床を復元した初期状態を作る（無ければ空状態）。 */
function loadInitialFloor(): NoiseFloorState {
  try {
    const raw = localStorage.getItem(LEARNED_KEY)
    if (!raw) return initNoiseFloorState()
    const saved = JSON.parse(raw) as NoiseFloorSnapshot
    if (!saved || typeof saved !== 'object' || !saved.floors || typeof saved.floors !== 'object') return initNoiseFloorState()
    return hydrateNoiseFloors(saved)
  } catch (e) {
    // 復元できないだけで床は学び直せるので warn にとどめる（error にすると初回起動や localStorage 無効環境で常時エラー化する）
    if (!loadWarned) {
      loadWarned = true
      log.warn('[detector] 慢性ノイズ床の復元失敗（新規セッションとして初期化）', e)
    }
    return initNoiseFloorState()
  }
}

/** 床を localStorage に保存する（容量超過・無効環境は握りつぶす）。 */
function saveFloor(state: NoiseFloorState): void {
  try {
    localStorage.setItem(LEARNED_KEY, JSON.stringify(extractNoiseFloors(state)))
  } catch (e) {
    // 保存できないと次回起動時に床が学び直しになるだけ。なぜ復元されないかを追えるよう一度だけ残す
    if (!saveWarned) {
      saveWarned = true
      log.warn('[detector] 慢性ノイズ床の保存失敗（localStorage 容量超過・プライベートモード等）', e)
    }
  }
}

export interface KyoshinDetectorV2Result {
  /**
   * 組み合わせの検知器（`utils/kyoshinEnsembleTracker`）の検知。段は早い段（`likely`）と確かな段（`confirmed`）だけで、
   * 震度では分けない（震度1 に届かない揺れも段のまま音・自動タブ切替・地図の寄せへつなぐ。2026-10-29 ユーザー選択「段のまま鳴らす」）
   */
  detections: EnsembleDetection[]
  /**
   * `detections` と同じデータ時刻に、直近に立ち上がった観測点キー（床の係の `recentOnsetKeys`）。検知点マーカー・
   * 検知カードが「揺れが去った後に残る孤立した震度0点」を落とす判定と、同じ場所の 2 つ目の地震の合図に使う
   */
  recentOnsetKeys: ReadonlySet<string>
  /** `detections` のデータ時刻（ISO 文字列）。強震モニタの取得の時刻とは、組み合わせの検知器が処理する遅れだけずれうる */
  dataTime: string
  /**
   * 観測点ごとの表示用慢性ノイズ床（value）。**`sites` と同じ並びの配列**で、震度0ドット表示
   * （KyoshinSubThresholdGL）が慢性的にノイジーな観測点を鈍く見せるフィルタに使う。空配列は
   * フィルタ未適用の合図。
   *
   * 座標キーの辞書にしないのは、同一座標に複数の実観測点が載る点があるため（`computeSiteKeys` が
   * `#2`, `#3` と別実体に分ける）。受け取る側が座標からキーを作り直すと、その規則が 2 箇所に増えて
   * 静かに食い違う。並びで対応づければ規則そのものが要らない。
   *
   * まだ床を持たない点は 0 を入れる（一度も観測できていない欠測点だけ）。
   */
  floors: number[]
  /**
   * `floors` を計算した観測点配列の参照。**`floors` を位置で使う側は、自分が持っている観測点配列と
   * これが同一参照であることを確かめてから使うこと。**
   *
   * 観測点リストが差し替わってから次の結果が届くまでの間は「新しい観測点 × 古い床」が並び、点数がたまたま
   * 一致すると長さの検査をすり抜けて別地点の床で判定してしまう。リストの差し替えは過去日のリプレイを
   * 始めるたびに起こる（`services/kyoshinSource.ts` が再生対象日の `siteConfigId` を使うため）。
   */
  floorsSites: SiteCoords
  /**
   * この結果が「**結果を出せなくなったので空にした**」ものか（`RESULT_STALL_RESET_FRAMES` 参照）。
   *
   * 受け取る側が「揺れが収まって検知が消えた」のと区別するために持つ。後者からの復帰は同じ地震が
   * 続いていることが多く、警報音や通知を鳴らし直すと「収まって、また始まった」という誤った印象を与える。
   */
  stalled: boolean
}

const EMPTY: KyoshinDetectorV2Result = {
  detections: [],
  recentOnsetKeys: new Set<string>(),
  dataTime: '',
  floors: [],
  floorsSites: [],
  stalled: false,
}

/**
 * 観測点集合のシグネチャ。これが変わったら床の係の観測点キー（`noiseFloorKeys`）を作り直す。
 *
 * **全点を見る。** 点数と先頭・末尾の座標だけで比べると、配列の中間だけが差し替わった更新を見逃し、古いキーを
 * 使い続ける。キーは座標が重なる点に出現順で `#2`, `#3` を割り当てる（Yahoo の観測点リストでは全 1725 点中
 * 431 点が該当）ので、表示側の `buildSiteIndex` が作り直すキーとずれ、`recentOnsetKeys` を使う判定が静かに効かなくなる。
 *
 * 呼ぶのは `sites` の**参照が変わったとき**だけ（同じ `siteConfigId` の観測点リストは `fetchSiteList` が同じ配列を返す）。
 *
 * export しているのはテストから直接呼ぶため（フック外から使う想定はない）。
 */
export function siteSignature(sites: SiteCoords): string {
  if (sites.length === 0) return ''
  const parts: string[] = [String(sites.length)]
  for (const s of sites) parts.push(siteKey(s[0], s[1]))
  return parts.join('|')
}

/**
 * **結果を出せないフレーム**がこの回数だけ続いたら、検知結果を空にする。
 *
 * 出せない理由は 3 つある——観測点数と震度の件数が食い違って入れない場合、組み合わせの検知器が例外を投げて
 * そのフレームを捨てた場合、観測点集合が合わない・無いのでそのフレームを捨てた場合（同じ時刻の積み直しは数えない。
 * 助走の消化で毎回起きる）。どれも結果が前フレームの値で凍結する。一方で表示側が使う現在震度は生きたまま
 * 更新され続けるので、放置すると「古いメンバーを現在の震度で描き続ける」状態になる。数フレームの一過性なら
 * 保持した方が明滅しないが、恒常的に壊れているなら表示を止める方が安全。
 *
 * export しているのはテストが閾値を参照するため（フック外から使う想定はない）。
 */
export const RESULT_STALL_RESET_FRAMES = 5

/**
 * 助走（`utils/kyoshinWarmup`）が届くまで通常フレームを待たせる上限（フレーム数）。
 *
 * 供給元は助走が無い場合も空配列で必ず 1 度渡す契約（`KyoshinSourceSink.prefill`）なので、
 * 通常はこの上限に触れない。**触れるのは契約が守られなかったとき**で、そのまま待ち続けると
 * 検知が恒久的に沈黙する。上限に達したら助走を諦めて通常どおり動かす。
 *
 * 数えるのは**フレーム数で、経過時間ではない**。通常は 1 秒に 1 フレーム届くので 90 秒ぶんに
 * 相当するが、観測点集合の識別子が揃わない区間（版の切替直後）のフレームはここへ積まれない
 * ため、実時間ではもっと長くなりうる。助走の取得は最長でも 15 ブロック（実測で 1 ブロック
 * 60 件が 1 秒未満）なので、正常な取得がこの幅に収まらないことはない。
 */
export const WARMUP_WAIT_MAX_FRAMES = 90

/**
 * 助走の消化で起きたことを記録する。
 *
 * **文面はここが持ち、`consumeWarmup` は事実だけを返す。** 同じ出来事を 2 通りの言葉で書くと、
 * 片方だけ直したときに記録と実装が食い違う。
 */
function logWarmupNotice(notice: WarmupNotice, supplyKey: string, sitesSiteConfigId: string, what: '助走' | '抜けた区間の取り直し' = '助走'): void {
  if (what !== '助走') {
    // **抜けた区間の取り直し**（リプレイの全滅区間 #986・ライブの途切れ #1183）は同じ消化を通るが、語を分ける（助走と取り違えると原因を追えない）。
    const detail =
      notice.kind === 'gave-up'
        ? `${notice.waitedFrames} フレーム待っても届かないため、穴のまま検知を続けます`
        : notice.kind === 'all-unusable'
          ? `${notice.total} フレームを 1 件も使えませんでした（版違い ${notice.versionMismatch} 件）`
          : notice.kind === 'feed-failed'
            ? `${notice.count} 件の消化が例外`
            : `消化を途中で打ち切りました（${notice.phase}）`
    const error = notice.kind === 'feed-failed' || notice.kind === 'aborted' ? notice.error : undefined
    if (error === undefined) log.warn(`[kyoshinV2] ${what}: ${detail}（supplyKey=${supplyKey}・sites=${sitesSiteConfigId}）`)
    else log.error(`[kyoshinV2] ${what}: ${detail}（supplyKey=${supplyKey}・sites=${sitesSiteConfigId}）`, error)
    return
  }
  switch (notice.kind) {
    case 'gave-up':
      log.warn(
        `[kyoshinV2] 助走が ${notice.waitedFrames} フレーム待っても届かないため、助走なしで検知を始めます`
        + `（supplyKey=${supplyKey}）`,
      )
      return
    case 'all-unusable':
      // **届いたのに 1 件も使えなかったことは記録する。** 画面からは「助走が無かった」のと
      // 見分けが付かず、立ち上がりの検知が遅れた原因を後から追えない。落とした理由（版違いか、
      // それ以外か）も添える —— 前者は観測点リストの切替と重なっただけだが、後者は助走そのものの
      // 作り方を疑う手がかりになる。
      log.warn(
        `[kyoshinV2] 助走 ${notice.total} フレームを 1 件も使えませんでした`
        + `（版違い ${notice.versionMismatch} 件・その他 ${notice.total - notice.versionMismatch} 件。`
        + `助走なしで検知を始めます。sites=${sitesSiteConfigId}）`,
      )
      return
    case 'feed-failed': {
      // **件数だけでは「どの入力で壊れたか」を再現できない**ので、最初に落ちたフレームの
      // データ時刻も添える。1 件ずつ出さないのは、助走が最大 900 件あるとログが埋まるため。
      const at = notice.frameTimeMs === null ? '(不明)' : new Date(notice.frameTimeMs).toISOString()
      log.error(
        `[kyoshinV2] 助走・待機分の消化で ${notice.count} 件が例外（残りは続行。最初に落ちたのは ${at}）`,
        notice.error,
      )
      return
    }
    case 'aborted':
      // 1 件ぶんの握りでは受け止められなかった（列の反復そのものが壊れた）。その段は
      // 途中で止まるが、検知そのものは続ける。
      log.error(
        `[kyoshinV2] ${notice.phase === 'warmup' ? '助走' : '待機分'}の消化中に例外`
        + '（その分を打ち切って検知を始めます）',
        notice.error,
      )
      return
    default: {
      // 種別を足して分岐を書き忘れたときに止まるのはここだけ。
      const never: never = notice
      log.warn('[kyoshinV2] 未知の助走の記録', never)
    }
  }
}

/** 時間軸が変わったとき、床だけ残して点ごとの履歴と立ち上がりを捨てる（設計書§37: フレームの間隔から推し量らせない） */
function dropTransientFloor(state: NoiseFloorState): NoiseFloorState {
  const sites: NoiseFloorState['sites'] = {}
  for (const [k, s] of Object.entries(state.sites)) sites[k] = { floorMean: s.floorMean, floorDev: s.floorDev, hist: [], triggeredAtMs: null }
  // 0 にしておけば、次のフレームは間隔が `MAX_RESUME_GAP_MS` を超えるので作り直しとして扱われる
  return { sites, lastDataTimeMs: 0 }
}

const EMPTY_KEYS: ReadonlySet<string> = new Set<string>()

/**
 * 強震モニタの揺れ検知の React ラッパー。
 *
 * 検知そのものは組み合わせの検知器（`utils/kyoshinEnsembleDetector`）が受け持ち、Web Worker の中で動かす
 * （立たなければ主スレッドで区切って動かす。`utils/kyoshinEnsembleWorkerClient`）。結果は音・自動タブ切替・
 * 自動フィット・地図・検知カード・行動チェックリストを駆動する。
 *
 * 主スレッドでは慢性ノイズ床（`utils/kyoshinNoiseFloor`）だけを毎フレーム学ぶ。震度0 未満の点を地図に出すかの
 * 絞り込みと、「今揺れ始めた点」の判定に使う。デバッグ用に最新結果を window.__kyoshinV2 へ公開する。
 *
 * @param sites 観測点座標（useKyoshinRealtime.sites）
 * @param indices 計測震度インデックス（useKyoshinRealtime.indices）
 * @param dataTime データ時刻文字列（useKyoshinRealtime.dataTime）
 * @param sitesSiteConfigId sites がどの `siteConfigId` で fetch されたか
 * @param indicesSiteConfigId indices が属する `siteConfigId`（毎フレーム RealTimeData 由来）
 * @param enabled 有効フラグ（false の間は何もしない）
 * @param supplyKey いま動いている供給を表す文字列（`useKyoshinRealtime.supplyKey`）
 * @param warmup その供給の助走フレーム（`useKyoshinRealtime.warmup`）。届くまでは通常フレームを
 *   待たせる。詳細は `utils/kyoshinWarmup`
 * @param backfill リプレイで全滅した区間の取り直し（`useKyoshinRealtime.backfill`。#986）。始まったら助走と同じく
 *   通常フレームを待たせ、届いたら穴のフレームを先に食わせる。無ければ `null`
 */
export function useKyoshinDetectorV2(
  sites: SiteCoords,
  indices: number[],
  dataTime: string,
  sitesSiteConfigId: string | null,
  indicesSiteConfigId: string | null,
  enabled: boolean,
  supplyKey: string,
  warmup: KyoshinWarmup | null,
  backfill: KyoshinBackfill | null,
): KyoshinDetectorV2Result {
  // `useRef(loadInitialFloor())` と書いてはいけない——**引数式は毎レンダー評価される**ため、
  // 1Hz の再レンダーのたびに localStorage の読み取りが走り、結果は捨てられる（理由と実測値は `useLazyRef`）。
  const floorRef = useLazyRef(loadInitialFloor)
  // 床の係の観測点キー。sites の参照が同じなら中身も同じ（fetchSiteList が同一 siteConfigId に対して同じ配列を返す）
  const keysRef = useRef<{ sites: SiteCoords; sig: string; keys: readonly string[] } | null>(null)
  /** いちばん新しい床（`sites` と同じ並び）と、それを計算した観測点配列 */
  const floorsRef = useRef<{ floors: number[]; sites: SiteCoords }>({ floors: [], sites: [] })
  /** 床の係がデータ時刻ごとに出した「今揺れ始めた点」。組み合わせの検知器の結果と同じ時刻で組にする */
  const onsetByMsRef = useRef(new Map<number, ReadonlySet<string>>())
  const lastSaveRef = useRef(0)
  /** 結果を出せなかったフレームの連続数（件数の食い違い・検知器の例外・観測点集合が合わない捨て。`RESULT_STALL_RESET_FRAMES`） */
  const stalledFramesRef = useRef(0)
  // 観測点数と震度の件数が食い違ったことの記録（間引き）。遅延初期化する
  // （`useRef(createLogThrottle(...))` と書くと毎レンダーで捨てるだけのクロージャを作る）。
  const pairMismatchLogRef = useRef<((emit: () => void) => void) | null>(null)
  const [result, setResult] = useState<KyoshinDetectorV2Result>(EMPTY)
  /**
   * 助走を待っているか。
   *
   * **立つのは「新しい時間軸で状態が空になった」ときだけ**——初回マウントと、リプレイの開始・停止でデータ時刻が
   * 空に転じたとき。**`supplyKey` の変化で立ててはいけない。** ローカル履歴アーカイブの収録範囲を再生中に
   * 跨ぐと供給元だけが替わるが、再生時刻はそのまま続く（`useKyoshinRealtime` の注記）。そこで待ちに入ると
   * 結果が古い値で凍結し、待たせたフレームが別の供給のものとして溜まる。
   */
  const waitingWarmupRef = useRef(true)
  /**
   * 抜けた区間の取り直し（リプレイの全滅区間 #986・ライブの途切れ #1183）を待っているなら、その番号。**待っていなければ `null`。**
   * 待つ間は助走と同じく通常フレームを {@link pendingRef} へ溜める（先に食わせると、後から届いた穴のフレームが
   * 「時刻の巻き戻り」として捨てられる）。上限（{@link WARMUP_WAIT_MAX_FRAMES}）まで待って届かなければ穴のまま進む。
   */
  const waitingBackfillRef = useRef<number | null>(null)
  /** 消化を済ませた取り直しの番号（同じ番号の `begin` で待ち直さないため）。 */
  const doneBackfillRef = useRef<number | null>(null)
  /**
   * 待ちきれずに穴のまま進めた取り直しの番号。その `frames` が後から届いたら 1 行残す（供給元は「取り直した」としか書けず、
   * 使われなかったことはここでしか分からない）。
   */
  const gaveUpBackfillRef = useRef<number | null>(null)
  /** 助走が届くまで待たせている通常フレーム（時刻の昇順・観測点集合の識別子つき）。 */
  const pendingRef = useRef<PendingFrame[]>([])
  /**
   * 最後に床の係へ渡したデータ時刻。助走と通常フレームは別の経路で届くので、重なった時刻・巻き戻った時刻がありうる。
   * 同じ時刻を 2 度渡すと間隔が 0 になり、床の係は作り直しとして履歴を捨てる。ここで落とす。
   */
  const lastSteppedMsRef = useRef(-Infinity)

  /** 組み合わせの検知器。マウントの間だけ生きる */
  const ensembleRef = useRef<EnsembleShadow | null>(null)
  /** 捨てたフレームの数（理由ごと）。`window.__kyoshinV2` で見る */
  const dropsRef = useRef<Record<ShadowDropReason, number>>({ 'sites-mismatch': 0, 'not-newer': 0, 'no-sites': 0 })
  /** 平常のゆらぎを端末で学び直す係。配る表が届き、端末に残した状態を読み終えてから作る */
  const learnerRef = useRef<QuietLearner | null>(null)
  // 学び直した状態を端末へ残せているか（診断欄に出す。読めなかった起動は残さないので、記録 1 行のほかに見える場所が要る）
  const learnerSaveRef = useRef<{ enabled: boolean | null; lastOk: boolean | null; lastAtMs: number | null }>({ enabled: null, lastOk: null, lastAtMs: null })
  /**
   * いまライブを受けているか。学び直すのはライブのフレームだけ（リプレイ・ローカル履歴アーカイブの過去の日を
   * 「いまの平常」として覚えない）。検知器は区切って遅れて処理するので、処理する時点の値を ref で見る
   */
  const isLiveRef = useRef(supplyKey === LIVE_KYOSHIN_SUPPLY_KEY)
  isLiveRef.current = supplyKey === LIVE_KYOSHIN_SUPPLY_KEY
  /** 配る表と、端末で学び直した表（まだ無ければ null）。ライブとリプレイを行き来したときに選び直す */
  const tablesRef = useRef<{ prior: QuietTables | null; learned: QuietTables | null }>({ prior: null, learned: null })

  useEffect(() => {
    const errorLog = createLogThrottle(ENSEMBLE_ERROR_LOG_MS)
    const learnerErrorLog = createLogThrottle(ENSEMBLE_ERROR_LOG_MS)
    const dropLog = createLogThrottle(ENSEMBLE_ERROR_LOG_MS)
    let inWorker = true
    // 検証用に公開する診断欄（Playwright から window.__kyoshinV2 を参照する）。検知結果の欄は画面へ出した結果でしか
    // 書き換えないが、こちらは捨て・例外・切り替えのたびにも書き換える——結果が出なくなったときほど見たい値なので
    const publishDiag = () => {
      const g = window as unknown as Record<string, unknown>
      g.__kyoshinV2 = {
        ...(g.__kyoshinV2 as Record<string, unknown> | undefined),
        backlog: ensembleRef.current?.backlog() ?? 0,
        drops: { ...dropsRef.current },
        tablesDays: getKyoshinQuietTables().days.length,
        // 学び直しの係へこの秒を渡したか（ライブで、係が立ち上がっている）
        learning: isLiveRef.current && learnerRef.current !== null,
        // 端末へ残すか（null＝まだ読み込み中、偽＝読めなかった起動なので残さない）と、最後に残そうとした結果
        learnerSave: { ...learnerSaveRef.current },
        // Web Worker で動いているか（偽なら主スレッドで区切って動いている）
        inWorker,
      }
    }
    // 検知結果を出せないフレーム（例外・観測点集合が合わない・観測点集合が無い）を数え、続くなら結果を空にする。
    // 保持し続けると、凍結したメンバーを現在の震度に当てて描き続ける。理由で数えを分けないこと —— 片方だけが
    // 交互に起きると、どちらの数えも閾値に届かず凍結が解けない
    const noteUnusableFrame = () => {
      stalledFramesRef.current++
      if (stalledFramesRef.current === RESULT_STALL_RESET_FRAMES) {
        log.error('[kyoshinV2] 組み合わせの検知器が結果を出せないフレームが続くため検知結果を空にします')
        setResult({ ...EMPTY, floors: floorsRef.current.floors, floorsSites: floorsRef.current.sites, stalled: true })
      }
    }
    const ensemble = createEnsembleWorkerClient(getKyoshinQuietTables(), {
      createWorker: () => {
        if (typeof Worker === 'undefined') throw new Error('この環境では Web Worker を使えません')
        return new Worker(new URL('../workers/kyoshinEnsemble.worker.ts', import.meta.url), { type: 'module' }) as unknown as EnsembleWorkerLike
      },
      workerSliceMs: ENSEMBLE_WORKER_SLICE_MS,
      silenceMs: ENSEMBLE_WORKER_SILENCE_MS,
      onFallback: (reason, lost) => {
        inWorker = false
        // 積んでいたフレームを失ったときは重く記録する（助走を失うと、既に揺れている状態を初動と見分けられないまま始まる）。
        // Worker を作れなかっただけ（初めから主スレッドで動く）なら何も失っていない
        const message = `[kyoshinEnsemble] Web Worker で組み合わせの検知器を動かせないので、主スレッドで区切って動かします（Worker に積んだまま失ったフレーム ${lost.frames} 件・うち画面へ出さないフレーム ${lost.silentFrames} 件）:`
        if (lost.frames > 0) log.error(message, reason)
        else log.warn(message, reason)
        publishDiag()
      },
      fallback: {
        createReporter: createEnsembleDetector,
        schedule: (fn) => {
          const id = setTimeout(fn, 0)
          return () => clearTimeout(id)
        },
        now: () => performance.now(),
        sliceMs: ENSEMBLE_MAIN_SLICE_MS,
        resumeGapMs: MAX_RESUME_GAP_MS,
        onResult: ({ ms, detections, values, sites: resultSites, sitesKey, silent }) => {
          stalledFramesRef.current = 0
          // 検知器が揺れを出している秒は、学び直しの係が前後ごと数えない。
          // 学び直しの係が投げても、この秒の検知は画面へ出す（検知器の例外とは分けて記録する）
          try {
            if (isLiveRef.current) learnerRef.current?.push(ms, sitesKey, resultSites, values, detections.length > 0)
          } catch (err) {
            learnerErrorLog(() => log.error('[kyoshinQuietLearner] 平常のゆらぎの学び直しが例外を投げました（この秒は数えない）:', err))
          }
          const byMs = onsetByMsRef.current
          const recent = byMs.get(ms) ?? EMPTY_KEYS
          // 古いものから捨てる（Map は入れた順に並ぶ）
          for (const k of byMs.keys()) {
            if (k >= ms - ONSET_KEEP_MS) break
            byMs.delete(k)
          }
          // 助走・取り直し・待たせていた秒の結果は画面へ出さない（`ShadowFrame.silent`）
          if (silent) { publishDiag(); return }
          const floors = floorsRef.current
          setResult({
            detections,
            recentOnsetKeys: recent,
            dataTime: new Date(ms).toISOString(),
            floors: floors.floors,
            floorsSites: floors.sites,
            stalled: false,
          })
          // 検証用にグローバル公開（Playwright から window.__kyoshinV2 を参照する）。診断欄は publishDiag が持つ
          ;(window as unknown as Record<string, unknown>).__kyoshinV2 = {
            detections,
            dataTimeMs: ms,
            // 孤立した震度0点の間引き（kyoshinDetectionView.dropIsolatedZeroPoints）が効いているかを追う
            recentOnsetKeys: recent.size,
          }
          publishDiag()
          const confirmed = detections.filter((d) => d.confidence === 'confirmed')
          if (confirmed.length > 0) {
            log.debug(
              `[kyoshinV2] confirmed=${confirmed.length} @${new Date(ms).toISOString()}`,
              confirmed.map((d) => ({ id: d.id, maxIntensity: d.maxIntensity?.toFixed(1) ?? null, members: d.memberKeys.length, epi: d.epicenter, sources: d.sources })),
            )
          }
        },
        onDrop: (reason, frame) => {
          dropsRef.current[reason]++
          // 同じ時刻の積み直し（`not-newer`）は毎回の助走の消化で起きる。観測点集合が合わずに捨てるのは、続けば検知が止まる
          if (reason !== 'not-newer') {
            dropLog(() => log.warn(`[kyoshinEnsemble] 観測点集合が合わないのでフレームを捨てました（${reason}・${new Date(frame.ms).toISOString()}・累計 ${dropsRef.current[reason]} 件）`))
            noteUnusableFrame()
          }
          publishDiag()
        },
        onError: (err, frame) => {
          errorLog(() => log.error(`[kyoshinEnsemble] 組み合わせの検知器が例外を投げたのでフレームを捨てました（${new Date(frame.ms).toISOString()}）:`, err))
          noteUnusableFrame()
          publishDiag()
        },
      },
    })
    ensembleRef.current = ensemble
    // 表は取れたら差し替える（取れるまでは全体の裾だけで動く）。届いた表を配る表として、学び直しの係も作る
    let disposed = false
    const off = onKyoshinQuietTablesLoaded((tables) => {
      log.info(`[kyoshinEnsemble] 平常のゆらぎの表を読み込みました（${tables.days.length} 日分・観測点 ${Object.keys(tables.tails).length} 点）`)
      tablesRef.current = { prior: tables, learned: tablesRef.current.learned }
      ensemble.setTables(tables)
      if (learnerRef.current !== null) return
      loadQuietLearnerState()
        .then(({ readable, state: initial }) => {
          if (disposed || learnerRef.current !== null) return
          learnerSaveRef.current = { enabled: readable, lastOk: null, lastAtMs: null }
          if (!readable) log.warn('[kyoshinQuietLearner] 端末に残した学び直しの状態を読めなかったので、初めから学び直し、この起動では保存しません（残した数を上書きしないため）')
          else log.info(`[kyoshinQuietLearner] 平常のゆらぎの学び直しを始めます（${initial ? '端末に残した数から' : '初めから'}）`)
          learnerRef.current = createQuietLearner({
            prior: tables,
            initial,
            ...QUIET_LEARNER_DEFAULTS,
            // 学び直した表はライブで受けている間だけ効かせる（リプレイは配る表で検知する。評価台と同じ条件にするため）
            onTables: (t) => {
              tablesRef.current = { prior: tablesRef.current.prior, learned: t }
              if (isLiveRef.current) ensemble.setTables(t)
            },
            onSave: (s) => {
              if (!readable) return
              void saveQuietLearnerState(s).then((ok) => {
                learnerSaveRef.current = { enabled: true, lastOk: ok, lastAtMs: Date.now() }
              })
            },
          })
        })
        .catch((err) => {
          log.error('[kyoshinQuietLearner] 平常のゆらぎの学び直しを始められませんでした（配る表だけで検知します）:', err)
        })
    })
    // 取得の規則が諦めても、間を置いて取り直す（オフラインで起動して戻った常時表示の端末が、全体の裾だけで動き続けないように）
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const loadTables = () => {
      loadKyoshinQuietTables().catch((err) => {
        if (disposed) return
        log.warn(`[kyoshinEnsemble] 平常のゆらぎの表を取得できなかったので、全体の裾だけで動かします（${QUIET_TABLES_RETRY_MS / 60_000} 分後に取り直します）:`, err)
        retryTimer = setTimeout(loadTables, QUIET_TABLES_RETRY_MS)
      })
    }
    loadTables()
    return () => {
      disposed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      off()
      learnerRef.current = null
      ensemble.dispose()
      if (ensembleRef.current === ensemble) ensembleRef.current = null
    }
  }, [])

  // ライブとリプレイを行き来したら、検知に使う表を切り替える（学び直した表はライブの間だけ）
  const isLive = supplyKey === LIVE_KYOSHIN_SUPPLY_KEY
  useEffect(() => {
    const { prior, learned } = tablesRef.current
    if (prior === null) return
    ensembleRef.current?.setTables(isLive && learned !== null ? learned : prior)
  }, [isLive])

  // 供給が作り直されたら結果を空にする。データ時刻が空になるのは `useKyoshinRealtime` が供給を
  // 作り直したとき（リプレイの時間軸の切替・ローカルアーカイブの出入り）だけで、そのとき旧い
  // 時間軸の検知は新しい軸に属さない。
  //
  // **下の effect に任せられない。** あちらは `!dataTime` で抜けるので `setResult` が呼ばれず、
  // 結果は前のフレームの値で凍結する。
  //
  // **`stalled` は立てない。** あれは「上流の異常で結果を出せなくなった」ことを伝える語で、受け取る側の
  // 振る舞いが変わる（行動チェックリストは帯の差し替えをやめ、発報側は次の検知を「同じ揺れの再開」と見なす）。
  //
  // 前回値を state で持つのは、React が捨てたレンダーの書き換えを一緒に捨てさせるため。
  const supplied = dataTime !== ''
  const [wasSupplied, setWasSupplied] = useState(supplied)
  if (wasSupplied !== supplied) {
    setWasSupplied(supplied)
    if (!supplied) setResult(EMPTY)
  }

  useEffect(() => {
    if (!enabled) return
    if (!dataTime || indices.length === 0 || sites.length === 0) {
      if (!dataTime) {
        // 時間軸が変わった。前の軸で進めた時刻・待たせていたフレーム・点ごとの履歴は新しい軸に属さない。
        // 残すと、過去へ飛ぶ切替で新しい軸のフレームが軒並み「巻き戻り」として捨てられる。床は残す
        stalledFramesRef.current = 0
        lastSteppedMsRef.current = -Infinity
        pendingRef.current = []
        floorRef.current = dropTransientFloor(floorRef.current)
        onsetByMsRef.current.clear()
        waitingWarmupRef.current = true
        waitingBackfillRef.current = null
        doneBackfillRef.current = null
        gaveUpBackfillRef.current = null
        ensembleRef.current?.reset()
        // 学び直しの係が遅らせて持っていた秒も捨てる（数えた分は残す）
        learnerRef.current?.reset()
      }
      return
    }
    const dataTimeMs = new Date(dataTime).getTime()
    if (!Number.isFinite(dataTimeMs)) return

    // sites と indices の siteConfigId が一致するフレームだけを処理する。切替直後は「新しい indices・旧い sites」が
    // 起こり、点数がたまたま一致すると座標と震度が誤って組になる。揃うまで待つ。
    if (sitesSiteConfigId == null || indicesSiteConfigId == null) return
    if (sitesSiteConfigId !== indicesSiteConfigId) return
    if (sites.length !== indices.length) {
      // 同じ `siteConfigId` なのに件数が違う＝上流データの異常。検知が丸ごと止まるが例外ではないので、
      // 記録しないと平常時と見分けがつかない（検知が出ないのが正常な状態なので）。毎フレーム出さないよう間引く。
      pairMismatchLogRef.current ??= createLogThrottle(PAIR_MISMATCH_LOG_MS)
      pairMismatchLogRef.current(() => log.error(
        `[kyoshinV2] 観測点数(${sites.length})と震度の件数(${indices.length})が食い違うため検知を停止しています`
        + `（siteConfigId=${sitesSiteConfigId}）`,
      ))
      // 続くなら結果を空にする（詳細は RESULT_STALL_RESET_FRAMES）。**床も空にする**——検知器の例外の経路と違い、
      // ここでは観測点と震度の並びそのものが食い違っているので、観測点の並びで対応づける床を位置で当てると
      // 別の点の床で絞ることになる（空の床は「絞り込みを掛けない」の合図）
      stalledFramesRef.current++
      if (stalledFramesRef.current === RESULT_STALL_RESET_FRAMES) {
        log.error('[kyoshinV2] 件数の食い違いが続くため検知結果を空にします')
        setResult({ ...EMPTY, stalled: true })
      }
      return
    }

    // 観測点集合が変わったときだけキーを作り直す。まず参照で弾き（毎秒はここで終わる）、参照が変わったときだけ全点を比べる
    if (!keysRef.current || keysRef.current.sites !== sites) {
      const sig = siteSignature(sites)
      if (!keysRef.current || keysRef.current.sig !== sig) keysRef.current = { sites, sig, keys: noiseFloorKeys(sites) }
      else keysRef.current.sites = sites
    }
    const keys = keysRef.current.keys
    ensembleRef.current?.setSites(sites, sitesSiteConfigId)

    /** 床の係へ 1 フレーム食わせ、その時刻の「今揺れ始めた点」を控える */
    const feedFloor = (state: NoiseFloorState, ms: number, values: number[]): NoiseFloorState => {
      const next = stepNoiseFloor(state, ms, values, keys)
      onsetByMsRef.current.set(ms, new Set(noiseFloorRecentOnsetKeys(next, values, keys)))
      return next
    }

    // ---- 抜けた区間の取り直しを待つか（#986・#1183。消化は助走の後）----
    //
    // **助走の待ちより先に見る。** 助走を待っている間は下で早く戻るので、後に置くと、待ちの間に届いた `begin` を
    // 見ないまま助走が明け、明けた後で古い `begin` に従って通常フレームを待たせてしまう。
    if (
      backfill !== null && backfill.supplyKey === supplyKey && backfill.frames !== null
      && backfill.id === gaveUpBackfillRef.current
    ) {
      log.warn(
        `[kyoshinV2] 待ちきれずに穴のまま進めた取り直しが後から届いたので使わない（supplyKey=${supplyKey}`
          + `・捨てたフレーム ${backfill.frames.length} 件）`,
      )
      gaveUpBackfillRef.current = null
    }
    if (backfill !== null && backfill.supplyKey === supplyKey && backfill.id !== doneBackfillRef.current) {
      if (waitingWarmupRef.current) {
        // **助走を待っている間の取り直しは使わない。** 助走の消化が最後に食わせた時刻を今のフレームの手前まで進めるので、
        // 後から届く穴のフレームは巻き戻りとして全部捨てられる（助走が穴の手前の履歴を作る）。
        log.warn(
          `[kyoshinV2] 助走を待っている間に抜けた区間の取り直しが始まったので使わない（supplyKey=${supplyKey}`
            + (backfill.frames === null ? '）' : `・捨てたフレーム ${backfill.frames.length} 件）`),
        )
        doneBackfillRef.current = backfill.id
      } else if (waitingBackfillRef.current !== backfill.id) {
        waitingBackfillRef.current = backfill.id
      }
    }

    // ---- 助走（`utils/kyoshinWarmup`）----
    //
    // 供給が始まった時点で既に揺れていると、検知器には「ずっと高いまま静止している点」にしか見えず立ち上がらない。
    // 開始より前のフレームを先に食わせて履歴を作る。**助走が届くまで通常フレームを食わせない**（先に食わせると、
    // 後から届いた助走が「時刻の巻き戻り」になって落とされる）。
    if (waitingWarmupRef.current) {
      pendingRef.current = pushPendingFrame(pendingRef.current, { dataTimeMs, indices, sitesKey: indicesSiteConfigId })
      const ready = warmup !== null && warmup.supplyKey === supplyKey
      if (!ready && pendingRef.current.length < WARMUP_WAIT_MAX_FRAMES) return
      const consumed = consumeWarmup({
        state: floorRef.current,
        lastSteppedMs: lastSteppedMsRef.current,
        // 助走が届いていない（＝上限まで待って諦めた）ことは `null` で伝える。
        warmupFrames: ready ? warmup.frames : null,
        pending: pendingRef.current,
        siteCount: sites.length,
        sitesSiteConfigId,
        feedFrame: feedFloor,
      })
      floorRef.current = consumed.state
      lastSteppedMsRef.current = consumed.lastSteppedMs
      // 床の係へ食わせたのと同じ順で検知器へも積む（観測点集合の照合と重なりの除去は検知器の係が行う）
      ensembleRef.current?.enqueue([...(ready ? warmup.frames.map(toShadowFrame) : []), ...pendingToShadowFrames(pendingRef.current)])
      pendingRef.current = []
      waitingWarmupRef.current = false
      for (const notice of consumed.notices) logWarmupNotice(notice, supplyKey, sitesSiteConfigId)
    }

    // ---- 抜けた区間の取り直し（#986・#1183）----
    //
    // 供給元は取得が戻った秒を渡す**前に** `begin` を出すので、ここで待ちに入れば穴のフレームを先に食わせられる。
    if (waitingBackfillRef.current !== null && !waitingWarmupRef.current) {
      pendingRef.current = pushPendingFrame(pendingRef.current, { dataTimeMs, indices, sitesKey: indicesSiteConfigId })
      const ready =
        backfill !== null && backfill.supplyKey === supplyKey && backfill.id === waitingBackfillRef.current && backfill.frames !== null
      if (!ready && pendingRef.current.length < WARMUP_WAIT_MAX_FRAMES) return
      const consumed = consumeWarmup({
        state: floorRef.current,
        lastSteppedMs: lastSteppedMsRef.current,
        warmupFrames: ready ? backfill.frames : null,
        pending: pendingRef.current,
        siteCount: sites.length,
        sitesSiteConfigId,
        feedFrame: feedFloor,
      })
      floorRef.current = consumed.state
      lastSteppedMsRef.current = consumed.lastSteppedMs
      ensembleRef.current?.enqueue([...(ready ? (backfill.frames ?? []).map(toShadowFrame) : []), ...pendingToShadowFrames(pendingRef.current)])
      pendingRef.current = []
      doneBackfillRef.current = waitingBackfillRef.current
      gaveUpBackfillRef.current = ready ? null : waitingBackfillRef.current
      waitingBackfillRef.current = null
      for (const notice of consumed.notices) logWarmupNotice(notice, supplyKey, sitesSiteConfigId, '抜けた区間の取り直し')
    }

    // 検知器へも積む。助走の消化と同じ回なら、このフレームは待たせた分として積み済みで、係が重なりとして捨てる。
    ensembleRef.current?.enqueue([{ ms: dataTimeMs, indices, sitesKey: indicesSiteConfigId, silent: false }])
    // Worker が黙っていないか（毎秒）
    ensembleRef.current?.checkResponsive()

    // 助走と重なる時刻・巻き戻った時刻は、ここでも落とす（助走の消化と同じ理由）
    if (dataTimeMs <= lastSteppedMsRef.current) return
    try {
      // 全国約 1725 点を毎秒 1 回まとめて学ぶ。カメラの移動と同じフレームに落ちればコマ落ちの原因になりうるため、
      // 区間として名前を付けて記録する（utils/frameProfiler.ts）。
      floorRef.current = profileSpan('kyoshin:noise-floor-step', () => feedFloor(floorRef.current, dataTimeMs, indices))
    } catch (err) {
      // 床の係が投げても検知器には積んであるので、検知は止まらない。床は前のフレームのまま
      log.error('[kyoshinV2] 慢性ノイズ床の学習が例外を投げました（このフレームは学ばない）:', err)
      return
    }
    lastSteppedMsRef.current = dataTimeMs
    floorsRef.current = { floors: noiseFloorsFor(floorRef.current, keys), sites }

    // 床を定期的に永続化する（再読込・5 時のリロード後も学習を保つ）
    if (dataTimeMs - lastSaveRef.current >= SAVE_INTERVAL_MS) {
      lastSaveRef.current = dataTimeMs
      saveFloor(floorRef.current)
    }
    // indices/sites は dataTime と同時に更新されるため deps は dataTime/enabled のみでよい。
    // siteConfigId 切替時は sites が遅れて更新されるが、その間は上の siteConfigId の照合で抜ける。
    // この前提は React 18 の自動バッチングで useKyoshinRealtime の applyFrame 内の setIndices/setDataTime/
    // setIndicesSiteConfigId が単一レンダーにまとまることに依る（applyFrame を同期で呼ぶ 2 経路が支えている。
    // useKyoshinRealtime.wiring.test.ts が回帰テストで固定している）。
    //
    // `warmup`・`backfill` を deps に含めるのは、データ時刻とは別のタイミングで届くため。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataTime, enabled, warmup, backfill])

  return result
}
