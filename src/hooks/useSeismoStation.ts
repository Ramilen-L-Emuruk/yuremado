// 自作地震計ホストから届く震度と波形を、観測点ごとの「いまの姿」へ畳む層。
//
// **強震モニタ（Yahoo）の経路には一切触らない。** 揺れ検知（`kyoshinEnsembleTracker`）も
// `KyoshinSource` も、入力（全国 700 点の 1 秒ごとの色）も時間軸（リプレイで
// 巻き戻る）も別物で、共通化できるところが無い。
//
// **震度の出どころが 3 つある。** これがこの層の主題 ——
//
//   - `station-reading`（観測点の合成）。複数センサーで裏付けた値
//   - `reading`（センサー単独）。**観測点に有効なセンサーが 2 台未満だと、
//     ホストは合成を作らない**（`seismo-host/src/receiver/sensorFusion.ts` の
//     `buildGroups` が `list.length < 2` で組まない）。そのときはこちらしか無い
//   - **途絶**（`'silent'`）。どちらも来なくなった状態。**行は残して値だけ落とす**
//     —— 消すと「揺れていない」と見分けが付かなくなる（→ `utils/seismoSilence.ts`）。
//     **一度も届いていない観測点はここへ来ない**（そちらは下の「未着」）
//   - **未着**（`'unseen'`）。ホストに割り当ててあるのに、割り当てが見えてから {@link UNSEEN_GRACE_MS} 経っても
//     何も届かない観測点（2026-10-22 選択「猶予の後に『未着』行を出す (Recommended)」、猶予は 2026-10-24 選択「60秒 (Recommended)」）
//
// **震度が一度も届かず、波形だけ届く観測点もある**（`'wave-only'`）。3 方向のうち解けない向きが
// ある観測点（水平の 2 軸のセンサーだけで上下を測れない等）では、ホストは解ける成分の合成波形だけを
// 出して震度を出さない（`seismo-host/src/receiver/sensorFusion.ts`）。帯にも下部の波形にも出す
// （2026-10-12 ユーザー承認）。波形も止まれば、ほかの観測点と同じ途絶になる。
//
// **どちらを採るかは「合成が実際に届いたか」で決める。設定は見ない。** ホストの
// 設定を根拠にすると、設定と実際が食い違ったとき（センサーが落ちた・帳面に
// 古い観測点が残っている）判断ごと狂う。届いているものだけを信じる。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  connectSeismoStream,
  isValidSeismoHostUrl,
  SeismoHostDirectory,
  type SeismoMessage,
  type SeismoStationWaveRevised,
  type SeismoStreamState,
  type SeismoWaveWant,
} from '../services/seismoStream'
import { fetchSeismoWaveSamples } from '../services/seismoWaveSamples'
import { SeismoWaveRefiller, type SeismoWaveRefillSkip } from '../services/seismoWaveRefill'
import {
  SeismoWaveBuffer,
  type SeismoWaveTally,
  type SeismoWaveWindow,
} from '../utils/seismoWaveBuffer'
import { createLogThrottle, log } from '../utils/logger'
import { MAX_WAVE_SPAN_SEC } from '../utils/waveSpan'
import { judgeSilence } from '../utils/seismoSilence'

/**
 * 震度が届かなくなってから落とすまで（ms）。
 *
 * **震度は毎秒 1 件届く**（窓 20 秒・刻み 1 秒。`utils/knet/seismicIntensity` の
 * `STEP_SEC_DEFAULT`）。合成はそこへ裏付けの待ち（300 ms。`sensorFusion.ts` の
 * `FUSION_WAIT_MS_DEFAULT`）が乗るだけなので、5 秒あれば正常な揺らぎを跨げる。
 *
 * **落とす判断をこの層に置く理由。** 届かなくなると再描画も起きないので、
 * 表示側からは「値が古い」を検出できない —— 画面には最後に届いた震度が残り、
 * **「揺れていない」と区別が付かなくなる**（#261 が避けたい形そのもの）。
 *
 * **接続の停滞（`seismoStream.ts` の `STALL_MS` = 45 秒）では代わりにならない。**
 * あちらが見るのは押し出しが生きているかで、**繋がっているのにその観測点だけが
 * 沈黙している**場合（センサーが落ちた・合成が組めなくなった）は掛からない。
 */
export const READING_STALE_MS = 5000

/**
 * 波形が届かなくなってから「止まっている」と見なすまで（ms）。
 *
 * **震度の鮮度（{@link READING_STALE_MS}）では代われない。** 押し出しは種別ごとに
 * 独立していて、**観測点の有効なセンサーが 2 台を切ると合成だけが止まり、震度は
 * 単独（`reading`）へ落ちて生き続ける**（`seismo-host/src/receiver/sensorFusion.ts` の
 * `buildGroups` が `list.length < 2` で組まない）。接続層の停滞検出（`seismoStream.ts` の
 * `STALL_MS` = 45 秒）も、震度が届いている限り発火しない。
 *
 * **これが無いと、絵が凍ったまま「いま静かに揺れている」ように見え続ける。**
 * 入れ物（`utils/seismoWaveBuffer.ts`）は押し出しで駆動するだけで、時間が経っても
 * 薄れない —— 読み出すたび最後のスナップショットを返すので、**止まったことが
 * 画面のどこにも現れない**。この機能でいちばん避けたい「揺れていない」と
 * 「届いていない」の混同そのもの。
 *
 * まとまりは 0.3 秒ごとに届く（実機の実測で 12 秒に 40 件）ので、5 秒あれば
 * 正常な揺らぎを跨げる。
 *
 * **有感の地震カードの波形も同じ値で判定する**（`hooks/useSeismoQuakeWaves.ts`）。
 * どちらも止まる原因は同じ押し出し（`station-wave`）なので、別々の数字を持つと
 * **同じ 1 つの途絶で、地図の下の絵とカードの絵が別のタイミングで薄くなる。**
 */
export const WAVE_STALE_MS = 5000

/**
 * 抱える波形の長さ（秒）。
 *
 * 実機の刻みは約 10 ms（100 Hz）なので、3 成分＋本数で 4 × 18000 サンプル ＝
 * `Float32Array` で 288 KB ほど。**観測点ごとに 1 本**持つ。
 *
 * **絵の横の幅（設定の時間幅）のいちばん長いものに揃える**（`utils/waveSpan.ts` の `MAX_WAVE_SPAN_SEC`）。
 * 短く持つと、設定で幅を広げたときに絵の左端が「抱えていない区間」なのか「届かなかった区間」
 * なのか分からなくなる。
 */
export const WAVE_RETAIN_SEC = MAX_WAVE_SPAN_SEC

/**
 * 下部の波形で穴を見つけてから、ホストの控え（`/waves`）へ取りに行くまで待つ時間（ms）。
 *
 * 起点から作り直したとき（起動直後・抱える長さを超える切断の後）も、同じだけ待って手前の空きを取りに行く。
 * 待つ理由は `services/seismoWaveRefill.ts` の `delayMs`（控えへの書き込みが追いつくのを待つ・続けてできた
 * 穴を 1 回へまとめる）。**数秒で足りる** —— ホストは押し出しと同時に控えへ書き、書き込み自体は非同期でも
 * ミリ秒で終わる。長くすると、穴が埋まるまで絵に空白が見えている時間がそのぶん伸びる。
 */
export const WAVE_REFILL_DELAY_MS = 3000

/** 穴埋めを見送った理由の記録の文面（`services/seismoWaveRefill.ts` の `SeismoWaveRefillSkip`）。 */
const SKIP_REASON_TEXT: Record<SeismoWaveRefillSkip, string> = {
  'no-buffer': 'その観測点の波形をまだ抱えていない',
  'nothing-to-do': '範囲に穴も手前の空きも無い',
  restarted: '取りに行っている間に起点から作り直した（新しい起点で取り直す）',
}

/**
 * 観測点ごとの姿を作り直す間隔（ms）。
 *
 * **1 件ごとに state を差し替えない。** センサー 9 本なら押し出しは毎秒 10 件
 * （`reading` 9 件＋`station-reading` 1 件）届くので、そのたび再描画すると
 * 毎秒 10 回になる。**震度そのものが毎秒 1 件**なので、それより細かく描き直す
 * 意味が無い。
 *
 * この刻みは古さの判定（{@link READING_STALE_MS}）も兼ねる —— 届かなくなっても
 * この巡回は回り続けるので、落とす契機が押し出しの到着に依存しない。
 */
const REBUILD_INTERVAL_MS = 500

/** 同じ理由の記録を間引く間隔（ms）。 */
const LOG_THROTTLE_MS = 300_000

/**
 * 割り当ててある観測点から何も届かないとき、「未着」の行を出すまでの猶予（ms）。**60 秒。**
 *
 * **ホストが「割り当てた基板が届いていない」と判定する猶予と揃える**（`seismo-host/src/receiver/assignedReception.ts` の
 * `STALE_AFTER_MS`。2026-10-24 ユーザー選択「60秒 (Recommended)」）。短くすると、繋いだ直後やホストの起動直後
 * （基板は時計が合うまで送らない）に毎回赤く出る。**起点は割り当てが台帳に見えた時刻**（`SeismoHostDirectory.assignedStations`）。
 */
export const UNSEEN_GRACE_MS = 60_000

/**
 * 合成の波形が戻ってから、センサー単独の波形の購読（`?wave=all`）をやめるまで待つ時間（ms）。**30 秒。**
 *
 * **すぐ戻さない。** 戻すたびに押し出しを繋ぎ直すので、合成が途切れ途切れに届く間（センサーが出たり入ったり）に
 * 繋ぎ直しを繰り返すことになる。単独を描いている間も合成は届くので、戻すのを待っても絵は合成へ戻る。
 */
export const SENSOR_WAVE_RETURN_HOLD_MS = 30_000

/**
 * 全部入りを要求してから、描ける単独の波形が来ないと見なすまで（ms）。**30 秒**（繋ぎ直しと最初のまとまりが届くまでに十分）。
 */
export const SENSOR_WAVE_PROBE_MS = 30_000

/** 届かなくなったセンサー単独の波形の入れ物を捨てるまで（ms）。合成へ戻った後に抱え続けないため。 */
const SENSOR_WAVE_DROP_MS = 60_000

/** その震度をどこから採ったか。 */
export type SeismoIntensitySource =
  /** 観測点の合成（`station-reading`）。複数センサーで裏付けた値。 */
  | { readonly kind: 'station' }
  /**
   * センサー単独（`reading`）の最大値。**合成が届いていない観測点。**
   *
   * @param sensorCount 最大値を選ぶのに見たセンサーの本数（古くないものだけ）。
   *   **1 なら裏付けが 1 本も無い。**
   */
  | { readonly kind: 'sensor'; readonly sensorCount: number }
  /**
   * **何も届かなくなった。** 一度は震度が届いていた観測点が、{@link READING_STALE_MS} を
   * 超えて合成も単独も途絶えた状態（→ `utils/seismoSilence.ts`）。
   *
   * **このとき行を消さない。** 消すと「揺れていない」と見分けが付かなくなる ——
   * この機能でいちばん避けたい混同そのもの（`docs/spec/data-sources-spec.md` §4.5）。
   * **接続の状態では代われない** —— 黙って切れた繋ぎは停滞の検出（45 秒）を待つし、
   * **繋がっているのにその観測点だけ沈黙する形はいつまでも `'open'` のまま**。
   *
   * **一度も届いていない観測点はここへ来ない**（割り当ててあれば猶予の後に `unseen`。それ以外は行を作らない）。購読を始めた
   * 直後に全部の行が「値が来ていない」と名乗ると、警告が常態になって意味を失う。
   *
   * **波形だけ届いていた観測点（{@link SeismoIntensitySource} の `'wave-only'`）が、波形も
   * 届かなくなったときもここ。** 届いていたものが途絶えたことに変わりは無い。
   */
  | { readonly kind: 'silent' }
  /**
   * **震度は一度も届いていないが、波形は届いている。** 上を解けない観測点は、ホストが合成波形
   * （解ける成分だけ）を出して震度を出さない。
   *
   * **途絶とは分ける**（赤くしない）。届くはずのものが止まったのではなく、最初から出ていない ——
   * 赤くすると常に「値が来ていない」と名乗り続け、警告が常態になる（2026-10-12 ユーザー承認）。
   * **震度が一度でも届いた観測点はここへ来ない**（震度が止まれば `'silent'`。#707 の判断）。
   */
  | { readonly kind: 'wave-only' }
  /**
   * **割り当ててあるのに、一度も何も届いていない**（{@link UNSEEN_GRACE_MS} を過ぎた）。途絶と同じく赤い行で出し、
   * 出どころの欄に「未着」と名乗る（2026-10-24 ユーザー選択「「未着」でよい (Recommended)」）。
   *
   * **表示名は識別子のままのことがある。** ホストの `/status` が名前を載せるのは実際に届いたセンサーの観測点だけで、
   * 割り当ての一覧（`assignedBoards`）は名前を持たない。
   */
  | { readonly kind: 'unseen' }

/** 下端の波形をどこから描いているか。 */
export type SeismoWaveSource =
  /** 観測点の合成波形（`station-wave`）。 */
  | 'station'
  /**
   * センサー単独の波形（`wave`）。**合成が止まった・届かない間だけ**、震度の帯と同じくいちばん強く振れているセンサーを
   * 描く（2026-10-22 選択「合成が止まったら単独へ落とす (Recommended)」、取り方は 2026-10-24 選択「止まった間だけ全部入りへ (Recommended)」）。
   */
  | 'sensor'

/** 観測点 1 つの、いまの姿。 */
export interface SeismoStationState {
  readonly stationId: string
  /** 引けた表示名。**引けていなければ識別子そのまま。** */
  readonly displayName: string
  /**
   * 観測点の緯度・経度（ホストの設定から引く）。**引けていない・ホストが持っていなければ `null`。**
   * 地図の下端の波形へ P/S の到達線を引くのに使う。
   */
  readonly lat: number | null
  readonly lon: number | null
  /**
   * 計測震度相当。**出せないなら `null`。**
   *
   * 「揺れていない」を意味する値ではないので 0 として扱わないこと
   * （ホスト側も同じ約束で `null` を返す）。
   */
  readonly intensity: number | null
  /**
   * 普段の計測震度（ホストの `/status` の `usualIntensities`）。**読めなければ `null`**
   * （→ `SeismoHostDirectory.usualMeasured`）。波形グラフを自動で出すかの物差し
   * （`utils/seismoWaveTrigger.ts`）。
   *
   * **観測点の合成の震度（`source.kind === 'station'`）にだけ付ける。** ホストは普段を観測点の合成波形から
   * 測るので、合成が届かない間の震度（センサーごとの最大）と比べると、統計の違うものを比べることになる。
   */
  readonly usualMeasured: number | null
  /** その値が代表する時刻（ホストの時計）。読めなければ `null`。 */
  readonly atMs: number | null
  readonly source: SeismoIntensitySource
  /** 抱えている波形のサンプル数（{@link waveSource} の側）。**0 なら波形は届いていない。** */
  readonly waveSampleCount: number
  /** 下端の波形をどこから描いているか（{@link SeismoStations.readLiveWave} が返す側）。 */
  readonly waveSource: SeismoWaveSource
  /**
   * 波形が届かなくなっているか（{@link WAVE_STALE_MS}）。
   *
   * **一度も届いていないうちは `false`** —— そちらは {@link waveSampleCount} が 0 で
   * 分かるし、購読を始めた直後と区別が付かない。ここが立つのは「届いていたのに
   * 途絶えた」場合だけ。
   *
   * **絵の側で必ず使うこと。** 抱えている中身は時間で薄れないので、これを見ないと
   * 止まった波形を「いま静かに揺れている」として描き続ける。
   */
  readonly waveStale: boolean
  /**
   * 波形を抱えている間に起きたことの数え上げ。**波形が届いていなければすべて 0。**
   *
   * **画面か記録へ出すために持つ。** 敵対的レビューが見つけた 2 つの不具合
   * （偽の隙間が数秒ごと・巻き戻り中にデータが全損）は**どちらもここでしか
   * 観測できなかった** —— 絵の上では「短くなった」「途切れた」としか見えない。
   * ホスト側が同じものを状態の口へ出している
   * （`seismo-host/src/admin/waveBuffer.ts` の `rewindCount` ほか）。
   */
  readonly waveTally: SeismoWaveTally
}

export interface SeismoStations {
  /** 震度か波形が届いている観測点（途絶えたものも含む）。**表示名の順。** */
  readonly stations: readonly SeismoStationState[]
  /** 繋がり具合。**無効・URL 不正のときは `null`**（URL 不正かどうかは {@link urlUnusable} で見分ける）。 */
  readonly stream: SeismoStreamState | null
  /**
   * 機能は入っているのに、URL が空か形が違うので繋ぎに行けない。
   *
   * **`stream` が `null` なのと見分けるために別に持つ。** `null` は「切っている」でも返るので、
   * それだけを見ると URL の誤りで繋がっていないことが地図から消える（2026-10-21 ユーザー選択
   * 「おすすめで」で、この場合も「地震計 未接続」を出すと決めた）。再生中は `enabled` が偽なので立たない。
   */
  readonly urlUnusable: boolean
  /**
   * この接続先で届いた、読めない押し出しの累計（設定の窓の自作地震計の行に出す。2026-10-22 選択「設定タブに出す
   * (Recommended)」。地図は 09-30 の決定どおり出さない）。**接続先が変わったら 0 へ戻す。**
   *
   * **1 件ごとには差し替えない。** 版が食い違っている間は毎秒 10 件とも読めないので、受けるたびに描き直すと
   * 障害が起きているときほど重くなる。観測点の姿の作り直し（{@link REBUILD_INTERVAL_MS}）と一緒に、変わったときだけ出す。
   * 理由は接続層が記録へ出す（`seismoStream.ts` の `noteUnreadable`）。
   */
  readonly unreadableCount: number
  /**
   * その観測点の波形を読む。**参照は安定**（毎レンダー変わらない）。
   *
   * **state に載せない。** 抱えている 180 秒ぶんで 288 KB あるので、毎秒の描き直しで
   * 写し取ると再描画の重さが波形の長さに引きずられる。読む頻度は描く側
   * （`requestAnimationFrame` で回すか、間引くか）が決める。`fromMs` より前は写さない（`null` なら抱えている全部）。
   */
  readonly readWave: (stationId: string, fromMs: number | null) => SeismoWaveWindow | null
  /**
   * 下端の波形が描く窓を読む。**合成が止まって単独を描いている間はそのセンサーの窓**、それ以外は {@link readWave} と同じ。
   *
   * **{@link readWave} と分ける。** 地震カードは合成の列を継ぎ足す（`hooks/useSeismoQuakeWaves.ts`）ので、そちらへ
   * 単独の値が混ざると、同じ絵の中で合成と単独が見分けられなくなる。参照は安定。
   */
  readonly readLiveWave: (stationId: string, fromMs: number | null) => SeismoWaveWindow | null
  /**
   * ホストが取り戻した区間の合成波形を作り直した知らせ（`station-wave-revised`・#597）を受け取る。
   * **戻り値を呼ぶと受け取りをやめる。参照は安定。**
   *
   * 下部の波形（{@link readWave} の中身）の穴はこの層が自分で埋める。これを使うのは、
   * 押し出しから作った列を別に持っている側（有感の地震カード・`hooks/useSeismoQuakeWaves.ts`）。
   */
  readonly subscribeWaveRevised: (listener: (revised: SeismoStationWaveRevised) => void) => () => void
}

export interface UseSeismoStationOptions {
  /** 設定の窓のトグル。**切れていれば繋がない。** */
  readonly enabled: boolean
  /** ホストの基点 URL（設定の窓の入力）。 */
  readonly baseUrl: string
  /**
   * 波形も要るか。**変えると繋ぎ直す。**
   *
   * 合成波形は毎秒 15 KB あるので、絵にしていない間は `'none'` にする
   * （切り替えは段 4 の担当）。
   */
  readonly wave: SeismoWaveWant
}

/** 帳面に積む 1 観測点ぶん。**state を作る材料。** */
export interface StationEntry {
  /** 合成（`station-reading`）の最新。 */
  station: { intensity: number | null; atMs: number | null; receivedAt: number } | null
  /** センサー単独（`reading`）の最新。**鍵は `boardKey/sensorId`。** */
  sensors: Map<string, { intensity: number | null; atMs: number | null; receivedAt: number }>
  wave: SeismoWaveBuffer | null
  /** 波形のまとまりを最後に受け取った時刻。**一度も受け取っていなければ `null`。** */
  waveReceivedAt: number | null
  /** センサー単独の波形（`?wave=all` の間だけ届く）。**鍵は `boardKey/sensorId`**（{@link sensors} と同じ）。 */
  sensorWaves: Map<string, { buffer: SeismoWaveBuffer; receivedAt: number }>
  /** 下端の波形に描いているセンサーの鍵。**合成を描いていれば `null`。** */
  liveSensorKey: string | null
  /** 全部入りを要求しても描ける単独の波形が来なかった（2 軸のセンサーだけ等）。**要求の理由から外す。** */
  sensorWaveUseless: boolean
  /**
   * 震度（合成・単独のどちらでも）を最後に受け取った時刻。
   * **一度も受け取っていなければ `null`。**
   *
   * **`station` と `sensors` の中身では代われない。** あちらは古くなった項目を落とすので
   * （{@link READING_STALE_MS}）、途絶えたあとは「一度も届いていない」と同じ姿になる。
   * **その 2 つを分けるためだけに持つ** —— 前者は行を残して赤く出し、後者は行を作らない。
   */
  readingReceivedAt: number | null
}

/** 空のときの参照を固定する。**毎回新しい配列を作ると再描画が 1 回増える。** */
const EMPTY_STATIONS: readonly SeismoStationState[] = []

/** 波形が 1 件も届いていない観測点の数え上げ。**参照を固定して比較を軽くする。** */
const EMPTY_TALLY: SeismoWaveTally = { gapSamples: 0, restarts: 0, droppedSamples: 0 }

/** 数え上げが同じかを見る。 */
function sameTally(a: SeismoWaveTally, b: SeismoWaveTally): boolean {
  return (
    a.gapSamples === b.gapSamples &&
    a.restarts === b.restarts &&
    a.droppedSamples === b.droppedSamples
  )
}

/** 2 つの姿が同じかを見る。**同じなら state を差し替えない。** */
export function sameStates(
  a: readonly SeismoStationState[],
  b: readonly SeismoStationState[],
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (
      x.stationId !== y.stationId ||
      x.displayName !== y.displayName ||
      x.lat !== y.lat ||
      x.lon !== y.lon ||
      x.intensity !== y.intensity ||
      x.usualMeasured !== y.usualMeasured ||
      x.atMs !== y.atMs ||
      x.source.kind !== y.source.kind ||
      x.waveSampleCount !== y.waveSampleCount ||
      x.waveSource !== y.waveSource ||
      x.waveStale !== y.waveStale ||
      !sameTally(x.waveTally, y.waveTally)
    ) {
      return false
    }
    if (
      x.source.kind === 'sensor' &&
      y.source.kind === 'sensor' &&
      x.source.sensorCount !== y.source.sensorCount
    ) {
      return false
    }
  }
  return true
}

/**
 * 自作地震計ホストの震度と波形を観測点ごとに持つ。
 *
 * **画面を離れたら購読を落とす。** 同時に繋いでいられるのは 8 本まで
 * （`seismo-host/src/receiver/readingHub.ts`）なので、握ったままにすると
 * 端末を増やしたときに自分で枠を食い潰す。
 */
export function useSeismoStation(options: UseSeismoStationOptions): SeismoStations {
  const { enabled, baseUrl, wave } = options
  const [stations, setStations] = useState<readonly SeismoStationState[]>(EMPTY_STATIONS)
  const [stream, setStream] = useState<SeismoStreamState | null>(null)
  const [unreadableCount, setUnreadableCount] = useState(0)
  /**
   * センサー単独の波形も要るか（合成の波形が止まった・届かない観測点がある間）。**変えると押し出しを繋ぎ直す。**
   * 決めるのは観測点の姿の作り直し（`rebuild`）で、戻すときは {@link SENSOR_WAVE_RETURN_HOLD_MS} 待つ。
   */
  const [needSensorWave, setNeedSensorWave] = useState(false)

  // **帳面は ref に持つ。** 押し出しは毎秒 10 件届くので、1 件ごとに state を
  // 差し替えると再描画がそのぶん増える（{@link REBUILD_INTERVAL_MS}）。
  const bookRef = useRef<Map<string, StationEntry>>(new Map())
  /** 押し出しの受け手。**帳面の効果が作り、繋ぎの効果が呼ぶ**（繋ぎ直しで帳面を捨てないため）。 */
  const onMessageRef = useRef<((message: SeismoMessage) => void) | null>(null)
  /** 読めない押し出しの累計（この接続先で）。state へは作り直しの巡回で写す。 */
  const unreadableRef = useRef(0)

  const readWave = useCallback((stationId: string, fromMs: number | null): SeismoWaveWindow | null => {
    return bookRef.current.get(stationId)?.wave?.snapshot(fromMs) ?? null
  }, [])

  const readLiveWave = useCallback((stationId: string, fromMs: number | null): SeismoWaveWindow | null => {
    const entry = bookRef.current.get(stationId)
    if (entry === undefined) return null
    if (entry.liveSensorKey !== null) {
      const sensor = entry.sensorWaves.get(entry.liveSensorKey)
      if (sensor !== undefined) return sensor.buffer.snapshot(fromMs)
    }
    return entry.wave?.snapshot(fromMs) ?? null
  }, [])

  // **繋ぎ直しをまたいで持つ。** 受け手（地震カード）は一度だけ登録し、繋ぎ直しのたびに登録し直さない。
  const revisedListenersRef = useRef(new Set<(revised: SeismoStationWaveRevised) => void>())
  const subscribeWaveRevised = useCallback(
    (listener: (revised: SeismoStationWaveRevised) => void): (() => void) => {
      const listeners = revisedListenersRef.current
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    [],
  )

  // **URL の形はここでも見る。** 形が違えば `fetch` が投げるだけだが、
  // 繋ぎ直しの輪が 1 秒ごとに同じ例外を繰り返すことになる。
  const canConnect = enabled && isValidSeismoHostUrl(baseUrl)
  // **波形の要求は設定（`wave`）が決め、合成が止まった間だけ単独まで広げる。** 設定が `'none'` なら広げない。
  const streamWave: SeismoWaveWant = wave === 'station' && needSensorWave ? 'all' : wave
  /** 帳面の効果から、設定の要求を読む（その効果の依存に入れると、設定を変えるたびに帳面ごと捨てる）。 */
  const waveRef = useRef(wave)
  waveRef.current = wave
  /** 押し出しが開いているか。**全部入りの探りの時計は、開いている間しか進めない**（下の `rebuild`）。 */
  const streamOpenRef = useRef(false)
  streamOpenRef.current = stream?.kind === 'open'

  // 帳面（観測点の姿・台帳・穴埋め）。**接続先が変わったときだけ作り直す** —— 要求の切り替え（合成 ↔ 全部入り）で
  // 繋ぎ直しても、抱えている波形と震度は捨てない。
  useEffect(() => {
    // **繋がない間は帳面ごと捨てる。** 残すと、URL を書き換えて繋ぎ直したときに
    // 前のホストの観測点が混ざる。
    bookRef.current = new Map()
    setStations(EMPTY_STATIONS)
    unreadableRef.current = 0
    setUnreadableCount(0)
    setNeedSensorWave(false)
    if (!canConnect) {
      onMessageRef.current = null
      return
    }

    const ctrl = new AbortController()
    const directory = new SeismoHostDirectory(baseUrl)
    // **繋ぐ前に 1 回引く。** 押し出しは識別子だけを名乗るので、これが済むまでは
    // 表示名が識別子のまま出て、センサー単独の震度はどの観測点にも寄せられない。
    //
    // `catch` を置かない。`refresh` は reject しない（理由は `SeismoHostDirectory.refresh` の注記）。
    void directory.refresh()

    const book = bookRef.current
    // **枠を用途ごとに分ける。** 1 つを共有すると、先に鳴った側が別種の障害の
    // 「初めて起きた 1 行」を隠す（接続層が同じ理由で分けている）。
    const throttledUnassigned = createLogThrottle(LOG_THROTTLE_MS)
    const throttledRebuildError = createLogThrottle(LOG_THROTTLE_MS)
    const throttledSensorWave = createLogThrottle(LOG_THROTTLE_MS)

    // **波形の作り直しは観測点ごとに枠を持つ。** 1 つを共有すると、ホストの
    // 再起動や時刻の補正で**複数の観測点が同時に作り直されたとき、最初の 1 件しか
    // 残らない**（他は間引きの間ずっと隠れる）。用途で分ける規約を、観測点の
    // 単位まで下ろした形。
    const waveRestartLogs = new Map<string, ReturnType<typeof createLogThrottle>>()
    const throttledWaveRestart = (stationId: string, emit: () => void): void => {
      let gate = waveRestartLogs.get(stationId)
      if (gate === undefined) {
        gate = createLogThrottle(LOG_THROTTLE_MS)
        waveRestartLogs.set(stationId, gate)
      }
      gate(emit)
    }

    // **震度の途絶も観測点ごとの枠にする。** 理由は波形の作り直しと同じ ——
    // ホストが落ちれば全観測点が同時に途絶えるので、1 つの枠では最初の 1 件しか残らない。
    const silentReadingLogs = new Map<string, ReturnType<typeof createLogThrottle>>()
    const throttledSilentReading = (stationId: string, emit: () => void): void => {
      let gate = silentReadingLogs.get(stationId)
      if (gate === undefined) {
        gate = createLogThrottle(LOG_THROTTLE_MS)
        silentReadingLogs.set(stationId, gate)
      }
      gate(emit)
    }

    // **取り戻した区間で下部の波形の穴を埋める**（#597）。繋ぎを切ったら取得ごと打ち切る。
    const throttledRevisedListener = createLogThrottle(LOG_THROTTLE_MS)
    const refiller = new SeismoWaveRefiller({
      bufferOf: (stationId) => book.get(stationId)?.wave ?? null,
      fetchSamples: ({ stationId, fromMs, toMs }) =>
        fetchSeismoWaveSamples({ baseUrl, stationId, fromMs, toMs, signal: ctrl.signal }),
      signal: ctrl.signal,
      delayMs: WAVE_REFILL_DELAY_MS,
      onFilled: (stationId, { filled, prepended, fromMs, toMs, chunks }) => {
        // **埋まらなかったことも残す。** 取りに行ったのに 0 なら、ホストがまだ作り直した分を
        // 読めていないか、時刻が合っていない —— 画面からは「埋まらない」としか見えない。
        // 取った範囲とまとまりの数を添えるのは、「控えに無かった（0 件）」と「あったが合わなかった」を見分けるため。
        if (filled > 0) log.info(`[seismo] ホストの控えから下部の波形の穴を埋めた（${stationId}）: ${filled} サンプル`)
        if (prepended > 0) log.info(`[seismo] ホストの控えから下部の波形の手前を継ぎ足した（${stationId}）: ${prepended} サンプル`)
        if (filled === 0 && prepended === 0) {
          log.debug(
            `[seismo] ホストの控えを取ったが、下部の波形は埋まらなかった（${stationId}）: ` +
              `${new Date(fromMs).toISOString()}〜${new Date(toMs).toISOString()}・${chunks} まとまり`,
          )
        }
      },
      // **どれも正常に起きうる**（知らせが波形より先に届いた・取る物が無い・取っている間に作り直した）ので debug に留める。
      onSkipped: (stationId, reason) =>
        log.debug(`[seismo] 下部の波形の穴埋めを見送った（${stationId}）: ${SKIP_REASON_TEXT[reason]}`),
      onError: (stationId, error) =>
        throttledRevisedListener(() => log.error(`[seismo] 下部の波形の穴を埋める途中で投げた（${stationId}）`, error)),
      // **諦めたことは必ず残す**（画面からは「埋まらない」としか見えない）。取り直す番は debug で。
      onFailed: (stationId, failures, retryInMs) =>
        failures === 0
          ? log.warn(`[seismo] 下部の波形の穴を取りに行く範囲が通らなかったので、取り直さない（${stationId}）`)
          : retryInMs === null
          ? log.warn(`[seismo] 下部の波形の穴を ${failures} 回続けて取れず、取り直しを諦めた（${stationId}）`)
          : log.debug(`[seismo] 下部の波形の穴を取れなかった（${stationId}・${failures} 回目）: ${Math.round(retryInMs / 1000)} 秒後に取り直す`),
    })

    /** その観測点の項目。**無ければ作る。** */
    const entryFor = (stationId: string): StationEntry => {
      const found = book.get(stationId)
      if (found !== undefined) return found
      const created: StationEntry = {
        station: null,
        sensors: new Map(),
        wave: null,
        waveReceivedAt: null,
        sensorWaves: new Map(),
        liveSensorKey: null,
        sensorWaveUseless: false,
        readingReceivedAt: null,
      }
      book.set(stationId, created)
      return created
    }

    onMessageRef.current = (message: SeismoMessage): void => {
      // **経過時間は `performance.now()` で測る**（{@link READING_STALE_MS}）。
      // 端末の壁時計を使うと、スリープからの復帰や時刻補正で跳ねたときに
      // 届いている値がまとめて「古い」へ倒れる。ホストが言う `atMs` も
      // 使わない —— あちらはホストの時計で、こちらとのずれを測る術が無い。
      const receivedAt = performance.now()
      // **普段の計測震度は、震度が届いている間 10 分おきに読み直す**（ホストが測り直す間隔）。
      // 叩く頻度は台帳の下限が担うので、毎回呼んでよい。
      directory.requireUsual()
      switch (message.kind) {
        case 'station-reading': {
          const { stationId, intensity, atMs } = message.reading
          directory.require(stationId)
          const entry = entryFor(stationId)
          entry.station = { intensity, atMs, receivedAt }
          // **届いたことを別に覚える**（`readingReceivedAt` の説明を見ること）。
          // `station` は古くなれば落とすので、これが無いと「途絶えた」と
          // 「一度も届いていない」が同じ姿になる。
          entry.readingReceivedAt = receivedAt
          return
        }
        case 'reading': {
          const { boardKey, sensorId, intensity, atMs } = message.reading
          directory.requireBoard(boardKey)
          const stationId = directory.stationIdForBoard(boardKey)
          // **観測点へ寄せられないセンサーは持たない。** 画面に出せるのは
          // 観測点の単位までで、`mac:020000000003` を利用者へ見せる意味が無い。
          //
          // **捨てたことは記録へ残す。** ここが無音だと、台帳を引けていない間
          // （＝合成が出ない観測点では震度が 1 件も出ない間）に**画面からは
          // 「揺れていない」と同じに見える** —— この機能でいちばん避けたい形。
          // 次の取り直しで寄せられるようになるが、それが来ない場合の手掛かりが
          // ここにしか無い。
          if (stationId === null) {
            throttledUnassigned(() =>
              log.warn(
                `[seismo] どの観測点にも寄せられないセンサーの震度を捨てた（${boardKey}）。` +
                  '台帳をまだ引けていないか、ホスト側で観測点へ割り当てられていない',
              ),
            )
            return
          }
          const entry = entryFor(stationId)
          entry.sensors.set(`${boardKey}/${sensorId}`, { intensity, atMs, receivedAt })
          // 合成と同じ扱い —— **どちらで届いても「震度が来た」に数える**。
          // 合成が組めない観測点（有効なセンサーが 2 台未満）ではこちらしか来ない。
          entry.readingReceivedAt = receivedAt
          return
        }
        case 'sensor-wave': {
          const w = message.wave
          const stationId = directory.stationIdForBoard(w.boardKey)
          // 震度と同じく、観測点へ寄せられないセンサーは持たない（記録は震度の側が残す）。**帳面の項目も作らない** ——
          // 震度より先に単独の波形だけが届いた観測点に項目を作ると、震度も合成も「一度も届いていない」のに項目があるので、
          // 未着にも途絶にもならず行が出ない。震度が届けば項目はそちらで作られる。
          if (stationId === null) return
          const entry = book.get(stationId)
          if (entry === undefined) return
          const key = `${w.boardKey}/${w.sensorId}`
          let found = entry.sensorWaves.get(key)
          if (found === undefined) {
            found = { buffer: new SeismoWaveBuffer(WAVE_RETAIN_SEC), receivedAt }
            entry.sensorWaves.set(key, found)
          }
          found.receivedAt = receivedAt
          // 1 台ぶんなので、効いた本数はどのサンプルも 1。
          const result = found.buffer.push({ ...w, memberCount: w.gal[0].map(() => 1) })
          if (result.kind === 'restarted') {
            throttledSensorWave(() => log.debug(`[seismo] センサー単独の波形を作り直した（${key}）: ${result.why}`))
          }
          return
        }
        case 'station-wave': {
          const w = message.wave
          directory.require(w.stationId)
          const entry = entryFor(w.stationId)
          entry.wave ??= new SeismoWaveBuffer(WAVE_RETAIN_SEC)
          // **届いたことを生存の印にする。中身が使えたかは問わない**（接続層の
          // 停滞検出と同じ扱い）。重なりで捨てた場合も押し出しは生きているので、
          // ここで更新しないと正常な取り直しが「途絶えた」に見える。
          entry.waveReceivedAt = receivedAt
          const previousLastMs = entry.wave.lastSampleMs
          const result = entry.wave.push(w)
          // **作り直したことは記録へ出す。** 起点が引き直されたのは時刻が飛んだ
          // 印で、絵の上では「急に短くなった」としか見えない。
          if (result.kind === 'restarted') {
            throttledWaveRestart(w.stationId, () =>
              log.warn(`[seismo] 波形を作り直した（${w.stationId}）: ${result.why}`),
            )
            // **手前の空きをホストの控えから継ぎ足す**（2026-10-07 ユーザー依頼）。起動直後も、
            // 届いたところから描き始めず、抱える長さぶん遡った絵にする。
            refiller.schedule(w.stationId, { fromMs: Number.NEGATIVE_INFINITY, toMs: w.firstSampleMs })
          } else if (result.kind === 'gap' && previousLastMs !== null) {
            // **こちらで見つけた穴も取りに行く**（2026-10-07 ユーザー承認）。繋ぎ直しの間や、押し出しが
            // 遅い受け手のぶんを捨てた間は、ホストは受け取れているので作り直しの知らせが来ない。
            // `previousLastMs !== null` は型を絞るためだけ（`gap` は抱えているときにしか返らない）。
            refiller.schedule(w.stationId, { fromMs: previousLastMs, toMs: w.firstSampleMs })
          }
          return
        }
        case 'station-wave-revised': {
          refiller.notice(message.revised)
          // **受け手の 1 つが投げても、他の受け手と下部の波形には響かせない。**
          for (const listener of revisedListenersRef.current) {
            try {
              listener(message.revised)
            } catch (error) {
              throttledRevisedListener(() =>
                log.error('[seismo] 作り直しの知らせの受け手が投げた', error),
              )
            }
          }
          return
        }
      }
    }

    /** 単独へ落ちる理由が最後にあった時刻。**`null` なら理由が無い**（要求を戻す待ちの起点）。 */
    let sensorWaveNeededAt: number | null = null
    /** 全部入りを要求し始めた時刻。**要求していなければ `null`**（描ける単独の波形が来ない観測点を見分ける起点）。 */
    let sensorWaveSince: number | null = null

    /** 作り直し 1 巡ぶん。帳面から姿を作り、変わっていれば差し替える。 */
    const rebuild = (): void => {
      const now = performance.now()
      // **繋がっていない間は探りの起点を進めない**（今から数え直す）。繋ぎ直しが 30 秒を超えると、描けるセンサーを持つ
      // 観測点まで「描けない」と見なして全部入りの理由から外し、合成が戻るまで単独の波形を二度と要求しない。
      if (sensorWaveSince !== null && !streamOpenRef.current) sensorWaveSince = now
      const { states, sensorWaveNeeded } = buildStationStates(book, directory, now, sensorWaveSince, {
        onSilent: (stationId, readingNever, forMs) =>
          // **どれだけ途絶えているかは記録にしか出ない**（画面は色だけで長さを語らない）。
          // 瞬断と本物の途絶を事後に分ける手掛かりがここにしか無いので、観測点ごとに間引いて残す。
          throttledSilentReading(stationId, () =>
            log.warn(
              readingNever
                ? `[seismo] 波形だけ届いていた観測点の波形が途絶えた（${stationId}）: ` +
                    `${Math.round(forMs / 1000)} 秒前から届いていない（震度は一度も届いていない）`
                : `[seismo] 観測点の震度が途絶えた（${stationId}）: ${Math.round(forMs / 1000)} 秒前から届いていない`,
            ),
          ),
        onSensorWaveUseless: (stationId) =>
          log.warn(
            `[seismo] センサー単独の波形を受けても描けるもの（3 軸のセンサー）が届かない（${stationId}）。` +
              'この観測点のために全部入りを受けるのをやめる',
          ),
      })
      setStations((prev) => (sameStates(prev, states) ? prev : states))
      setUnreadableCount(unreadableRef.current)

      // **単独の波形の要求は、理由が消えてから {@link SENSOR_WAVE_RETURN_HOLD_MS} 待って戻す。**
      // 設定が合成だけを求めているときに限る（`'none'` なら広げない）。
      if (waveRef.current === 'station' && sensorWaveNeeded) sensorWaveNeededAt = now
      const need = sensorWaveNeededAt !== null && now - sensorWaveNeededAt < SENSOR_WAVE_RETURN_HOLD_MS
      if (!need) sensorWaveNeededAt = null
      // 記録は更新関数の外で出す（更新関数は開発時に 2 回呼ばれるので、中で出すと記録が重なる）。
      if (need !== (sensorWaveSince !== null)) {
        log.info(
          need
            ? '[seismo] 観測点の合成波形が止まっているので、センサー単独の波形も受け取る（?wave=all）'
            : '[seismo] 観測点の合成波形が戻ったので、センサー単独の波形の受け取りをやめる',
        )
        sensorWaveSince = need ? now : null
      }
      setNeedSensorWave(need)
    }

    // **投げても飲み込む。** ここが例外で抜けると、そのひと巡ぶんの「古い震度を
    // 落とす」「単独へ落ちる」が止まる —— この層の主目的そのもの。
    // `setInterval` は次の巡回を続けるので止まり続けはしないが、**`[seismo]` の
    // 記録には何も残らない**（押し出しの受け手が `callSafely` で守られているのと
    // 同じ扱いへ揃える）。
    const timer = setInterval(() => {
      try {
        rebuild()
      } catch (error) {
        throttledRebuildError(() => log.error('[seismo] 観測点の姿の作り直しが投げた', error))
      }
    }, REBUILD_INTERVAL_MS)

    return () => {
      clearInterval(timer)
      onMessageRef.current = null
      // 穴埋めの取得と待っている予約を打ち切る。
      ctrl.abort()
    }
  }, [canConnect, baseUrl])

  // 押し出しの繋ぎ。**要求（合成 ↔ 全部入り）が変わったら繋ぎ直す**が、帳面は上の効果が持ち続ける。
  useEffect(() => {
    if (!canConnect) {
      setStream(null)
      return
    }
    const ctrl = new AbortController()
    const handle = connectSeismoStream({
      baseUrl,
      wave: streamWave,
      signal: ctrl.signal,
      onMessage: (message) => onMessageRef.current?.(message),
      onState: setStream,
      // 累計は接続先ごとに数える（接続層の数は繋ぎ直しのたびに 0 から数え直すので使わない）。
      onUnreadable: () => {
        unreadableRef.current += 1
      },
    })
    return () => {
      // **`signal` を落としてから閉じる。** どちらか一方でも購読は畳まれるが、
      // 揃えておくと「閉じたのに枠が空かない」形を作らない。
      ctrl.abort()
      handle.close()
    }
  }, [canConnect, baseUrl, streamWave])

  const urlUnusable = enabled && !canConnect
  return useMemo(
    () => ({ stations, stream, urlUnusable, unreadableCount, readWave, readLiveWave, subscribeWaveRevised }),
    [stations, stream, urlUnusable, unreadableCount, readWave, readLiveWave, subscribeWaveRevised],
  )
}

/** {@link buildStationStates} が知らせる記録の口。 */
interface BuildStationStatesHooks {
  /** 一度は届いていた観測点が途絶えた（`readingNever` は震度が一度も届いていない＝波形だけの観測点）。 */
  readonly onSilent: (stationId: string, readingNever: boolean, forMs: number) => void
  /** 全部入りを要求しても描ける単独の波形が来ない観測点を、要求の理由から外した。 */
  readonly onSensorWaveUseless: (stationId: string) => void
}

/**
 * 下端の波形に描くセンサーを選ぶ。**合成の波形が流れていれば `null`**（合成を描く）。
 *
 * 選ぶのは、届いているセンサーのうち**震度がいちばん大きいもの**（帯の「単独 N本の最大」と同じ相手）。
 * どれも震度が無ければ前に選んでいたもの、それも無ければ最初に見つかったもの。
 */
export function pickLiveSensor(
  sensorWaves: ReadonlyMap<string, { readonly receivedAt: number }>,
  sensors: ReadonlyMap<string, { readonly intensity: number | null }>,
  previous: string | null,
  now: number,
  compositeFlowing: boolean,
): string | null {
  if (compositeFlowing) return null
  let best: string | null = null
  let bestIntensity = Number.NEGATIVE_INFINITY
  let first: string | null = null
  let previousFresh = false
  for (const [key, w] of sensorWaves) {
    if (now - w.receivedAt >= WAVE_STALE_MS) continue
    first ??= key
    if (key === previous) previousFresh = true
    const intensity = sensors.get(key)?.intensity ?? null
    if (intensity !== null && intensity > bestIntensity) {
      best = key
      bestIntensity = intensity
    }
  }
  // **前に選んだセンサーに粘る**（{@link LIVE_SENSOR_SWITCH_MARGIN} 以上上回る相手が出るまで乗り換えない）。静穏時は
  // センサーどうしの震度がほぼ同じ値で入れ替わるので、粘らないと 0.5 秒ごとに別のセンサーの線へ切り替わる。
  if (previousFresh && previous !== null) {
    if (best === null) return previous
    const prevIntensity = sensors.get(previous)?.intensity ?? null
    if (prevIntensity !== null && bestIntensity < prevIntensity + LIVE_SENSOR_SWITCH_MARGIN) return previous
  }
  return best ?? first
}

/** 単独の線を別のセンサーへ乗り換えるのに要る震度の差（計測震度）。 */
export const LIVE_SENSOR_SWITCH_MARGIN = 0.3

/**
 * 帳面から観測点の姿を作る（{@link useSeismoStation} の作り直し 1 巡ぶん）。**帳面の古い項目はここで落とす。**
 *
 * 戻り値の `sensorWaveNeeded` は、合成の波形が止まった・無いのに震度は届いている観測点があるか
 * （センサー単独の波形を要求する理由）。
 */
export function buildStationStates(
  book: Map<string, StationEntry>,
  directory: Pick<SeismoHostDirectory, 'displayName' | 'location' | 'usualMeasured' | 'assignedStations'>,
  now: number,
  /** 全部入り（`?wave=all`）を要求し始めた時刻。**要求していなければ `null`。** */
  sensorWaveSince: number | null,
  hooks: BuildStationStatesHooks,
): { readonly states: SeismoStationState[]; readonly sensorWaveNeeded: boolean } {
  const next: SeismoStationState[] = []
  let sensorWaveNeeded = false
  for (const [stationId, entry] of book) {
    // **届かなくなったセンサー単独の入れ物は捨てる**（合成へ戻った後に抱え続けない）。
    for (const [key, w] of entry.sensorWaves) {
      if (now - w.receivedAt >= SENSOR_WAVE_DROP_MS) entry.sensorWaves.delete(key)
    }
    // **一度も届いていないうちは立てない。** 購読を始めた直後と区別が付かない。
    // **判定は `utils/seismoSilence.ts` の 1 箇所へ寄せてある** —— 震度・波形・
    // 有感カードの波形で同じ述語を使う（別々に書くと後から食い違う）。
    const compositeWave = judgeSilence({ lastReceivedAt: entry.waveReceivedAt, now, staleMs: WAVE_STALE_MS })
    const readingsFlowing =
      judgeSilence({ lastReceivedAt: entry.readingReceivedAt, now, staleMs: READING_STALE_MS }).kind === 'flowing'
    // **合成の波形が止まった・無いのに震度は届いている観測点がある間は、単独の波形も要る**（S10）。
    // 震度が届いていない観測点は、センサーも黙っているので要求しても描けない。
    //
    // **全部入りを要求しても描ける単独の波形が {@link SENSOR_WAVE_PROBE_MS} 来ない観測点は、理由から外す**（2 軸のセンサー
    // だけの観測点は `gal: null` で届き、描けない）。外さないと、毎秒約 65 KB を受け続けても何も描けない。合成が戻るか
    // 震度が止まれば数え直す。
    const wantsSensorWave = compositeWave.kind !== 'flowing' && readingsFlowing
    const hasFreshSensorWave = [...entry.sensorWaves.values()].some((w) => now - w.receivedAt < WAVE_STALE_MS)
    if (!wantsSensorWave || hasFreshSensorWave) entry.sensorWaveUseless = false
    else if (sensorWaveSince !== null && now - sensorWaveSince >= SENSOR_WAVE_PROBE_MS && !entry.sensorWaveUseless) {
      entry.sensorWaveUseless = true
      hooks.onSensorWaveUseless(stationId)
    }
    if (wantsSensorWave && !entry.sensorWaveUseless) sensorWaveNeeded = true
    entry.liveSensorKey = pickLiveSensor(
      entry.sensorWaves,
      entry.sensors,
      entry.liveSensorKey,
      now,
      compositeWave.kind === 'flowing',
    )
    const liveSensor = entry.liveSensorKey === null ? undefined : entry.sensorWaves.get(entry.liveSensorKey)
    const waveSource: SeismoWaveSource = liveSensor === undefined ? 'station' : 'sensor'
    const waveSampleCount = liveSensor?.buffer.sampleCount ?? entry.wave?.sampleCount ?? 0
    const waveTally = liveSensor?.buffer.tally ?? entry.wave?.tally ?? EMPTY_TALLY
    // **単独を描いている間は「途絶」と名乗らない**（線は流れている。合成が止まったことは見出しが言う）。
    const waveStale = liveSensor === undefined && compositeWave.kind === 'silent'
    const waveParts = { waveSampleCount, waveSource, waveStale, waveTally }
    const located = { displayName: directory.displayName(stationId), ...directory.location(stationId) }

    // **合成が古くなく、値を持っていればそれを採る。** 単独へ落ちるのは、合成が
    // 一度も届いていないか、届かなくなったとき、**または合成の震度が空のとき**
    // （2026-10-22 選択「空なら単独へ落とす (Recommended)」。古いときと揃える）。
    //
    // **判定は同じ述語へ通す**（→ `utils/seismoSilence.ts`）。境目を直に書くと、
    // 同じ「届かなくなった」に判定が 2 つできて、片方だけ動かしたときに
    // 静かに食い違う（`flowing` は「一度は届いていて、まだ新しい」だけ）。
    const station = entry.station
    const fresh =
      station !== null &&
      judgeSilence({ lastReceivedAt: station.receivedAt, now, staleMs: READING_STALE_MS }).kind === 'flowing'
    const stationRow = (s: NonNullable<StationEntry['station']>): SeismoStationState => ({
      stationId,
      ...located,
      usualMeasured: directory.usualMeasured(stationId),
      intensity: s.intensity,
      atMs: s.atMs,
      source: { kind: 'station' },
      ...waveParts,
    })
    if (fresh && station.intensity !== null) {
      next.push(stationRow(station))
      continue
    }

    // **単独は最大値を採る。** 同じ観測点の複数センサーのうち、いちばん強く
    // 振れたものがそこで観測された揺れ（合成が組めない＝裏付けが無い状態なので、
    // 平均や中央で薄める根拠が無い）。**何本から採ったかを添える**ので、
    // 裏付けの有無は受け取る側が示せる。
    let best: number | null = null
    let bestAtMs: number | null = null
    let count = 0
    for (const [key, r] of entry.sensors) {
      // **古い項目はここで落とす。** 残すと、止まったセンサーの値が
      // 「いまの震度」として最大値の選抜に残り続ける。
      if (now - r.receivedAt >= READING_STALE_MS) {
        entry.sensors.delete(key)
        continue
      }
      count += 1
      if (r.intensity !== null && (best === null || r.intensity > best)) {
        best = r.intensity
        bestAtMs = r.atMs
      }
    }
    // **合成は新しいが値が空で、単独にも値が無い**なら、合成の行のまま出す（震度は「—」）。
    // 単独へ落とすのは「単独に値があるとき」だけ —— 値の無い単独へ落とすと「合成」が「単独」に
    // 名乗り替わるだけで、何も良くならない。
    if (fresh && best === null) {
      next.push(stationRow(station))
      continue
    }
    if (count === 0) {
      // **ここは 3 つの意味を持つので、必ず分ける。**
      //
      //   - **震度も波形も一度も届いていない** → 並べない。「震度不明の行」は作らない。
      //     **購読を始めた直後も必ずここを通る**（割り当ててあれば、猶予の後に下の「未着」が拾う）
      //   - **震度は一度も届いていないが、波形は届いている** → `'wave-only'` で並べる
      //     （3 方向のうち解けない向きがある観測点。2026-10-12 ユーザー承認）。波形も
      //     止まれば下の途絶へ合流する
      //   - **届いていたのに途絶えた** → **残す。** 消すと「揺れていない」と
      //     見分けが付かなくなる（→ `SeismoIntensitySource` の `'silent'`）
      //
      // **帳面からは消さない** —— 波形の入れ物を捨てると、震度が戻ったときに
      // 絵が抱えている長さぶん巻き戻る。
      const readingSilence = judgeSilence({ lastReceivedAt: entry.readingReceivedAt, now, staleMs: READING_STALE_MS })
      // **震度が一度も届いていなければ、波形で決める。** 震度が一度でも届いた観測点は
      // 波形が流れていても途絶として扱う（震度が止まったこと自体が知らせるべき事実・#707）。
      const silence = readingSilence.kind === 'never' ? compositeWave : readingSilence
      // 普段はホストが観測点の合成波形から測った値なので、合成でない震度とは比べない（以下の行はどれも `null`）。
      if (readingSilence.kind === 'never' && silence.kind === 'flowing') {
        next.push({ stationId, ...located, usualMeasured: null, intensity: null, atMs: null, source: { kind: 'wave-only' }, ...waveParts })
        continue
      }
      if (silence.kind !== 'silent') continue
      hooks.onSilent(stationId, readingSilence.kind === 'never', silence.forMs)
      next.push({ stationId, ...located, usualMeasured: null, intensity: null, atMs: null, source: { kind: 'silent' }, ...waveParts })
      continue
    }
    next.push({
      stationId,
      ...located,
      usualMeasured: null,
      intensity: best,
      atMs: bestAtMs,
      source: { kind: 'sensor', sensorCount: count },
      ...waveParts,
    })
  }
  // **割り当ててあるのに何も届かない観測点を「未着」で並べる**（S1）。帳面に項目があるものは
  // 何かが一度は届いているので、上の判定（途絶・波形のみ）に任せる。
  for (const { stationId, sinceMs } of directory.assignedStations()) {
    if (book.has(stationId) || now - sinceMs < UNSEEN_GRACE_MS) continue
    next.push({
      stationId,
      displayName: directory.displayName(stationId),
      ...directory.location(stationId),
      usualMeasured: null,
      intensity: null,
      atMs: null,
      source: { kind: 'unseen' },
      waveSampleCount: 0,
      waveSource: 'station',
      waveStale: false,
      waveTally: EMPTY_TALLY,
    })
  }
  // **並びを固定する。** 帳面の順（初めて届いた順）で出すと、ホストを
  // 繋ぎ直すたびに行が入れ替わる。
  next.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'))
  return { states: next, sensorWaveNeeded }
}
