// 稼働状況タブ（`GET /status` の可視化）。**宛先は運用者**——`/status` 自体の
// 位置づけは `seismo-host/README.md`「状態と押し出しの口」を見ること。
//
// **`/status` は認証を持たない読み取り専用の口。** この画面は `/api/*` と違い
// トークンなしでも表示できる（fetch 自体はトークンを付けない）。
//
// **`boardKey`・`sensorId` は無認証の UDP パケット由来で、文字種検証を持たない
// （`stationConfig.ts` の `nonEmptyString` は空文字でないことしか見ない）。**
// `stationConfigWarning`・`ungroupedMultiBoardStations` も運用者が入力した
// 生の値をそのまま含みうる。**このファイルで組み立てる HTML へ差し込む値は
// 例外なく `escapeHtml` を通すこと** —— 通し忘れると、トークンを持たない
// 攻撃者が UDP パケット 1 個で管理コンソールのトークンを盗めるストアド XSS になる
// （#313 段 C 敵対的レビューで検出）。

import { ago, boardLabelHtml, escapeHtml, isStale, qs, receptionBadgeHtml } from './dom'
import { describeSilence } from '../receiver/assignedReception'
import { warnableClockOffset } from '../receiver/boardClockVerdict'
import type { BoardClockOffset } from '../receiver/boardClockVerdict'
import { readFinite, readNonEmptyString } from './readJson'
import { storageWarningList, type StorageBriefView } from './storageText'
import {
  listWarning,
  plainDetail,
  singleWarning,
  warningItem,
  type StatusWarning,
  type WarningItem,
} from './statusWarnings'
import type { TabContext } from './tabState'
import { apiFetch } from './api'
import { confirmDialog } from './confirmDialog'
import {
  HOST_RESTART_BUTTON_LABEL,
  HOST_RESTART_CONFIRM,
  hostRestartAcceptedLine,
  hostRestartFailureLine,
  type OperationLine,
} from './adminOperations'

/**
 * `GET /status` の形。**`statusReport.ts` の `StatusReport` を丸ごと再定義しない。**
 * ここで使う欄だけを持つ最小限の形にする——`StatusReport` は Node 専用の型
 * （`SegmentState` 等）を経由して定義されており、admin 側のプロジェクト
 * （DOM 型・ブラウザ向け）へ Node 型を持ち込むと衝突する。
 *
 * **欄が増減したら手で追随させる必要がある。** 自動では検知できない
 * （型検査は「この型が JSON と一致するか」までは見ない）。
 */
/**
 * 同じ起動のあいだに「ホストが起動した時刻」（`generatedAtMs − uptimeSec`）が揺れる幅の上限。
 * `uptimeSec` は秒へ切り捨てるので揺れは 1 秒未満。余裕を見て 2 秒。
 */
const HOST_START_JITTER_MS = 2000

export interface StatusReportView {
  readonly generatedAtMs: number
  readonly uptimeSec: number
  readonly sensors: readonly {
    readonly boardKey: string
    readonly sensorId: string
    readonly lastPacketMs: number | null
    readonly lastIntensity: number | null
    /** 震度そのものを出せない理由。出せているなら null（#373 で読むようになった）。 */
    readonly lastSkipReason: string | null
    /** 最後に受け取ったパケットの軸の本数。まだ受け取っていなければ null。 */
    readonly axisCount: number | null
    /**
     * 設定の軸の本数と届いた本数が違い、値を捨てているならその 2 つ（`receiver/sensorHealth.ts`）。
     * **版の古いホストには欄が無い**ので、無ければ食い違っていないと読む。
     */
    readonly axisMismatch?: { readonly configuredAxes: number; readonly receivedAxes: number } | null
    readonly enabled: boolean
    readonly calibrationConfigured: boolean
    readonly station: { readonly displayName: string } | null
    /** 基板の表示名。**版の古いホストには欄が無い**ので、無ければ名前なしと読む。 */
    readonly boardName?: string | null
  }[]
  readonly stationIntensities: readonly {
    readonly stationId: string
    readonly lastPacketMs: number | null
    readonly lastIntensity: number | null
    /**
     * 最後に震度が出た時刻（ホストの時計）。まだ出ていなければ null。
     * **震度の欄の古さはこれで測る**（`stationIntensityStale`）。
     */
    readonly lastReadingReceivedMs: number | null
    /** 合成の計測震度を出せない理由。出せているなら null（同上）。 */
    readonly lastSkipReason: string | null
    /** 最後に合成したまとまりで実際に混ざった本数（#315）。 */
    readonly lastMemberCountMin: number | null
    readonly lastMemberCountMax: number | null
    /** センサー対ごとの差分の強さ（#315）。 */
    readonly pairDiffs: readonly {
      readonly a: { readonly boardKey: string; readonly sensorId: string }
      readonly b: { readonly boardKey: string; readonly sensorId: string }
      readonly rmsGal: readonly (number | null)[]
      readonly sampleCount: readonly number[]
    }[]
    /**
     * センサーごとのずれの強さ（#688）。**版の古いホストは持たない**ので、読むときは配列かを確かめる
     * （{@link worstResidual}）。
     */
    readonly residuals?: readonly {
      readonly member: { readonly boardKey: string; readonly sensorId: string }
      readonly channels: readonly string[]
      readonly axes: readonly { readonly rmsGal: number | null }[]
    }[]
  }[]
  /**
   * 基板 1 枚ぶんの計測震度相当（`receiver/boardIntensity.ts`）。**設定の基板の並びのまま。**
   * **版の古いホストは返さない**ので、読む側で配列であることを確かめる（{@link boardIntensitiesOf}）。
   */
  readonly boardIntensities?: readonly BoardIntensityView[]
  /**
   * 保存先の容量と複製（`receiver/storageControl.ts` の `StorageBrief`）。
   * **版の古いホストは返さない**ので、読む側で有無を確かめる。
   */
  readonly storage?: StorageBriefView
  /** 生データ（miniSEED）の記録の健全性（`receiver/mseedRecorder.ts` の `MseedHealth` のうち画面に出す欄）。 */
  readonly mseed: {
    readonly writeErrors: number
    readonly lostRecords: number
    readonly recordsWritten: number
    readonly unreadableWritten: number
    readonly lastWriteError: string | null
    readonly lastInternalError: string | null
  }
  readonly stationConfigWarning: string | null
  readonly ungroupedMultiBoardStations: readonly string[]
  /**
   * 観測点に割り当てた基板ごとの様子（`receiver/assignedReception.ts`）。
   * **古いホストは返さない**ので、読む側で配列であることを確かめる（`assignedBoardsOf`）。
   */
  readonly assignedBoards?: readonly AssignedBoardView[]
  /**
   * 基板ごとの時計のずれ（`receiver/boardClock.ts`）。
   * **古いホストは返さない**ので、読む側で配列であることを確かめる（`boardClocksOf`）。
   */
  readonly boardClocks?: { readonly boards: readonly BoardClockOffset[] }
  /**
   * ホスト自身の時計（`receiver/hostClock.ts`）。読むのは警告に要る 2 つだけ。
   * **古いホストは返さない**ので、読む側で形を確かめる（`hostClockWarningList`）。
   */
  readonly hostClock?: { readonly source?: unknown; readonly consecutiveFailures?: unknown }
}

/**
 * ホストの時計を合わせられていないことを伝える警告（2026-10-27 ユーザー承認「足す」）。
 *
 * **出すのは、合わせられていない（`source` が `os`）うえに直近の問い合わせが失敗しているとき。**
 * 起動直後のまだ訊いていない間は出さない。基板の時計の警告（`boardClockWarnings`）は
 * ホストの時計を物差しにするので、この行が出ている間は全基板が同じだけずれて見えうる。
 */
export function hostClockWarnings(hostClock: StatusReportView['hostClock']): readonly string[] {
  return hostClockWarningList(hostClock).map((w) => w.html)
}

/** {@link hostClockWarnings} の組の形（通知の見張りが出入りを見るのに使う）。 */
export function hostClockWarningList(hostClock: StatusReportView['hostClock']): readonly StatusWarning[] {
  if (hostClock === undefined || hostClock === null) return []
  const failures = readFinite(hostClock.consecutiveFailures)
  if (hostClock.source !== 'os' || failures === null || failures < 1) return []
  return [
    singleWarning(
      'host-clock',
      'ホストの時計を時刻の相手（ntp.nict.jp・pool.ntp.org）に合わせられていない。' +
        'OS の時計のまま動いているので、基板の時計のずれにはホストのずれも混ざって見える',
    ),
  ]
}

/** 基板 1 枚ぶんの行（`receiver/boardIntensity.ts` の `BoardIntensity` のうち画面に出す欄）。 */
interface BoardIntensityView {
  readonly boardKey: string
  readonly boardName: string | null
  readonly stationId: string
  readonly stationName: string | null
  /** `fused`・`single`・`two-axis`・`no-sensor`（`BoardIntensitySource`）。 */
  readonly source: string
  readonly lastPacketMs: number | null
  readonly lastIntensity: number | null
  readonly lastReadingReceivedMs: number | null
  readonly lastSkipReason: string | null
  readonly lastMemberCountMin: number | null
  readonly lastMemberCountMax: number | null
}

/** 基板ごとの震度の一覧。**配列でなければ空として扱う**（`assignedBoardsOf` と同じ理由）。 */
export function boardIntensitiesOf(status: Pick<StatusReportView, 'boardIntensities'>): readonly BoardIntensityView[] {
  if (!Array.isArray(status.boardIntensities)) return []
  // **形の崩れた要素は落とす**（`null` の行で `.source` を読むと、タブ全体が描けなくなる）。
  return status.boardIntensities.filter((b): b is BoardIntensityView => typeof b === 'object' && b !== null)
}

/**
 * 基板ごとの時計のずれ。**配列でなければ空として扱う**（`assignedBoardsOf` と同じ理由）。
 */
export function boardClocksOf(status: Pick<StatusReportView, 'boardClocks'>): readonly BoardClockOffset[] {
  const boards = status.boardClocks?.boards
  return Array.isArray(boards) ? boards : []
}

/**
 * 時計のずれた基板を伝える警告。**HTML として組み立て済み。**
 *
 * **出す・出さないはホストのログと同じ判定**（`warnableClockOffset`）。黙った基板は出さない
 * —— そちらは「届いていない」の警告が持つ。時刻は `readFinite` を通す（`/status` は無検証で
 * 読んでいるので、欄の無い版から `undefined` が来うる）。
 */
export function boardClockWarnings(nowMs: number, boards: readonly BoardClockOffset[]): readonly string[] {
  return boardClockWarningList(nowMs, boards).map((w) => w.html)
}

/** {@link boardClockWarnings} の組の形（通知の見張りが対象ごとの出入りを見るのに使う）。 */
export function boardClockWarningList(nowMs: number, boards: readonly BoardClockOffset[]): readonly StatusWarning[] {
  const items: WarningItem[] = []
  for (const b of boards) {
    const offset = warnableClockOffset(
      { offsetMs: readFinite(b.offsetMs), lastPacketMs: readFinite(b.lastPacketMs) },
      nowMs,
    )
    if (offset === null) continue
    const way = offset > 0 ? '遅れ' : '進み'
    items.push(warningItem(b.boardKey, b.boardKey, plainDetail(`${Math.round(Math.abs(offset))} ms ${way}`)))
  }
  const w = listWarning('board-clock', '時計がホストとずれている基板', items)
  return w === null ? [] : [w]
}

interface AssignedBoardView {
  readonly boardKey: string
  readonly stationId: string
  readonly lastPacketMs: number | null
  readonly state: string
  readonly sensors: readonly {
    readonly sensorId: string
    readonly lastPacketMs: number | null
    readonly state: string
  }[]
}

/**
 * 割り当てた基板の一覧。**配列でなければ空として扱う。**
 *
 * `/status` は無検証で読んでいるので、この欄を持たない版のホストからは `undefined` が来る
 * —— そのまま `.filter` すると画面ごと「状態を取得できていない」へ倒れる。
 */
export function assignedBoardsOf(status: Pick<StatusReportView, 'assignedBoards'>): readonly AssignedBoardView[] {
  return Array.isArray(status.assignedBoards) ? status.assignedBoards : []
}

/**
 * 割り当てた基板・センサーが届いていないことを伝える警告。**HTML として組み立て済み。**
 *
 * **`waiting`（ホストを起動して、または割り当てて間が無い）は出さない。** その間は
 * まだ届いていなくて当たり前で、出すと再起動や登録のたびに並ぶ。
 *
 * **センサーを個別に言うのは基板が届いているときだけ**（ホストのログと同じ扱い。
 * `main.ts` の `buildAssignedSilenceReport`）。
 *
 * **「いつから」はホストのログと同じ文面**（`describeSilence`）。経過は `nowMs`
 * （`/status` の `generatedAtMs`）から測る —— 端末の時計で測ると、ずれた分だけ嘘になる。
 * 時刻は `readFinite` を通す（欄の無い版から `undefined` が来ても「一度も」に倒れる）。
 */
export function assignedSilenceWarnings(nowMs: number, boards: readonly AssignedBoardView[]): readonly string[] {
  return assignedSilenceWarningList(nowMs, boards).map((w) => w.html)
}

/** {@link assignedSilenceWarnings} の組の形（通知の見張りが対象ごとの出入りを見るのに使う）。 */
export function assignedSilenceWarningList(
  nowMs: number,
  boards: readonly AssignedBoardView[],
): readonly StatusWarning[] {
  const boardItems = boards
    .filter((b) => b.state === 'silent')
    .map((b) => {
      const silence = describeSilence(nowMs, readFinite(b.lastPacketMs))
      return warningItem(b.boardKey, b.boardKey, {
        html: `観測点 ${escapeHtml(b.stationId)}・${silence}`,
        text: `観測点 ${b.stationId}・${silence}`,
      })
    })
  const sensorItems = boards
    .filter((b) => b.state === 'live')
    .flatMap((b) =>
      (Array.isArray(b.sensors) ? b.sensors : [])
        .filter((s) => s.state === 'silent')
        .map((s) =>
          warningItem(
            // boardKey も sensorId も無認証の UDP 由来でどの文字も入りうるので、区切り文字で繋がず JSON で包む。
            JSON.stringify([b.boardKey, s.sensorId]),
            `${b.boardKey} / ${s.sensorId}`,
            plainDetail(describeSilence(nowMs, readFinite(s.lastPacketMs))),
          ),
        ),
    )
  return [
    listWarning('assigned-board-silent', '観測点に割り当てた基板が届いていない', boardItems),
    listWarning('assigned-sensor-silent', '基板は届いているが、登録したセンサーが届いていない', sensorItems),
  ].filter((w): w is StatusWarning => w !== null)
}

type PairDiffView = StatusReportView['stationIntensities'][number]['pairDiffs'][number]

/**
 * いちばん離れているセンサー対（#315）。1 組も無ければ null。
 *
 * **36 組を並べない。** 9 台なら全ペアで 36 行になり、観測点の表が読めなくなる。
 * 運用者が知りたいのは「おかしい対があるか」で、**あれば必ず最大に現れる**
 * ——細かく見たいときは `/status` の生の値を読む。
 *
 * **軸ごとの最大を採る。** 感度のずれは軸ごとに現れる（#367）ので、
 * 3 軸を平均すると 1 軸だけおかしい対が薄まる。
 */
/**
 * 生データの記録の警告。**組み立て済みの HTML**（理由は `escapeHtml` を通す —— 例外の文面には
 * 無認証の UDP で届いた中身が混ざりうる）。理由はホストが最後に起きたものを持ち続けるので、
 * 一度出たら消えない（いつかは起きたことを見落とさないため）。
 */
export function mseedWarnings(m: StatusReportView['mseed']): readonly string[] {
  return mseedWarningList(m).map((w) => w.html)
}

/** {@link mseedWarnings} の組の形。 */
export function mseedWarningList(m: StatusReportView['mseed']): readonly StatusWarning[] {
  const out: StatusWarning[] = []
  if (m.lastWriteError !== null) out.push(singleWarning('mseed-write', '生データの書き込みエラー', m.lastWriteError))
  // **こちらの不具合の印。** 受け止めたパケットは中身ごと残してあるが、出たら直す対象。
  if (m.lastInternalError !== null) {
    out.push(singleWarning('mseed-internal', '生データの組み立てで想定外の例外', m.lastInternalError))
  }
  return out
}

/** 「生データの保存」欄の 1 行（数だけなのでエスケープは要らない）。 */
export function mseedSummary(m: StatusReportView['mseed']): string {
  return (
    `書き込みエラー: ${m.writeErrors} 件 / 失ったレコード: ${m.lostRecords} 本 / ` +
    `書けたレコード: ${m.recordsWritten} 本 / 読めないまま保存したパケット: ${m.unreadableWritten} 件`
  )
}

export function worstPairDiff(
  pairs: readonly PairDiffView[],
): { readonly pair: PairDiffView; readonly rmsGal: number } | null {
  let best: { pair: PairDiffView; rmsGal: number } | null = null
  for (const pair of pairs) {
    for (const rms of pair.rmsGal) {
      // **測れなかった軸（null）は候補にしない。** 0 で埋めると
      // 「差が無かった」対として最大の争いに混ざる。
      if (rms === null) continue
      if (best === null || rms > best.rmsGal) best = { pair, rmsGal: rms }
    }
  }
  return best
}

/**
 * 混ざった本数の欄。**揃っていなければ幅で出す。**
 *
 * **幅が出ていても警めの色にしない。** 実機では正常運転でも幅が出る
 * （まとまりの末尾で 1〜3 本欠ける。REQUIREMENTS.md §7）ので、色を付けると
 * **常に警告が出ている状態**になり、#362 の本物の乱れと区別が付かない。
 * **どこからが異常かの物差しは未設計**（#374）。
 *
 * **`readFinite` を通す。** `/status` は無検証のキャストで読んでいるので、
 * 欄が無ければ `undefined` が来る（版がずれたとき）——`undefined === null` は偽だが
 * `undefined === undefined` は真なので、`null` だけを見る形だと
 * **「undefined 本」というそれらしい文字列が画面へ出る**。同じ行の隣の欄
 * （`lastIntensity.toFixed`）は同じ状況で例外を投げ「状態を取得できていない」へ
 * 倒れるので、ここだけ弱いままにしない（2026-09-28 のレビューが指摘）。
 */
export function memberCell(min: unknown, max: unknown): string {
  const lo = readFinite(min)
  const hi = readFinite(max)
  if (lo === null || hi === null) return '—'
  if (lo === hi) return `${lo} 本`
  return `${lo}〜${hi} 本`
}

type ResidualView = NonNullable<StatusReportView['stationIntensities'][number]['residuals']>[number]

/**
 * いちばん大きいずれ（#688）。センサーと軸の組で 1 つ。無ければ null。
 *
 * **並べない・平均しない**理由は {@link worstPairDiff} と同じ（おかしい台があれば必ず最大に現れる。
 * 軸ごとに見るのは、感度のずれが軸ごとに現れるため）。
 *
 * **配列でなければ無いものとして扱う。** `/status` は無検証のキャストで読んでいて、版の古いホストは
 * この欄を持たない —— `undefined` のまま回すと行ごと例外で落ちる。
 */
export function worstResidual(
  residuals: unknown,
): { readonly residual: ResidualView; readonly axis: number; readonly rmsGal: number } | null {
  if (!Array.isArray(residuals)) return null
  let best: { residual: ResidualView; axis: number; rmsGal: number } | null = null
  for (const residual of residuals as readonly ResidualView[]) {
    if (!Array.isArray(residual?.axes)) continue
    if (typeof residual.member?.boardKey !== 'string' || typeof residual.member.sensorId !== 'string') continue
    residual.axes.forEach((axis, j) => {
      const rms = readFinite(axis?.rmsGal)
      // **出せなかった軸（null）は候補にしない**（{@link worstPairDiff} と同じ）。
      if (rms === null) return
      if (best === null || rms > best.rmsGal) best = { residual, axis: j, rmsGal: rms }
    })
  }
  return best
}

/** ずれの欄。**いちばん大きいセンサーと軸だけ**を出す。 */
function residualCell(residuals: unknown): string {
  const worst = worstResidual(residuals)
  if (worst === null) return '—'
  const member = `${escapeHtml(worst.residual.member.boardKey)}/${escapeHtml(worst.residual.member.sensorId)}`
  // **軸の名前はセンサーが名乗るもの**（無認証の UDP 由来）なので `escapeHtml` を通す。
  const channels = Array.isArray(worst.residual.channels) ? worst.residual.channels : []
  const axisName = typeof channels[worst.axis] === 'string' ? channels[worst.axis]! : `${worst.axis + 1}`
  return `${worst.rmsGal.toFixed(2)} gal <span class="muted">${member}・${escapeHtml(axisName)}</span>`
}

/** 差分の欄。**いちばん離れている対だけ**を出す。 */
function pairDiffCell(pairs: readonly PairDiffView[]): string {
  const worst = worstPairDiff(pairs)
  if (worst === null) return '—'
  const a = `${escapeHtml(worst.pair.a.boardKey)}/${escapeHtml(worst.pair.a.sensorId)}`
  const b = `${escapeHtml(worst.pair.b.boardKey)}/${escapeHtml(worst.pair.b.sensorId)}`
  return `${worst.rmsGal.toFixed(2)} gal <span class="muted">${a} ↔ ${b}</span>`
}

type SensorView = StatusReportView['sensors'][number]
type StationView = StatusReportView['stationIntensities'][number]

/**
 * 古い値へ付ける印（#373）。**真なら赤くする。**
 *
 * **付けるのは値の欄だけ。** 識別子（観測点 ID・基板／センサー）と受信欄には付けない
 * ——行を丸ごと赤くすると「どれの話か」が読み取りにくくなるうえ、受信欄には既に
 * 同じ色の「途絶」の札が出ている。
 *
 * **赤い理由は 1 つに絞らない。** 届かなくなった行も、届いてはいるが値を出せていない
 * 行も同じ赤にする——運用者が知りたいのは「この数字をいま信じてよいか」で、
 * そこから先の切り分けは受信欄の札と `/status` の生の値が受け持つ。
 */
const STALE_ATTR = ' class="stale-value"'

function staleAttr(stale: boolean): string {
  return stale ? STALE_ATTR : ''
}

/**
 * 震度の欄が古いか。**届いていないか、届いていても震度を出せていないか。**
 *
 * **`lastSkipReason` も見る。** あれが立っている間、震度は 1 つも出ていない
 * （`receiver/stationHealth.ts`・`receiver/sensorHealth.ts` とも、値が出た回
 * ——`noteReading`——にだけ消す）。**それでも受信の時刻は動き続ける**ので、
 * 到着だけを見ていると「基板は生きているが合成だけ壊れている」状態で
 * 最後に出た震度が平常の色のまま居座る（2026-09-30 の敵対的レビューが指摘）。
 *
 * **時刻では判定しない。** 震度が出た時刻（`lastReadingAtMs`）は**基板が名乗る
 * 時間軸**で、受信の時刻（`lastPacketMs`）は受け手の時計——引き比べると、
 * 基板の時計のずれがそのまま「古い」の誤判定になる。
 *
 * **`/status` は無検証で読んでいる**ので、欄が無ければ `undefined` が来る
 * （版がずれたとき）。文字列であることまで確かめる。
 */
function isIntensityStale(nowMs: number, atMs: number | null, skipReason: unknown): boolean {
  return isStale(nowMs, atMs) || typeof skipReason === 'string'
}

/**
 * 観測点の震度の欄が古いか。**受信の時刻ではなく、震度が出た時刻（ホストの時計）で測る**
 * —— 受信の時刻では震度だけ止まった観測点を見落とす理由は `receiver/stationHealth.ts` の
 * `lastReadingReceivedMs`。センサーの行は受信の時刻のままでよい（あちらは震度が止まれば理由が立つ）。
 *
 * **欄が無ければ古いと見る**（版がずれたとき。`undefined` を数として引くと「新しい」に化ける）。
 */
function stationIntensityStale(nowMs: number, s: StationView): boolean {
  const at: unknown = s.lastReadingReceivedMs
  return isIntensityStale(nowMs, typeof at === 'number' ? at : null, s.lastSkipReason)
}

/**
 * センサー 1 個ぶんの行。
 *
 * **運用者が入力した値（基板の鍵・センサーの名前・観測点の表示名）を埋め込む**ので
 * `escapeHtml` を通す。**「有効」「校正」は設定そのもの**なので古くならない——
 * 途絶しても赤くしない（`receiver/statusReport.ts` が毎回いまの設定から引き直す）。
 */
export function sensorRowHtml(nowMs: number, s: SensorView): string {
  const mismatch = readAxisMismatch(s.axisMismatch)
  return `
          <tr>
            <td>${escapeHtml(s.station?.displayName ?? '未割当')}</td>
            <td>${boardLabelHtml(s.boardKey, typeof s.boardName === 'string' ? s.boardName : null)} / ${escapeHtml(s.sensorId)}</td>
            <td>${receptionBadgeHtml(nowMs, s.lastPacketMs)} ${ago(nowMs, s.lastPacketMs)}</td>
            ${sensorIntensityCellHtml(nowMs, s, mismatch !== null)}
            <td>${s.enabled ? '有効' : '無効'}</td>
            ${
              mismatch !== null
                ? `<td${STALE_ATTR}>軸の本数が違う（設定 ${mismatch.configuredAxes} 本・届いたのは ${mismatch.receivedAxes} 本）</td>`
                : `<td>${s.calibrationConfigured ? '設定あり' : '既定値のまま'}</td>`
            }
          </tr>`
}

/**
 * センサーの震度の欄。
 *
 * - **軸の本数が設定と食い違って値を捨てている**なら赤い「—」（何も出していない。2026-10-09 ユーザー承認）
 * - **2 軸のセンサー**は「2 軸」を灰色で（震度を出さないのが正しい状態で、異常ではない。同日承認）。
 *   見分けは「軸が 2 本で、出せない理由が軸の本数（`axis-count`）」—— 理由が別なら本物の異常なので赤くする
 * - それ以外は値（古ければ赤）
 */
function sensorIntensityCellHtml(nowMs: number, s: SensorView, mismatched: boolean): string {
  if (mismatched) return `<td${STALE_ATTR}>—</td>`
  if (s.axisCount === 2 && s.lastSkipReason === 'axis-count') return '<td class="muted">2 軸</td>'
  return `<td${staleAttr(isIntensityStale(nowMs, s.lastPacketMs, s.lastSkipReason))}>${
    s.lastIntensity !== null ? s.lastIntensity.toFixed(2) : '—'
  }</td>`
}

/**
 * `/status` の `axisMismatch` を読む。**数として読めなければ食い違っていないと読む**
 * （`/status` は無検証で読んでいるので、欄が無い・形が違う版のホストでも行を壊さない）。
 */
function readAxisMismatch(value: unknown): { configuredAxes: number; receivedAxes: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const configuredAxes = v.configuredAxes
  const receivedAxes = v.receivedAxes
  if (!Number.isInteger(configuredAxes) || !Number.isInteger(receivedAxes)) return null
  return { configuredAxes: configuredAxes as number, receivedAxes: receivedAxes as number }
}

/**
 * 観測点 1 つぶんの行（複数センサーの合成）。
 *
 * **3 つの値は同じ回に更新されるとは限らない。** 混ざった本数と差分は合成波形が
 * 出た回に、震度は震度が出た回に書き換わる（`main.ts` の `deliverStationFusion`）
 * ——**波形は出ているが震度だけ出せない**状態がありうるので、震度の欄だけは
 * 震度が出た時刻と `lastSkipReason` で測る（`stationIntensityStale`）。届かなくなったときは 3 つとも古い。
 */
export function stationRowHtml(nowMs: number, s: StationView): string {
  const stale = staleAttr(isStale(nowMs, s.lastPacketMs))
  return `
          <tr>
            <td>${escapeHtml(s.stationId)}</td>
            <td>${receptionBadgeHtml(nowMs, s.lastPacketMs)} ${ago(nowMs, s.lastPacketMs)}</td>
            <td${staleAttr(stationIntensityStale(nowMs, s))}>${s.lastIntensity !== null ? s.lastIntensity.toFixed(2) : '—'}</td>
            <td${stale}>${memberCell(s.lastMemberCountMin, s.lastMemberCountMax)}</td>
            <td${stale}>${pairDiffCell(s.pairDiffs)}</td>
            <td${stale}>${residualCell(s.residuals)}</td>
          </tr>`
}

/**
 * 基板 1 枚ぶんの行（「基板ごとの震度」。#713-1）。
 *
 * **値の欄は出どころ（`source`）で出し分ける**（2026-10-11 ユーザー承認）。
 * - `fused`: 基板ごとの合成の値と混ざった本数（`3 本`、揺れていれば `2〜3 本`）
 * - `single`: センサー単独の値。本数の欄は「1 本（センサー単独）」
 * - `two-axis`: 震度は灰色の「2 軸」（センサーの表と同じ。震度を出さないのが正しい状態）
 * - `no-sensor`・それ以外: 震度を出せないので赤い「—」
 *
 * **古さの測り方は観測点の行と同じ**（震度が出た時刻と `lastSkipReason`。`stationIntensityStale`）。
 * センサー単独の行は、ホストが「センサーが届いた時刻」を震度の時刻として入れてくる
 * （`receiver/boardIntensity.ts` の `lastReadingReceivedMs`）ので、センサーの表と同じ測り方になる。
 */
export function boardIntensityRowHtml(nowMs: number, b: BoardIntensityView): string {
  // **文字列の欄は型を確かめてから使う**（`/status` は無検証で読んでいて、版の違うホストでは欠けうる。
  // 欠けた値を `escapeHtml` へ渡すと例外で稼働状況タブ全体が描けなくなる）。読めなければ「—」。
  const boardKey = readNonEmptyString(b.boardKey)
  const boardName = readNonEmptyString(b.boardName)
  const station = readNonEmptyString(b.stationName) ?? readNonEmptyString(b.stationId)
  const lastPacketMs = readFinite(b.lastPacketMs)
  return `
          <tr>
            <td>${boardKey !== null ? boardLabelHtml(boardKey, boardName) : '—'}</td>
            <td>${station !== null ? escapeHtml(station) : '—'}</td>
            <td>${receptionBadgeHtml(nowMs, lastPacketMs)} ${ago(nowMs, lastPacketMs)}</td>
            ${boardIntensityCellHtml(nowMs, b)}
            ${boardMemberCellHtml(nowMs, b, lastPacketMs)}
          </tr>`
}

function boardIntensityCellHtml(nowMs: number, b: BoardIntensityView): string {
  if (b.source === 'two-axis') return '<td class="muted">2 軸</td>'
  if (b.source !== 'fused' && b.source !== 'single') return `<td${STALE_ATTR}>—</td>`
  const stale = isIntensityStale(nowMs, readFinite(b.lastReadingReceivedMs), b.lastSkipReason)
  const value = readFinite(b.lastIntensity)
  return `<td${staleAttr(stale)}>${value !== null ? value.toFixed(2) : '—'}</td>`
}

function boardMemberCellHtml(nowMs: number, b: BoardIntensityView, lastPacketMs: number | null): string {
  if (b.source === 'single') return '<td>1 本（センサー単独）</td>'
  if (b.source !== 'fused') return '<td>—</td>'
  // 書き方は観測点の表と揃える（`memberCell`。「本」を付けるのは 2026-10-11 ユーザー承認）。
  return `<td${staleAttr(isStale(nowMs, lastPacketMs))}>${memberCell(b.lastMemberCountMin, b.lastMemberCountMax)}</td>`
}

/**
 * 稼働状況の警告をすべて並べる（稼働状況タブの「⚠」の行と、通知の見張りが同じものを読む）。
 *
 * **警告文は `describeFailure`（サーバー側）が組み立てる際、運用者が入力した生の値
 * （`JSON.stringify(f.value)`）を埋め込むことがある。** `stationId`（`ungroupedMultiBoardStations`）も
 * 同様に運用者由来。どちらも HTML ではエスケープする —— `boardKey`/`sensorId` と同じ理由（冒頭のコメント）。
 */
export function collectStatusWarnings(status: StatusReportView): readonly StatusWarning[] {
  const now = status.generatedAtMs
  const out: StatusWarning[] = []
  if (status.stationConfigWarning !== null) {
    out.push(singleWarning('station-config', '観測点設定', status.stationConfigWarning))
  }
  const ungrouped = listWarning(
    'ungrouped-stations',
    '基板を複数割り当てたが、合成できていない観測点',
    status.ungroupedMultiBoardStations.map((id) => warningItem(id, id)),
  )
  if (ungrouped !== null) out.push(ungrouped)
  out.push(...mseedWarningList(status.mseed))
  // 保存先の容量（文面は保存先タブと共有。`storageText.ts`）。
  if (status.storage !== undefined) out.push(...storageWarningList(status.storage))
  out.push(...assignedSilenceWarningList(now, assignedBoardsOf(status)))
  // 時計の警告はホストの時計を先に出す（基板の時計のずれの読み方が変わるため）。
  out.push(...hostClockWarningList(status.hostClock))
  out.push(...boardClockWarningList(now, boardClocksOf(status)))
  return out
}

/**
 * まだ声が届いている行の数。**要約カードの「N / 全体」の左側。**
 *
 * **センサーと観測点の両方が通る。** 同じ物差し（`isStale`）で数えないと、片方の
 * カードだけが途絶を数え落とす。
 */
export function countLive(nowMs: number, rows: readonly { readonly lastPacketMs: number | null }[]): number {
  return rows.filter((r) => !isStale(nowMs, r.lastPacketMs)).length
}

/** 稼働状況タブは選択も表示の好みも持たない（読むだけの画面）。使うのは打ち切りの合図だけ。 */
export async function initStatusView(container: HTMLElement, ctx: TabContext): Promise<void> {
  const { signal } = ctx
  container.innerHTML = `
    <div class="status-error"></div>
    <div class="status-body muted">読み込み中…</div>
    <!-- **ホストの再起動は、5 秒ごとに描き直す欄の外に置く**（#313・2026-10-27 ユーザー承認）。
         中に置くと、押した後の結果の行が次の描き直しで消える。 -->
    <section class="panel">
      <button type="button" class="host-restart danger">${HOST_RESTART_BUTTON_LABEL}</button>
      <div class="host-restart-result"></div>
    </section>
  `

  const errorEl = qs(container, '.status-error')
  const bodyEl = qs(container, '.status-body')

  const render = (status: StatusReportView): void => {
    const now = status.generatedAtMs

    const sensorRows = status.sensors.map((s) => sensorRowHtml(now, s)).join('')

    const stationRows = status.stationIntensities.map((s) => stationRowHtml(now, s)).join('')

    const boardRows = boardIntensitiesOf(status)
      .map((b) => boardIntensityRowHtml(now, b))
      .join('')

    const warnings = collectStatusWarnings(status).map((w) => w.html)
    const assignedBoards = assignedBoardsOf(status)

    const liveSensorCount = countLive(now, status.sensors)
    const liveAssignedCount = assignedBoards.filter((b) => b.state === 'live').length
    const liveStationCount = countLive(now, status.stationIntensities)
    const hours = Math.floor(status.uptimeSec / 3600)
    const minutes = Math.floor((status.uptimeSec % 3600) / 60)

    bodyEl.innerHTML = `
      <div class="stat-cards">
        <div class="stat-card">
          <div class="stat-label">稼働時間</div>
          <div class="stat-value">${hours} 時間 ${minutes} 分</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">受信中のセンサー</div>
          <div class="stat-value">${liveSensorCount} / ${status.sensors.length}</div>
        </div>
        <!-- **隣のセンサーの数では代われない。** あちらの分母は一度でも届いたセンサー
             だけで、起動してから一度も届かない基板は分母にも入らない（全部が受信中に見える）。
             こちらの分母は観測点の設定に割り当てた基板の数。 -->
        <div class="stat-card">
          <div class="stat-label">割り当てた基板</div>
          <div class="stat-value">${liveAssignedCount} / ${assignedBoards.length}</div>
        </div>
        <!-- **隣のセンサーと同じ「生きている数 / 全体」の形にする。** この帳面は
             設定を変えても作り直さない（\`receiver/stationHealth.ts\`）ので、管理コンソールで
             消した観測点の行が残り続ける——全体だけを出すと、1 つへ減らした後も
             減らす前の数を数え続ける（#373）。 -->
        <div class="stat-card">
          <div class="stat-label">複数センサー合成の観測点</div>
          <div class="stat-value">${liveStationCount} / ${status.stationIntensities.length}</div>
        </div>
      </div>
      ${
        warnings.length > 0
          ? `<p class="error">${warnings.map((w) => `⚠ ${w}`).join('<br>')}</p>`
          : '<p class="muted">警告なし</p>'
      }
      <section class="panel">
        <h2>センサー</h2>
        <table>
          <thead><tr><th>観測点</th><th>基板 / センサー</th><th>受信</th><th>計測震度相当</th><th>有効</th><th>校正</th></tr></thead>
          <tbody>${sensorRows.length > 0 ? sensorRows : '<tr><td colspan="6" class="muted">未受信</td></tr>'}</tbody>
        </table>
      </section>
      <section class="panel">
        <!-- **センサー → 基板 → 観測点の細かい順に並べる**（2026-10-11 ユーザー承認）。同じ観測点に
             置いた基板どうしで値が離れていれば、据え付けかセンサーを疑う手掛かりになる。 -->
        <h2>基板ごとの震度</h2>
        <table>
          <thead><tr><th>基板</th><th>観測点</th><th>受信</th><th>計測震度相当</th><th>混ざった本数</th></tr></thead>
          <tbody>${boardRows.length > 0 ? boardRows : '<tr><td colspan="5" class="muted">観測点に割り当てた基板がありません</td></tr>'}</tbody>
        </table>
      </section>
      <section class="panel">
        <!-- **「複数センサー合成」を見出しから外さない。** \`stationIntensities\` は
             2 台以上を割り当てた観測点にしか現れない（\`statusReport.ts\`）。見出しを
             「観測点ごとの震度」と一般化すると、センサー 1 台の構成では正常に動いて
             いても永久に空のままで、運用者が登録の失敗を疑う。 -->
        <h2>複数センサー合成の震度</h2>
        <table>
          <!-- **「混ざった本数」と「差分の最大」を並べて出す。** 前者が揃っていない
               ことと、特定の対だけ差分が大きいことは、どちらも据え付けを疑う手掛かり
               （#362・#315）。震度だけでは、値が高いときに「本当に揺れた」のか
               「顔ぶれの入れ替わりで段差が乗った」のかを見分けられない。 -->
          <thead><tr><th>観測点</th><th>受信</th><th>計測震度相当</th><th>混ざった本数</th><th>差分の最大（対）</th><th>ずれの最大（軸）</th></tr></thead>
          <tbody>${stationRows.length > 0 ? stationRows : '<tr><td colspan="6" class="muted">2 台以上を割り当てた観測点がありません</td></tr>'}</tbody>
        </table>
      </section>
      <section class="panel">
        <h2>生データの保存</h2>
        <p>${mseedSummary(status.mseed)}</p>
      </section>
    `
  }

  // **`signal.aborted` を確認してから DOM を書く。** タブ切替直後（初回 fetch の
  // 完了前に別タブへ移った場合）に、差し替わった DOM への書き込みや、二度と
  // 止まらないポーリングを始めてしまう事故を防ぐ（`app.ts` の `mountTab` 参照。
  // 旧 `teardown` イベント方式は、初回 fetch 完了前の切替でリスナー登録前に
  // イベントが飛んでしまい、タイマーを止められなかった）。
  // ホストの再起動を頼めた後、起動し直したのを見たら結果の行を消してボタンを戻す（同じタブのまま次を押せるように）。
  // **起動し直したかは、応答から求めた「ホストが起動した時刻」が前より進んだかで見る**（`hostStartedAtMs`）。
  // `uptimeSec` の大小だと、5 秒ごとの読み直しが重なって古い応答が後から届いたときに「戻った」と取り違え、
  // 起動してすぐの再起動（前の uptime が小さい）では永久に戻らない。落ちている間の印（`sawHostDown`）は
  // **通信そのものが失敗したときだけ**立てる —— HTTP のエラーや表示の例外はホストが生きている印。
  let restartRequested = false
  let sawHostDown = false
  let lastHostStartedAtMs: number | null = null
  const reload = async (): Promise<void> => {
    let res: Response
    try {
      res = await fetch('/status')
    } catch (error) {
      if (signal.aborted) return
      if (restartRequested) sawHostDown = true
      showReloadFailure(error)
      return
    }
    try {
      if (signal.aborted) return
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const status = (await res.json()) as StatusReportView
      if (signal.aborted) return
      noteHostStart(status)
      render(status)
      errorEl.textContent = ''
    } catch (error) {
      if (signal.aborted) return
      showReloadFailure(error)
    }
  }
  /** 応答からホストの起動時刻を求め、頼んだ再起動が済んだならボタンを戻す。 */
  const noteHostStart = (status: StatusReportView): void => {
    if (!Number.isFinite(status.generatedAtMs) || !Number.isFinite(status.uptimeSec)) return
    const startedAtMs = status.generatedAtMs - status.uptimeSec * 1000
    // `uptimeSec` は秒へ切り捨てるので、同じ起動でも 1 秒ほど揺れる。それより大きく進んだら別の起動。
    const restarted =
      sawHostDown || (lastHostStartedAtMs !== null && startedAtMs > lastHostStartedAtMs + HOST_START_JITTER_MS)
    if (lastHostStartedAtMs === null || startedAtMs > lastHostStartedAtMs) lastHostStartedAtMs = startedAtMs
    if (restartRequested && restarted) {
      restartRequested = false
      sawHostDown = false
      restartResult.textContent = ''
      restartResult.classList.remove('error')
      restartButton.disabled = false
    }
  }
  const showReloadFailure = (error: unknown): void => {
    errorEl.textContent = error instanceof Error ? error.message : String(error)
    // **取得できていない間、古い「受信中」バッジを凍結させない。** バッジは
    // 直前に成功した応答の時刻を基準に「途絶」を判定するため、`/status`
    // 自体への到達性が失われている間は実際の経過時間を反映せず、失敗が
    // 始まった瞬間の見た目のまま残り続ける——運用者がエラー文言（小さく
    // 添えているだけ）を見落とすと「センサーは生きている」と誤認しうる
    // （#313 段 C 敵対的レビューで検出）。表示ごと「不明」へ倒す。
    bodyEl.innerHTML = '<p class="muted">状態を取得できていない</p>'
  }

  const restartButton = qs<HTMLButtonElement>(container, '.host-restart')
  const restartResult = qs(container, '.host-restart-result')
  const showRestartLine = (line: OperationLine): void => {
    restartResult.textContent = line.text
    restartResult.classList.toggle('error', line.error)
  }
  restartButton.addEventListener('click', () => {
    void (async () => {
      const ok = await confirmDialog(document, HOST_RESTART_CONFIRM)
      if (!ok || signal.aborted) return
      restartButton.disabled = true
      let line: OperationLine
      try {
        const body = await apiFetch<{ readonly status?: unknown }>('/api/restart', { method: 'POST' })
        line = hostRestartAcceptedLine(body?.status)
      } catch (error) {
        line = hostRestartFailureLine(error)
      }
      if (signal.aborted) return
      showRestartLine(line)
      // **頼めたら、起動し直すのを見るまで押せないままにする**（2 度目は締めくくりの途中で断られるだけ）。
      // 断られたら押し直せるように戻す。
      restartButton.disabled = !line.error
      if (!line.error) {
        restartRequested = true
        sawHostDown = false
      }
    })()
  })

  await reload()
  if (signal.aborted) return
  // **見に来ている間だけ更新すればよい。** 他タブが選ばれている間は
  // `initStatusView` を再度呼び直すまで動かさない（`abort` で止める）。
  const timer = window.setInterval(() => void reload(), 5000)
  signal.addEventListener('abort', () => window.clearInterval(timer), { once: true })
}
