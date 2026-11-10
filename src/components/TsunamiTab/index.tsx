import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAutoOpenWhileSpeaking } from '../../hooks/useAutoOpenWhileSpeaking'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiEstimation, TsunamiObservation, TsunamiWarningComment } from '../../types/earthquake'
import { QUAKE_ARRIVAL_TIME_LABEL, formatDateTimeMin, formatDepth, formatHypocenterSource, formatMagnitude, formatMagnitudeCondition, formatNameFromMark, formatTimeMin, hasDepth } from '../../utils/formatters'
import { quakeEventKey, extractQuakeEventId } from '../../utils/quakeMerge'
import { linkTsunamiSources, shownTsunamiSource } from '../../utils/tsunamiSourceLinks'
import { groupAreasForCardDisplay, splitAreasByKindName, tsunamiLiftedAreas, matchesArea, observationBadgeKeys, observationHeight, observationArrivalUnknown, observationMaxHeightTime, estimationBadgeKeys, estimationHeight, GRADES_IN_CARD_ORDER, isTsunamiGradeRaised, sourceEarthquakeTime, tsunamiAreaKey, tsunamiEventIds, evacuationActionLine, tideStationKey, arrivalConditionBadge, arrivalConditionKey, type ObsUpdateMark, type ObsUpdateField, type TsunamiValueMarks, type EstimationUpdateField } from '../../utils/tsunami'
import { TSUNAMI_MISSING_COLOR as MISSING_COLOR } from '../../utils/tsunamiStyle'
import { useMessages } from '../../i18n/I18nProvider'
import type { Messages } from '../../i18n/messages'
import { UPDATE_MARK_COLOR, type UpdateMark } from '../../utils/updateMark'
import { mapChunksToRefs, planFollowScroll, followViewHasRoom, hasFollowContext, type FollowRect, type SpeechFollowSession, type SpeechRef } from '../../utils/ttsFollow'
import { getSpeechClock } from '../../utils/voicevox'
import { INTERACTION_HOLD_SEC } from '../Map/gl/camera'
import { log } from '../../utils/logger'
import { useTsunamiObsCoords } from '../../hooks/useTsunamiObsCoords'
import { commentsOverlayMaxHeight, canShowCommentsEntry, bannerStickMode } from './overlayHeight'
import { DisclosureCaret, prefersReducedMotion } from '../EarthquakeTab/quakeMotion'
import { useTsunamiZones } from '../../hooks/useTsunamiZones'
import { ringsBoundsIndex, EMPTY_BOUNDS_INDEX } from '../../utils/subregions'
import type { LatLng } from '../../utils/stationCoords'

export interface FocusedDistrict {
  // 今回の受信で変更（新規/更新）があった区域すべて。寄せ先を決められない受信では空配列
  districts: { code?: string; name?: string }[]
  // その中で波高が最大の区域（画面に収まらない場合はこれを一番上に配置する）。districts が空のときは null
  top: { code?: string; name?: string } | null
  /**
   * `districts` が空のときに、カードの先頭へ戻すか。
   *
   * **「寄せ先が無い」と「先頭へ戻せ」は別の事実。** 空配列だけで両方を表していたころ、
   * 各地の満潮時刻・津波到達予想時刻に関する情報（観測点を載せず等級も変えない続報）が
   * 「変化なし」として先頭戻しに回り、**直前の報が寄せた位置を捨てていた**。沖合の観測情報も
   * 同じ穴に落ちる —— 新しい観測点はあるのに、沖合の観測点は津波予報区を持たないため
   * 寄せ先の一覧が空になる（実電文での実測は docs/spec/tsunami-spec.md §14 の 2026-09-11 の項）。
   *
   * 先頭へ戻してよいのは、カードの中身が入れ替わって前の位置に意味が無くなったときだけ
   * （解除・新規発報・等級の変わった報）。**既定値を置かない** ——
   * 受信の種類ごとに決める判断なので、足し忘れを型検査で捕まえる。
   *
   * **既定の状態への復帰（アイドル復帰など）はここを通らない。** あちらは受信ではなく
   * タブ切替なので、`autoShowTick`（`shouldResetTsunamiScroll` が判定する）が担う。
   * かつては復帰もここへ要求を出していたが、**タブが変わっていなくても戻す**形だったため、
   * 津波タブを見ている最中の復帰で読んでいた位置が捨てられていた。
   */
  resetToTop: boolean
  ts: number
}

interface Props {
  tsunamis: JMATsunami[]
  earthquakes?: JMAQuake[]
  onEarthquakeLink?: (quakeKey: string) => void
  onObservationClick?: (name: string) => void
  /** 区域名をクリックしたときに、その予報区の範囲へ地図を寄せる。 */
  onFocusMap?: (positions: LatLng[]) => void
  focusedDistrict?: FocusedDistrict | null
  obsUpdateStatus?: Map<string, ObsUpdateMark>
  /**
   * 直近の受信で等級が動いた区域（`tsunamiAreaKey`）。この集合にある区域だけが
   * 「〇〇から切り替え」を出す。**区域が持つ `lastGrade` だけで出さないこと** ――
   * 気象庁の `LastKind` は変化した後の続報にも載り続けるため、何通も後まで
   * 「たった今切り替わった」ように見え続ける（→ docs/spec/tsunami-spec.md §10）。
   */
  areaGradeChangedKeys?: ReadonlySet<string>
  /**
   * 観測点以外の値（満潮時刻・予想波高・沿岸への推定）に付ける「この報で動いた」印（→ `utils/tsunami.ts` の
   * `TsunamiValueMarks`）。判定は受信処理（`useLiveEventHandler`）が前の報と突き合わせて作る。
   */
  tsunamiValueMarks: TsunamiValueMarks
  /** 進行中の読み上げ。渡されるとカードが読み上げに追従する（`null` なら追従しない） */
  speechSession?: SpeechFollowSession | null
  /**
   * 気象庁が書いた文（本文・付加文）をいま読み上げているか。真のあいだ、バナーの
   * 「気象庁が書いた文」を開く（→ docs/spec/audio-tts-spec.md §6）。
   */
  speakingTelegramText?: boolean
  /**
   * 津波タブが実際に見えているか。
   * タブは `invisible` で隠すだけなので、非表示でもスクロールは効いてしまう。
   */
  isVisible?: boolean
  /**
   * 読み上げが有効か。**有効なら受信時スクロールを行わず、読み上げ追従に任せる。**
   *
   * 受信時スクロールは電文が届いた瞬間に「変わった区域」へ寄せるが、読み上げが始まるのは
   * その 0.8〜2.8 秒後（通知音との間隔）。両方が働くと、先に区域へ寄ってから追従が等級カードの
   * 頭へ引き戻す、という逆向きの動きが見える。読み上げがあるなら声と画面を一致させる側に
   * 任せる（読み上げがある経路は順序の判断を読み上げ側に預ける、という既存の方針に揃える）。
   */
  speechFollowEnabled?: boolean
  /**
   * 津波タブを自動で見せた回数。**増えるたびにスクロールを先頭へ戻す。**
   *
   * 別のタブへ移ったあと続報やアイドル復帰で連れ戻されると、前に見ていた途中の位置が
   * 残ったまま表示される。自動で見せる以上は先頭（最も重い等級のカード）から見せる。
   * 手動で開いたときは増えないので、自分でスクロールした位置は保たれる。
   *
   * **これは最も弱い層。** 同じ受信で受信時スクロールや読み上げ追従が動くならそちらが
   * 上書きする（先頭へ戻すのは `useLayoutEffect`、他は `useEffect` と rAF なので必ず後）。
   */
  autoShowTick?: number
}

/**
 * 読み上げが有効なとき、受信時スクロールが追従を待つ時間。
 *
 * 声が出るまでには「通知音を鳴らし終える間隔」（`ttsDelayFor`。大津波警報は 2.27 秒）に
 * 読み上げの待ち行列と合成の時間が積み上がる。**実測では受信から 13 秒後**に最初の追従が
 * 動いた（大津波警報テスト）ので、それより余裕を持たせる。短すぎると、正常に読み上げられる
 * 場面でも受信時スクロールが先に動いて往復が見える ―― この機能で消したかったものそのもの。
 *
 * 長く取ることの代償は「読み上げが成立しなかったときに待たされる時間」だけ。塞いでしまう
 * （永久に待つ）のに比べれば軽い。
 */
const SPEECH_FOLLOW_GRACE_MS = 20000

/**
 * 追従用の行の登録キー。区域は code を優先し、無ければ名前で引く（`matchesArea` と同じ順序）。
 *
 * 津波カードの行を指さない参照（地震情報の `quakeRegion` / `quakeFact`）は空を返す。
 * ここへ来ることは無い（`hasFollowTarget` が地震情報の読み上げで追従を始めさせない）が、
 * 引き当てられない参照を無理に区域名として扱うと、名前が偶然一致した行を掴む。
 */
function speechRowKeys(ref: SpeechRef): string[] {
  if (ref.kind === 'grade') return [`grade:${ref.grade}`]
  if (ref.kind === 'station') return [`station:${ref.name}`]
  if (ref.kind !== 'area') return []
  return ref.code ? [`area:code:${ref.code}`, `area:name:${ref.name}`] : [`area:name:${ref.name}`]
}

type TsunamiGrade = TsunamiArea['grade']

interface GradeStyle {
  headerBg: string
  headerColor: string
  headerBorder: string
  cardBorder: string
  arrivalColor: string
  heightColor: string
}

function getGradeStyle(grade: TsunamiGrade): GradeStyle {
  switch (grade) {
    case 'MajorWarning':
      return { headerBg: '#2d0036', headerColor: '#e879f9', headerBorder: '#a855f7', cardBorder: '#a855f7', arrivalColor: '#a855f7', heightColor: '#e879f9' }
    case 'Warning':
      return { headerBg: '#450a0a', headerColor: '#fca5a5', headerBorder: '#ef4444', cardBorder: '#ef4444', arrivalColor: '#f87171', heightColor: '#fca5a5' }
    case 'Watch':
      return { headerBg: '#431407', headerColor: '#fdba74', headerBorder: '#f97316', cardBorder: '#f97316', arrivalColor: '#f97316', heightColor: '#fdba74' }
    case 'Forecast':
      return { headerBg: '#0c1a26', headerColor: '#67e8f9', headerBorder: '#0891b2', cardBorder: '#0891b2', arrivalColor: '#22d3ee', heightColor: '#67e8f9' }
    default:
      return { headerBg: '#1f2937', headerColor: '#9ca3af', headerBorder: '#4b5563', cardBorder: '#4b5563', arrivalColor: '#6b7280', heightColor: '#9ca3af' }
  }
}

/** 津波タブの辞書（`Messages['tsunami']`）。 */
type TsunamiMessages = Messages['tsunami']

/** 観測点の波高の欄（数値・微弱・観測中）。出すものが無ければ空文字。 */
function observationHeightLabel(obs: TsunamiObservation, tm: TsunamiMessages): string {
  const h = observationHeight(obs)
  if (h === null) return ''
  return h.kind === 'height' ? tm.height(h.description, h.over) : h.kind === 'weak' ? tm.weak : tm.observing
}

/** 観測点の最大波の時刻の欄（出さない場面なら空文字。→ `observationMaxHeightTime`）。 */
function maxWaveText(obs: TsunamiObservation, tm: TsunamiMessages): string {
  const hm = observationMaxHeightTime(obs)
  return hm ? tm.maxWave(hm) : ''
}

/** 到達状況の札。表にある語は辞書で引き、表に無い語は電文の語のまま（→ `arrivalConditionBadge`）。 */
function arrivalConditionLabel(condition: string | undefined, tm: TsunamiMessages): string | undefined {
  const key = arrivalConditionKey(condition)
  return key ? tm.arrivalCondition[key] : arrivalConditionBadge(condition)
}

/** 官署の塊（「編集官署 気象庁本庁」「発表官署 気象庁」）。地震カードと同じく区切り記号を置かず間隔で分ける。片方しか無ければその片方だけ。 */
function officeLabels(issue: JMATsunami['issue'], tm: TsunamiMessages): string[] {
  return [
    issue.editorialOffice && tm.editingOffice(issue.editorialOffice),
    issue.publishingOffice && tm.issuingOffice(issue.publishingOffice),
  ].filter((s): s is string => Boolean(s))
}

// 等級カードを積む順は読み上げと共有する（`GRADES_IN_CARD_ORDER`）。ここに独自の配列を置くと、
// 読み上げの並びとカードの並びが片方だけ変わって追従スクロールが往復する。
const GRADE_ORDER = GRADES_IN_CARD_ORDER

// FocusedDistrict の区域識別子（code/name）を発表区域に紐づける。照合ルールは matchesArea と同じ。
function districtMatchesArea(district: { code?: string; name?: string }, area: TsunamiArea): boolean {
  if (district.code && area.code) return district.code === area.code
  return !!district.name && district.name === area.name
}

/**
 * 等級と予想の高さの見出し（「大津波警報　5m」）。**その等級の区域を巻いている間はバナー（または帯）の下に貼りつく**
 * （2026-11-04 ユーザー選択「地震タブと同じ規則 (Recommended)」の説明「…等級と予想の高さの見出しも、その等級の区域を
 * 巻いている間はバナー／帯の下に貼りつける」）。貼りつく位置はスクロールの器が持つ `--ts-stick-top`。
 *
 * 高さの区切りが無い組（予想の高さを持たない区域）は等級名だけを出す。
 * **その高さの区域に予想波高の印が付いていれば、高さの文字にその色を当てる**（どの区域かは
 * 区域の行の縦線が示す。2026-10-24 ユーザー選択「見出し＋行の縦線 (Recommended)」）。
 */
function TsunamiGradeHeader({ gradeLabel, heightLabel, style, markColor, anchorRef }: { gradeLabel: string; heightLabel: string | undefined; style: GradeStyle; markColor: string | undefined; anchorRef: (el: HTMLDivElement | null) => void }) {
  const tm = useMessages().tsunami
  return (
    <div ref={anchorRef} data-grade-header=""
      className="sticky z-[5] flex items-baseline gap-2.5 flex-wrap"
      style={{ top: 'var(--ts-stick-top, 0px)', padding: '4px var(--qk-pad)', backgroundColor: style.headerBg, borderBottom: `1px solid ${style.cardBorder}55` }}>
      <span data-grade-label="" className="font-extrabold" style={{ fontSize: 'var(--qk-fs)', color: style.headerColor }}>{gradeLabel}</span>
      {heightLabel && (
        <span className="font-black leading-none" style={{ fontSize: 'calc(var(--qk-f) + 6px)', color: markColor ?? style.heightColor }}>
          {tm.height(heightLabel, false)}
        </span>
      )}
    </div>
  )
}

/**
 * 津波の原因地震を 1 行で出す。
 *
 * **1 件目と 2 件目以降で同じものを通すこと。** 電文は原因地震を複数持ちうる（短い間に起きた
 * 地震がまとめて 1 通で発表される）ので、別々に書くと項目を足したとき片方に漏れる。
 */
function SourceEarthquakeLine({ eq, link }: {
  eq: NonNullable<JMATsunami['sourceEarthquakes']>[number]
  link: React.ReactNode
}) {
  const tm = useMessages().tsunami
  const quakeTime = sourceEarthquakeTime(eq)
  // 日時として読めなければ句ごと落とす（→ `formatters.ts` の `readDateTime`）。震源名・規模・
  // 深さが並ぶ行の付随情報なので、「地震発現時刻」の語だけが残るより出さないほうがよい。
  const quakeHm = quakeTime ? formatTimeMin(quakeTime) : null
  // 規模の記号は電文の種別（`Mj7.6`）。地震カードと同じ `formatMagnitude` を通す（2026-10-29 ユーザー承認
  // 「地震カードと同じく出す (Recommended)」「Mj7.6 の形 (Recommended)」）。規模が数値で無いときは気象庁が添えた説明を出す
  // （「Ｍ８を超える巨大地震」）。ここを空にすると、最大級の地震ほど震源名だけの薄い表示になる。
  const magnitudeText = eq.magnitude !== undefined
    ? formatMagnitude(eq.magnitude, eq.magnitudeType)
    : eq.magnitudeCondition ? formatMagnitudeCondition(eq.magnitudeCondition) : null
  // 深さ。**遠地地震による津波では、震源の深さがこの電文にしか無い**（対応する地震情報が発表されないことがある）。
  // `0` は「ごく浅い」という有効値なので `hasDepth` で弾く。**値によらず「深さ」を前置する** —— 地震カード・地図・
  // 共有カードもそう出しており、ここだけ省くとアプリの中で表記が割れる。
  const depthText = eq.depth !== undefined && hasDepth(eq.depth) ? tm.depth(formatDepth(eq.depth, eq.depthAtLeast === true)) : null
  // 震央地名を大きく、規模と深さを次に大きく（2026-11-04 ユーザー選択「B1 帯は等級だけ (Recommended)」の見本）。
  // 値のかたまりの途中では折り返さず、入らなければかたまりごと次の行へ送る。
  return (
    <div data-source-line="" className="flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5" style={{ marginBottom: 4 }}>
      <span className="font-extrabold text-white whitespace-nowrap" style={{ fontSize: 'calc(var(--qk-f) + 4px)' }}>{eq.hypocenterName}</span>
      {magnitudeText && <span className="font-bold text-white whitespace-nowrap" style={{ fontSize: 'calc(var(--qk-f) + 2px)' }}>{magnitudeText}</span>}
      {depthText && <span className="font-bold text-white whitespace-nowrap" style={{ fontSize: 'calc(var(--qk-f) + 2px)' }}>{depthText}</span>}
      {/* 地震の時刻は `sourceEarthquakeTime` を通す（**発現時刻を先に採る**）。発生時刻を出すと、
          同じ地震が地震カードと津波カードで 1 分違って見える。理由と実電文で測った数字は
          `docs/spec/tsunami-spec.md` §4 が正。 */}
      {quakeHm && <span className="text-secondary whitespace-nowrap" style={{ fontSize: 'var(--qk-fs)' }}>{QUAKE_ARRIVAL_TIME_LABEL} {quakeHm}</span>}
      {link}
      {/* 震央補助表現（「御前崎の北東40km付近」）と震源決定機関（「ＰＴＷＣ」等）。
          前者は震央地名より具体的に場所が分かり、後者は誰が決めた値かを示す。
          前者は数字と単位だけ半角へ直し（`formatNameFromMark`。地震カードと同じ）、後者は原文のまま出す。
          後者は**気象庁以外の機関が決めた震源を採用したときだけ**入る（Ⅱ.13 2-3-2）ので、
          機関名だけでは含意（気象庁の決定ではない）が伝わらない。ラベルに書く。 */}
      {eq.nameFromMark && <div className="w-full text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>{formatNameFromMark(eq.nameFromMark)}</div>}
      {eq.source && <div className="w-full text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>{formatHypocenterSource(eq.source)}</div>}
    </div>
  )
}

/** 電文が名乗る運用種別（訓練・試験）の札。色は地震タブの札と同じ（2026-11-02 選択「今のアプリの色 (Recommended)」）。 */
function OperationStatusChip({ status }: { status: string }) {
  const tm = useMessages().tsunami
  return (
    <span className="shrink-0 whitespace-nowrap rounded-[3px] px-1.5 font-bold"
      style={{ fontSize: 'var(--qk-fs)', backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}>
      {tm.operationStatus(status)}
    </span>
  )
}

/**
 * 寄せと追従の視野から引く、貼りつく等級の見出しの高さ。**寄せた先では行の真上に見出しが貼りつく**ので、
 * 引かないと行の頭が見出しの裏へ潜る。見出しはどの等級も同じ作りなので、最初の 1 つで測る。
 */
function stuckGradeHeaderHeight(container: HTMLElement): number {
  const header = container.querySelector<HTMLElement>('[data-grade-header]')
  return header ? header.getBoundingClientRect().height : 0
}

/** 時刻の欄の 1 項目。動いた項目だけ文字に色を当てる（→ 観測点の行の `fieldColor`）。 */
interface TimePart { text: string; color?: string }

/**
 * 観測点の行（区域の下・沖合・解除された区域の下で共通）。**細い線で区切った表の行**にする
 * （2026-11-04 ユーザー選択「表の行にする (Recommended)」。地震タブの 1 件 1 行の一覧に合わせ、枠つきの箱をやめた）。
 *
 * 左に観測点名と札、その下に時刻の欄、右端に波高。**左の縦線は印が無い行でも幅を取る**（透明で置く）——
 * 付いたり消えたりで行の中身が横へずれないように。
 */
function StationRow({ rowRef, name, nameColor, nameWeight, chips, timeParts, height, markColor, onActivate }: {
  rowRef?: (el: HTMLDivElement | null) => void
  name: string
  nameColor: string
  nameWeight: 'bold' | 'semibold'
  chips: React.ReactNode
  timeParts: TimePart[]
  /** 右端に出す波高（数値なら大きく、文字なら本文の大きさ）。無ければ null。 */
  height: { text: string; numeric: boolean; color?: string } | null
  markColor: string | null | undefined
  /** 押すと地図がその観測点へ寄る。押せない行は undefined。 */
  onActivate?: () => void
}) {
  return (
    <div
      ref={rowRef}
      data-station-row=""
      className={`grid grid-cols-[1fr_auto] items-center gap-x-2 border-t border-border/60${onActivate ? ' cursor-pointer hover:brightness-125 transition-[filter] motion-reduce:transition-none' : ''}`}
      style={{ padding: '5px var(--qk-pad) 5px calc(var(--qk-pad) + 12px)', borderLeft: `3px solid ${markColor ?? 'transparent'}` }}
      onClick={onActivate}
      role={onActivate ? 'button' : undefined}
      tabIndex={onActivate ? 0 : undefined}
      onKeyDown={onActivate ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate() } } : undefined}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={nameWeight === 'bold' ? 'font-bold' : 'font-semibold'} style={{ fontSize: 'var(--qk-f)', color: nameColor }}>{name}</span>
          {chips}
        </div>
        {timeParts.length > 0 && (
          <div data-station-times="" className="text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>
            {timeParts.map((part, pi) => (
              // **区切りの空白は色を当てる範囲の外に置く。** 中へ入れると、動いた項目の
              // 手前の空白まで塗られて色の帯が項目からずれる。値の途中では折り返さない。
              <Fragment key={pi}>
                {pi > 0 ? '　' : ''}
                <span className="whitespace-nowrap" style={part.color ? { color: part.color, fontWeight: 600 } : undefined}>{part.text}</span>
              </Fragment>
            ))}
          </div>
        )}
      </div>
      {height && (
        <span className="whitespace-nowrap text-right"
          style={height.numeric
            ? { fontSize: 'calc(var(--qk-f) + 4px)', fontWeight: 800, color: height.color ?? '#ffffff' }
            : { fontSize: 'var(--qk-f)', color: height.color ?? 'var(--color-secondary)', fontWeight: height.color ? 600 : undefined }}>
          {height.text}
        </span>
      )}
    </div>
  )
}

/** 観測点の札（実測・欠測・到達確認など。語は `observationBadges` が決める）。 */
function ObservationChips({ obs, tint }: { obs: TsunamiObservation; tint: { bg: string; fg: string } }) {
  const tm = useMessages().tsunami
  return (
    <>
      {observationBadgeKeys(obs).map(key => (
        <span
          key={key}
          className="font-bold px-1.5 rounded-[3px] whitespace-nowrap"
          style={{ fontSize: 'var(--qk-fs)', ...(key === 'missing'
            ? { background: `${MISSING_COLOR}26`, color: MISSING_COLOR }
            : { background: tint.bg, color: tint.fg }) }}
        >
          {tm.badge[key]}
        </span>
      ))}
    </>
  )
}

function TsunamiAreaRow({ area, observations, style, onObservationClick, canFocusObs, onAreaFocus, isChanged, isTop, registerRow, registerSpeechRow, registerSpeechAnchor, obsUpdateStatus, areaGradeChangedKeys, tsunamiValueMarks }: { area: TsunamiArea; observations: TsunamiObservation[]; style: GradeStyle; onObservationClick?: (name: string) => void; canFocusObs: (name: string) => boolean; onAreaFocus?: (name: string) => (() => void) | undefined; isChanged: boolean; isTop: boolean; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void; registerSpeechAnchor: (keys: string[], el: HTMLElement | null) => void; obsUpdateStatus?: Map<string, ObsUpdateMark>; areaGradeChangedKeys?: ReadonlySet<string>; tsunamiValueMarks: TsunamiValueMarks }) {
  const areaFocus = onAreaFocus?.(area.name)
  const setRowRef = useCallback((el: HTMLDivElement | null) => {
    registerRow?.(area, isChanged, isTop, el)
    // 追従スクロールの引き当て用。focusedDistrict とは違い、変更の有無に関わらず全区域を登録する
    registerSpeechRow?.(speechRowKeys({ kind: 'area', code: area.code, name: area.name }), el)
  }, [registerRow, registerSpeechRow, area, isChanged, isTop])

  // 到達状況はバッジに出す（表に無い語もその文字のまま。→ `arrivalConditionBadge`）。本文には時刻だけを出す。
  //
  // **実測がある区域でもバッジを出す**（2026-10-21 ユーザー選択「バッジも出す (Recommended)」。全期間で 434 報中 288 報・
  // 延べ 3,874 区域＝到達状況のある 5,288 区域の約 7 割がこの形）。以前は実測行で代わると見て出さず、語を本文へ
  // 戻していた。
  const tm = useMessages().tsunami
  const arrivalBadgeLabel = arrivalConditionLabel(area.firstHeight?.condition, tm)
  // 時刻が日時として読めないときは、時刻そのものが無い電文と同じ扱いにする（「到達予想 」とラベルだけ残さない）。
  const areaArrivalHm = area.firstHeight?.arrivalTime ? formatTimeMin(area.firstHeight.arrivalTime) : null
  const arrivalText = areaArrivalHm ? tm.estimatedArrival(areaArrivalHm) : null
  // 予想波高の印（→ `TsunamiValueMarks.forecastHeight`）。行の左端に縦線を引く（見出しの文字の色は等級カードが付ける。
  // 2026-10-24 ユーザー選択「見出し＋行の縦線 (Recommended)」）。
  const forecastMark = tsunamiValueMarks.forecastHeight.get(tsunamiAreaKey(area))
  const forecastMarkColor = forecastMark ? UPDATE_MARK_COLOR[forecastMark.status] : undefined

  // 直近の受信で等級が動いた区域に、その移り変わりを 1 行で示す。
  //
  // 条件は 2 つ。**直近の受信で動いた区域であること**（`areaGradeChangedKeys`。区域が持つ
  // `lastGrade` は変化後の続報にも残るため、これが無いと出続ける）と、**前回が「津波なし」
  // （`Unknown`）でないこと**（新規発表の報では全区域がそこから始まり、全部の行に付いて
  // 意味を持たなくなる）。`lastGrade` は電文が `LastKind` を持つ区域だけが持つ。
  const gradeChange = areaGradeChangedKeys?.has(tsunamiAreaKey(area))
    && area.lastGrade && area.lastGrade !== 'Unknown' && area.lastGrade !== area.grade
    ? {
      raised: isTsunamiGradeRaised(area.lastGrade, area.grade),
      // 電文の名前（`LastKind/Name`。「大津波警報：発表」など）を優先する（2026-10-30 ユーザー選択「電文の名前を出す (Recommended)」）
      label: area.lastKindName ? tm.kindName(area.lastKindName) : tm.grade[area.lastGrade],
    }
    : null

  const stations = area.stations ?? []
  // 実測値がある観測点名のセット（予測だけの行から外す）
  const observedNames = new Set(observations.map(o => o.name))
  // **`immediate` は文言が読めないときの補い。** `firstHeight` を持たない古いデータでは
  // 真偽値しか残らない。**「ただちに津波来襲と予測」と
  // 1 対 1 ではなく**、実データでは「津波到達中と推測」の区域でも真になる（第１波の到達を
  // 確認では偽）ので、文言が読めるならそちらを優先する
  // （→ [`tsunami-spec.md`](../../../docs/spec/tsunami-spec.md) §9「区域の到達状況」）。
  const arrivalBadge = arrivalBadgeLabel ?? (area.immediate ? tm.arrivalCondition.imminent : undefined)
  /** 満潮時刻が前の報から動いた潮位観測点の、時刻の文字の色（行の縦線は付けない。→ `TsunamiValueMarks.highTide`）。 */
  const highTideColor = (stationName: string): string | undefined => {
    const st = stations.find(x => x.name === stationName)
    return st && tsunamiValueMarks.highTide.has(tideStationKey(area, st)) ? UPDATE_MARK_COLOR.changed : undefined
  }

  return (
    <div ref={setRowRef} data-area-row="" className="border-t border-border first:border-t-0"
      /* 予想波高の印。**印が無い行でも幅を取る**（透明で置く。付いたり消えたりで行の中身が横へずれないように）。 */
      style={{ borderLeft: `3px solid ${forecastMarkColor ?? 'transparent'}` }}>
      {/* 読み上げが配下の観測点を読むときの前置き。**この見出し 1 行だけを登録する** ――
          読み上げ文は読点でチャンクが割れるので「石川県能登、」と「輪島港で〜」は別のチャンクに
          なり、観測点のチャンクに入った時点でここが視野から流れ出る（→ `contextElementFor`）。
          区域行の外枠を渡すと、観測点を多く抱えた区域では視野に収まらず前置きごと捨てられる。

          **`useCallback` で安定化していないのは、`observations` が毎レンダー新しい配列だから**
          （呼び出し側が `observations.filter(...)` で作る）。依存に入れても毎回作り直されるので、
          安定化しても登録のやり直しは減らない。`Map` への delete → set が対で走るだけで害は無い。

          **この結線は自動テストが無い。** jsdom はレイアウトを持たないため追従の effect
          （`planFollowScroll` を呼ぶ側）を発火させられなかった。確かめるときは実機で測る ――
          dev サーバーで設定の窓の「変化の小さい続報テスト」を流し、
          `Element.prototype.scrollTo` を差し替えて送り先を記録する。**送り先は「区域見出しの
          上端 − 余白 24px − バナーの高さ」**になる（バナーは sticky で、追従は
          `viewTop = containerRect.top + stickyBannerHeight` を見る。実測で約 190px あった。
          帯の形のときは帯の高さを引く → `bannerStickMode`。貼りついた等級の見出しの高さも引く → `stuckGradeHeaderHeight`）。
          前置きが効いていなければ、同じ式が観測点の行の上端に一致する。 */}
      <div ref={el => {
        for (const obs of observations) registerSpeechAnchor(speechRowKeys({ kind: 'station', name: obs.name }), el)
      }}
        className="flex items-center gap-2"
        style={{ padding: '7px var(--qk-pad) 4px' }}>
        <div className="flex-1 min-w-0">
          {/* 区域名を押すとその予報区の海岸線が入る範囲へ地図が寄る。**押せるのは境界を引ける
              区域だけ**（観測点の行と同じ規律 → §9「観測点の行・区域名をクリックしたときの寄り先」）。
              行全体を押せるようにしないのは、この行が観測点の一覧を抱えているため。 */}
          <span
            className={`text-white font-bold block${areaFocus ? ' cursor-pointer hover:underline' : ''}`}
            style={{ lineHeight: '1.2', fontSize: 'calc(var(--qk-f) + 1px)' }}
            {...(areaFocus ? {
              role: 'button' as const,
              tabIndex: 0,
              onClick: (e: React.MouseEvent) => { e.stopPropagation(); areaFocus() },
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); areaFocus() }
              },
            } : {})}
          >
            {area.name}
          </span>
          {arrivalText && (
            <span className="block mt-0.5" style={{ fontSize: 'var(--qk-fs)', color: style.arrivalColor }}>
              {arrivalText}
            </span>
          )}
          {gradeChange && (
            <span className="block mt-0.5" style={{ fontSize: 'var(--qk-fs)', color: gradeChange.raised ? '#f87171' : 'var(--color-secondary)' }}>
              {tm.gradeChangedFrom(gradeChange.label, gradeChange.raised)}
            </span>
          )}
          {/* 大津波警報の区域で、予想波高が初めて数値になった／上方修正された
              （電文の `MaxHeight/Condition` = 重要）。観測・推定の「重要」とは意味が違うので
              語を分けている（→ tsunami.ts の forecastHeightImportantBadge）。 */}
          {area.forecastHeightImportant && (
            <span className="block mt-0.5" style={{ fontSize: 'var(--qk-fs)', color: '#f87171' }}>
              {tm.forecastHeightImportant}
            </span>
          )}
        </div>
        {arrivalBadge && (
          <span className="shrink-0 font-bold px-1.5 rounded-[3px] border whitespace-nowrap"
            style={{ fontSize: 'var(--qk-fs)', color: '#f87171', backgroundColor: 'rgba(239,68,68,0.15)', borderColor: '#ef4444' }}>
            {arrivalBadge}
          </span>
        )}
      </div>
      {/* 観測点ごとに実測・予測を統合して表示 */}
      {(observations.length > 0 || stations.length > 0) && (
        <div>
          {/* 実測値あり観測点 */}
          {observations.map((obs, i) => {
            const clickable = !!onObservationClick && canFocusObs(obs.name)
            const updateMark = obsUpdateStatus?.get(obs.name)
            const markColor = updateMark ? UPDATE_MARK_COLOR[updateMark.status] : null
            /**
             * その項目に当てる文字色。**縦線と同じ色**を使う（同じ出来事を指す印なので、別の色に
             * すると読み手が 2 つの語彙を覚えることになる）。縦線が「この地点で何かあった」、
             * 文字色が「この項目よ」の 2 段構え。
             *
             * **波高にも当てる。** 観測点の行の波高は既定を白にしてあるので、等級の色と衝突しない
             * （等級は等級カードの枠と見出しが示す。→ `docs/spec/tsunami-spec.md` §9）。
             */
            const fieldColor = (field: ObsUpdateField): string | undefined =>
              markColor && updateMark?.fields.has(field) ? markColor : undefined
            const matched = stations.find(s => s.name === obs.name)
            // 実測の到達時刻が出せていない行に、予報側が持っている到達予想を添える。
            //
            // **欠測で絞らない。** 実配信でこの値が残るのは欠測の地点だけだが（到達そのものを
            // 観測できていないので、気象庁に予想を取り下げる理由が無い）、観測状態の名前で条件を
            // 書くと、別の状態で届いたときに黙って落とす。見たいのは「実測の到達時刻が出せて
            // いない」ことそのもの。
            //
            // **語は区域の行（`arrivalText`）と揃える。** 実測は「05:12 押し波」の形で出るため、
            // 語を冠さないと予報の値が観測できた時刻に見える。
            // **判定は整形の結果で行う。** 値があっても日時として読めなければ実測の到達時刻は
            // 出せないので、上の「実測の到達時刻が出せていない」に含まれる。
            const obsArrivalHm = obs.arrivalTime ? formatTimeMin(obs.arrivalTime) : null
            const forecastArrivalHm = !obsArrivalHm && matched?.arrivalTime
              ? formatTimeMin(matched.arrivalTime)
              : null
            const forecastArrivalText = forecastArrivalHm ? tm.estimatedArrival(forecastArrivalHm) : ''
            const matchedHighTideHm = matched?.highTideDateTime ? formatTimeMin(matched.highTideDateTime) : null
            // この欄は空になりうる要素が並ぶ。**区切りを前置きする書き方にしない** —— 先頭が
            // 空のとき字下げだけが残る（到達予想を足す前から、欠測の行の満潮時刻がそうなっていた）。
            // **項目ごとに印を分けるので、1 本の文字列へ繋がない。** 動いた項目の肩へ点を置くには
            // 区切って描くしかない（間の全角空白も要素として挟む）。
            const timeParts: TimePart[] = [
              {
                text: obsArrivalHm
                  ? tm.firstWave(obsArrivalHm, obs.initial ?? null)
                  : observationArrivalUnknown(obs) ? tm.arrivalUnknown : '',
                // **到達時刻が出せていない行（「第１波識別不能」など）にも色を当てる。** 第1波の印は
                // 電文の `FirstHeight/Revise` からも付き、そのときに動いたのはこの文字そのもの
                // （2026-10-21 ユーザー選択「おすすめで」）。
                color: fieldColor('firstWave'),
              },
              // 第1波についての話が続くので、実測の到達時刻と同じ位置に置く。
              { text: forecastArrivalText },
              // 最大波を観測した時刻。第1波の到達時刻と紛れないよう語を冠する
              // （決め方は `observationMaxHeightTimeText`）。
              { text: maxWaveText(obs, tm), color: fieldColor('maxHeightTime') },
              // 同名 station があれば満潮時刻をここに表示。動いたら時刻の文字に色を付ける（→ `highTideColor`）
              { text: matchedHighTideHm ? tm.highTide(matchedHighTideHm) : '', color: highTideColor(obs.name) },
            ].filter(p => p.text)
            const heightText = observationHeightLabel(obs, tm)
            return (
              <StationRow
                key={i}
                /* 追従スクロールの引き当て用。読み上げが読むのは実測・到達確認の観測点だけなので、
                   下の「予測のみ」の行は登録しない（同名の行が 2 つあると引き当てが曖昧になる） */
                rowRef={el => registerSpeechRow?.([`station:${obs.name}`], el)}
                name={obs.name}
                nameColor={style.heightColor}
                nameWeight="bold"
                chips={<ObservationChips obs={obs} tint={{ bg: `${style.cardBorder}30`, fg: style.heightColor }} />}
                timeParts={timeParts}
                /* **波高の既定は白。** 等級は等級カードの枠と見出しが示しているので、ここを
                   等級の色で塗るのは同じ事実の繰り返しで、動いた項目に文字色を当てる余地も
                   失っていた（→ `docs/spec/tsunami-spec.md` §9）。数値の代わりの文字（「観測中」など）にも
                   波高の印を当てる —— `MaxHeight/Revise` の「追加」で付く印は、値を持たないこの形にしか出番が無い。 */
                height={heightText ? { text: heightText, numeric: !!obs.height, color: fieldColor('height') } : null}
                markColor={markColor}
                onActivate={clickable ? () => onObservationClick!(obs.name) : undefined}
              />
            )
          })}
          {/* 実測値なし観測点（station のみ） */}
          {stations.filter(s => !observedNames.has(s.name)).map((st, i) => {
            // **語は実測の行・区域の行と揃える。** 同じ `TsunamiStation.arrivalTime` を、実測の
            // エントリが有るか無いかだけで「到達予想」「到達」と呼び分けると、上下に並んだとき
            // 片方が確定した事実に見える。バッジ（「予測」）があっても、時刻の語が違えば別の
            // 性質の値として読まれる。
            // 日時として読めない時刻はラベルごと落とす（「到達予想 」だけが残ると値があるように見える）。
            const stArrivalHm = st.arrivalTime ? formatTimeMin(st.arrivalTime) : null
            const stHighTideHm = st.highTideDateTime ? formatTimeMin(st.highTideDateTime) : null
            const stArrivalBadge = arrivalConditionLabel(st.arrivalCondition, tm)
            const timeParts: TimePart[] = [
              { text: stArrivalHm ? tm.estimatedArrival(stArrivalHm) : '' },
              { text: stHighTideHm ? tm.highTide(stHighTideHm) : '', color: highTideColor(st.name) },
            ].filter(p => p.text)
            // **予測だけの行も押すと地図が寄る**（2026-10-21 ユーザー選択「押せるようにする (Recommended)」。全期間 延べ
            // 10,100 行）。押せるかは実測の行と同じく座標表に名前があるか（`canFocusObs`）。
            const stClickable = !!onObservationClick && canFocusObs(st.name)
            return (
              <StationRow
                key={i}
                name={st.name}
                nameColor="#d1d5db"
                nameWeight="semibold"
                /* 観測点ごとの到達状況（「津波到達中と推測」「第１波の到達を確認」）があれば、「予測」の代わりに
                   区域の到達状況と同じ語・同じ見た目のバッジを出す（2026-10-19 ユーザー選択「「予測」を置き換える（推奨）」）。
                   すでに来ていると推測される点を「予測」と書かない。 */
                chips={stArrivalBadge ? (
                  <span className="font-bold px-1.5 rounded-[3px] border whitespace-nowrap"
                    style={{ fontSize: 'var(--qk-fs)', color: '#f87171', backgroundColor: 'rgba(239,68,68,0.15)', borderColor: '#ef4444' }}>
                    {stArrivalBadge}
                  </span>
                ) : (
                  <span className="font-bold px-1.5 rounded-[3px] text-secondary" style={{ fontSize: 'var(--qk-fs)', background: 'rgba(255,255,255,0.08)' }}>{tm.forecastChip}</span>
                )}
                timeParts={timeParts}
                height={null}
                markColor={null}
                onActivate={stClickable ? () => onObservationClick!(st.name) : undefined}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * 区域に紐づかない観測点（沖合）の行。
 *
 * **更新の印は区域の下の行と同じものを出す。** 判定（`changedObservationFields`）は沖合の
 * 観測点についても作られているのに、この行がそれを受け取っていなかったため、**沖合だけ
 * 縦線も項目の印も出ていなかった**。読み上げは同じように読むので、声が名指しした観測点を
 * 画面が示せない状態になる。
 */
function TsunamiObservationRow({ obs, onObservationClick, canFocusObs, registerSpeechRow, obsUpdateStatus }: { obs: TsunamiObservation; onObservationClick?: (name: string) => void; canFocusObs: (name: string) => boolean; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void; obsUpdateStatus?: ReadonlyMap<string, ObsUpdateMark> }) {
  const tm = useMessages().tsunami
  const clickable = !!onObservationClick && canFocusObs(obs.name)
  // 日時として読めない到達時刻は、時刻が無い電文と同じ落とし先（下の fallback 群）へ回す。
  const arrivalHm = obs.arrivalTime ? formatTimeMin(obs.arrivalTime) : null
  const updateMark = obsUpdateStatus?.get(obs.name)
  const markColor = updateMark ? UPDATE_MARK_COLOR[updateMark.status] : null
  /** 区域の行と同じ規約（色は縦線と共有・動いた項目だけ塗る）。 */
  const fieldColor = (field: ObsUpdateField): string | undefined =>
    markColor && updateMark?.fields.has(field) ? markColor : undefined
  const maxHeightTimeText = maxWaveText(obs, tm)
  const arrivalFallbackText = observationArrivalUnknown(obs) ? tm.arrivalUnknown : ''
  // 時刻の欄は沿岸の観測点の行と同じ書き方にする（「00:56 引き波　最大波 …　（ＧＰＳ波浪計）」。
  // 2026-11-04 ユーザー選択「沿岸と同じ書き方 (Recommended)」）。最大波の観測時刻は**到達時刻の有無に関わらず出す**
  // （第1波を識別できなくても最大波は観測できている電文がある）。区域に紐づく行と同じく、代わりの文字にも第1波の印を当てる。
  const timeParts: TimePart[] = [
    { text: arrivalHm ? tm.firstWave(arrivalHm, obs.initial ?? null) : arrivalFallbackText, color: fieldColor('firstWave') },
    { text: maxHeightTimeText, color: fieldColor('maxHeightTime') },
    // 特殊観測機器（「ＧＮＳＳ波浪計」「水圧計」）。沖合の観測点だけが持つ。電文の語をそのまま出す ——
    // 言い換えると、どちらの計器が測った値か分からなくなる。**括弧で括る** —— 素で並べると地名や別の値と読める。
    { text: obs.sensor ? `（${obs.sensor}）` : '' },
  ].filter(p => p.text)
  const heightText = observationHeightLabel(obs, tm)
  return (
    <StationRow
      /* 追従スクロールの引き当て用。この行は区域に紐づかない観測点（沖合）で、読み上げは
         区域の下の観測点と同じように読む。登録しないとその観測点を読んでいる間だけカードが
         動かず、引き当て失敗の診断も鳴る */
      rowRef={el => registerSpeechRow?.([`station:${obs.name}`], el)}
      name={obs.name}
      nameColor="#ffffff"
      nameWeight="bold"
      /* 区域に紐づく行と同じ語を出す（バッジの決め方は `observationBadges`）。ここへ出さないと、
         沖合の観測点だけ欠測・到達確認が画面から落ちる。**語を間引かない** —— この行だけ「到達確認」を
         外していた時期があり、波高がまだ出ていない沖合の観測点は印が 1 つも出なかった。 */
      chips={<ObservationChips obs={obs} tint={{ bg: 'rgba(255,255,255,0.08)', fg: 'var(--color-secondary)' }} />}
      timeParts={timeParts}
      height={heightText ? { text: heightText, numeric: !!obs.height, color: fieldColor('height') } : null}
      markColor={markColor}
      onActivate={clickable ? () => onObservationClick!(obs.name) : undefined}
    />
  )
}

function TsunamiGradeCard({ grade, label, isFirstOfGrade, areas, observations, onObservationClick, canFocusObs, onAreaFocus, focusedDistrict, registerRow, registerSpeechRow, registerSpeechAnchor, obsUpdateStatus, areaGradeChangedKeys, tsunamiValueMarks }: { grade: TsunamiGrade; label: string; isFirstOfGrade: boolean; areas: TsunamiArea[]; observations: TsunamiObservation[]; onObservationClick?: (name: string) => void; canFocusObs: (name: string) => boolean; onAreaFocus?: (name: string) => (() => void) | undefined; focusedDistrict?: FocusedDistrict | null; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void; registerSpeechAnchor: (keys: string[], el: HTMLElement | null) => void; obsUpdateStatus?: Map<string, ObsUpdateMark>; areaGradeChangedKeys?: ReadonlySet<string>; tsunamiValueMarks: TsunamiValueMarks }) {
  if (areas.length === 0) return null
  const style = getGradeStyle(grade)
  const groups = groupAreasForCardDisplay(areas, observations)
  return (
    /* 等級を告げたときの合わせ先は**カード全体**。帯だけを見ると、帯が視野の下端に映って
       いるだけで「収まっている」と判定して動かない ―― それでは等級を言った時点でカードの頭に
       来ない。全体を範囲にすれば視野に収まらない限り送られ、上端（＝帯）に揃う。 */
    // 同じ等級が電文の名前で 2 枚に分かれたときは、等級を告げたときの合わせ先を先頭の 1 枚にだけ登録する
    // （2 枚目で上書きすると、読み上げが等級を言った時点で後ろのカードへ飛ぶ）。
    // **`overflow-hidden` にしない** —— 隠す箱はスクロールの器になり、中の見出しの貼りつき（`sticky`）が効かなくなる。
    // 角丸の外へはみ出す分は `overflow-clip` で切る（器にならない）。
    <div ref={isFirstOfGrade ? (el => registerSpeechRow?.(speechRowKeys({ kind: 'grade', grade }), el)) : undefined}
      className="bg-card rounded-sm overflow-clip"
      style={{ border: `2px solid ${style.cardBorder}` }}>
      {groups.map((group, gi) => (
        <div key={gi}>
          {(group.heightLabel || gi === 0) && (() => {
            // その高さの区域のどれかに予想波高の印があれば、見出しにも色を当てる。「追加」（緑）が混ざれば緑を優先する。
            const marks = group.areas.map(a => tsunamiValueMarks.forecastHeight.get(tsunamiAreaKey(a))).filter(m => !!m)
            const markColor = marks.length === 0 ? undefined
              : UPDATE_MARK_COLOR[marks.some(m => m.status === 'new') ? 'new' : 'changed']
            // 区域を読むときの合わせ先はこの見出し（どの等級・どの高さの話かが視野から消えないように）。
            // 高さの無い区域は続く分が 1 つの組に束ねてあり（→ `groupAreasByHeight`）、先頭の組なら等級名だけの見出しを
            // 立てて、その組を巻く間ずっと貼りつく。高さのある組を挟んだ後ろの高さの無い組は見出しを持たないので、
            // その区域もこの見出しが受ける。
            const anchored = group.heightLabel ? group.areas : groups.slice(gi).filter(g => !g.heightLabel).flatMap(g => g.areas)
            return (
              <TsunamiGradeHeader
                gradeLabel={label}
                heightLabel={group.heightLabel || undefined}
                style={style}
                markColor={markColor}
                anchorRef={el => {
                  for (const area of anchored) registerSpeechAnchor(speechRowKeys({ kind: 'area', code: area.code, name: area.name }), el)
                }}
              />
            )
          })()}
          {group.areas.map((area, i) => (
            <TsunamiAreaRow
              canFocusObs={canFocusObs}
              onAreaFocus={onAreaFocus}
              key={i}
              area={area}
              observations={observations.filter(o => matchesArea(o, area))}
              style={style}
              onObservationClick={onObservationClick}
              isChanged={focusedDistrict?.districts.some(d => districtMatchesArea(d, area)) ?? false}
              isTop={focusedDistrict?.top != null && districtMatchesArea(focusedDistrict.top, area)}
              registerRow={registerRow}
              registerSpeechRow={registerSpeechRow}
              registerSpeechAnchor={registerSpeechAnchor}
              obsUpdateStatus={obsUpdateStatus}
              areaGradeChangedKeys={areaGradeChangedKeys}
              tsunamiValueMarks={tsunamiValueMarks}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * この報で解除された区域を並べる枠。等級カードの後ろに置く。
 *
 * **等級カードを流用しないこと。** 解除された区域は電文が `Area` と `Category` しか持たず、
 * 波高・到達時刻・潮位観測点のいずれも無い。等級カードの行（`TsunamiAreaRow`）はそれらを
 * 描く前提で組んであるので、通しても空欄が並ぶだけになる。
 *
 * **前回の等級は無条件に出す。** 等級カードの「〇〇から切り替え」は直近の受信で動いた区域だけに
 * 付く（`areaGradeChangedKeys`。`lastGrade` が続報にも載り続けるため）が、こちらは枠そのものが
 * 「この報で解除された区域」を意味するので、印を絞る理由が無い。
 */
function TsunamiCancelledCard({ areas, observations, onObservationClick, canFocusObs, onAreaFocus, obsUpdateStatus, focusedDistrict, registerRow, registerSpeechRow, registerSpeechAnchor }: { areas: TsunamiArea[]; observations: TsunamiObservation[]; onObservationClick?: (name: string) => void; canFocusObs: (name: string) => boolean; onAreaFocus?: (name: string) => (() => void) | undefined; obsUpdateStatus?: ReadonlyMap<string, ObsUpdateMark>; focusedDistrict?: FocusedDistrict | null; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void; registerSpeechAnchor: (keys: string[], el: HTMLElement | null) => void }) {
  const tm = useMessages().tsunami
  if (areas.length === 0) return null
  // 無彩色。解除は「もう出ていない」という報せなので、等級の色を借りない。
  const style = getGradeStyle('Unknown')
  // **カード自体は追従の引き当て先にしない。** 等級カードが `grade:` の鍵を持つのは、読み上げが
  // 「〇〇警報。」と等級を告げる箇所を指すため。解除の読み上げは区域名しか指さないので、
  // ここに鍵を置いても誰も引かない。
  return (
    <div className="bg-card rounded-sm overflow-hidden"
      style={{ border: `2px solid ${style.cardBorder}`, boxShadow: `0 0 0 1px ${style.cardBorder}40` }}>
      <div ref={el => {
        for (const area of areas) {
          registerSpeechAnchor(speechRowKeys({ kind: 'area', code: area.code, name: area.name }), el)
        }
      }}
        className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
        style={{ backgroundColor: style.headerBg, color: style.headerColor, borderBottom: `1px solid ${style.headerBorder}` }}>
        {tm.liftedHeader}
      </div>
      {areas.map((area, i) => (
        <Fragment key={i}>
          <TsunamiCancelledRow
            area={area}
            style={style}
            onAreaFocus={onAreaFocus}
            isChanged={focusedDistrict?.districts.some(d => districtMatchesArea(d, area)) ?? false}
            isTop={focusedDistrict?.top != null && districtMatchesArea(focusedDistrict.top, area)}
            registerRow={registerRow}
            registerSpeechRow={registerSpeechRow}
          />
          {/* 解除される前にこの区域で観測した値。区域と観測点の対応は電文どおりに見せる。 */}
          {observations.filter(o => matchesArea(o, area)).map(obs => (
            <TsunamiObservationRow key={obs.name} obs={obs} onObservationClick={onObservationClick} canFocusObs={canFocusObs} registerSpeechRow={registerSpeechRow} obsUpdateStatus={obsUpdateStatus} />
          ))}
        </Fragment>
      ))}
    </div>
  )
}

/**
 * 解除カードの行。読み上げの追従と受信時スクロールの寄せ先になるため、等級カードの行と同じ
 * 2 つの登録（`registerRow` / `registerSpeechRow`）を通す。
 */
function TsunamiCancelledRow({ area, style, onAreaFocus, isChanged, isTop, registerRow, registerSpeechRow }: { area: TsunamiArea; style: GradeStyle; onAreaFocus?: (name: string) => (() => void) | undefined; isChanged: boolean; isTop: boolean; registerRow?: (area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => void; registerSpeechRow?: (keys: string[], el: HTMLElement | null) => void }) {
  const tm = useMessages().tsunami
  // **解除された区域名も押すと地図が寄る**（2026-10-21 ユーザー選択「押すと寄る (Recommended)」。海岸線は描かず
  // 場所だけ寄せる —— 地図は解除された区域の海岸線を描かない）。押せるのは境界を引ける区域だけ（等級カードの行と同じ）。
  const areaFocus = onAreaFocus?.(area.name)
  const setRowRef = useCallback((el: HTMLDivElement | null) => {
    registerRow?.(area, isChanged, isTop, el)
    registerSpeechRow?.(speechRowKeys({ kind: 'area', code: area.code, name: area.name }), el)
  }, [registerRow, registerSpeechRow, area, isChanged, isTop])
  return (
    <div ref={setRowRef} className="border-b border-white/5 last:border-0">
      <div className="flex items-center gap-2 px-3 py-2 roomy:gap-3 roomy:px-4 roomy:py-3">
        <div className="flex-1 min-w-0">
          <span
            className={`text-white font-semibold block text-[1.0625rem] roomy:text-[1.25rem]${areaFocus ? ' cursor-pointer hover:underline' : ''}`}
            style={{ lineHeight: '1.2' }}
            {...(areaFocus ? {
              role: 'button' as const,
              tabIndex: 0,
              onClick: (e: React.MouseEvent) => { e.stopPropagation(); areaFocus() },
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); areaFocus() }
              },
            } : {})}
          >
            {area.name}
          </span>
          {/* 等級の呼び名は読み上げと共有する（`TSUNAMI_GRADE_NAME`）。**前回の等級を読めない区域は「解除」とだけ
              出す**（2026-10-21 ユーザー選択「「解除」とだけ出す」。全期間 19,906 区域で 0 件）。 */}
          <span className="block mt-1" style={{ fontSize: '0.8125rem', color: style.arrivalColor }}>
            {tm.gradeLifted(area.lastGrade && area.lastGrade !== 'Unknown' ? tm.grade[area.lastGrade] : null)}
          </span>
        </div>
      </div>
    </div>
  )
}

function getTopGrade(tsunamis: JMATsunami[]): TsunamiGrade {
  for (const grade of GRADE_ORDER) {
    if (tsunamis.some(t => t.areas.some(a => a.grade === grade))) return grade
  }
  return 'Unknown'
}

// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
/**
 * 気象庁が書いた文の中身（行動指示の行をタップしたときに開く部分）。
 *
 * **小見出しは付けない。** 読めば何の話か分かる文ばかりで、名前を足すとかえって読む量が増える。
 * 区切り線だけで分ける。並びは電文の本文 → 固定付加文（主題順・`WARNING_COMMENT_ORDER`）→
 * 自由付加文。
 */
function TsunamiCommentBody({ endText, bodyText, comments, freeText, borderColor, textColor }: { endText?: string; bodyText?: string; comments?: TsunamiWarningComment[]; freeText?: string; borderColor: string; textColor: string }) {
  const blocks: { key: string; text: string; pre: boolean }[] = [
    // 取消・解除の表示中は、その文（取消の理由・全区域解除の文）を先頭に置き、その下に取消前の文を並べる
    // （2026-10-24 ユーザー選択「取消・解除の文も面に入れる」）。
    ...(endText ? [{ key: '__end', text: endText, pre: true }] : []),
    // 電文の本文。**バナーには出していない**ので、ここが唯一の出しどころ。
    ...(bodyText ? [{ key: '__body', text: bodyText, pre: true }] : []),
    ...(comments ?? []).map(c => ({ key: c.key, text: c.text, pre: false })),
    // 自由付加文。全角スペースで整形された表が入るため改行と空白をそのまま保つ。
    ...(freeText ? [{ key: '__free', text: freeText, pre: true }] : []),
  ]
  if (blocks.length === 0) return null
  return (
    <div>
      {/* 先頭だけ区切り線を出さない。**`first:` の指定では消せない** —— インラインの
          `borderTop` が常に勝つので、先頭かどうかをここで見て出し分ける。 */}
      {blocks.map((b, i) => (
        <div key={b.key}
          className={i === 0 ? '' : 'pt-2 mt-2'}
          style={i === 0 ? undefined : { borderTop: `1px solid ${borderColor}` }}>
          <div style={{ fontSize: '0.6875rem', color: textColor, opacity: 0.95, lineHeight: 1.6, whiteSpace: b.pre ? 'pre-wrap' : 'pre-line' }}>
            {b.text}
          </div>
        </div>
      ))}
    </div>
  )
}

export const TsunamiTab = memo(function TsunamiTab({ tsunamis, earthquakes, onEarthquakeLink, onObservationClick, onFocusMap, focusedDistrict, obsUpdateStatus, areaGradeChangedKeys, tsunamiValueMarks, speechSession, speakingTelegramText, isVisible, speechFollowEnabled, autoShowTick }: Props) {
  const tm = useMessages().tsunami
  // 行をクリックできるかは「地図がその観測点へ寄れるか」で決める。
  //
  // 座標表（`tsunami-obs-coords.json`）に無い観測点は地図に印が出ず、`FocusObsGL` も寄せ先を
  // 見つけられずに黙って何もしない。押せる見た目だけ与えると、利用者からは「押したのに動かない」
  // 理由が分からない。判定の材料は地図側（`useTsunamiLayerData`）が印を出すかどうかと同じ座標表。
  const obsCoords = useTsunamiObsCoords()
  const canFocusObs = useCallback((name: string) => !!obsCoords?.[name], [obsCoords])
  /**
   * 区域名から「その予報区へ寄せる」動作を作る。**押せるかどうかもこれで決まる**（境界を引けない
   * 区域は `undefined` が返り、押せる見た目にならない）。観測点の行と同じ規律。
   *
   * 寄り先は海岸線の**外接矩形の 2 点**（`fitToPositions` が矩形へ寄せるので全頂点は要らない）。
   * 索引は入力の参照をキーにキャッシュされるので、区域の行ごとに作り直されることはない。
   */
  const zones = useTsunamiZones()
  const zoneBounds = zones ? ringsBoundsIndex(zones, () => Object.entries(zones)) : EMPTY_BOUNDS_INDEX
  const onAreaFocus = useCallback((name: string) => {
    if (!onFocusMap) return undefined
    const bounds = zoneBounds.get(name)
    if (!bounds) return undefined
    const corners: LatLng[] = [[bounds.minLat, bounds.minLng], [bounds.maxLat, bounds.maxLng]]
    return () => onFocusMap(corners)
  }, [onFocusMap, zoneBounds])
  // cancelledAt がある = 10秒表示中なので active に含める
  const active = tsunamis.filter(t => !t.cancelled || t.cancelledAt)

  // バナーの本文と、そこから開く付加文。
  //
  // **フックは早期 return より前に置く。** 下の「津波情報はありません」で return しており、
  // 後ろに置くと津波が出た瞬間にフックの数が変わって React が描画ごと落とす（実際に踏んだ）。
  const isCancelledDisplay = active.every(t => !!t.cancelledAt)
  // 見るのは `active[0]` だけ。**状態は常に 0〜1 件スロット**で、同時発表は最新の 1 通で
  // 置き換わる（`useEarthquakes.ts` の TSU-3）。ここを配列で回しても 2 件目は来ない。
  const bannerBodyText = active[0]?.bodyText
  const bannerComments = active[0]?.warningComments
  const bannerFreeText = active[0]?.freeText
  // 行動指示の行に出す文。気象庁の避難行動の付加文が採れればそれを使う（→ `evacuationActionLine`）。
  const bannerActionLine = evacuationActionLine(bannerComments)
  // 取消・解除の表示中に面の先頭へ置く文（取消の理由・全区域解除の文）。
  const bannerEndText = isCancelledDisplay ? (active[0]?.cancelText ?? active[0]?.liftText) : undefined
  // 開くものが 1 つも無ければ、その行はタップの入口にしない（押せる見た目だけ与えない）。
  // **取消・解除の表示中も開ける**（2026-10-21 ユーザー選択「開けるようにする (Recommended)」）。表示中は 10 秒で消える。
  const hasCommentsToShow = (bannerComments?.length ?? 0) > 0 || !!bannerBodyText || !!bannerFreeText || !!bannerEndText
  // 読み上げているあいだだけ開く（→ `useAutoOpenWhileSpeaking`）。**バナー 4 種と同じフックを使う。**
  // 自前で組んでいた頃は「手で開き直したら読み終わりで閉じない」という安全弁が抜けており、
  // 利用者が開いた面を読み終わりで閉じていた。
  const [commentsOpen, setCommentsOpen] = useAutoOpenWhileSpeaking(!!speakingTelegramText, 'tsunamiComment')
  // **開いたまま等級が動いたら閉じる。** 付加文の面は下の区域一覧を覆うので、開けっ放しだと
  // 発表・引き上げ・一部解除が届いても利用者の目に入らない。
  //
  // **ただし報ごとには閉じない。** 満潮時刻や観測の続報は数分おきに届き（2026-04-20 の実電文で
  // 41 通）、そのたびに閉じると読んでいる途中で毎回消える。鍵は津波の識別子と「区域ごとの等級」の
  // 組にして、等級が動いた報だけが閉じる契機になるようにする。
  //
  // **同じ津波かは番号の重なりで見る**（`isSameTsunamiEvent` と同じ物差し。運用種別も揃えて比べる）。番号の組を
  // 1 つの文字列の鍵へ縮める（最小の番号など）と、組み直しや、より小さい番号を持つ報の追加で鍵が動き、
  // 等級が動いていないのに閉じる。番号を持たない電文（`EventID` が空）は `id` で比べる —— その電文は続報として束ねられない
  // （`isTsunamiContinuation`）ので前報の中身も引き継がず、報ごとに閉じても「等級が動いたときだけ閉じる」との食い違いにはならない。
  const commentsIdentity = active[0]
    ? `${active[0].operationStatus ?? ''}|${tsunamiEventIds(active[0]).join(' ') || `#${active[0].id}`}`
    : ''
  const commentsGrades = (active[0]?.areas ?? []).map(a => `${a.code ?? a.name}:${a.grade}`).join(',')
  // **前回値は state で持つ。ref をレンダー中に書き換えない。** React は描いた結果を捨てて
  // 描き直すことがあり、捨てられたレンダーでも ref の書き換えだけは残る。次のレンダーでは
  // 「鍵は変わっていない」と見えて閉じそこねる —— 実機で等級が動いても開いたままになった。
  // state なら捨てられたレンダーの更新も一緒に捨てられるので、この取りこぼしが起きない。
  const [prevComments, setPrevComments] = useState({ identity: commentsIdentity, grades: commentsGrades })
  // **閉じるのはエフェクトで行う。** 開閉の状態はフックが持ち、その setter は
  // 「手で操作した」という意味を持つ（読み上げの持ち物から外す）。レンダー中に呼ぶと、
  // React が捨てたレンダーでもフック内部の印だけが書き換わる。
  //
  // 1 描画ぶん閉じるのが遅れるが、**等級が動いた報で閉じる**という意図は保たれる。
  useEffect(() => {
    if (prevComments.identity === commentsIdentity && prevComments.grades === commentsGrades) return
    setPrevComments({ identity: commentsIdentity, grades: commentsGrades })
    if (prevComments.grades === commentsGrades && isSameCommentsTsunami(prevComments.identity, commentsIdentity)) return
    // 読み上げ中でも閉じる（面は区域一覧を覆うので、発表・引き上げ・一部解除を隠さない）。
    // フックの setter を通すので、その読み上げのあいだは開き直さない。
    setCommentsOpen(false)
  }, [commentsIdentity, commentsGrades, prevComments, setCommentsOpen])

  // バナーの実高さを測る。使い道は 2 つ。
  //   - 読み上げの追従と受信時の寄せが視野から引く高さ（貼り付けている間だけ）
  //   - 大きいまま貼り付けるか、流して帯にするかの判定（`bannerStickMode`）
  // 発令中/解除・地震カードリンクの有無で行数が変わるので、固定値では合わない。
  // 「津波情報なし」表示から実データ表示への切替でバナー要素自体が生成し直されるため、
  // useRef + 空配列 useEffect ではなく callback ref で mount のたびに監視し直す
  const bannerObserverRef = useRef<ResizeObserver | null>(null)
  const bannerElRef = useRef<HTMLDivElement | null>(null)
  const [bannerHeight, setBannerHeight] = useState(0)
  // 付加文の入口の行を除いたバナーの高さと、入口の行の高さ（→ `canShowCommentsEntry`）。入口の行の高さは
  // 消えている間も覚えておく —— 判定は「出したときの高さ」で行うので、消えた途端に 0 へ戻すと揺れが戻る。
  const [bannerBaseHeight, setBannerBaseHeight] = useState(0)
  const [commentsEntryHeight, setCommentsEntryHeight] = useState(0)
  const commentsEntryHeightRef = useRef(0)

  const bannerRef = useCallback((el: HTMLDivElement | null) => {
    bannerElRef.current = el
    bannerObserverRef.current?.disconnect()
    bannerObserverRef.current = null
    // 消えたら 0 へ戻す。前の津波の高さが残ると、次の津波の最初の判定が古い高さで決まる
    if (!el) { setBannerHeight(0); setBannerBaseHeight(0); return }
    // contentRect は padding を含まない content-box。バナーには pt-3 の padding があるため
    // 実際の占有高さ（border-box）は getBoundingClientRect で測る。
    // **入口の行もここで同じ瞬間に測る** —— 別々に見張ると、バナーは入口込み・入口は 0 のような食い違った組が出る。
    const measure = () => {
      const height = el.getBoundingClientRect().height
      const entry = el.querySelector<HTMLElement>('[data-comments-entry]')
      if (entry) {
        commentsEntryHeightRef.current = entry.getBoundingClientRect().height + (parseFloat(getComputedStyle(entry).marginTop) || 0)
      }
      setBannerHeight(height)
      setBannerBaseHeight(height - (entry ? commentsEntryHeightRef.current : 0))
      setCommentsEntryHeight(commentsEntryHeightRef.current)
    }
    // 見張りを持たない環境（テストの jsdom）では張らず、下の 1 回だけ測る（リアルタイムタブのカウントダウンと同じ扱い）
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure)
      observer.observe(el)
      bannerObserverRef.current = observer
    }
    // **初期値も同期で入れる**（パネル側と形を揃える）。監視のコールバックだけに任せると、
    // 「津波情報なし」から切り替わった直後の数フレームはバナーが 0 のままで、下の上限が
    // 実際より大きく出る。
    measure()
  }, [])

  // 今回変更された区域の行DOM（area.code ?? area.name をキーに登録・登録解除される）
  const changedRowElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const topRowElRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // 重ねた付加文の高さの上限。**パネルの実寸から引く** —— 画面の高さ（`vh`）で切ると、
  // 上下分割でパネルが画面の一部しか占めていないときに下へはみ出す（実測値は
  // docs/spec/tsunami-spec.md §9）。バナーの下に置くので、残りがそのまま上限。
  //
  // **callback ref で測る。`useEffect` + `[]` では張り直されない。** 津波が無い間は下の
  // 「津波情報はありません」で早期 return しており、この要素自体が存在しない。効果は
  // 空振りして終わり、津波が届いても依存が変わらないので二度と走らない —— 結果、高さが 0 の
  // ままで上限が付かず、開いた付加文がパネルの外まで伸びる（実際にそうなった）。
  const [panelHeight, setPanelHeight] = useState(0)
  const panelObserverRef = useRef<ResizeObserver | null>(null)
  // 器の要素そのものも状態に持つ。**帯の見張り（下の effect）は器ごとに張り直す** —— 津波が無い間は器ごと消え、次の津波で
  // 新しい器が作られる。参照だけで持つと effect が走り直さず、2 回目以降の津波で帯が一度も出なかった。
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el
    setContainerEl(el)
    panelObserverRef.current?.disconnect()
    panelObserverRef.current = null
    if (!el) { setPanelHeight(0); return }
    const observer = new ResizeObserver(() => setPanelHeight(el.clientHeight))
    observer.observe(el)
    panelObserverRef.current = observer
    setPanelHeight(el.clientHeight)
  }, [])
  // 面の高さの上限と、そもそも開かせてよいかの判断（→ `overlayHeight.ts`）。
  // **寸法の判断はコンポーネントの外に置く** —— ここに書くとテストで押さえられない。
  const commentsMaxHeight = commentsOverlayMaxHeight(panelHeight, bannerHeight)
  // バナーを大きいまま貼り付けるか、流して巻いたら 1 行の帯を出すか（→ `bannerStickMode`）。
  // **追従と受信時の寄せが視野から引くのは、上に貼りついているものの高さ** —— 大きいまま貼るならバナー、
  // 帯の形なら帯（流しているバナーはスクロールで上へ抜け、代わりに帯が出る）。
  const bannerMode = bannerStickMode(panelHeight, bannerHeight)
  const [bandHeight, setBandHeight] = useState(0)
  const [bandShown, setBandShown] = useState(false)
  const bandObserverRef = useRef<ResizeObserver | null>(null)
  const setBandRef = useCallback((el: HTMLDivElement | null) => {
    bandObserverRef.current?.disconnect()
    bandObserverRef.current = null
    if (!el) { setBandHeight(0); return }
    const observer = new ResizeObserver(() => setBandHeight(el.getBoundingClientRect().height))
    observer.observe(el)
    bandObserverRef.current = observer
    setBandHeight(el.getBoundingClientRect().height)
  }, [])
  // 帯を出すのは、流しているバナーが帯の高さより上へ抜けたときだけ。巻くたびに測る（描画は状態が変わったときだけ）。
  useEffect(() => {
    const container = containerEl
    if (bannerMode !== 'band' || !container) { setBandShown(false); return }
    let raf = 0
    const measure = () => {
      raf = 0
      const banner = bannerElRef.current
      if (!banner) return
      const gone = banner.getBoundingClientRect().bottom - container.getBoundingClientRect().top <= Math.max(bandHeight, 1)
      setBandShown(gone)
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure) }
    measure()
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => { container.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf) }
    // バナーの高さが続報で変わったときも測り直す（巻かなくても、帯を出すかが変わる）
  }, [bannerMode, bandHeight, bannerHeight, containerEl])
  // 帯が出たら、バナーの下へ重ねた付加文の面を閉じる。面はバナーと一緒に上へ抜け、閉じる入口が見えなくなる
  useEffect(() => {
    if (bandShown) setCommentsOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 帯が出た瞬間だけ閉じる（開閉の関数が変わっても閉じ直さない）
  }, [bandShown])
  /** 帯を押すと先頭へ戻り、バナーを見せる。端末で「動きを減らす」を選んでいれば一度に飛ぶ。 */
  const scrollToBanner = useCallback(() => {
    containerRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [])
  const stickyBannerHeight = bannerMode === 'stick' ? bannerHeight : bandHeight
  // **出す場所が無いときも入口にしない。** パネルを縮めるとバナーだけで埋まり、面は
  // 高さ 0 になる。開くと矢印が ▶→▼ に変わるだけで中身は 1 行も見えず、理由も出ない。
  // 測るのは入口を出したときの高さ（→ `canShowCommentsEntry`。いまの高さで測ると入口の出し入れで揺れ続ける）。
  const canOpenComments = hasCommentsToShow && canShowCommentsEntry(panelHeight, bannerBaseHeight, commentsEntryHeight)

  const registerRow = useCallback((area: TsunamiArea, isChanged: boolean, isTop: boolean, el: HTMLDivElement | null) => {
    const key = area.code ?? area.name ?? ''
    if (el && isChanged) changedRowElsRef.current.set(key, el)
    else changedRowElsRef.current.delete(key)
    if (isTop) topRowElRef.current = el
  }, [])

  // 読み上げ追従の引き当て表（キーの作り方は speechRowKeys）。区域は変更の有無に関わらず全件、
  // 観測点は実測・到達確認の行だけを持つ。
  const speechRowElsRef = useRef<Map<string, HTMLElement>>(new Map())
  const registerSpeechRow = useCallback((keys: string[], el: HTMLElement | null) => {
    for (const key of keys) {
      if (el) speechRowElsRef.current.set(key, el)
      else speechRowElsRef.current.delete(key)
    }
  }, [])

  // 区域キー → その区域が属する**等級カードの頭**（「大津波警報」の帯）。
  //
  // 区域を読んで動くときの行き先をここに揃える。区域行だけを基準にすると、その区域が
  // 画面の上端に来るように送られ、**どの等級の話をしているのかが視野から消える**。カードの頭を
  // 範囲に含めれば上端がそこになり、等級・波高見出し・区域が上から順に収まる。
  const speechAnchorElsRef = useRef<Map<string, HTMLElement>>(new Map())
  const registerSpeechAnchor = useCallback((keys: string[], el: HTMLElement | null) => {
    for (const key of keys) {
      if (el) speechAnchorElsRef.current.set(key, el)
      else speechAnchorElsRef.current.delete(key)
    }
  }, [])

  // 手で動かしたあとは追従を止める。地図の自動フィットと同じ考え方で、同じ保持時間を使う。
  //
  // 拾うのは `wheel` と `touchstart` の 2 つだけ。`scroll` は自分の `scrollTo` が撒くので
  // 使えない（自動と手動を区別する仕組みが別に必要になる）。`pointerdown` も採らない
  // ―― 観測点行のクリックは地図を寄せるための正当な操作で、それで追従が 30 秒止まるのは筋が
  // 違う（地図側のガードも「実際に視点が動いた」`zoomstart`/`dragstart` だけを見ていて
  // クリックは拾わない）。スクロールバーのドラッグとブラウザ内検索は取りこぼす。
  //
  // ref ではなく state で持つのは、保持が明けた瞬間に追従側の effect を起こし直すため
  // （CameraFollowsGL の useUserInteractionGuard と同じ理由）。
  const [userScrollHold, setUserScrollHold] = useState(false)
  // 先頭復帰（`autoShowTick`）からも読む。あちらは保持の明けで動き直してはいけないので
  // （明けた瞬間に画面が飛ぶ）、state を依存に取らず ref で今の値だけを見る。
  const userScrollHoldRef = useRef(false)
  userScrollHoldRef.current = userScrollHold
  const userHoldTimerRef = useRef<number | undefined>(undefined)
  const hasCards = active.length > 0
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onInteract = () => {
      setUserScrollHold(true)
      window.clearTimeout(userHoldTimerRef.current)
      userHoldTimerRef.current = window.setTimeout(() => setUserScrollHold(false), INTERACTION_HOLD_SEC * 1000)
    }
    container.addEventListener('wheel', onInteract, { passive: true })
    container.addEventListener('touchstart', onInteract, { passive: true })
    return () => {
      container.removeEventListener('wheel', onInteract)
      container.removeEventListener('touchstart', onInteract)
    }
  }, [hasCards])
  useEffect(() => () => window.clearTimeout(userHoldTimerRef.current), [])

  /**
   * 追従が最後に「読んでいる箇所を引き当てた」時刻（受信時スクロールが読む）。
   *
   * **真偽値ではなく時刻で持つ。** 真偽値だと読み上げが終わった時点で落ちるため、そのあと
   * 受信時スクロールの猶予が明けたときに「追従は働かなかった」と誤って判断し、読み終えた
   * カードを区域へ寄せ直してしまう。受信（`focusedDistrict.ts`）より後に追従が動いていれば
   * その受信は追従が受け持ったと見なせる。
   */
  const followHandledAtRef = useRef(0)

  // 追従の進み具合。**読み上げ 1 本（`token`）に紐づけて持つ。** 追従の effect は
  // `isVisible` などの変化でも作り直されるため、ここに置かないと途中で記憶が失われる。
  const followProgressRef = useRef<{
    token: number
    lastIndex: number
    /** smooth スクロールの行き先。着くまでは判定の基準をこちらにする */
    targetScrollTop: number | null
    /**
     * 区域・観測点の行を一度でも引き当てられたか（診断用）。
     * **等級は数えない。** 理由は下の `sawRowRef` を立てている箇所のコメント。
     */
    resolvedAny: boolean
    /** 区域・観測点を指すチャンクが一度でもあったか（診断用。無ければ引けなくて当然） */
    sawRowRef: boolean
    /** 視野の高さが無くて追従を見送ったことを記録したか（読み上げ 1 本につき 1 回だけ残す） */
    warnedNoRoom: boolean
  } | null>(null)

  /**
   * 読み上げに合わせてカードを送る。
   *
   * 現在位置の解決を rAF で回しているのは、voicevox が渡すのが「予約」（`startAt` は
   * AudioContext の時間軸で未来を指す）だから。チャンクごとに `setTimeout` を張る形にすると、
   * バックグラウンドのタブでタイマーが間引かれる一方で音は実時間で鳴り終わり、滞留した
   * タイマーが後から発火して追従の状態が残る。rAF なら非表示中は止まり、戻ったときに
   * 一発で正しい位置へ収束する。
   */
  useEffect(() => {
    const session = speechSession
    if (!session || !isVisible || userScrollHold) return

    // **進み具合はセッション単位で持つ（effect のローカルにしない）。** この effect は
    // `isVisible` / `userScrollHold` / `stickyBannerHeight` の変化でも作り直される。ローカルに
    // 置くと、読み上げの途中で手を触れたりバナーの高さが変わったりするたびに「一度出した箇所」の
    // 記憶が消え、消したはずの往復スクロールが戻ってくる。
    if (followProgressRef.current?.token !== session.token) {
      followProgressRef.current = {
        token: session.token,
        lastIndex: -1,
        targetScrollTop: null,
        resolvedAny: false,
        sawRowRef: false,
        warnedNoRoom: false,
      }
    }
    const progress = followProgressRef.current

    let raf = 0
    let refsPerChunk: SpeechRef[][] | null = null
    let mappedChunks: readonly string[] | null = null

    const lookup = (table: Map<string, HTMLElement>, ref: SpeechRef): HTMLElement | null => {
      for (const key of speechRowKeys(ref)) {
        const el = table.get(key)
        if (el) return el
      }
      return null
    }

    /**
     * 読んでいる箇所そのものが占める要素。
     * 等級はカードの頭、観測点は区域行の内側なので、いずれも 1 つで足りる。
     */
    const rowElementFor = (ref: SpeechRef): HTMLElement | null =>
      lookup(speechRowElsRef.current, ref)

    /**
     * 併せて視野に入れたい前置き。区域では**その等級カードの頭**、観測点では**その区域の見出し**
     * （沖合の観測点なら「沖合観測」の帯）。
     *
     * 区域行だけを上端に合わせると、どの等級の話をしているのかが視野から消える。**観測点も同じで、
     * 読み上げ文は読点でチャンクが割れるため「石川県能登、」と「輪島港で〜」は別チャンクになる**
     * —— 観測点のチャンクへ進んだ時点で前置きが無いと、その行だけが上端へ揃えられ、直前に読んだ
     * 区域名が視野の外へ流れる。
     *
     * ただしこれを「読んでいる箇所」に混ぜてはいけない。混ぜると送り先の上端が常にカードの頭に
     * なり、等級のところで一度寄せた後は区域行がどれだけ見切れていても動かなくなる
     * （`planFollowScroll` の JSDoc 参照）。前置きとして別に渡し、収まるときだけ含める。
     *
     * **前置きに区域行そのもの（`TsunamiAreaRow` の外枠）を渡さないこと。** あれは配下の観測点を
     * 全部抱えているので、観測点の多い区域では視野に収まらず前置きごと捨てられる —— いちばん
     * 見切れやすい場面で効かなくなる。渡すのは見出しの 1 行だけ。
     */
    const contextElementFor = (ref: SpeechRef): HTMLElement | null =>
      hasFollowContext(ref) ? lookup(speechAnchorElsRef.current, ref) : null

    // 差し替えで DOM から外れた要素は矩形が全 0 になる。そのまま使うと巨大なスクロールになる
    const rectsFor = (
      refs: readonly SpeechRef[],
      offset: number,
      pick: (ref: SpeechRef) => HTMLElement | null,
    ): FollowRect[] => {
      const rects: FollowRect[] = []
      for (const ref of refs) {
        const el = pick(ref)
        if (!el || !el.isConnected) continue
        const r = el.getBoundingClientRect()
        if (r.height <= 0) continue
        rects.push({ top: r.top - offset, bottom: r.bottom - offset })
      }
      return rects
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const container = containerRef.current
      if (!container || !session.chunks || session.schedule.length === 0) return

      // チャンクと参照の対応は 1 度だけ求める（チャンク列は読み上げの途中で変わらない）
      if (refsPerChunk === null || mappedChunks !== session.chunks) {
        mappedChunks = session.chunks
        refsPerChunk = mapChunksToRefs(session.segments, session.chunks)
      }

      const now = getSpeechClock()
      if (now === null) return
      // 鳴り始めた予約のうち最後のものが「いま読んでいるチャンク」。schedule は届いた順＝
      // startAt の昇順に積まれる
      let currentIndex = -1
      for (const entry of session.schedule) {
        if (entry.startAt > now) break
        currentIndex = entry.index
      }
      if (currentIndex < 0) return

      // 行き先に着いたら基準を現在位置へ戻す
      if (progress.targetScrollTop !== null
        && Math.abs(container.scrollTop - progress.targetScrollTop) < 2) {
        progress.targetScrollTop = null
      }
      if (currentIndex === progress.lastIndex) return
      progress.lastIndex = currentIndex

      const currentRefs = refsPerChunk[currentIndex] ?? []
      if (currentRefs.length === 0) return

      // **同じ箇所を読み直す文は無い前提に立っている。** 読み上げは区域名を 1 回だけ出す
      // （区域と波高を 1 文で言い切る。→ `ttsText` の `areaHeightSentence`）。かつては
      // 「区域を列挙 → 予想最大波高でもう一周」の形で同じ区域を 2 回読んでいて、2 周目に
      // 付き合うと 1 周目で見せた場所へ戻ってすぐ下がる往復になったため、出した箇所を
      // 記録して追わない仕掛けを置いていた。文面を変えて重複が無くなったので外してある。
      // **読み上げ文を「同じ区域を 2 回読む」形に戻すなら、ここも戻すこと。**

      // これから読む箇所（この先のチャンクを読み上げ順に）
      const upcomingRefs: SpeechRef[] = []
      for (let i = currentIndex + 1; i < refsPerChunk.length; i++) {
        upcomingRefs.push(...refsPerChunk[i])
      }

      const containerRect = container.getBoundingClientRect()
      // 矩形は「行き先」から見た位置に直す。scrollTop が増えると要素は上へ動くので、
      // 進む量ぶん引く（コンテナ自身は動かないので視野はそのまま）。
      const base = progress.targetScrollTop ?? container.scrollTop
      const offset = base - container.scrollTop
      const currentRects = rectsFor(currentRefs, offset, rowElementFor)

      // 診断の集計。**等級（`grade`）は数えない。**
      //
      // 等級のカードは全等級ぶん常に登録されていて、電文の中身に依らず必ず引ける。読み上げ文は
      // 必ず等級の宣言から始まるので、これを成功に数えると `resolvedAny` が毎回 true になり、
      // 続く区域・観測点が 1 件も引けなくても下の警告が出なくなる。区域コードの食い違いを
      // 見つけるために置いた診断が、静かに死ぬ。前置き（カードの頭）を数えないのも同じ理由。
      if (currentRefs.some(r => r.kind !== 'grade')) {
        progress.sawRowRef = true
        if (currentRects.length > 0) progress.resolvedAny = true
      }

      // **行を引き当てられないうちは受け持ったことにしない。** 区域コードや観測点名が
      // 食い違って一度も引けない読み上げでも、無条件に印を立てると受信時スクロール
      // （変更区域へ寄せるフォールバック）まで道連れで止まり、画面が一切動かなくなる。
      if (currentRects.length === 0) return

      const viewTop = containerRect.top + stickyBannerHeight + stuckGradeHeaderHeight(container)
      // **動けないことを黙らせない。** `planFollowScroll` はこのとき `null` を返すが、「もう
      // 見えている」ときと見分けが付かない。読み上げ 1 本につき 1 回だけ残す。
      //
      // **動けないうちは受け持ったことにもしない**（上の「行を引けないうち」と同じ理由）。
      // 印を立てると受信時の寄せが道連れで止まる —— あちらは余白を引かずに測るので、
      // こちらが動けない狭さでも動けることがある。
      if (!followViewHasRoom(viewTop, containerRect.bottom)) {
        // 進み具合を戻す —— 戻さないと、パネルを広げて視野が戻っても、このチャンクは
        // 「もう扱った」ことになって追い直さない（次のチャンクまで待つ）。
        // 戻すと毎フレームこの判定を通るが、矩形を数個測るだけで記録は 1 回に絞ってある。
        progress.lastIndex = -1
        // パネルを畳んでいる（高さ 0）のは利用者の操作で、異常ではないので記録しない。
        if (!progress.warnedNoRoom && containerRect.height > 0) {
          progress.warnedNoRoom = true
          log.warn('[tsunami] 読み上げの追従を見送り（視野の高さが無い）', {
            panel: Math.round(containerRect.height),
            banner: Math.round(bannerHeight),
            sticky: stickyBannerHeight > 0,
          })
        }
        return
      }
      followHandledAtRef.current = Date.now()
      const next = planFollowScroll({
        viewTop,
        viewBottom: containerRect.bottom,
        currentRects,
        contextRects: rectsFor(currentRefs, offset, contextElementFor),
        upcomingRects: rectsFor(upcomingRefs, offset, rowElementFor),
        currentScrollTop: base,
        maxScrollTop: Math.max(0, container.scrollHeight - container.clientHeight),
      })
      if (next === null) return

      progress.targetScrollTop = next
      container.scrollTo({ top: next, behavior: 'smooth' })
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [speechSession, isVisible, userScrollHold, stickyBannerHeight, bannerHeight])

  // 読み上げが終わったところで、追従が仕事をできたかを振り返る。
  //
  // 上の effect のクリーンアップではなく**セッションの終わり**で見るのは、あちらが
  // `isVisible` などの変化でも作り直されるため。作り直しのたびに評価すると、タブを離れた
  // だけで「引き当てられなかった」と言い出す。
  useEffect(() => {
    if (speechSession) return
    const last = followProgressRef.current
    followProgressRef.current = null
    // **区域・観測点を読んだのに、その行を一度も引き当てられなかったときだけ残す。**
    //
    // 読み始めた直後にタブを離れると、追従の rAF が止まって以降のチャンクを見ないため、
    // 引き当ての失敗と区別できずに出ることがある（ログのノイズに留まる既知の限界）。
    // 読み上げは出ているのに画面が動かない状態で、症状（動かない）からは追従の不具合と表示の
    // 不具合を区別できない。区域コード・観測点名の食い違い（`matchesArea` が想定している経路）
    // を疑う手がかり。等級しか読まなかった読み上げでは引けなくて当然なので黙る。
    if (last?.sawRowRef && !last.resolvedAny) {
      log.warn('[tsunami] 読み上げ追従: 区域・観測点の行を一度も引き当てられなかった')
    }
  }, [speechSession])

  // 自動で見せられたときは先頭へ戻す（`autoShowTick` の JSDoc 参照）。
  //
  // **`useLayoutEffect` で行うのは順序のため。** 同じ受信で受信時スクロール（`useEffect`）や
  // 読み上げ追従（rAF）が動くなら、そちらに上書きさせたい。先頭へ戻すのは「他に行き先が
  // 決まらなかったとき」の既定でしかない。
  //
  // 一瞬で移す（`behavior: 'smooth'` にしない）。移動してきた直後で、まだ何も見せていない
  // 場所からの滑走を見せる意味が無いうえ、続く追従のスクロールと重なって二重に動く。
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    // 手で動かした直後は動かさない。他の 2 つの駆動（受信時スクロール・読み上げ追従）も
    // 同じ保持を尊重するので、ここだけ無条件に走ると「触った直後に飛ぶ」のが残る。
    //
    // **保持が明けたときに埋め合わせはしない**（既知の限界）。手でスクロール中に他タブへ移り、
    // 保持が明ける前に自動で連れ戻された場合は、前の位置のまま表示される。埋め合わせるには
    // 保持の明けを待って一度だけ実行する仕掛けが要るが、それは「何もしていないのに画面が飛ぶ」
    // という、この保持で防いでいるものを作り直すことになる。触った位置を残す方を採る。
    if (userScrollHoldRef.current) return
    container.scrollTop = 0
    // 追従が持っている「行き先」も捨てる。残すと、この先頭復帰を追従が知らないまま
    // 矩形を補正し、まだ動く前の位置を基準に判定してしまう。
    const progress = followProgressRef.current
    if (progress) progress.targetScrollTop = null
  }, [autoShowTick])

  // 変更区域が画面に収まるならまとめて見えるように、収まらなければ波高最大の区域が
  // ヘッダー直下に来るようにスクロールする（読み上げが無効な端末の唯一の自動スクロール）
  useEffect(() => {
    if (!focusedDistrict) return
    const container = containerRef.current
    if (!container) return

    const run = () => {
      // この受信より後に追従が動いていれば、その受信は追従が受け持ったと見なして見送る。
      // **読み上げは数十秒続く**ため、その最中にここが動くと、いま読んでいる箇所から引き剥がした
      // うえで次のチャンクで追従が引き戻す。
      if (followHandledAtRef.current >= focusedDistrict.ts) return
      // 寄せ先が無い受信。先頭へ戻すかどうかは要求側が決める（→ `FocusedDistrict.resetToTop`）。
      // **寄せ先が無いことを理由に動かさない** —— 満潮時刻の報や沖合の観測情報が、直前の報や
      // 読み上げが合わせた位置を捨てていた。
      if (focusedDistrict.districts.length === 0) {
        if (focusedDistrict.resetToTop) container.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }
      const changedEls = Array.from(changedRowElsRef.current.values())
      if (changedEls.length === 0) return

      const containerRect = container.getBoundingClientRect()
      const viewTop = containerRect.top + stickyBannerHeight + stuckGradeHeaderHeight(container)
      const viewBottom = containerRect.bottom
      const availableHeight = viewBottom - viewTop
      // 視野が無ければ寄せない。下の「収まらないときは先頭の行を上端へ」が、視野の外（パネルの
      // 下端より下）へ合わせにいってしまう。
      if (availableHeight <= 0) {
        // パネルを畳んでいる（高さ 0）ときは利用者の操作なので記録しない
        if (containerRect.height > 0) log.warn('[tsunami] 受信時の寄せを見送り（視野の高さが無い）', {
          panel: Math.round(containerRect.height),
          banner: Math.round(bannerHeight),
          sticky: stickyBannerHeight > 0,
        })
        return
      }

      const tops = changedEls.map(el => el.getBoundingClientRect().top)
      const bottoms = changedEls.map(el => el.getBoundingClientRect().bottom)
      const spanTop = Math.min(...tops)
      const spanBottom = Math.max(...bottoms)
      const spanHeight = spanBottom - spanTop

      let delta = 0
      if (spanHeight <= availableHeight) {
        if (spanTop < viewTop) delta = spanTop - viewTop
        else if (spanBottom > viewBottom) delta = spanBottom - viewBottom
      } else if (topRowElRef.current) {
        delta = topRowElRef.current.getBoundingClientRect().top - viewTop
      }

      if (Math.abs(delta) > 1) {
        container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' })
      }
    }

    // **寄せる先がある受信だけ、追従が受け持つのを待つ。** 電文が届いた瞬間に変更区域へ寄せても、
    // 0.8〜2.8 秒後（通知音との間隔）に読み上げが始まって等級カードの頭へ引き戻すことになり、
    // 逆向きの動きが見える。声と画面を一致させる側に任せる。
    //
    // **寄せ先が無い受信（`districts` が空）は待たない。** 理由は先頭へ戻す側の 3 つで違う。
    //
    // - **解除**: 追従の対象になる読み上げを持たない（解除の読み上げは区域名を含まない
    //   ので参照が無い）。待たせても追従は永久に来ず、猶予のあいだ解除前の位置に留まるだけ。
    //   **解除で待たされるのが一番まずい。**
    // - **新規発報・等級の変わった報**: こちらは区域名を含む読み上げを持つので追従も来る。
    //   ただし等級が変わるのは最上位の区域群が入れ替わったときで、カードは重い等級を先頭へ
    //   積むため、**即時の先頭戻しと追従の着地点がほぼ一致する**（先に戻しても往復にならない）。
    //   この一致は「変化した区域が必ず先頭グループへ来る」ことに依っているので、並べ方を
    //   変えるときは待たせる側へ回すかを見直すこと。
    //
    // 戻さない側（`resetToTop` が false）は `run()` が何もしないので、待つかどうかで
    // 結果が変わらない。
    //
    // 待つ場合も**待ちっぱなしにはしない。** 「有効」は端末の設定値にすぎず、その電文で実際に
    // 読み上げが成立するかは別（VOICEVOX が未起動・到達不能でも `speakWithVoicevox` は無音の
    // まま正常終了する契約）。待って何も起きなければ、ここが唯一の自動スクロールになる。
    if (speechFollowEnabled && focusedDistrict.districts.length > 0) {
      const timer = window.setTimeout(run, SPEECH_FOLLOW_GRACE_MS)
      return () => window.clearTimeout(timer)
    }
    run()
  // focusedDistrict.ts を依存にすることで同一区域の再フォーカスも発火する
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedDistrict?.ts, stickyBannerHeight, bannerHeight, speechFollowEnabled])

  if (active.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-4">
        <div className="text-center">
          <p className="text-green-400 font-bold">{tm.noneTitle}</p>
          <p className="text-secondary text-sm mt-1">{tm.noneBody}</p>
        </div>
      </div>
    )
  }

  const topGrade = getTopGrade(active)
  const topStyle = getGradeStyle(topGrade)
  const cancelInfo = tm.cancel[active[0]?.cancelReason ?? 'lifted']
  const latestTime = active[0]?.time
  // 観測状況を確定した時刻（`Head/TargetDateTime`）。**発表時刻と同じ分なら出さない** ——
  // 同じ数字が 2 つ並ぶだけで、「観測値は発表より前の時点のもの」という肝心の意味が薄れる。
  // 実電文では VTSE52 で 60〜360 秒・VTSE51 で 0〜120 秒さかのぼり、0 秒の報も普通にある。
  //
  // **発表時刻が日時として読めないときは、比べずに出す。** そのときは発表時刻の欄（下の
  // 「◯◯ 更新」）自体が出ないため、同じ数字が 2 つ並ぶ心配がない。
  const observationAsOfRaw = active[0]?.observationDateTime
  const observationAsOfHm = observationAsOfRaw ? formatTimeMin(observationAsOfRaw) : undefined
  const latestHm = latestTime ? formatTimeMin(latestTime) : undefined
  const observationAsOf = observationAsOfHm && observationAsOfHm !== latestHm ? observationAsOfHm : undefined
  const latestUpdatedText = latestTime ? formatDateTimeMin(latestTime) : null
  // 失効時刻（電文の `ValidDateTime`）。**気象庁はこれを「失効時刻」と呼ぶ**（→
  // `docs/spec/tsunami-spec.md` §3 の cancelReason 表）。実電文で付くのは警報・注意報が
  // 解除されて予報だけが残った段階なので、ふだん出るのは津波予報のカード。
  //
  // **解除表示中は出さない。** 終わったことは帯が伝えており、そこへ「いつ終わる予定だったか」を
  // 並べても読み手の行動を変えない（2026-10-21 ユーザー選択「今のまま記録する (Recommended)」。全期間の解除の報 2 通は
  // どちらも失効時刻を持たない）。
  //
  // **電文が期限を載せない報では出ない。** 気象庁が言っていない時刻は
  // **画面へ出してはいけない**（発表値の顔で推測が並ぶ）。ここが `validDateTime` だけを見て
  // いるので自然にそうなる。
  //
  // **日付は常に添える。** 上の「更新」と同じ `formatDateTimeMin` を通すので、縦に並んだ
  // 2 行の書式が揃う。**読み上げ側は日をまたぐときだけ日付を言う**（`expiryNeedsDate`）——
  // 分ける理由は `docs/spec/tsunami-spec.md` §9「失効時刻はバナーの右上に出す」が持つ。
  const expiryRaw = isCancelledDisplay ? undefined : active[0]?.validDateTime
  const expiryText = expiryRaw ? formatDateTimeMin(expiryRaw) : null
  // 1 件目を主に扱い、残りは下に併記する（電文は複数の地震を持ちうる）。
  const sourceEarthquakes = active[0]?.sourceEarthquakes ?? []
  const sourceEarthquake = sourceEarthquakes[0]
  // 別の地震の津波で置き換える前に出していた津波の原因地震（→ `JMATsunami.previousSourceEarthquakes`）。
  // 今の報の原因地震のあとに同じ形で並べる（2026-10-24 ユーザー選択「同じ形で後に並べる (Recommended)」）。
  const previousSourceEarthquakes = active[0]?.previousSourceEarthquakes ?? []


  // 原因地震ごとに、対応する地震カードを引く。**結び方は `linkTsunamiSources` だけが決める**
  // （番号が足された津波は原因地震を 2 つ以上持ち、どれがどの地震かは発現時刻で突き合わせる）。
  // バナー全体を押したときは、結べた原因地震のうち先頭のカードへ寄せる（従来の 1 件のときと同じ）。
  const sourceLinks = active[0] && earthquakes ? linkTsunamiSources(active[0], earthquakes) : []
  // 取り消された地震カードへは結ばない（2026-10-21 ユーザー選択「今のまま記録する (Recommended)」。全期間で原因地震の
  // 地震情報が取り消された例は 0 件）。
  const linkedQuakes = sourceLinks.map(link => link.eventId && earthquakes
    ? earthquakes.find(q => extractQuakeEventId(q) === link.eventId && !q.cancelledAt)
    : undefined)
  const linkedQuake = linkedQuakes.find((q): q is JMAQuake => !!q)

  // バナーの色。等級の帯は等級の枠の色で塗り、字は白（取消・解除の表示中は灰色）。等級の色そのものは変えない。
  const bannerBand = isCancelledDisplay ? '#4b5563' : topStyle.cardBorder
  const bannerFg = isCancelledDisplay ? '#9ca3af' : topStyle.headerColor
  // 巻いたときの帯（1 行。等級名の長い言語では題が折り返す）に出す文。どれもバナーにある値。原因地震の行は置かない
  // （帯を押せば戻るバナーにある。2026-11-10 ユーザー選択「原因地震の行を帯から外す」）。
  const bannerTitle = isCancelledDisplay ? cancelInfo.title : tm.inEffect(tm.grade[topGrade])

  // h-full を持つ下記の要素自身がスクロール領域になるため、横スクロールの抑止は
  // App.tsx の TAB_SCROLLER_CLASS ではなくここで行う（祖先の指定は子に効かない）。
  return (
    // 文字と余白は地震タブの 2 組（器自身の幅 520px で切り替える `quake-list`）を使う。
    // 等級の見出しはバナーが貼りついている間だけその下へ貼りつく（`--ts-stick-top`）。
    <div ref={setContainerRef} className="quake-list h-full overflow-y-auto overflow-x-hidden overscroll-x-none"
      style={{ '--ts-stick-top': `${stickyBannerHeight}px` } as React.CSSProperties}>
     <div className="quake-list-scope">
      {/* 狭い画面などでバナーが見える高さの 4 割を超えるときは、バナーを流し、巻いて上へ抜けたら 1 行の帯を上に出す
          （2026-11-04 ユーザー選択「地震タブと同じ規則 (Recommended)」。→ `overlayHeight.ts` の `bannerStickMode`）。
          帯は高さ 0 の貼りつく箱の中へ重ねる —— 流れの中に場所を取らせると、出し入れのたびに下の行が上下する。 */}
      {bannerMode === 'band' && (
        <div className="sticky top-0 z-30 h-0">
          <div
            ref={setBandRef}
            role="button"
            tabIndex={bandShown ? 0 : -1}
            aria-hidden={!bandShown}
            onClick={scrollToBanner}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); scrollToBanner() } }}
            // 隠している間は `invisible` も付ける。上へ押し出すだけだと、帯の下の影（下へ 3px＋ぼかし 8px）が
            // タブの上端に覗く。`visibility` を出し入れの遷移に入れるので、引っ込む動きの間は見えたまま、
            // 引っ込み終えてから消える。出している間は `visible` を明示しない —— タブは `invisible` の付け外しで
            // 切り替わるので、明示すると隠れたタブの上に帯だけが残る（地震タブの帯 `QuakeOpenPin` と同じ作り）。
            className={`flex flex-wrap items-center gap-x-2 cursor-pointer transition-[transform,visibility] duration-150 ease-out motion-reduce:transition-none shadow-[0_3px_8px_rgba(0,0,0,.55)]${bandShown ? '' : ' invisible pointer-events-none'}`}
            style={{
              padding: '6px var(--qk-pad)',
              background: bannerBand,
              transform: bandShown ? 'translateY(0)' : 'translateY(-110%)',
            }}>
            {/* 等級名の長い言語（津波予報のスペイン語など）では題が折り返す。切って等級を隠さない */}
            <span className="font-extrabold text-white" style={{ fontSize: 'var(--qk-f)' }}>{bannerTitle}</span>
            {active[0]?.operationStatus && <OperationStatusChip status={active[0].operationStatus} />}
            {latestHm && <span className="ml-auto whitespace-nowrap text-white/90" style={{ fontSize: 'var(--qk-fs)' }}>{tm.updated(latestHm)}</span>}
          </div>
        </div>
      )}
      {/* 発令中 / 解除バナー。対応する地震カードがある場合のみクリック可能。
          貼り付けるのはバナーが見える高さの 4 割までのときだけ（→ `bannerStickMode`）。外すときも
          `relative` は残す —— 開いた付加文の面がこの要素を基準に重なる。
          **貼りつく包みには面の色を敷く** —— 敷かないと、包みの上の余白から巻いた行が透けて見える。 */}
      <div ref={bannerRef} className={`${bannerMode === 'stick' ? 'sticky top-0 ' : ''}z-10 bg-panel relative`}
        style={{ padding: 'var(--qk-pad) var(--qk-pad) 0' }}>
        <div
          role={linkedQuake ? 'button' : undefined}
          tabIndex={linkedQuake ? 0 : undefined}
          onClick={linkedQuake ? () => onEarthquakeLink?.(quakeEventKey(linkedQuake)) : undefined}
          onKeyDown={linkedQuake ? (e) => { if (e.key === 'Enter' || e.key === ' ') onEarthquakeLink?.(quakeEventKey(linkedQuake)) } : undefined}
          className={`bg-card rounded-sm overflow-hidden${linkedQuake ? ' cursor-pointer hover:brightness-110 transition-[filter] motion-reduce:transition-none' : ''}`}
          style={{ border: `2px solid ${bannerBand}` }}>
          {/* 等級の帯（2026-11-04 ユーザー選択「B1 帯は等級だけ (Recommended)」）。時刻は帯に積まず、すぐ下の行へ流す ——
              右に縦へ積むと、見出しの左右に余白ができていた（同日の発言「観測時刻のせいで左右に変な余白がある」）。 */}
          <div className="flex items-baseline gap-x-2.5 gap-y-0.5 flex-wrap" style={{ background: bannerBand, padding: '5px 12px' }}>
            <span className="font-black text-white" style={{ fontSize: 'calc(var(--qk-f) + 12px)', lineHeight: 1.15 }}>
              {isCancelledDisplay ? cancelInfo.title : tm.grade[topGrade]}
            </span>
            {!isCancelledDisplay && <span className="font-bold text-white" style={{ fontSize: 'var(--qk-f)' }}>{tm.inEffectWord}</span>}
            {/* 電文が自分で名乗っている運用種別（`Control/Status`）。訓練・試験のときだけ出す。
                印が無いと、訓練の大津波警報が本物と同じ顔で出る。 */}
            {active[0]?.operationStatus && <OperationStatusChip status={active[0].operationStatus} />}
          </div>
          {(latestUpdatedText || observationAsOf || expiryText) && (
            <div className="text-secondary" style={{ fontSize: 'var(--qk-fs)', padding: '6px 12px 0' }}>
              {/* 発表時刻が日時として読めなければこの項目だけ落とす。観測時点・失効は残す —— 別の事実で、片方が
                  読めないことをもう片方を隠す理由にしない。項目の途中では折り返さず、入らなければ項目ごと次の行へ送る。 */}
              {[
                latestUpdatedText && tm.updated(latestUpdatedText),
                // 観測状況を確定した時刻（電文の `Head/TargetDateTime`）。観測情報でのみ入り、
                // 実電文では最大 6 分さかのぼる。**下の波高がいつ時点のものか**を示す。
                observationAsOf && tm.observedAsOf(observationAsOf),
                // 失効時刻（電文の `ValidDateTime`）。上の 2 つは過去の時刻、これだけが未来。
                // 語は「失効」の 2 文字（気象庁の要素名は「失効時刻」。読み上げは「失効時刻」と言う → `utils/ttsText.ts`）。
                expiryText && tm.expires(expiryText),
              ].filter((s): s is string => !!s).map((s, i) => (
                <Fragment key={s}>{i > 0 && '　'}<span className="whitespace-nowrap">{s}</span></Fragment>
              ))}
            </div>
          )}
          <div style={{ padding: '4px 12px 0' }}>
            {/* 行動指示の行。**気象庁の避難行動の付加文があればそれを出す**（無ければアプリの文。文面は読み上げと共有する
                `fallbackEvacuationAction` —— 別々に持つと、片方だけ直したときに画面と声が違う行動を指示することになる）。
                見出し文に同じ文があっても両方出す（2026-11-04 ユーザー選択「両方そのまま出す (Recommended)」。
                控えの全期間の津波警報・注意報 184 通のうち、見出し文にこの文がある 35 通は 35 通とも付加文にもあった）。 */}
            <div className="font-extrabold" style={{ fontSize: 'calc(var(--qk-f) + 2px)', color: bannerFg, lineHeight: 1.4 }}>
              {isCancelledDisplay ? cancelInfo.desc : tm.evacuation(topGrade, bannerActionLine)}
            </div>
            {/* 見出し文（電文の `Head/Headline/Text`）。**原文のまま出す**（改行も保つ。2026-10-30 ユーザー選択
                「カードに出す (Recommended)」。書き方の内訳は tsunami-spec.md §4）。最新の報のものを出す
                （統合は新報の見出し文を採る）。取消・解除の表示中も出す（その報の見出し文なので）。 */}
            {active[0]?.headline && (
              <div className="text-white" style={{ fontSize: 'var(--qk-f)', lineHeight: 1.55, whiteSpace: 'pre-line' }}>
                {active[0].headline}
              </div>
            )}
            {/* 気象庁が書いた取消しの概要（電文の `Body/Text`）。アプリの定型文（上の `cancelInfo.desc`）
                とは別で、なぜ取り消したのかはここにしか無い。 */}
            {isCancelledDisplay && active[0]?.cancelText && (
              <div className="mt-1 text-secondary" style={{ fontSize: 'var(--qk-fs)', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                {active[0].cancelText}
              </div>
            )}
            {/* 全区域の解除の報に気象庁が書いた文（付加文 0107 など）。取消しの理由と同じ場所・同じ見た目で出す
                （2026-10-14 ユーザー選択「画面にも出し、読み上げる」）。解除された区域名は出さない
                （2026-10-19 ユーザー選択「出さない（推奨）」）。 */}
            {isCancelledDisplay && active[0]?.liftText && (
              <div className="mt-1 text-secondary" style={{ fontSize: 'var(--qk-fs)', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                {active[0].liftText}
              </div>
            )}
            {/* 付加文への入口。地震カードの「気象庁からの補足 ▸」と同じ畳んだ行（2026-11-04 ユーザー選択「B1 帯は等級だけ
                (Recommended)」の見本）。開いた中身はこれまでどおりバナーの下へ重ねる（流し込むと区域一覧が押し下がる）。
                **バナー自身のクリック（地震カードへの移動）へ伝播させない。** */}
            {canOpenComments && (
              <div
                data-comments-entry
                role="button"
                tabIndex={0}
                aria-expanded={commentsOpen}
                onClick={e => { e.stopPropagation(); setCommentsOpen(!commentsOpen) }}
                onKeyDown={e => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault(); e.stopPropagation(); setCommentsOpen(!commentsOpen)
                }}
                className="mt-1.5 cursor-pointer rounded-sm bg-panel px-2.5 py-1.5 text-secondary hover:text-white"
                style={{ fontSize: 'var(--qk-fs)' }}>
                {tm.notesFromJma} <DisclosureCaret open={commentsOpen} />
              </div>
            )}
          </div>
          {/* 原因地震。**取消・解除の表示中も出す**（2026-10-21 ユーザー選択「原因地震も出す (Recommended)」。全期間の解除 2 通とも
              原因地震を持つ）。 */}
          {(sourceEarthquake || previousSourceEarthquakes.length > 0) && (
            <div className="mt-2 border-t border-border" style={{ padding: '6px 12px 0' }}>
              {/* 短い間に複数の地震が起きると、1 つの津波情報にまとめて発表される。
                  2 件目以降を落とすと、どの地震による津波なのかが読み取れなくなる。
                  **1 件目と 2 件目以降で別々に書かない** —— 項目を足したとき片方に漏れる
                  （実際、震央補助表現と震源決定機関を 1 件目にだけ足して 2 件目で落としていた）。 */}
              {sourceEarthquakes.map((eq, i) => (
                <SourceEarthquakeLine
                  key={i}
                  // 結べた地震カードがあれば、その上段の値で出す（→ `shownTsunamiSource`）
                  eq={shownTsunamiSource(eq, linkedQuakes[i])}
                  link={linkedQuakes[i]
                    ? (linkedQuakes[i] === linkedQuake
                      // 先頭の結べた地震はバナー全体が押せるので、印だけを添える（従来の形）。
                      ? <span className="text-secondary" style={{ marginLeft: '0.375rem', fontSize: 'var(--qk-fs)' }}>{tm.earthquakeLink}</span>
                      // 2 つ目以降はその行の印だけがその地震へ寄せる（バナー全体のクリックへ流さない）。
                      : <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); onEarthquakeLink?.(quakeEventKey(linkedQuakes[i]!)) }}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return
                            // Space の既定の動き（パネルのスクロール）を止める。`button` 要素なら自前で止めるが、これは `role="button"`。
                            e.preventDefault()
                            e.stopPropagation()
                            onEarthquakeLink?.(quakeEventKey(linkedQuakes[i]!))
                          }}
                          className="text-secondary cursor-pointer"
                          style={{ marginLeft: '0.375rem', fontSize: 'var(--qk-fs)' }}
                        >{tm.earthquakeLink}</span>)
                    : null}
                />
              ))}
              {/* 前の津波の原因地震。地震カードへの印は付けない —— 結び付け（`linkTsunamiSources`）は今の報の原因地震だけを
                  相手にする。 */}
              {previousSourceEarthquakes.map((eq, i) => (
                <SourceEarthquakeLine
                  key={`prev-${i}`}
                  eq={eq}
                  link={null}
                />
              ))}
            </div>
          )}
          {/* 電文が名乗る情報名（`Head/Title`）と官署。**上の等級の帯とは別物** —— あちらはアプリが区域の等級から組み立てた
              見出しで、こちらは気象庁がその報に付けた名前（同じ VTSE51 が「津波観測に関する情報」と「各地の満潮時刻・
              津波到達予想時刻に関する情報」を名乗り分ける）。官署は「編集官署 …　発表官署 …」の形（2026-10-29 ユーザー承認
              「地震カードと同じく出す (Recommended)」・2026-10-30 ユーザー選択「編集官署の隣に出す (Recommended)」）。
              **`issue.source` は見ない** —— 発表官署へ落ちるので「編集官署」と名乗ると事実を誤らせる。
              名前の途中で割らず、収まらないときは項目ごと次の行へ送る（2026-11-01 ユーザー選択「今回一緒に直す (Recommended)」）。 */}
          {(active[0]?.infoName || active[0]?.issue.editorialOffice || active[0]?.issue.publishingOffice) && (
            <div className="text-secondary" style={{ fontSize: 'var(--qk-fs)', padding: '6px 12px 8px' }}>
              {[active[0].infoName, ...officeLabels(active[0].issue, tm)].filter((s): s is string => !!s).map((s, i) => (
                <Fragment key={s}>{i > 0 && '　'}<span className="whitespace-nowrap">{s}</span></Fragment>
              ))}
            </div>
          )}
          {!(active[0]?.infoName || active[0]?.issue.editorialOffice || active[0]?.issue.publishingOffice) && <div style={{ height: 8 }} />}
        </div>
        {/* 開いた付加文。**バナーの下へ重ねる（流し込まない）。**
            流し込むとバナーが伸びて、後ろの区域一覧が押し下がる —— 読むつもりで開いただけで
            見ていた場所が動いてしまう。重ねればバナーの高さは変わらず、後ろは動かない。
            パネルからはみ出さないよう高さに上限を置き、超えた分はこの中でスクロールさせる。 */}
        {/* 出す条件は入口と同じ述語にする。別々にすると、中身が空になったときに
            枠だけ残り、しかも入口が死んでいて閉じられない形ができる。 */}
        {commentsOpen && canOpenComments && (
          <div
            className="absolute z-20 rounded-b-sm overflow-y-auto overscroll-contain bg-card px-3 pb-3 pt-2 shadow-[0_3px_8px_rgba(0,0,0,.55)]"
            style={{
              left: 'var(--qk-pad)',
              right: 'var(--qk-pad)',
              top: '100%',
              border: `2px solid ${bannerBand}`,
              borderTop: 'none',
              maxHeight: commentsMaxHeight,
            }}>
            <TsunamiCommentBody
              endText={bannerEndText}
              bodyText={bannerBodyText}
              comments={bannerComments}
              freeText={bannerFreeText}
              borderColor="var(--color-border)"
              textColor="#e6e9ec"
            />
          </div>
        )}
      </div>

      <div className="p-2 flex flex-col gap-2 roomy:p-3 roomy:gap-3">
      {active.map(t => {
        const observations = t.observations ?? []
        // この報で解除された区域。解除カードに並べ、その区域の観測点もカードの区域の下へ置く
        // （2026-10-19 ユーザー選択「解除の区域の下へ移す（推奨）」）。区域に紐づかない観測点だけを
        // 「沖合観測」の枠に残す —— 解除された区域の沿岸の観測点が沖合として並ばないように。
        const liftedAreas = tsunamiLiftedAreas(t, observations)
        const unmatched = observations.filter(o =>
          !t.areas.some(a => matchesArea(o, a)) && !liftedAreas.some(a => matchesArea(o, a)))
        return (
          // `isolate`: 取消の覆い（z-10）をこの箱の中に閉じる。閉じないと、巻いたときに上へ貼りつくバナー（z-10）と
          // そこから開いた補足の面（z-20）より前に出て、覆いが被さる。
          <div key={t.id} className="flex flex-col gap-3 relative isolate">
            {t.cancelledAt && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 rounded-md" style={{ minHeight: '5rem' }}>
                <span className="font-black text-white" style={{ fontSize: '2.5rem', lineHeight: 1.1 }}>{cancelInfo.badge}</span>
                <span className="text-sm font-bold text-white/90 mt-1">{cancelInfo.desc}</span>
              </div>
            )}
            {GRADE_ORDER.flatMap(grade => splitAreasByKindName(t.areas.filter(a => a.grade === grade)).map((part, partIndex) => (
              <TsunamiGradeCard
                canFocusObs={canFocusObs}
                onAreaFocus={onAreaFocus}
                key={`${grade}-${part.label}`}
                grade={grade}
                label={part.label ? tm.kindName(part.label) : tm.grade[grade]}
                isFirstOfGrade={partIndex === 0}
                areas={part.areas}
                observations={observations}
                onObservationClick={onObservationClick}
                focusedDistrict={focusedDistrict}
                registerRow={registerRow}
                registerSpeechRow={registerSpeechRow}
                registerSpeechAnchor={registerSpeechAnchor}
                obsUpdateStatus={obsUpdateStatus}
                areaGradeChangedKeys={areaGradeChangedKeys}
                tsunamiValueMarks={tsunamiValueMarks}
              />
            )))}
            {/* この報で解除された区域。等級カードの後ろ＝いちばん軽い遷移先として置く
                （読み上げも引き下げの組の最後に読む）。

                **並びは読み上げが作る組をそのまま使う。** ここで `announcedCancelledAreas` を
                独自に並べ替えると、**前回の等級が違う区域が同時に解除された報**で声と画面が
                食い違う —— 読み上げは `(遷移元, 遷移先)` の組ごとに分けて遷移元の重い順に読むが、
                こちらは全部を 1 つのリストとして扱うので電文順のまま残る。追従スクロールが
                解除カードの中を往復することになり、この機能が直そうとしたのと同じ症状になる。 */}
            <TsunamiCancelledCard
              areas={liftedAreas}
              observations={observations}
              onObservationClick={onObservationClick}
              canFocusObs={canFocusObs}
              onAreaFocus={onAreaFocus}
              obsUpdateStatus={obsUpdateStatus}
              focusedDistrict={focusedDistrict}
              registerRow={registerRow}
              registerSpeechRow={registerSpeechRow}
              registerSpeechAnchor={registerSpeechAnchor}
            />
            {(unmatched.length > 0 || (t.estimations?.length ?? 0) > 0) && (
              <div className="bg-card rounded-sm overflow-hidden"
                style={{ border: '2px solid #1d4ed8', boxShadow: '0 0 0 1px rgba(29,78,216,0.25)' }}>
                {/* 実測が 1 件も無く推定だけが届く電文もあるので、見出しは中身に合わせる。 */}
                {unmatched.length > 0 && (
                  /* 沖合の観測点を読むときの前置き。区域に紐づく行が区域の見出しを前置きにするのと
                     同じ扱いで、この帯が視野から流れると何の一覧を読んでいるのか分からなくなる。 */
                  <div ref={el => {
                    for (const obs of unmatched) registerSpeechAnchor(speechRowKeys({ kind: 'station', name: obs.name }), el)
                  }}
                    className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
                    style={{ backgroundColor: '#0c1a3a', color: '#93c5fd', borderBottom: '1px solid #1d4ed8' }}>
                    {tm.offshoreObservations}
                  </div>
                )}
                {unmatched.map((obs, i) => (
                  <TsunamiObservationRow key={i} obs={obs} onObservationClick={onObservationClick} canFocusObs={canFocusObs} registerSpeechRow={registerSpeechRow} obsUpdateStatus={obsUpdateStatus} />
                ))}
                {/* 沖合の観測から導いた沿岸への推定。実測とは別のものなので実測の下に区切って
                    並べる。**推定したのは気象庁で、アプリ側の計算ではない**ことを見出しに書く。 */}
                {t.estimations && t.estimations.length > 0 && (
                  <>
                    <div className="w-full py-1 px-4 text-center"
                      style={{ backgroundColor: 'rgba(12,26,58,0.6)', color: '#93c5fd', fontSize: '0.6875rem', ...(unmatched.length > 0 && { borderTop: '1px solid #1d4ed8' }) }}>
                      {tm.coastalEstimates}
                    </div>
                    {t.estimations.map((est, i) => (
                      <EstimationRow key={i} est={est} mark={tsunamiValueMarks.estimation.get(est.name)} />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
      </div>
     </div>
    </div>
  )
})

/**
 * 沿岸への推定の行。**最大波を推定した時刻（「最大波 23:26」）と、追加・更新の印を出す**（2026-10-21 ユーザー選択
 * 「時刻も印も出す (Recommended)」。語は 2026-10-24 ユーザー選択「「最大波 23:26」 (Recommended)」。全期間 46 項目中
 * 時刻 14・最大波の印 9）。印の付け方は観測点の行と同じ（縦線＝その行で何かあった・文字色＝どの項目か）。
 */
function EstimationRow({ est, mark }: { est: TsunamiEstimation; mark: UpdateMark<EstimationUpdateField> | undefined }) {
  const tm = useMessages().tsunami
  const heightInfo = estimationHeight(est)
  const heightText = heightInfo === null ? '' : heightInfo.kind === 'height' ? tm.height(heightInfo.description, false) : tm.estimating
  const markColor = mark ? UPDATE_MARK_COLOR[mark.status] : undefined
  const fieldStyle = (field: EstimationUpdateField) =>
    markColor && mark?.fields.has(field) ? { color: markColor, fontWeight: 600 } : undefined
  // 日時として読めない時刻は句ごと落とす（「最大波 」だけが残らないように）。
  const maxHeightHm = est.maxHeightDateTime ? formatTimeMin(est.maxHeightDateTime) : null
  return (
    <div className="px-4 py-1.5 border-b border-white/5 last:border-0"
      /* 印が無い行でも幅を取る（観測点の行と同じ） */
      style={{ borderLeft: `3px solid ${markColor ?? 'transparent'}` }}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="text-white text-[0.9375rem] truncate">{est.name}</span>
          {estimationBadgeKeys(est).map(key => (
            <span key={key} className="text-xs font-bold px-1.5 py-0.5 rounded-sm"
              style={{ background: 'rgba(29,78,216,0.3)', color: '#93c5fd' }}>
              {tm.badge[key]}
            </span>
          ))}
        </span>
        <span className="shrink-0 text-right" style={{ fontSize: '0.8125rem', color: '#93c5fd' }}>
          {/* 数値が無ければ、無い理由（電文の「推定中」）を出す。 */}
          {heightText && <span className="font-bold" style={fieldStyle('height')}>{heightText}</span>}
          {/* 日時として読めない時刻は句ごと落とす（「到達予想」だけが残ると、
              いつ来るのかを述べているように見える）。到達についての説明は
              すぐ下に別の行として出るので、情報が全部消えるわけではない。 */}
          {(() => {
            const hm = est.arrivalTime ? formatTimeMin(est.arrivalTime) : null
            return hm ? <span className="ml-2" style={fieldStyle('firstWave')}>{tm.estimatedArrivalAfter(hm)}</span> : null
          })()}
        </span>
      </div>
      {maxHeightHm && (
        <div className="mt-0.5" style={{ fontSize: '0.6875rem', color: '#9ca3af' }}>
          <span style={fieldStyle('maxHeightTime')}>{tm.maxWave(maxHeightHm)}</span>
        </div>
      )}
      {/* 到達についての説明は時刻と併存する（電文解説資料 Ⅱ.13 1-2-2-2 の事例１）。
          時刻があるときに隠すと、時刻を出せる沿岸ほど注意喚起が落ちる。 */}
      {est.arrivalCondition && (
        <div className="mt-0.5" style={{ fontSize: '0.6875rem', color: '#9ca3af' }}>
          <span style={fieldStyle('firstWave')}>{est.arrivalCondition}</span>
        </div>
      )}
    </div>
  )
}

/**
 * 付加文の面を閉じる判定で使う「同じ津波か」（`TsunamiTab` の `commentsIdentity` どうし）。
 * 運用種別が同じで、番号の組が 1 つでも重なれば同じ津波（→ `utils/tsunami.ts` の `isSameTsunamiEvent`）。
 * 番号を持たない電文（`#` で始まる `id`）は一致だけで見る。
 */
function isSameCommentsTsunami(a: string, b: string): boolean {
  const [aStatus, aIds = ''] = a.split('|')
  const [bStatus, bIds = ''] = b.split('|')
  if (aStatus !== bStatus) return false
  if (aIds.startsWith('#') || bIds.startsWith('#')) return aIds === bIds
  const bSet = new Set(bIds.split(' ').filter(Boolean))
  return aIds.split(' ').some(id => id !== '' && bSet.has(id))
}
