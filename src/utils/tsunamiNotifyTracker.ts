import type { JMATsunami, TsunamiArea, TsunamiGrade, TsunamiObservation } from '../types/earthquake'
import {
  GRADE_PRIORITY, tsunamiLiftedAreas, tsunamiMaxGrade, isTsunamiGradeReport, isTsunamiObservationOnly, isTsunamiContinuation,
  isTsunamiExpired, mergeTsunamiObservations, isObservationMissing, firstWaveSpokenKey, changedObservationFields,
  sortObservationsForCardDisplay, isPartialTsunamiRetraction, type ObsUpdateMark, type TsunamiStateStep,
} from './tsunami'
import { tsunamiIssueNotification, tsunamiLiftNotification, tsunamiEndNotification, tsunamiObservationNotification, tsunamiPartialRetractionNotification, type TsunamiNotification } from './tsunamiNotification'

/**
 * 津波の報を受けたときの、通知と観測点の印の判定。**アプリの受信処理（`useLiveEventHandler`）と中継のプッシュ通知が同じものを使う**
 * （中継は `src/app` に写して読む）。ここに置くのは画面の部品（寄せ先・タイマー・音・読み上げ）に触れない純関数と、
 * それが進める記憶の形だけ。どの順で呼ぶか（新しい津波で記憶を落とす・取消の重複を止める）は呼び出し側が持つ。
 */

/** カードの並びを引くための材料（→ {@link tsunamiCardOrderBasis}）。仕様書での呼び方も「材料」で揃えている。 */
export interface TsunamiCardOrderBasis {
  /** カードが描いている区域。 */
  areas: TsunamiArea[]
  /** カードが持っている観測点の全体（マージ済み）。 */
  observations: TsunamiObservation[]
  /** カードの解除カードに並ぶ区域（カードと同じく `tsunamiAreaGradeChanges` の解除の組の順）。 */
  liftedAreas: TsunamiArea[]
}

/**
 * カードの並びを引くための材料を作る ―― カードが描いている区域と、カードが持っている観測点の全体。
 *
 * **受信した電文の値をそのまま使ってはいけない。** 区域は観測情報の続報が持たず
 * （`isTsunamiObservationOnly`）、観測点はどの報も「その報が載せた分」しか持たない。一方カードは
 * 前の発表の区域を出したまま観測点を足していくので、画面が出している津波と混ぜて初めてカードと同じ材料になる。
 *
 * 区域の並びは「その区域で最も深刻な実測波高」で決まるため（`sortAreasForCardDisplay`）、
 * 電文の観測点だけで並べると**観測を持たない区域として後ろへ回り、カードと逆転する**。等級を
 * 切り替える報（警報 → 注意報など）は観測点をほとんど載せないので、そこが最も大きくずれる。
 *
 * この材料を渡す先は 4 つあり、どれもカードと並びが食い違うと実害が出る（**増減したら、この数を
 * 書いている他の 2 箇所も直す。** 場所は `tsunami-spec.md` §9 が挙げている）:
 * 読み上げ（追従スクロールがカード上を往復する）・ブラウザ通知の区域（カードの上位と違う区域を
 * 代表として挙げる）・受信時スクロールの送り先（カードの先頭でない区域へ寄る）・区域単位で等級が
 * 動いた報（`tsunamiAreaGradeChanges` が遷移ごとに区域を並べる。**この並びは読み上げと寄せ先の
 * 両方がそのまま使う**ので、前の 3 つとは別に材料を渡す先が 1 つある）。
 * カードのハイライト（`setAreaGradeChangedKeys`）も同じ組から作るが、Set にするため並びに依らない。
 *
 * **引き継ぐ条件はカードと同じ述語（`isTsunamiContinuation`）で判定する。** カードは別の地震の
 * 津波・解除表示中のカードからは値を引き継がず、`eventId` を持たない電文では
 * そもそも蓄積しない。ここだけ無条件に混ぜると、**カードに無い観測点で並べ替えた結果**を
 * 上の 4 つが使うことになる。
 *
 * `displayed` はアプリでは画面が出している津波（`tsunamisRef.current[0]`）、中継では前の報までを当てた津波。
 *
 * **既知の限界（アプリだけ）**: `tsunamisRef` は App のレンダーで代入されるため、キューのディスパッチャが 1 tick で津波電文を
 * 2 件以上さばいたときは 2 件目がバッチ前の値を見る。並びがカードと 1 件分ずれるだけで、読み上げる内容も新旧の言い分けも
 * 変わらない（言い分けの基準は `spokenObsHeightRef`）。中継は前の報を当てた津波を渡すので、この限界は無い。
 */
export function tsunamiCardOrderBasis(event: JMATsunami, displayed: JMATsunami | undefined): TsunamiCardOrderBasis {
  const inherited = isTsunamiContinuation(displayed, event) ? displayed : undefined
  const observations = mergeTsunamiObservations(inherited?.observations, event.observations ?? []) ?? []
  // 解除された区域も区域と同じく、区域を伝えている報なら新報、伝えていない報なら前報から取る
  // （`mergeTsunamiReports` の規則）。引き継ぎ元が無い報はカードがその報をそのまま描くので、その報から取る。
  const liftedSource = event.areas.length > 0 || !inherited ? event : inherited
  return {
    areas: event.areas.length > 0 ? event.areas : (inherited?.areas ?? []),
    observations,
    liftedAreas: tsunamiLiftedAreas(liftedSource, observations),
  }
}

/**
 * 届いた報を、音・読み上げ・通知の前で落とすか（2026-10-21 ユーザー選択「案1で」）。当てた結果で津波が終わった
 * （`outdated`）か、取消でない報が届いた時点で期限を過ぎている。`ended` は前者（津波の記憶を解除と同じく落とす）。
 */
export function tsunamiReportDropped(step: TsunamiStateStep | null, event: JMATsunami, now: Date | null): { dropped: boolean; ended: boolean } {
  const ended = step?.kind === 'ended' && step.reason === 'outdated'
  return { dropped: ended || (!event.cancelled && isTsunamiExpired(event, now)), ended }
}

/**
 * 等級を発表する報で、等級の動かない続報か（区域が空の観測情報を含む。引き下げは含めない）。観測点の印の分け方と
 * 音の種別がこれを見る。`prevGrade` は直前までに受けた等級（{@link nextTsunamiGrade} で進める）。
 */
export function isTsunamiSameGradeReport(event: JMATsunami, prevGrade: KnownTsunamiGrade | null): boolean {
  return isTsunamiObservationOnly(event)
    || (prevGrade !== null && GRADE_PRIORITY[tsunamiMaxGrade(event)] === GRADE_PRIORITY[prevGrade])
}

/** 解除・取消でない報を受けたあとの等級の記憶。等級を読めない報（`Unknown`。区域を持たない観測情報など）では進めない。 */
export function nextTsunamiGrade(prev: KnownTsunamiGrade | null, event: JMATsunami): KnownTsunamiGrade | null {
  const grade = tsunamiMaxGrade(event)
  return grade === 'Unknown' ? prev : grade
}

/**
 * 観測点の画面用の記憶（バッジ・印・観測の通知の判定に使う）。読み上げ用の記憶は別にあり、進め方が違う
 * （画面は受信した全観測点を受信時に進め、読み上げは声にした分だけ発話の直前に進める）。
 */
export interface TsunamiObsDisplayMemory {
  /** これまでに一度でも受信した観測点名（波高未確定のまま新規到達した観測点の検出用）。 */
  readonly seenNames: Set<string>
  /** 観測点ごとに受信済みの最大波高。 */
  readonly maxHeights: Map<string, { value: number; over?: boolean }>
  /** 観測点ごとに受信済みの「最大波の観測時刻」（波高が据え置きで時刻だけが進む報があるので別に持つ）。 */
  readonly maxHeightTimes: Map<string, string>
  /** 観測点ごとに画面へ出した第1波の内容（`firstWaveSpokenKey` の鍵）。 */
  readonly firstWaves: Map<string, string>
  /** 直前の報で欠測だった観測点（欠測へ転じたかを見る。最高値の記憶では「欠測のまま続く」と見分けられない）。 */
  readonly missing: Set<string>
  /** 直前の報が載せていた波高（最高値と比べると、下がったまま続く報のたびに印が付く）。 */
  readonly reportedHeights: Map<string, { value: number; over?: boolean }>
}

export function createTsunamiObsDisplayMemory(): TsunamiObsDisplayMemory {
  return { seenNames: new Set(), maxHeights: new Map(), maxHeightTimes: new Map(), firstWaves: new Map(), missing: new Set(), reportedHeights: new Map() }
}

/** 終わった津波・別の津波へ移ったときに落とす。 */
export function clearTsunamiObsDisplayMemory(memory: TsunamiObsDisplayMemory): void {
  memory.seenNames.clear()
  memory.maxHeights.clear()
  memory.maxHeightTimes.clear()
  memory.firstWaves.clear()
  memory.missing.clear()
  memory.reportedHeights.clear()
}

/** 読めた等級（`Unknown` を除く）。等級の記憶はこれだけを持つ。 */
export type KnownTsunamiGrade = Exclude<TsunamiGrade, 'Unknown'>

const NO_PREV_HEIGHTS: ReadonlyMap<string, { value: number; over?: boolean }> = new Map()

/**
 * 波高の記憶だけを進める（名前は覚えない）。
 *
 * **欠測の観測点に使う。** 欠測の読み上げは「これまでに◯◯で3.2メートル以上を観測したのち、
 * 欠測となっています」の形で波高を声にするため、波高は既読へ進めるのが正しい（声になった分だけ
 * 記録する規約）。一方**名前を到達確認の記憶（`spokenObsNamesRef`）へ入れてはいけない**——
 * 入れると、観測が復帰して到達が確認できたときに「もう読んだ」と見なされて黙る。
 *
 * **記憶は高水位マーク式**（値が上がったとき・`over` が新しく付いたときだけ進める）。電文の
 * `MaxHeight` は「これまでの最大波」なので下がらないのが常で、下がる報は訂正にあたる。深刻さが
 * 後退したことを「更新」として扱わないための形。
 *
 * **`over` が外れる向きも記録しない。** 地図のカメラ（`utils/tsunami.ts` の
 * `hasObservedHeightChanged`）が向きを問わず拾うのとは**意図的に非対称**で、あちらは「動いたか」、
 * こちらは「深刻になったか」を問う。そのぶん「`over` が外れ、また付く」続報では 2 度目の昇格を
 * 取りこぼすが、その形は標本 A（地震情報の区分の 2020-11〜2026-10 のアーカイブ）で見つかっていない（→ docs/spec/tsunami-spec.md §6）。ただし `over` が
 * 付いた観測点そのものが 1 点しかないので、起きないとまでは言えない（→ docs/spec/telegram-coverage-audit.md §7「前提を全期間で数えた結果」）。
 */
export function rememberObservationHeights(
  obs: readonly TsunamiObservation[],
  heights: Map<string, { value: number; over?: boolean }>,
): void {
  for (const o of obs) {
    if (!o.height) continue
    const prev = heights.get(o.name)
    if (prev === undefined || o.height.value > prev.value || (o.height.over && !prev.over)) {
      heights.set(o.name, { value: o.height.value, over: o.height.over })
    }
  }
}

/**
 * 観測点の到達と最大波高を記録する。
 *
 * **記憶が 2 つあるので、どちらに書くかは呼び出し側が決める。** 画面（バッジ・スクロール）用は
 * 受信時に、読み上げ用は発話を始める瞬間に進める。
 * 同じ手順を 2 度書くと、片方だけ「同値でも over への昇格は記録する」といった条件を取り落とす。
 */
export function rememberObservations(
  obs: readonly TsunamiObservation[],
  names: Set<string>,
  heights: Map<string, { value: number; over?: boolean }>,
): void {
  for (const o of obs) names.add(o.name)
  rememberObservationHeights(obs, heights)
}

/**
 * 画面用の記憶を、その報が載せた観測点で進める。**ライブ経路とリプレイ復元の両方から呼ぶこと。**
 *
 * - 到達・最大波高・最大波の観測時刻・第1波は「これまで」を進める（時刻を波高と別に持つのは、波高は
 *   上がったときだけ更新するため。混ぜると波高が据え置きの報で時刻だけが取り残される）
 * - 欠測だったか・載っていた波高は「直前の報」で置き換える。載っていない観測点は、その報が何も語っていないので触らない
 */
export function rememberTsunamiObsDisplay(obs: readonly TsunamiObservation[], memory: TsunamiObsDisplayMemory): void {
  rememberObservations(obs, memory.seenNames, memory.maxHeights)
  for (const o of obs) {
    if (o.maxHeightDateTime) memory.maxHeightTimes.set(o.name, o.maxHeightDateTime)
    const firstWave = firstWaveSpokenKey(o)
    if (firstWave) memory.firstWaves.set(o.name, firstWave)
    if (isObservationMissing(o)) memory.missing.add(o.name)
    else memory.missing.delete(o.name)
    if (o.height) memory.reportedHeights.set(o.name, { value: o.height.value, over: o.height.over })
  }
}

/** {@link tsunamiObservationMarks} の答え。 */
export interface TsunamiObservationMarks {
  /** その報でカードの行に付ける印（観測点名 → 印）。 */
  readonly entries: readonly (readonly [string, ObsUpdateMark])[]
  /** 寄せ先を決めるのに使う、波高を持つ観測点（等級の動かない続報では動いたものだけ、それ以外はその報の全件）。 */
  readonly focusWithHeight: TsunamiObservation[]
  /** 寄せ先を決めるのに使う、波高を持たない観測点（初出・項目が動いた・欠測へ転じた）。 */
  readonly focusWithoutHeight: TsunamiObservation[]
}

/**
 * 解除・取消でない津波の報で、カードのどの観測点の行に印を付けるか。**記憶は読むだけで進めない**（進めるのは
 * {@link rememberTsunamiObsDisplay}。呼び出し側が印を使い終えてから呼ぶ）。
 *
 * - **等級の動かない続報（`sameGradeReport`）では、何かが動いた観測点だけ。** 波高を持つ観測点は項目が動いたか欠測へ
 *   転じたもの、波高を持たない観測点（到達確認・欠測）はそれに加えて初めて載ったもの。印の判定・バッジ・寄せ先・
 *   行に出す項目の印は同じ判定（`changedObservationFields`）から出す —— 別々に書くと、読み上げが名指しした観測点の
 *   バッジが点滅しない食い違いを作る
 * - **等級が動いた報では、動いたものだけに印を付ける**（その報には値が 1 つも変わっていない観測点が同梱されうる）。
 *   **ただし新しい津波（`newFire`）・記憶が空のときは絞らない** —— 前の津波で見た同名の観測点と比べて「動いていない」と
 *   判定すると、印も地図の点滅も出ないまま終わる。「まだ何も見ていない」は等級ではなく記憶の空で見る（等級を伝えない
 *   電文では等級の記憶が進まないのに、観測点の記憶はその報でも埋まる）
 * - 欠測へ転じた観測点にも印を付ける（2026-10-21 ユーザー選択「印を付ける (Recommended)」）
 * - 印の `status` は行の左端の縦線で、前に見たかで `new` か `changed`。波高を持たない行は名前を前に見たかで決める
 *   （波高の記憶には一度も入らないため）
 */
export function tsunamiObservationMarks(
  event: JMATsunami,
  memory: TsunamiObsDisplayMemory,
  opts: { readonly sameGradeReport: boolean; readonly newFire: boolean },
): TsunamiObservationMarks {
  const observations = event.observations ?? []
  const entries: [string, ObsUpdateMark][] = []
  const fieldsOf = (o: TsunamiObservation, fresh = false) =>
    changedObservationFields(
      o,
      fresh ? undefined : memory.maxHeightTimes.get(o.name),
      fresh ? undefined : memory.firstWaves.get(o.name),
      fresh ? NO_PREV_HEIGHTS : memory.maxHeights,
      fresh ? undefined : memory.reportedHeights.get(o.name),
    )
  const turnedMissing = (o: TsunamiObservation): boolean =>
    isObservationMissing(o) && memory.seenNames.has(o.name) && !memory.missing.has(o.name)
  const push = (o: TsunamiObservation, status: 'new' | 'changed', fields: ObsUpdateMark['fields']) => {
    entries.push([o.name, { status, fields }])
  }
  const newlyShown = observations.filter(o => !o.height
    && (!memory.seenNames.has(o.name) || fieldsOf(o).size > 0 || turnedMissing(o)))

  if (opts.sameGradeReport) {
    const updated = observations.filter(o => o.height && (fieldsOf(o).size > 0 || turnedMissing(o)))
    for (const o of updated) push(o, memory.maxHeights.has(o.name) ? 'changed' : 'new', fieldsOf(o))
    for (const o of newlyShown) push(o, memory.seenNames.has(o.name) ? 'changed' : 'new', fieldsOf(o))
    return { entries, focusWithHeight: updated, focusWithoutHeight: newlyShown }
  }

  const withHeight = observations.filter(o => !!o.height)
  const noMemory = memory.maxHeights.size === 0 && memory.maxHeightTimes.size === 0
    && memory.firstWaves.size === 0 && memory.seenNames.size === 0
  const fresh = opts.newFire || noMemory
  for (const o of withHeight) {
    const fields = fieldsOf(o, fresh)
    if (!fresh && fields.size === 0 && !turnedMissing(o)) continue
    push(o, !fresh && memory.maxHeights.has(o.name) ? 'changed' : 'new', fields)
  }
  for (const o of newlyShown) push(o, !fresh && memory.seenNames.has(o.name) ? 'changed' : 'new', fieldsOf(o, fresh))
  return { entries, focusWithHeight: withHeight, focusWithoutHeight: newlyShown }
}

/**
 * 発表中の津波の報の通知（→ `tsunamiIssueNotification`）。**出すのは等級を発表する報（VTSE41 と、種別を持たない報）
 * だけ**（`isTsunamiGradeReport`）。津波情報（VTSE51）も区域を載せるが、中身は直前の VTSE41 の写しなので、ここで出すと
 * 発表のたびに同じ「発表」の通知が重なる。区域が空の報を弾くのは、見出しを等級から・本文を区域名から作るため。
 * 区域はカードの材料から取る（電文順で切ると、カードの先頭に並ぶ深刻な区域が通知から落ちる）。
 */
export function tsunamiIssueNotificationFor(event: JMATsunami, basis: TsunamiCardOrderBasis): TsunamiNotification | null {
  if (event.cancelled || !isTsunamiGradeReport(event) || isTsunamiObservationOnly(event)) return null
  return tsunamiIssueNotification(event, basis)
}

/**
 * 等級を発表しない報（津波情報 VTSE51・沖合の観測 VTSE52）の通知（→ `tsunamiObservationNotification`）。中身はその報で
 * カードに印が付いた観測点を、カードの並びで。印が 1 つも無い報（同じ値の再送・満潮時刻だけの報）は出さない。
 */
export function tsunamiObservationNotificationFor(
  event: JMATsunami,
  marks: Pick<TsunamiObservationMarks, 'entries'>,
  basis: TsunamiCardOrderBasis,
): TsunamiNotification | null {
  if (event.cancelled || isTsunamiGradeReport(event) || marks.entries.length === 0) return null
  const markedNames = new Set(marks.entries.map(([name]) => name))
  const marked = sortObservationsForCardDisplay(basis.observations, basis.areas, basis.liftedAreas).filter(o => markedNames.has(o.name))
  return marked.length > 0 ? tsunamiObservationNotification(event, marked) : null
}

/**
 * 津波情報・沖合の観測だけの取消（{@link isPartialTsunamiRetraction}）の通知（→ `tsunamiPartialRetractionNotification`）。
 * **観測情報の通知を出した報（`notifiedObs` に {@link partialRetractionKey} がある報）への取消にだけ出す**（2026-11-09 ユーザー選択
 * 「音は全部・通知は通知した報だけ (Recommended)」）。札は観測情報の通知と同じ `tsunami-obs` で置き換える。中継も同じ判定を写す
 */
export function tsunamiPartialRetractionNotificationFor(event: JMATsunami, notifiedObs: ReadonlySet<string>): TsunamiNotification | null {
  if (!isPartialTsunamiRetraction(event)) return null
  // 種類だけで当てる（`forgetPartialRetractionsOf` と同じ理由。原因地震が加わると EventID が「A」から「A B」へ伸び、
  // 観測の通知を出したときの鍵と取消の鍵が一致しない。控えの全期間で、続く津波の報の間で伸びたのは 2 回）
  const suffix = `|${event.headType}`
  if (![...notifiedObs].some(key => key.endsWith(suffix))) return null
  return tsunamiPartialRetractionNotification(event)
}

/**
 * 解除・取消・失効の通知。**出すのは表示中の津波に向いた終わりだけ**（`step.kind === 'ended'`）—— 札が発表中の通知と
 * 同じなので、別の津波の遅れて届いた解除が、閉じるまで残していた「津波警報」の通知を「津波警報等の解除」へ置き換えて
 * しまう。取消・失効だけを終わりの通知へ回し、それ以外（読めない値を含む）は解除の通知へ倒す（音・読み上げの扱いと揃える）。
 * 同じ取消の 2 通目を止めるのは呼び出し側（`tsunamiCancelKey`）。
 */
export function tsunamiEndNotificationFor(event: JMATsunami, step: TsunamiStateStep | null): TsunamiNotification | null {
  if (!event.cancelled || step?.kind !== 'ended') return null
  return event.cancelReason === 'retracted' || event.cancelReason === 'expired'
    ? tsunamiEndNotification(event)
    : tsunamiLiftNotification(event)
}

/**
 * 津波の解除・誤報取消を「もう伝えた」と覚える鍵。ライブとリプレイの復元で同じ鍵を使うこと
 * （ずれると、復元で既読にした取消をライブの続きでもう一度読む）。
 *
 * `eventId` を持たない電文は発表日時（`issue.time`）を鍵にする。`id` は同じ発表でも揃う保証が無いので、
 * `id` では同じ解除の 2 度目を見分けられない（parseTsunamiFromXml は EventID 欠落時に空文字を返しうるので `||` で判定する）。
 */
export function tsunamiCancelKey(report: JMATsunami): string {
  return report.eventId || (report.issue.time ? `issue:${report.issue.time}` : report.id)
}

/**
 * 津波情報・沖合の観測だけの取消（{@link isPartialTsunamiRetraction}）を「もう伝えた」と覚える鍵。
 * 解除・誤報取消の鍵（{@link tsunamiCancelKey}）とは別にする —— 同じ鍵だと、津波情報の取消を伝えただけで
 * 後から届く本物の解除が「伝え済み」になって鳴らない。
 *
 * 報番号は入れない（同じ取消が別の id で配信し直されても二重に読まないため）。同じ種類の報が
 * 改めて届いたら {@link forgetPartialRetractionsOf} で外す。
 */
export function partialRetractionKey(report: JMATsunami): string {
  return `${report.eventId || report.id}|${report.headType}`
}

/**
 * 種類 `headType` の一部取消の既読を外す。**番号の重なりでは見ない** —— 原因地震が加わると EventID が
 * 「A」から「A B」へ伸びるので、取消のときの鍵と再発表の鍵が一致しない。表示する津波は 1 つなので、
 * 種類だけで外して足りる。
 */
export function forgetPartialRetractionsOf(spoken: Set<string>, headType: string): void {
  const suffix = `|${headType}`
  for (const key of spoken) if (key.endsWith(suffix)) spoken.delete(key)
}

/** 観測点ごとに持つ読み上げ・画面の記憶（一部取消で抜けた観測点だけを落とすのに使う）。 */
export interface TsunamiObservationMemories {
  readonly maps: readonly Map<string, unknown>[]
  readonly sets: readonly Set<string>[]
}

/**
 * 取消で値が変わった観測点の記憶を落とす。取り消された値を「もう伝えた」まま残すと、同じ観測点が
 * 改めて届いたときに声にならない。
 *
 * 落とすのは 2 通り —— 組み直した津波から**抜けた**観測点と、名前は残ったが**中身が取消前と違う**観測点
 * （取り消された報が波高・時刻・第1波・状態を上書きしていた。記憶はその取り消された値を持っている）。
 * 中身が同じまま残った観測点の記憶は触らない（読み直しになるため）。
 * 組み直す報が残らなかったとき（`after` が null）は、取消前の観測点をすべて落とす。
 */
export function forgetRetractedObservations(before: JMATsunami, after: JMATsunami | null, memories: TsunamiObservationMemories): void {
  const remaining = new Map((after?.observations ?? []).map(o => [o.name, observationMemoryKey(o)]))
  for (const o of before.observations ?? []) {
    if (remaining.get(o.name) === observationMemoryKey(o)) continue
    for (const m of memories.maps) m.delete(o.name)
    for (const s of memories.sets) s.delete(o.name)
  }
}

/**
 * 観測点の記憶（`TsunamiObservationMemories`）が写し取っている中身だけを並べた鍵。**記憶を足したら、その記憶が読む項目もここへ足すこと。**
 * 波高と「以上」・観測状態（欠測・観測中のまま警報相当もここから決まる）・最大波の観測時刻・第1波。
 */
export function observationMemoryKey(o: TsunamiObservation): string {
  return JSON.stringify([o.height?.value ?? null, o.height?.over ?? null, o.condition ?? null, o.maxHeightDateTime ?? null, firstWaveSpokenKey(o) ?? null])
}
