// 行動チェックリストを出すかどうかを決める。
//
// 【何を見るか】EEW・強震モニタ・地震情報の 3 経路。揺れを知る手段は状況で変わる（発報が間に
// 合えば EEW、間に合わなければ観測、後から地震情報）ので、1 つに絞ると気づけない場面ができる。
// **3 つが同時に成立しうるため、緊急度の順に見て最初に成立したものを出す。**
//
// 【閉じたら消さずに畳む】大きな地震のあとは余震が続き、続報も次々届く。地震ごとに別物として
// 出し直すと、閉じても閉じても現れることになる。閉じたら小さなボタンへ畳み、その間に届いた
// 揺れではボタンのままにする。読みたくなったら押せば開く。
//
// 【畳んだままにしない 2 つの場合】
//   - 震度が上がったとき … 震度5弱で閉じたあとの震度6強は伝えるべきもの。開き直す
//   - 時間が経ったとき … 最後の揺れから SUPPRESS_MS を過ぎたらボタンも消える。次の地震は
//     改めてパネルで出る
//
// 【出しすぎと出さなすぎ】この機能は出しすぎても害が小さく、出ないことの方が問題。判定に迷う
// ところ（半径内に観測点が無い等）はすべて「出す」側へ倒している。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EEWAlert, JMAQuake } from '../types/earthquake'
import { recordReplayEvent } from '../utils/replayEventLog'
import {
  judgeEewForScope,
  judgeKyoshinForScope,
  judgeQuakeForScope,
  type ChecklistScope,
  type NearbyScope,
} from '../utils/actionChecklistTrigger'
import type { DetectedPoint } from '../utils/kyoshinDetectionView'
import { quakeEventKey } from '../utils/quakeMerge'
import { eewEventKey } from '../utils/eew'
import { isValidIntensityScale } from '../utils/intensity'
import { log } from '../utils/logger'
import type { ChecklistReason } from '../components/ActionChecklist'

/** 畳んだ状態を覚えるキー。 */
const SUPPRESS_KEY = 'action-checklist-suppress'

/**
 * 畳んでからボタンを出しておく時間。
 *
 * この間は自動で開き直さず、過ぎたらボタンも消える。揺れが届くたびに延びるので、余震が続いて
 * いる間はボタンが残る。1 時間としたのは、直後の行動（火の元・靴・出口）を読み終える猶予と、
 * 「まだ揺れている状況」が概ね収まる長さの折り合い。
 */
export const SUPPRESS_MS = 60 * 60 * 1000

/**
 * 寿命を延ばすのは残りがこれを切ったときだけ。
 *
 * 強震モニタは 1 秒ごとに判定するため、揺れが届くたびに書き換えると `localStorage` への書き込みと
 * タイマーの張り直しが毎秒走る。半分を残して延ばせば、延長は高々 30 分に 1 度で済む。
 */
const SUPPRESS_EXTEND_BELOW_MS = SUPPRESS_MS / 2

/**
 * 「もう出し終えた」と覚えておく識別子の数。
 *
 * 寿命が尽きてボタンを消したあと、**同じ揺れで帯が開き直さないようにする**ために要る。
 * 地震情報は最新の 1 件が長く居座るため（1 時間後も同じ地震が最新のままなのは普通）、
 * 覚えていないと消した次の再描画でそのまま出し直してしまう。
 */
const DONE_KEYS_MAX = 20

/** 畳んだ記録。リロードしても残す（開き直すと閉じた意味が無くなるため）。 */
interface SuppressRecord {
  /** この時刻まで自動で開き直さない。過ぎたらボタンも消す。 */
  until: number
  /** 畳んだときの震度。**これを超える揺れが来たら畳んだままにしない。** */
  scale: number
  /**
   * 畳んだときに出ていた帯の識別子。誤報取消された EEW を閉じてできた記録かを見分けるのに使う
   * （→ `docs/spec/action-checklist-spec.md` §4「元の EEW・地震情報が取り消されたとき」）。
   * この項目を持たない旧形式の記録は見分けが付かないので、取消のときは捨てる側へ倒す。
   */
  key?: string
}

export interface ChecklistState {
  reason: ChecklistReason
  scale: number
  /**
   * 実際にどの範囲で判定したか（→ `ChecklistScope`）。帯の見出しの言い回しと、見出しの下の 1 行に使う。
   * **「地点を登録しているか」ではない** —— 地点があっても判定が全国基準へ倒れることがある。
   */
  scope: ChecklistScope
  /** 畳んだ対象を見分けるための識別子。 */
  key: string
}

// 時刻は壁時計（`Date.now()`）で測る。ここで要るのは「畳んでから 1 時間」という**経過時間**だけで、
// 他の時刻系と値を突き合わせない。サーバー同期時計（`serverNow`）を使わないのは、この記録が
// 起動直後（同期が済む前）にも読まれること、再生（テスト時刻設定）中に再生時計へ追従させると
// 数十分を数秒で飛ばす再生で畳んだ記録が即座に失効することによる。

/**
 * 誤報取消された EEW か。
 *
 * **`cancelledAt` で見る。** 画面が持つ EEW には取消が `{ ...表示中の EEW, cancelledAt }` の形で
 * 当たるため、`cancelled`（受け取った電文そのものが取消報か）は取消前の false のまま残る
 * （→ `docs/spec/eew-spec.md`「取消かどうかは `cancelledAt` で見る」）。`cancelled` も併せて
 * 見るのは、取消報そのものが渡された場合に備えるため。
 */
function isEewCancelled(eew: EEWAlert): boolean {
  return eew.cancelled === true || eew.cancelledAt != null
}

/**
 * 取消表示中の地震カードか。取消は `{ ...カード, cancelledAt }` の形で当たり、10 秒後に一覧から消える
 * （`useEarthquakes`）。その間も `id` と観測点を持ったまま残るので、判定から外すにはこれを見る。
 */
function isQuakeCancelled(q: JMAQuake): boolean {
  return q.cancelledAt != null
}

/**
 * 続報が届いたかを見分けるための、カードの指紋。
 *
 * **カードが控えている電文（`sourceTelegrams`）のうち、最も新しい発表時刻と、その時刻の電文の
 * 通数で作る。** 新しい続報が届けばどちらかが増える（DMDATA 版の発表時刻は分単位なので、同じ分に
 * 届いた続報は通数で拾う）。
 *
 * - **採用した電文（カードの `id`・`telegramKey`）は使わない。** 「もっと見る」や履歴で古い電文が
 *   後から足されると、時刻順の当て直し（`quakeMerge.ts` の `refoldQuakeCard`）で採用される電文が
 *   古い完全版へ替わることがある（完全版より後の速報段階の報は採用されないため）。続報は届いていない
 * - **`id` だけでも足りない。** DMDATA の `id` は `dmdata-quake-<EventID>-<報番号>` で電文の種別を
 *   含まないので、震源情報の第 1 報のあとに震源・震度情報の第 1 報が届いても同じ値になる
 * - **受け取った通数の合計も使わない。** 古い電文が足されると増える
 *
 * 控えを持たないカード（統合を通さずに作られたもの）や発表時刻を読めないカードは、`id` と
 * `telegramKey` の組で見る。**限界:** 最も新しい電文と同じ分の古い電文が後から足されると、続報と
 * 取り違える。
 */
function quakeFingerprint(q: JMAQuake): string {
  let latest = Number.NEGATIVE_INFINITY
  let count = 0
  for (const t of q.sourceTelegrams ?? []) {
    const ms = new Date(t.time).getTime()
    if (!Number.isFinite(ms)) continue
    if (ms > latest) {
      latest = ms
      count = 1
    } else if (ms === latest) {
      count++
    }
  }
  return count > 0 ? `${latest}#${count}` : `${q.id}#${q.telegramKey ?? ''}`
}

/**
 * 地震情報の経路で判定する地震の顔ぶれを、いまの一覧に合わせて更新する（`judged` と `seen` を
 * その場で書き換える）。入れる条件は `useActionChecklist` の `judgedQuakesRef` を参照。
 *
 * `judged` の値は、先頭に来たこと・続報が届いたことにこの画面が気づいた壁時計の時刻。判定に使うのは
 * そこから `SUPPRESS_MS` 以内の地震だけ（→ `isJudgedFresh`）。
 *
 * 取消表示中のカードは判定に入れず、指紋も書き換えない。同じ鍵の取消カードと新しいカードが一覧に
 * 並ぶことがあり、両方で書き換えると指紋が 1 回の走査の中で入れ替わって「続報が届いた」と取り違える。
 * ただし前に見た指紋は残す（取消のあとの出し直しを続報として拾うため）。
 *
 * 一覧から消えた地震は両方から外す（覚えたままにすると、一覧と同じだけ際限なく溜まる）。
 */
function updateJudgedQuakes(
  quakes: readonly JMAQuake[],
  judged: Map<string, number>,
  seen: Map<string, string>,
  now: number,
): void {
  const present = new Set<string>()
  // 取消表示中の鍵。判定からは外すが、前に見た指紋は消さない —— 消すと、取消のあと同じ地震が
  // 先頭でない位置へ出し直されたとき「初めて現れた」扱いになり、判定されない。
  const cancelled = new Set<string>()
  quakes.forEach((q, i) => {
    if (isQuakeCancelled(q)) {
      cancelled.add(quakeEventKey(q))
      return
    }
    const key = quakeEventKey(q)
    present.add(key)
    const prev = seen.get(key)
    const fingerprint = quakeFingerprint(q)
    const followUp = prev !== undefined && prev !== fingerprint
    if (followUp || (i === 0 && !judged.has(key))) judged.set(key, now)
    seen.set(key, fingerprint)
  })
  for (const key of judged.keys()) if (!present.has(key)) judged.delete(key)
  for (const key of seen.keys()) if (!present.has(key) && !cancelled.has(key)) seen.delete(key)
}

/** 気づいてから `SUPPRESS_MS` 以内か。 */
function isJudgedFresh(judgedAt: number, now: number): boolean {
  return now - judgedAt <= SUPPRESS_MS
}

function loadSuppress(): SuppressRecord | null {
  try {
    const raw = localStorage.getItem(SUPPRESS_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { until, scale, key } = parsed as Record<string, unknown>
    if (typeof until !== 'number' || !Number.isFinite(until)) return null
    // **震度は階級表にある値だけを採る。** 階級外の値（例: 99）が入ると「これを超えたら開き直す」
    // が永久に成立せず、以後どんな揺れでもボタンが自動で開かなくなる。記録は永続化されるため、
    // 一度混入するとリロードでも直らない。
    if (typeof scale !== 'number' || !isValidIntensityScale(scale)) return null
    // 期限切れは無かったことにする。次の揺れは改めてパネルで出す。
    if (until <= Date.now()) return null
    return typeof key === 'string' ? { until, scale, key } : { until, scale }
  } catch (e) {
    // null へ倒すのは安全側（「畳んでいない」＝出す方向）。ただし黙ると「閉じてもリロードで
    // 開き直す」の原因が読み取り側か書き込み側か切り分けられなくなるため記録する。
    log.warn('[checklist] 畳んだ記録を読み込めなかった', e)
    return null
  }
}

function saveSuppress(record: SuppressRecord | null): void {
  try {
    if (record) localStorage.setItem(SUPPRESS_KEY, JSON.stringify(record))
    else localStorage.removeItem(SUPPRESS_KEY)
  } catch (e) {
    // 永続化できない環境（プライベートモード・容量超過）でも畳む動作そのものは止めない。
    log.warn('[checklist] 畳んだ記録を保存できなかった', e)
  }
}

export function useActionChecklist(params: {
  minScale: number
  /**
   * ホーム地点の周り（`useNearbyScope`）。
   *
   * **作るのは呼び出し側。** 自作地震計の波形も同じ範囲で「近所が揺れているか」を
   * 見るので、両方が 1 つの `scope` を共有する（別々に作ると半径や索引の扱いが
   * 片方だけ動いたときに黙ってずれる）。
   */
  scope: NearbyScope
  /**
   * 検知エンジンが確定した揺れのメンバー観測点（`deriveKyoshinView` の `detectedPoints`）。
   *
   * 生の観測値ではなくこちらを渡す。理由は `kyoshinScaleForScope`。
   */
  detectedPoints: readonly DetectedPoint[]
  /**
   * 検知エンジンが結果を出せなくなっているか（`useKyoshinDetectorV2` の `stalled`）。
   *
   * **これを見ないと「揺れが収まった」と「エンジンが詰まっている」を区別できない。** エンジンは
   * 連続して壊れると検知結果を空にするので、`detectedPoints` だけを見ていると揺れの最中でも
   * 「近所は揺れていない」と読んでしまう。強震モニタ経路の入力をエンジンへ移した以上、その異常も
   * 併せて受け取る必要がある（`useKyoshinAlerts` が同じ理由でこれを見ている）。
   */
  kyoshinStalled: boolean
  /**
   * 発報中の EEW。**取消を当てた直後のもの（`cancelledAt` 付き・10 秒で消える）も含めて渡す。**
   *
   * 判定からは外すが、出している帯の元が取り消されたことはこれでしか分からない。取消済みを
   * 除いて渡すと、EEW がリストから消えるだけで帯を下ろす契機が無くなる。最終報のあとの自動解除で
   * 終わった EEW と区別できないため —— そちらは取消の表示を経ずにリストから外れ、揺れは実際に
   * 起きているので帯は残すのが正しい。
   */
  eews: readonly EEWAlert[]
  /**
   * 地震情報の一覧（地震の時刻の新しい順。`useEarthquakes` の `earthquakes`）。
   *
   * **先頭の 1 件だけでなく一覧を渡す。** 観測点は続報で後から加わる。先頭だけを見ると、続報が届く前に
   * 別の地震が先頭へ来たとき、前の地震で加わった近所の点が判定されない。どれを判定するかは
   * `judgedQuakesRef`（→ docs/spec/action-checklist-spec.md §2「同時に成立したら緊急度の順」）。
   */
  quakes: readonly JMAQuake[]
}): {
  state: ChecklistState | null; collapsed: boolean; dismiss: () => void; restore: () => void
  resetForReplay: () => void
} {
  const { minScale, scope, detectedPoints, kyoshinStalled, eews, quakes } = params
  const latestQuake = quakes[0]

  const [state, setState] = useState<ChecklistState | null>(null)
  const [suppress, setSuppress] = useState<SuppressRecord | null>(loadSuppress)
  // **記録が残っていれば畳んだ状態から始める。** false から始めると、閉じたあとにリロードした
  // 端末で次の余震が帯として開き直し、閉じた意味が無くなる（記録の永続化だけでは足りない）。
  const [collapsed, setCollapsed] = useState(() => suppress !== null)

  const stateRef = useRef(state)
  stateRef.current = state
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed
  const suppressRef = useRef(suppress)
  suppressRef.current = suppress
  // 寿命が尽きて消した識別子。**永続化はしない** —— リロードは「もう一度見たい」ことも
  // 意味しうるので、その場合は改めて出してよい。
  const doneKeysRef = useRef<string[]>([])
  // 地震情報の経路で判定する地震（地震の鍵）。入るのは次の 2 つ（2026-10-19 ユーザー選択「続報が
  // 届いた地震も見直す (推奨)」。→ docs/spec/action-checklist-spec.md §2「同時に成立したら緊急度の順」）。
  //   - 先頭に来た地震 … 従来どおり、届いた時点で判定する
  //   - 続報が届いた地震 … 前に見たカードの指紋（`quakeFingerprint`）と違えば届いたと分かる
  // **先頭でない地震が初めて現れただけでは入れない。** 起動時の履歴や「もっと見る」で古い地震が
  // まとめて入るたびに、何日も前の地震の帯が出ることになる。
  // 値は、先頭に来たこと・続報が届いたことに気づいた時刻。**判定するのはそこから `SUPPRESS_MS`（1 時間）以内だけ**
  // （2026-10-20 ユーザー承認。原文「推しで」、承認した案は「判定するのは最後に電文が届いてから
  // 1 時間以内の地震に限る」）。期限が無いと、寿命で消した識別子（`DONE_KEYS_MAX` 件まで）が
  // 押し出されたとき・より深刻な帯が消えたあとに、何時間も前の地震の帯が開き直す。
  // 期限の内側では続報で加わった近所の点を判定し続け、先頭の地震（もっと低い震度）に差し替えない
  // （選び方は下の `pickChecklist`）。
  const judgedQuakesRef = useRef(new Map<string, number>())
  // 地震の鍵ごとに、前に見たカードの指紋。続報が届いたかの見分けに使う。
  const seenQuakesRef = useRef(new Map<string, string>())

  const applySuppress = useCallback((record: SuppressRecord | null) => {
    suppressRef.current = record
    setSuppress(record)
    saveSuppress(record)
  }, [])

  /** 出した（または中身が同じなので触らずに済んだ）なら true。寿命が尽きて消したもので弾いたら false。 */
  const show = useCallback((next: ChecklistState): boolean => {
    // 寿命が尽きて消したものは出し直さない。
    if (doneKeysRef.current.includes(next.key)) return false
    const record = suppressRef.current
    const now = Date.now()
    const wasCollapsed = collapsedRef.current
    // 畳んだままにするのは「いま畳んでいて」「期限内で」「震度が上がっていない」ときだけ。
    const keepCollapsed =
      wasCollapsed && record != null && now < record.until && next.scale <= record.scale

    // **寿命の延長は表示の更新より先に決める。** 下の「中身が変わらないなら触らない」で先に
    // 抜けてしまうと、同じ震度が続く揺れ（強震モニタは毎秒判定する）で延長が一度も走らず、
    // まだ揺れている最中にボタンが消えうる。
    if (keepCollapsed && record.until - now < SUPPRESS_EXTEND_BELOW_MS) {
      // **基準の震度は上書きしない** —— 余震で下がっていく値に追随させると、そのうち小さな
      // 揺れでも「上がった」と見なして開いてしまう。
      applySuppress({ ...record, until: now + SUPPRESS_MS })
    }

    // 中身が変わらないなら触らない（開いた項目の状態を保つため）。**震度は比較に含める** ——
    // 同じ EEW の続報で予想が上がることがあり、キーだけで弾くとその引き上げを取りこぼす。
    const cur = stateRef.current
    if (
      cur && cur.key === next.key && cur.scale === next.scale && cur.scope === next.scope
      && wasCollapsed === keepCollapsed
    ) return true

    setState(next)
    setCollapsed(keepCollapsed)
    // 判定した範囲（`scope`）だけが変わった回は、見出しと根拠の 1 行を描き直すだけで記録しない。
    // 強震モニタは毎秒判定し、半径内の点が欠測を出入りすると `near` と `nationwide` が往復するので、
    // 記録すると同じ揺れで「帯が出た」が積み上がる
    if (cur && cur.key === next.key && cur.scale === next.scale && wasCollapsed === keepCollapsed) return true
    // 録画ツール向けの記録（→ `docs/spec/recording-interface-spec.md`）。**中身が変わらない
    // 回は上で抜けている**ので、ここへ来るのは画面が実際に動いたときだけ。畳んだまま出す
    // 場合（`keepCollapsed`）も「帯は出ている」ので開いた側として残す。
    recordReplayEvent({
      type: 'overlay', overlay: 'actionChecklist', open: true,
      reason: keepCollapsed ? '揺れを検知（畳んだまま）' : '揺れを検知',
      subject: null,
    })
    // 畳んでいたものを開き直したなら、記録は役目を終えた。開いたまま受けた揺れでは消さない
    // （`restore` で開いた人の「もう一度閉じたときの基準」として残す）。
    if (wasCollapsed && !keepCollapsed && record) applySuppress(null)
    return true
  }, [applySuppress])

  // 強震モニタの観測値。**判定は検知フレームが進むたび（高々 1 秒に 1 度）に限る。** App は EEW の
  // 予報円で 100ms ごとに再描画されるため、素で書くとレンダーのたびに走査が走る。
  //
  // 検知エンジンが詰まっている間は判定しない。空の検知結果を「揺れていない」と読むと、揺れの
  // 最中に帯を引っ込めることになる（下の `kyoshinStalled` の扱いと対になっている）。
  const kyoshinHit = useMemo(
    () => (kyoshinStalled ? null : judgeKyoshinForScope(detectedPoints, scope, minScale)),
    [detectedPoints, scope, minScale, kyoshinStalled],
  )
  const hitScale = kyoshinHit?.scale ?? null

  // 強震モニタの識別子は「その揺れの区切り」を表す必要があるが、強震モニタ自体は地震を区別
  // しない。直近の EEW か地震があればそれに紐づけ、無ければ**閾値を超えた時刻**を使う。
  // **閾値を割るまでは作り直さない** —— 揺れている最中に作り直すと、その間に EEW や地震情報が
  // 届いたときキーが入れ替わり、畳んだものが開き直す。閾値を割ったら捨て、次に超えたときは
  // 別の揺れとして扱う。
  //
  // 時刻を丸めない理由: EEW も地震情報もまだ無い数十秒の窓に別々の地震が 2 つ入ることがある
  // （群発・離れた 2 地域の同時発生）。時単位に丸めると両者が同じ識別子を共有し、1 件目を
  // 閉じたあと 2 件目が「同じ揺れの続き」として扱われて開き直さない。
  const kyoshinAnchorRef = useRef<string | null>(null)

  useEffect(() => {
    // **識別子を捨てるのは「揺れが収まった」ときだけ。** 検知エンジンが詰まって結果を出せない
    // 数秒でも `hitScale` は null になるが、そこで捨てると復帰したとき同じ揺れが別物として扱われ、
    // 畳んだ帯が開き直す。
    if (hitScale == null && !kyoshinStalled) kyoshinAnchorRef.current = null
    // **判定する地震の顔ぶれは、出さない設定の間も更新する。** 止めると、その間に先頭に来た地震を
    // 取りこぼし、その間に届いた続報は設定を戻した時刻で記録される（1 時間の期限が実際より遅れて始まる）。
    const now = Date.now()
    updateJudgedQuakes(quakes, judgedQuakesRef.current, seenQuakesRef.current, now)
    if (minScale < 0) return

    // **緊急度の順に見て、最初に成立したものを出す。** 3 つは同時に成立しうる（発報中の EEW・
    // 揺れている観測値・直前の地震の確定情報）。順序を決めずに書くと最後に評価したものが勝ち、
    // EEW が出ている最中に「強い揺れがありました」（過去形）へ落ちる。
    // **最も深刻な EEW を選ぶ。** `eews` の並びは発報を受けた順（内部の Map の挿入順）で、
    // 深刻さとは無関係。最初に閾値を超えたところで打ち切ると、後から発生したより強い地震の
    // 予想を見落とす（連続する余震や、離れた 2 地域でほぼ同時に起きたときに実際に起きる）。
    //
    // **出している帯の元が取り消された EEW・地震情報なら、まずそれを下ろしてから判定をやり直す**
    // （→ `docs/spec/action-checklist-spec.md` §4「元の EEW・地震情報が取り消されたとき」）。開いている
    // 帯は寿命でも消さない設計なので、ここで下ろさないと取り消された「震度7 強い揺れが予想されています」
    // 「強い揺れがありました」が手で閉じるまで残る。
    // 地震情報は、取消表示中のカードと同じ鍵の生きたカードが並ぶことがある（取消のあとに出し直された
    // 報）。その鍵は生きているので取り消された扱いにしない。
    const liveQuakeKeys = new Set(quakes.filter(q => !isQuakeCancelled(q)).map(q => quakeEventKey(q)))
    const cancelledKeys = new Set([
      ...eews.filter(isEewCancelled).map(e => `eew:${eewEventKey(e)}`),
      ...quakes
        .filter(q => isQuakeCancelled(q) && !liveQuakeKeys.has(quakeEventKey(q)))
        .map(q => `quake:${quakeEventKey(q)}`),
    ])
    // 取り消された帯を閉じてできた記録は捨てる（震度の基準が取り消された予想・観測から来ている）。
    // **いま出ている帯とは別に見る** —— 閉じたあと別の EEW の帯へ移っていても、記録の震度は残っている。
    const record = suppressRef.current
    if (record?.key != null && cancelledKeys.has(record.key)) applySuppress(null)
    const cur = stateRef.current
    const retracted = cur != null && cancelledKeys.has(cur.key)
    if (retracted) {
      // 識別子を持たない古い記録は、どの帯を閉じたものか分からないので捨てる側へ倒す。
      if (suppressRef.current?.key == null) applySuppress(null)
      // 記録を捨てたなら畳んだ状態も解く（記録が無いまま畳んでいると、寿命のタイマーも動かない）。
      if (suppressRef.current == null) collapsedRef.current = false
      // **ref（`stateRef`・上の `collapsedRef`）はレンダーを待たずに下ろす。** 下の `show` が
      // 「いま出ているもの」「いま畳んでいるか」をこれで見るので、取り消された帯を前提に判定させない。
      stateRef.current = null
      // 録画ツール向けの記録（画面には出ない）。切り替える場合も、取り消された帯が下りたことは 1 件残す
      // （「揺れを検知」の開いた記録だけでは、何が引っ込んだのかが読めない）。
      recordReplayEvent({
        type: 'overlay', overlay: 'actionChecklist', open: false,
        reason: cur.reason === 'quake' ? '地震情報が取り消された' : '緊急地震速報が取り消された',
        subject: null,
      })
    }
    const next = pickChecklist()
    // **切り替え先を出せなかったら消す。** `show` は寿命が尽きて消したもの（`doneKeysRef`）を弾く。
    // 地震情報は最新の 1 件が長く居座るので、切り替え先がそれだと結果を見ずに任せたとき
    // 取り消された帯が画面に残る。
    const shown = next != null && show(next)
    if (retracted && !shown) {
      setState(null)
      // 記録を残した場合は畳んだ状態を保つ（リロード直後と同じ形。次の揺れは畳んだまま出る）。
      setCollapsed(collapsedRef.current)
    }

    function pickChecklist(): ChecklistState | null {
      let eewHit: { scale: number; scope: ChecklistScope; key: string } | null = null
      for (const eew of eews) {
        if (isEewCancelled(eew)) continue
        const hit = judgeEewForScope(eew, scope, minScale)
        if (hit == null) continue
        // **報番号を含む `eew.id` は使わない。** 続報のたびにキーが変わり、畳んだものが開き直す。
        if (eewHit == null || hit.scale > eewHit.scale) eewHit = { ...hit, key: `eew:${eewEventKey(eew)}` }
      }
      if (eewHit) return { reason: 'eew', scale: eewHit.scale, scope: eewHit.scope, key: eewHit.key }

      if (kyoshinHit != null) {
        if (kyoshinAnchorRef.current == null) {
          const eewAnchor = eews.find(e => !isEewCancelled(e))
          kyoshinAnchorRef.current = (eewAnchor ? eewEventKey(eewAnchor) : null)
            ?? (latestQuake ? quakeEventKey(latestQuake) : null)
            ?? new Date().toISOString()
        }
        return { reason: 'kyoshin', scale: kyoshinHit.scale, scope: kyoshinHit.scope, key: `kyoshin:${kyoshinAnchorRef.current}` }
      }

      // **詰まっている間に地震情報へ落とさない。** 揺れが続いているのに「強い揺れがありました」
      // （過去形）へ差し替わり、震度も別の値になる。留めるのは**表示中が強震モニタ由来のときだけ**
      // —— 何も出ていない状態まで止めると、エンジンが壊れ続けている端末で地震情報の経路まで死ぬ。
      if (kyoshinStalled && stateRef.current?.reason === 'kyoshin') return null

      // **判定する地震のうち、最も深刻なものを選ぶ**（EEW と同じ。同じ震度なら一覧の前＝地震の時刻が
      // 新しい方）。判定するのは気づいてから 1 時間以内の地震だけ（`judgedQuakesRef`）。
      // **取消表示中のカードは外す。** 顔ぶれ（`updateJudgedQuakes`）は鍵で持つので、同じ鍵の生きた
      // カードと並んでいると取消カードもここまで来る。**寿命が尽きて消したものも選ぶ前に外す** ——
      // 外さないと、それが最大のとき `show` で弾かれ、閾値に達した別の地震まで出なくなる。
      let quakeHit: { scale: number; scope: ChecklistScope; key: string } | null = null
      for (const q of quakes) {
        if (isQuakeCancelled(q)) continue
        const eventKey = quakeEventKey(q)
        const judgedAt = judgedQuakesRef.current.get(eventKey)
        if (judgedAt === undefined || !isJudgedFresh(judgedAt, now)) continue
        const key = `quake:${eventKey}`
        if (doneKeysRef.current.includes(key)) continue
        const hit = judgeQuakeForScope(q, scope, minScale)
        if (hit == null) continue
        if (quakeHit == null || hit.scale > quakeHit.scale) quakeHit = { ...hit, key }
      }
      if (quakeHit) return { reason: 'quake', scale: quakeHit.scale, scope: quakeHit.scope, key: quakeHit.key }
      return null
    }
  }, [eews, kyoshinHit, kyoshinStalled, quakes, latestQuake, scope, minScale, show, applySuppress])

  // 設定で「出さない」に切り替えたら、いま出ているものも引っ込める。判定側で早期に抜けるだけ
  // では、開いたままの帯が手動で閉じるまで残り続ける（開いている間は寿命でも消さない設計のため）。
  // 畳んだ記録は残す —— 再び有効にしたとき、閉じた状態から始めるのが自然。
  useEffect(() => {
    if (minScale >= 0) return
    // 録画ツール向けの記録。**実際に出ていたときだけ**（→ `docs/spec/recording-interface-spec.md`）。
    // 設定を切った回はいつでも通るので、出ていなかった回まで記録すると
    // 「開いていないものを閉じた」が並ぶ。
    const wasShown = stateRef.current !== null
    setState(null)
    setCollapsed(false)
    if (wasShown) {
      recordReplayEvent({ type: 'overlay', overlay: 'actionChecklist', open: false, reason: '設定で「出さない」へ変えた', subject: null })
    }
  }, [minScale])

  // 畳んだままのボタンは期限が来たら消す。**開いている間は消さない** —— 読んでいる最中に
  // 消えることになる。
  useEffect(() => {
    if (!collapsed || !suppress) return
    const clear = () => {
      const key = stateRef.current?.key
      if (key) {
        doneKeysRef.current = [...doneKeysRef.current.filter(k => k !== key), key].slice(-DONE_KEYS_MAX)
      }
      setState(null)
      setCollapsed(false)
      applySuppress(null)
      // 録画ツール向けの記録。**出ていたときだけ**（`key` が無ければ元から出ていない）。
      if (key) {
        recordReplayEvent({ type: 'overlay', overlay: 'actionChecklist', open: false, reason: '寿命が尽きた', subject: null })
      }
    }
    const remain = suppress.until - Date.now()
    if (remain <= 0) {
      clear()
      return
    }
    const timer = setTimeout(clear, remain)
    return () => clearTimeout(timer)
  }, [collapsed, suppress, applySuppress])

  const dismiss = useCallback(() => {
    const cur = stateRef.current
    setCollapsed(true)
    if (!cur) return
    applySuppress({ until: Date.now() + SUPPRESS_MS, scale: cur.scale, key: cur.key })
  }, [applySuppress])

  // 畳んだボタンを押して開く。**抑止の記録は消さない** —— 開いている間は `keepCollapsed` が
  // 成立しないので畳まれることはなく、記録は「もう一度閉じたときの震度の基準」として残る。
  const restore = useCallback(() => setCollapsed(false), [])

  /**
   * リプレイの開始・停止で落とす。**時間軸に紐づくものだけ。**
   *
   * - 表示中の帯（`state`）—— 入力（地震・EEW・揺れ）が空になっても消える経路が無いため、
   *   落とさないと切替前の地震の帯が新しい時間軸の画面に残る
   * - `doneKeysRef`（寿命が尽きて消した識別子）—— 残すと、同じ地震を再生しても二度と出ない
   * - `kyoshinAnchorRef`（強震モニタ由来の揺れの識別子）
   * - `judgedQuakesRef`・`seenQuakesRef`（判定する地震と、前に見たカードの指紋）—— 残すと、
   *   新しい時間軸で同じ地震を再生したとき、旧い軸で見た `id` と比べて「続報が届いた」と取り違える
   *
   * **抑止の記録（`SuppressRecord`）は落とさない。** 利用者が閉じた意思で、永続化してある
   * （リプレイへ入った途端に開き直すのは閉じた意思を無視することになる）。期限は壁時計で
   * 管理しており、再生時計とは意図的に切り離してある（早送りで即座に失効させないため）。
   *
   * **畳んだ状態は記録から引き直す。** `false` へ倒すと「いま畳んでいる」が偽になり、
   * 記録が残っているのに次の揺れが開いて出る（畳んだままにする条件の 1 つが「いま畳んでいる」
   * ため）。**リロード直後と同じ形**にするのが筋で、初期値と同じ式で決める。
   */
  const resetForReplay = useCallback(() => {
    doneKeysRef.current = []
    kyoshinAnchorRef.current = null
    judgedQuakesRef.current.clear()
    seenQuakesRef.current.clear()
    setState(null)
    setCollapsed(suppressRef.current !== null)
  }, [])

  return { state, collapsed, dismiss, restore, resetForReplay }
}
