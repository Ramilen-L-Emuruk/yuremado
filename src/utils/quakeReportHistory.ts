import type {
  JMAEstimatedIntensity, JMAInternationalTsunami, JMALpgm, JMAQuake, JMATsunami,
} from '../types/earthquake'
import type { AreaPrefIndex } from './quakePoints'
import {
  extractQuakeEventId, foldQuakeTelegrams, mergeQuakeInto, quakeEventKey, quakeHoldBack, reportOrderKey,
  type QuakeHoldBackReason,
} from './quakeMerge'
import { withBorrowedFromTsunami } from './borrowFromTsunami'
import { withLatestQuakeFacts } from './latestQuakeFacts'
import { tsunamiEventIds } from './tsunami'
import {
  advanceQuakeMarks, markIssuedAt, quakeFactSnapshot, quakeRowSnapshot, quakeTelegramRevise,
  type QuakeCardMarks, type QuakeMarkMemory, type QuakeMarkSnapshot,
} from './quakeUpdateMark'
import { msOf, quakeTelegramLabels, sortTimeline } from './quakeReportTimeline'
import { log } from './logger'

/**
 * 開いた地震カードの「更新 ▾」の報の一覧で、**報を押すとその報の時点のカードを出す**ための組み立て
 * （2026-11-07 ユーザー依頼「それぞれの報をタップすることでその時点のカードを表示できるようにしませんか？
 * その際、更新の印も出せるようにしたいです。」。決まったことは docs/spec/quake-spec.md「報の一覧から前の報を見る」）。
 *
 * **その時点のカードは、押した行とそれより上の行の報だけで組む。** 地震情報はカードの控え（`sourceTelegrams`）から
 * 当て直し、長周期・推計・国際津波・津波はその行までに届いていたものだけを、ライブと同じ当て方（借りる → 上段へ当てる）で
 * 当てる（同日選択「その時刻までの全部で組む (Recommended)」）。
 *
 * **カードが採らなかった報（捨てた報）も一覧に並べ、押すと「採っていたら」の姿を出す**（同日のユーザー発言「どうせなら
 * 捨てた報も一覧にグレーとかで乗せて選択できるようにして何が更新されるかもしれなかったか見れるようにしませんか？
 * もちろんほかの動きは今と変わりなくです。」）。採らない判定は受信と同じ {@link quakeHoldBack}、採ったときの姿は
 * 統合の据え置きだけを飛ばして作る（`mergeQuakeInto` の `ignoreHoldBack`）。**ライブの統合・音・読み上げは何も変えない。**
 *
 * **印はライブと同じ規則で、直前の報と比べる**（同日選択「直前の報とライブと同じ規則 (Recommended)」）。捨てた報は
 * その時点の実際のカードと比べる（同日選択「その時点の実際のカードと (Recommended)」）。最初の報は比べる相手が無いので付かない。
 *
 * **すべて純関数。** 一覧は開いたカードでだけ組み、印は押した行についてだけ組む（行の写しは観測点の数だけ重い）。
 */

/** 一覧の行の種類。 */
export type QuakeHistoryEntryKind = 'quake' | 'lpgm' | 'internationalTsunami' | 'estimated' | 'tsunami'

/** 報の一覧の 1 行。 */
export interface QuakeHistoryEntry {
  /** 行を指す鍵。押した行を覚えるのに使う（同じ報なら、一覧を組み直しても同じ値になる）。 */
  id: string
  kind: QuakeHistoryEntryKind
  /** 一覧に出す名前（例「震源・震度情報 #2」）。 */
  label: string
  /** 発表時刻（ミリ秒）。読めなければ null（一覧の末尾）。 */
  ms: number | null
  /** カードが採らなかった報なら、その理由（→ {@link quakeHoldBack}）。 */
  heldBack?: QuakeHoldBackReason
  /** その時点でカードがまだ無い（地震情報より先に届いた報）。押せない。 */
  noCard?: true
}

/** 地震へ値を貸した津波の報 1 通ぶんの記録（→ {@link recordTsunamiFactStep}）。 */
export interface TsunamiFactStep {
  /** 届いた津波電文の識別子（`JMATsunami.id`）。一覧の行の鍵にする（記録が増減しても同じ報を指すように）。 */
  id?: string
  /** 届いた津波電文の発表時刻（`Head/ReportDateTime`）。 */
  time: string
  /** 届いた津波電文の作成時刻のミリ秒（あれば）。 */
  createdAtMs?: number
  /** 一覧の行に出す名前（電文の情報名 `Head/Title`）。 */
  label: string
  /** その報を当てたとき、地震カードへの当て込みが見た津波の一覧（状態の津波と、取消ならその報自身）。 */
  tsunamis: readonly JMATsunami[]
}

/** 組み立てに使うもの。どれも、いま画面のカードに当てている値（最新）を渡す。 */
export interface QuakeHistoryInputs {
  /** 画面に出している地震カード（最新）。 */
  card: JMAQuake
  /** このカードの長周期地震動の報（最新の 1 報）。 */
  lpgm: JMALpgm | undefined
  /** このカードに添える国際津波関連情報。 */
  internationalTsunamis: readonly JMAInternationalTsunami[]
  /** このカードの推計震度分布図（最新。前の報は `previousVersions`）。 */
  estimatedIntensity: JMAEstimatedIntensity | null | undefined
  /** 地震へ値を貸した津波の報の記録（古い順・全地震ぶん。このカードに関わるものだけを拾う）。 */
  tsunamiSteps: readonly TsunamiFactStep[]
  /** いまの津波の一覧（記録が無いとき、カードが覚えている借り物から 1 行を作るのに使う）。 */
  tsunamis: readonly JMATsunami[]
  /** 津波の原因地震と地震カードを結ぶ相手（ふつうは地震の一覧）。 */
  quakes: readonly JMAQuake[]
  areaPrefIndex: AreaPrefIndex
}

/** 押した報の時点の姿。地図とカードへ配る。 */
export interface QuakeHistoryView {
  entryId: string
  /** その時点のカード（捨てた報なら「採っていたら」の姿）。 */
  quake: JMAQuake
  /** その時点で届いていた長周期地震動の報（無ければ undefined）。 */
  lpgm: JMALpgm | undefined
  /** その時点で届いていた国際津波関連情報。 */
  internationalTsunamis: readonly JMAInternationalTsunami[]
  /** その時点の推計震度分布図の版（無ければ null）。 */
  estimatedIntensity: JMAEstimatedIntensity | null
  /** その報で動いた所の印（無ければ undefined）。 */
  marks: QuakeCardMarks | undefined
  heldBack?: QuakeHoldBackReason
}

/** 報の一覧の行を組む。行の並びは発表時刻の古い順（{@link sortTimeline}）。 */
export function quakeHistoryEntries(inputs: QuakeHistoryInputs): QuakeHistoryEntry[] {
  return walk(inputs, null, false).entries
}

/**
 * 押した行の時点の姿を組む。その行が一覧に無い・押せない行なら null。
 *
 * 印を組むので {@link quakeHistoryEntries} より重い。押したときだけ呼ぶ。
 */
export function quakeHistoryView(inputs: QuakeHistoryInputs, entryId: string): QuakeHistoryView | null {
  return walk(inputs, entryId, true).view
}

// --- 地震へ値を貸した津波の報の記録 ---

/** 記録の上限。津波は年に数回で、1 つの津波の続報は 40 通を超えることがある（能登の実電文）。 */
export const TSUNAMI_FACT_STEPS_MAX = 300

/**
 * 津波の報を当てて地震カードが変わったなら、その報を記録へ積む。変わらなければ同じ配列を返す。
 *
 * **津波の状態は地震ごとに最新の 1 件だけ**なので、前の報から借りていた値は中身が消える。報の一覧で前の時点を押したとき
 * その時点の値を出せるよう、カードを変えた報ごとに、当て込みが見た津波の一覧を残す（2026-11-07 ユーザー選択
 * 「報ごとに残す (Recommended)」）。**値の変わらない続報（観測情報だけの報など）は積まない。**
 *
 * どのカードとも結べなくなった記録（地震カードが一覧から落ちた）は捨てる。
 */
export function recordTsunamiFactStep(
  steps: readonly TsunamiFactStep[],
  incoming: JMATsunami,
  seen: readonly JMATsunami[],
  cardsBefore: readonly JMAQuake[],
  cardsAfter: readonly JMAQuake[],
): readonly TsunamiFactStep[] {
  if (cardsAfter === cardsBefore) return steps
  const step: TsunamiFactStep = {
    id: incoming.id,
    time: incoming.time,
    ...(incoming.createdAtMs !== undefined && { createdAtMs: incoming.createdAtMs }),
    label: incoming.infoName || '津波情報',
    tsunamis: seen,
  }
  const ids = new Set<string>()
  for (const c of cardsAfter) {
    const own = extractQuakeEventId(c)
    if (own) ids.add(own)
    for (const id of c.appliedTsunamiSource?.eventIds ?? []) ids.add(id)
  }
  const kept = [...steps, step].filter(s => s.tsunamis.some(t => tsunamiEventIds(t).some(id => ids.has(id))))
  return kept.length > TSUNAMI_FACT_STEPS_MAX ? kept.slice(kept.length - TSUNAMI_FACT_STEPS_MAX) : kept
}

// --- 組み立て ---

type Candidate =
  | { kind: 'quake'; id: string; label: string; ms: number | null; telegram: JMAQuake }
  | { kind: 'lpgm'; id: string; label: string; ms: number | null; lpgm: JMALpgm }
  | { kind: 'internationalTsunami'; id: string; label: string; ms: number | null; intl: JMAInternationalTsunami }
  | { kind: 'estimated'; id: string; label: string; ms: number | null; ei: JMAEstimatedIntensity }
  | { kind: 'tsunami'; id: string; label: string; ms: number | null; tsunamis: readonly JMATsunami[] }

function candidatesOf(inputs: QuakeHistoryInputs): Candidate[] {
  const { card } = inputs
  const telegrams = card.sourceTelegrams ?? [card]
  const labels = quakeTelegramLabels(telegrams)
  // 同じ分の報の前後は作成時刻で決まる（→ `reportOrderKey`）。一覧は分までの時刻で並べるので、先に作成時刻の順へ
  // 並べておき、同じ分の中でも当て直しと同じ順に並ぶようにする
  const ordered = telegrams.map((t, i) => ({ t, i }))
    .sort((a, b) => reportOrderKey(a.t) - reportOrderKey(b.t) || a.i - b.i)
  const out: Candidate[] = ordered.map(({ t, i }) => ({
    kind: 'quake', id: `quake:${t.telegramKey ?? `${t.id}|${t.time}|${t.issue.type}|${i}`}`,
    label: labels.get(t) ?? t.issue.type, ms: msOf(t.issue.time), telegram: t,
  }))
  if (inputs.lpgm && !inputs.lpgm.cancelled) {
    const l = inputs.lpgm
    out.push({ kind: 'lpgm', id: `lpgm:${l.eventId}|${l.time}`, label: l.infoName ?? '長周期地震動に関する観測情報', ms: msOf(l.time), lpgm: l })
  }
  for (const x of inputs.internationalTsunamis) {
    out.push({ kind: 'internationalTsunami', id: `intl:${x.time}|${x.title}`, label: '国際津波関連情報', ms: msOf(x.time), intl: x })
  }
  const ei = inputs.estimatedIntensity
  if (ei) {
    for (const v of [...(ei.previousVersions ?? []), ei]) {
      out.push({ kind: 'estimated', id: `estimated:${v.id}|${v.time}`, label: '推計震度分布図', ms: msOf(v.time), ei: v })
    }
  }
  for (const s of tsunamiStepsFor(inputs)) {
    out.push({ kind: 'tsunami', id: `tsunami:${s.id ?? `${s.time}|${s.label}`}`, label: s.label, ms: msOf(s.time), tsunamis: s.tsunamis })
  }
  return withUniqueIds(sortTimeline(out))
}

/**
 * 行の鍵を一意にする。同じ鍵が重なったら（同じ電文の鍵が 2 通あるなど）、2 つ目から出現の番号を足す。
 * **並びの番号では作らない** —— 記録の増減で番号がずれると、押した行が別の報を指す。
 */
function withUniqueIds(list: Candidate[]): Candidate[] {
  const seen = new Map<string, number>()
  return list.map(c => {
    const n = seen.get(c.id) ?? 0
    seen.set(c.id, n + 1)
    return n === 0 ? c : { ...c, id: `${c.id}#${n + 1}` }
  })
}

/**
 * このカードに関わる津波の報。記録（{@link recordTsunamiFactStep}）から拾い、**記録が 1 通も無いのにカードが津波から値を
 * 借りていれば、いまの津波の一覧で 1 行を作る**（履歴から組み直したカードは、借りた時点の報の記録を持たない）。
 */
function tsunamiStepsFor(inputs: QuakeHistoryInputs): readonly TsunamiFactStep[] {
  const { card } = inputs
  const ids = new Set<string>(card.appliedTsunamiSource?.eventIds ?? [])
  const own = extractQuakeEventId(card)
  if (own) ids.add(own)
  if (ids.size === 0) return []
  const related = (ts: readonly JMATsunami[]) => ts.some(t => tsunamiEventIds(t).some(id => ids.has(id)))
  const mine = inputs.tsunamiSteps.filter(s => related(s.tsunamis))
  if (mine.length > 0) return mine
  const src = card.hypocenterSource ?? card.domesticTsunamiSource ?? card.appliedTsunamiSource?.mark
  if (!src || !related(inputs.tsunamis)) return []
  return [{ time: src.reportTime, label: src.infoName, tsunamis: inputs.tsunamis }]
}

const NO_TSUNAMIS: readonly JMATsunami[] = []

/** その時点で当てる材料（地震情報の当て直しの結果と、それまでに届いた他の報）。 */
interface Scene {
  core: JMAQuake | undefined
  lpgm: JMALpgm | undefined
  intl: JMAInternationalTsunami[]
  ei: JMAEstimatedIntensity | null
  tsunamis: readonly JMATsunami[]
}

/** 材料から画面のカードを組む。ライブと同じ順（津波から借りる → 長周期・推計・津波の新しい値を上段へ当てる）。 */
function cardOf(scene: Scene, core: JMAQuake, quakes: readonly JMAQuake[]): JMAQuake {
  const lpgmMap = new Map<string, JMALpgm>()
  if (scene.lpgm) lpgmMap.set(scene.lpgm.eventId, scene.lpgm)
  const borrowed = withBorrowedFromTsunami(core, scene.tsunamis, quakes)
  return withLatestQuakeFacts(borrowed, lpgmMap, scene.ei ? [scene.ei] : [], scene.tsunamis, quakes)
}

/** 画面で見える値（上段・津波から借りた印）が同じか。津波の行を一覧に出すかを決める。 */
function sameShownFacts(a: JMAQuake | undefined, b: JMAQuake | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const fa = quakeFactSnapshot(a)
  const fb = quakeFactSnapshot(b)
  for (const [k, v] of fa) if (fb.get(k)?.key !== v.key) return false
  return a.hypocenterSource?.reportTime === b.hypocenterSource?.reportTime
    && a.domesticTsunamiSource?.reportTime === b.domesticTsunamiSource?.reportTime
}

function snapshotOf(
  card: JMAQuake,
  before: QuakeMarkMemory | undefined,
  telegram: JMAQuake | null,
  areaPrefIndex: AreaPrefIndex,
): QuakeMarkSnapshot {
  return {
    facts: quakeFactSnapshot(card),
    // 地震情報でない報は行（観測点・市町村）を運ばない。前の写しを使う（ライブの `applyLatestFactsWithMarks` と同じ）
    rows: telegram || !before ? quakeRowSnapshot(card.points, card.cities ?? [], areaPrefIndex) : before.rows,
    issuedAt: markIssuedAt(card.issue.time),
    reportType: card.issue.type,
    telegramType: telegram ? telegram.issue.type : before?.telegramType ?? null,
    revise: telegram ? quakeTelegramRevise(telegram) : null,
  }
}

function walk(
  inputs: QuakeHistoryInputs,
  target: string | null,
  withMarks: boolean,
): { entries: QuakeHistoryEntry[]; view: QuakeHistoryView | null } {
  const { card, quakes, areaPrefIndex } = inputs
  const key = quakeEventKey(card)
  const liveKeys = new Set([key])
  const scene: Scene = { core: undefined, lpgm: undefined, intl: [], ei: null, tsunamis: NO_TSUNAMIS }
  const folded: JMAQuake[] = []
  let maxOrder = Number.NEGATIVE_INFINITY
  let shown: JMAQuake | undefined
  let memory: ReadonlyMap<string, QuakeMarkMemory> = new Map()
  const noMarks: ReadonlyMap<string, QuakeCardMarks> = new Map()
  const entries: QuakeHistoryEntry[] = []
  let view: QuakeHistoryView | null = null

  const advance = (next: JMAQuake, telegram: JMAQuake | null) => {
    const state = advanceQuakeMarks({
      prev: { memory, marks: noMarks }, key,
      snapshot: snapshotOf(next, memory.get(key), telegram, areaPrefIndex), liveKeys, now: 0,
    })
    return state
  }

  for (const c of candidatesOf(inputs)) {
    let heldBack: QuakeHoldBackReason | undefined
    let hypothetical: JMAQuake | undefined
    if (c.kind === 'quake') {
      const t = c.telegram
      const held = scene.core ? quakeHoldBack(scene.core, t) : null
      if (held && scene.core) {
        heldBack = held.reason
        hypothetical = mergeQuakeInto(scene.core, t, { quiet: true, ignoreHoldBack: true })
      }
      folded.push(t)
      const order = reportOrderKey(t)
      // 作成時刻の順に当てる。前の報より古い報が後ろに並んだとき（分までの時刻では前後が決まらない組）は当て直す
      scene.core = scene.core === undefined
        ? { ...mergeQuakeInto(undefined, t, { quiet: true }), eventKey: key }
        : order < maxOrder
          ? refold(card, folded, areaPrefIndex, scene.core)
          : mergeQuakeInto(scene.core, t, { quiet: true })
      maxOrder = Math.max(maxOrder, order)
    } else if (c.kind === 'lpgm') scene.lpgm = c.lpgm
    else if (c.kind === 'internationalTsunami') scene.intl = [...scene.intl, c.intl]
    else if (c.kind === 'estimated') scene.ei = c.ei
    else scene.tsunamis = c.tsunamis

    const next = scene.core ? cardOf(scene, scene.core, quakes) : undefined
    // 津波の行は、カードの見える値を変えた報だけ並べる（値の変わらない続報で一覧を埋めない）
    if (c.kind === 'tsunami' && sameShownFacts(shown, next)) {
      shown = next
      continue
    }
    const entry: QuakeHistoryEntry = {
      id: c.id, kind: c.kind, label: c.label, ms: c.ms,
      ...(heldBack && { heldBack }),
      ...(!next && { noCard: true as const }),
    }
    entries.push(entry)

    const telegram = c.kind === 'quake' ? c.telegram : null
    if (c.id === target && next) {
      const viewCard = withRetractionsUntil(hypothetical ? cardOf(scene, hypothetical, quakes) : next, card, c.ms)
      // 最初の報は比べる相手が無い（ライブも初報には印を付けない）
      const marks = withMarks && shown ? advance(viewCard, telegram).marks.get(key) : undefined
      view = {
        entryId: c.id, quake: viewCard, lpgm: scene.lpgm, internationalTsunamis: scene.intl,
        estimatedIntensity: scene.ei, marks, ...(heldBack && { heldBack }),
      }
      // 押した行より下は要らない
      break
    }
    // 捨てた報ではカードは変わらない。記憶も進めない（ライブも据え置いた報で画面は動かない）
    if (withMarks && next && !heldBack) memory = advance(next, telegram).memory
    if (!heldBack) shown = next
  }
  return { entries, view }
}

/** 当て直しが 1 通も残さなかったとき（取り下げ済みの報を飛ばした結果など）。前の姿のまま進め、記録を残す。 */
function refold(card: JMAQuake, folded: readonly JMAQuake[], areaPrefIndex: AreaPrefIndex, prev: JMAQuake): JMAQuake {
  const next = foldQuakeTelegrams(card, folded, areaPrefIndex)
  if (next) return next
  log.error('[地震タブ] 報の一覧の時点のカードを当て直せず、前の報の姿のまま進めます', { eventKey: quakeEventKey(card), telegrams: folded.length })
  return prev
}

/**
 * 一部取消の帯（`retractedReports`）を、その時点までに届いた取消だけにする（2026-11-07 ユーザー選択「取消より前の時点では
 * 出さない (Recommended)」）。取消の時刻は取消電文の発表時刻（`cancelTime`。長周期の取消は `reportTime` が取消電文の時刻）。
 * 時刻の読めない行（`ms` が null）では最新のカードと同じ帯を出す。
 */
function withRetractionsUntil(view: JMAQuake, latest: JMAQuake, ms: number | null): JMAQuake {
  const all = latest.retractedReports ?? []
  const kept = ms === null ? all : all.filter(r => {
    const at = msOf(r.cancelTime ?? r.reportTime)
    return at !== null && at <= ms
  })
  if (kept.length === 0) {
    if (!view.retractedReports) return view
    const { retractedReports: _gone, ...rest } = view
    return rest as JMAQuake
  }
  return { ...view, retractedReports: kept }
}
