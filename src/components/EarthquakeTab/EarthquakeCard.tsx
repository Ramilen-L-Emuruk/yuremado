import { Fragment, memo, useMemo, useRef, useEffect, useLayoutEffect, useState } from 'react'
import type { JMAQuake, JMALpgm, IssueType, EarthquakePoint, IntensityScale, JMAEstimatedIntensity, JMAInternationalTsunami, QuakeReportRecord, BorrowedFromTsunami, LpgmPeriodBand } from '../../types/earthquake'
import { quakeEventKey, isKnownCorrection } from '../../utils/quakeMerge'
import { QUAKE_CARD_KEY_ATTR } from '../../utils/quakeCardScroll'
import { getLpgmClassLabel, getLpgmClassColor, lpgmCategoryNoteWithRegions, buildLpgmRows, canOpenLpgmNotes, lpgmPeriodRows, LPGM_PERIODS_HEADING, LPGM_PERIODS_NOTE, type LpgmStationRow } from '../../utils/lpgm'
import { readableTextColor, liftForContrast } from '../../utils/contrast'
import { estimatedIntensityAvailability, estimatedMarkMismatchNote } from '../../utils/estimatedIntensity'
import { telegramTextSubject, quakeTelegramTextTarget } from '../../utils/ttsFollow'
import { jmaCommentGroups, type JmaCommentGroup } from '../../utils/jmaCommentGroups'
import { domesticTsunamiCardForecastText, warnIfDomesticTsunamiSentenceMissing } from '../../utils/domesticTsunamiComment'
import { useAutoOpenWhileSpeakingIn } from '../../hooks/useAutoOpenWhileSpeaking'
import { scrollParentOf } from '../../hooks/useFollowScroll'
import { SerialBadge } from '../SerialBadge'
import {
  formatQuakeTimeLabeled,
  formatQuakeTime,
  QUAKE_ARRIVAL_TIME_LABEL,
  QUAKE_ORIGIN_TIME_LABEL,
  INTERNATIONAL_TSUNAMI_INFO_NAME,
  QUAKE_ARRIVAL_TIME_UNKNOWN,
  formatDepth,
  formatDomesticTsunami,
  TSUNAMI_WARNING_GROUP_TITLE,
  quakeReportLabels,
  formatCorrectType,
  hasHypocenterFacts,
  hasMagnitude,
  magnitudeHeading,
  formatHypocenterSource,
  formatMagnitudeWithCondition,
  formatCoordinate,
  formatNameFromMark,
  formatTimeMin,
  formatHourMinute,
  readDateTime,
  NON_JMA_MARK,
  NON_JMA_MARK_TITLE,
  withNonJmaMark,
} from '../../utils/formatters'
import { getIntensityLabel, getIntensityColor, getIntensityBgColor, getDepthColor, getMagnitudeColor } from '../../utils/intensity'
import { hasKnownEpicenter } from '../../utils/geo'

import { areaPrefIndexOf, regionOrderIndexOf, stationPrefIndexOf, lookupPointCoords, lookupStationRegion, regionOrderRank, type LatLng } from '../../utils/stationCoords'
import { isAreaPoint, isMaxScaleUnreceived, partitionUnreceivedPoints, unreceivedUnitLabel, buildIntensityRows, makeAreaPrefResolver, cityKey, intensityRowsShowUnreceivedNote, type IntensityStationRow, type IntensityRegionRow, type IntensityRows } from '../../utils/quakePoints'
import { log } from '../../utils/logger'
import { rowMarkKey, rowMarkOf, type QuakeCardMarks, type QuakeUpdateField } from '../../utils/quakeUpdateMark'
import { intensityRowsToExpand, lpgmRowsToExpand, mergeAutoExpanded } from '../../utils/autoExpandMarkedRows'
import { UPDATE_MARK_COLOR, type UpdateStatus } from '../../utils/updateMark'
import { UpdateDot } from '../UpdateDot'

import { useStationCoords } from '../../hooks/useStationCoords'
import { useSubRegions } from '../../hooks/useSubRegions'
import { usePrefectures } from '../../hooks/usePrefectures'
import { ringsBoundsIndex, EMPTY_BOUNDS_INDEX, type RingsBounds } from '../../utils/subregions'
import { groupUnreceivedPointNames, type UnreceivedPointGroup } from './unreceivedPointNames'
import { QuakeSeismoWave } from './QuakeSeismoWave'
import { QuakeListRow, TileScaleLabel, quakeTileColors } from './QuakeListRow'
import { QuakeOpenPin } from './QuakeOpenPin'
import { DisclosureCaret, Reveal, growFrom, fadeIn, CARD_RESIZE_MS, CARD_RESIZE_ANIMATION_ID, CANCEL_FADE_MS } from './quakeMotion'
import { quakeReportTimeline, formatTimelineTime } from '../../utils/quakeReportTimeline'
import type { SeismoQuakeWave } from '../../hooks/useSeismoQuakeWaves'
import type { SeismoWaveCollapsedView } from '../../hooks/useSettings'

/**
 * 区域の行より下にある行の鍵をすべて集める。**親の行へ印を上げるために要る**
 * （一覧は既定で畳んであるので、配下にだけ付けると開かないと気づけない）。
 */
function regionDescendantKeys(region: IntensityRegionRow): string[] {
  return [
    ...region.cities.flatMap(c => [rowMarkKey.city(region.name, c.name), ...c.stations.map(st => rowMarkKey.station(st.name))]),
    ...region.stations.map(st => rowMarkKey.station(st.name)),
  ]
}

/**
 * 長周期地震動に添える気象庁からの補足（付加文 3 種＋詳細ページ）の開閉キー。
 *
 * 震度一覧・長周期一覧の行と**同じ `expanded` を共有する**ので、鍵の名前空間を分けておく
 * （行の側は `pref:` / `area:` / `city:` / `lpgm:pref:` / `lpgm:area:` を使う）。
 */
const LPGM_NOTES_KEY = 'lpgm:notes'
/** 地震情報の「気象庁からの補足」の開閉の鍵（長周期の補足と同じ `expanded` を共有する）。 */
const QUAKE_NOTES_KEY = 'quake:notes'
/** 国際津波関連情報（WEPA60）の 1 報の開閉の鍵（同じ `expanded` を共有する）。 */
const internationalTsunamiFoldKey = (id: string): string => `wepa60:${id}`

/**
 * 区域も都道府県も分からず、長周期の一覧に置けなかった観測点を記録する
 * （2026-10-22 ユーザー選択「消すときに記録を残す (Recommended)」。→ `buildLpgmRows` の `onUnplaceableStation`）。
 *
 * 一覧は選択し直すたびに組み直されるので、**同じ報の同じ観測点は 1 回だけ**残す。覚えておく数は
 * 上限で切る（実電文では 1 件も起きていない形なので、溢れるのは書式が変わったときだけ）。
 */
const notedUnplaceableLpgm = new Set<string>()
const NOTED_UNPLACEABLE_LPGM_MAX = 500
function noteUnplaceableLpgmStation(lpgmId: string, stationName: string): void {
  const key = `${lpgmId}\n${stationName}`
  if (notedUnplaceableLpgm.has(key)) return
  if (notedUnplaceableLpgm.size >= NOTED_UNPLACEABLE_LPGM_MAX) notedUnplaceableLpgm.clear()
  notedUnplaceableLpgm.add(key)
  log.warn(`[lpgm] 区域も都道府県も分からない長周期地震動の観測点を、一覧に置けず省きました（${lpgmId}・${stationName}）`)
}

/**
 * 自動展開へ「開く先が無い」と渡すための空集合。
 *
 * **その場で `new Set()` を作らない** —— 呼ぶたびに別の参照になり、中身が変わらないのに
 * 変わったように見える。
 */
const EMPTY_KEYS: ReadonlySet<string> = new Set()


/** 震度の下へ添える「（未入電）」「（未入電あり）」の大きさ（行の文字に対する比）。 */
const UNRECEIVED_NOTE_EM = 0.7

/**
 * 震度の欄の幅。未入電の行が無い一覧ではいまの 36px のまま、ある一覧では「（未入電あり）」（7 字）が入る幅で
 * 全段の全行をそろえる。
 *
 * **観測点の段だけ詰めない。** 観測点の段は「未入電あり」を出さないので欄を「（未入電）」の幅まで詰められるが、
 * 詰めると観測点の地名が親の市町村の地名より左から始まり、字下げの順が逆に見える（2026-11-02 ユーザー選択
 * 「親より右へそろえる」）。
 */
function intensityValueColumn(unreceivedLayout: boolean): string {
  return unreceivedLayout ? `${7 * UNRECEIVED_NOTE_EM + 0.3}em` : '2.25rem'
}

/**
 * 震度一覧の 1 行。都道府県・一次細分区域・市町村・観測点の 4 段で共有する。
 *
 * **段ごとに書き分けない。** 未入電の語（「5弱以上」「未入電あり」）と震度の色は 4 段とも
 * 同じ規則で、書き分けると片方だけ直したときに静かにずれる。
 *
 * **震度の色（`getIntensityColor`）は値だけで決め、段では変えない。** 段の区別に使うのは
 * 字下げ・文字の大きさと、地名の文字色（県の行だけ白、下の 3 段はグレー）、それに震度側の
 * 太字（県の行だけ）。
 *
 * **カード自体が `<button>` なので、開閉は `<div role="button">` で作る**（HTML はボタンの
 * 入れ子を許さない。長周期のトグルと同じ作法）。開けない段には `role` も `tabIndex` も
 * 与えない —— 押せない行がタブ移動で止まると邪魔になる。
 */
function IntensityRow({ label, scale, unreceived, unreceivedIsOwn, hasUnreceived, nonJma, depth, expandKey, expanded, onToggle, onFocus, mark, unreceivedLayout }: {
  label: string
  scale: IntensityScale
  /** その行の震度が未入電の値から来ている（ラベルへ「以上」を足す）。 */
  unreceived: boolean
  /**
   * 「未入電」の印を出すか。**`unreceived` とは分ける。**
   *
   * 県・区域の行の値は、電文が区域の `MaxInt` を持たないときに**配下から積み上げる**。
   * 積み上げは震度の大小で決まるため、**観測できた震度3 と未入電（下限 45）が混在すると未入電が勝つ**。その行を
   * 「未入電」と断定すると、届いている観測値を無かったことにする。**電文が直にその行について
   * 言っている場合だけ**に出す —— 観測点の行と、値を持たない市町村。範囲の行は下の
   * `hasUnreceived` が「未入電あり」を担う。
   */
  unreceivedIsOwn?: boolean
  hasUnreceived?: boolean
  nonJma?: boolean
  /** 字下げの段（0＝都道府県）。 */
  depth: 0 | 1 | 2 | 3
  /** 開閉の鍵。`null` なら開けない行。 */
  expandKey: string | null
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
  /**
   * その行が指す場所へ地図を寄せる。**置き場所は行が開閉を持つかで変わる。**
   *
   * - 開閉を持たない行（観測点）→ **行全体**が寄せになる
   * - 開閉を持つ行（県・区域・市町村）→ **地名の部分だけ**（行全体は開閉が取る）
   *
   * 1 回のクリックに 2 つの意味を持たせられないので当たり判定を分けている。どちらの段でも
   * 「地名を押せば寄る」は成り立つ（→ docs/spec/quake-spec.md §8）。
   */
  onFocus?: () => void
  /**
   * この報でこの行（または配下の行）が動いたか。行の左端の縦線で出す。
   *
   * **縦線は印が無くても幅を取る**（透明で置く）。付いたり消えたりで地名の位置がずれると、
   * 一覧を目で追っているときに行がまとめて動いて見える。
   */
  mark?: UpdateStatus
  /**
   * この一覧に未入電の行が 1 つでもあるか。あれば震度の欄を広げ、「（未入電）」「（未入電あり）」を
   * 震度の下に書く余地を取る。**全行同じ幅にする** —— 印の付いた行だけ欄を広げると、その行だけ地名の
   * 始まりがずれる。
   */
  unreceivedLayout: boolean
}) {
  const canExpand = expandKey != null
  const isOpen = canExpand && expanded.has(expandKey)
  // 行の主アクション。**開閉があればそちらが取る**（`onFocus` の注記を参照）。
  // `stopPropagation` は、カード自体の `<button>`（選択のトグル）へ伝わらせないため。
  const activate = canExpand ? () => onToggle(expandKey) : onFocus
  // 開閉を持つ行では、寄せを地名の部分へ移す（行全体は開閉が取っているため）。
  const labelFocus = canExpand ? onFocus : undefined
  return (
    <div
      {...(activate ? {
        role: 'button' as const,
        tabIndex: 0,
        // 開けない行に `aria-expanded` を付けない —— 開閉できる行だと読み上げさせてしまう。
        ...(canExpand ? { 'aria-expanded': isOpen } : {}),
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); activate() },
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); activate() }
        },
      } : {})}
      data-quake-row
      className={`${QUAKE_ROW_CLASS}${activate ? ' cursor-pointer hover:bg-white/5 quake-press-row' : ''}`}
      style={{ ...quakeRowStyle(depth, mark), gridTemplateColumns: `${intensityValueColumn(unreceivedLayout)} 1fr auto` }}
    >
      {/* 震度の欄。「震度」の語は付けない（見本 opened.html の .ir）。未入電の行は「5弱以上」と
          書き切り、その下へ小さく「（未入電）」「（未入電あり）」を添える（2026-11-02 ユーザー選択
          「C4'' 段ごとにそろえる」。元の問いは「普通に五弱以上(未入電)とかって書いちゃだめなの？」）。

          **その行自身が未入電か、配下にあるだけかを書き分ける。**
          - 「未入電」＝この行の震度そのものが届いていない（観測点の行と、値を持たない市町村）
          - 「未入電あり」＝この範囲に未入電の地点があるが、行の値は観測できている
          未入電は地点単位の事実なので、配下にあるだけの県へ「未入電」と書くと県が丸ごと未入電に読める。
          **両方は出さない。** 行自身が未入電なら、配下に未入電があることは言わずとも含む。
          語は気象庁のものをそのまま使い、読み上げとも揃える。 */}
      <span
        className={`flex flex-col leading-[1.15] whitespace-nowrap${depth === 0 ? ' font-extrabold' : ' font-bold'}`}
        style={{ color: getIntensityColor(scale) }}
      >
        <span>{getIntensityLabel(scale)}{unreceived && '以上'}</span>
        {(unreceivedIsOwn || hasUnreceived) && (
          <small
            className="font-normal"
            style={{ fontSize: `${UNRECEIVED_NOTE_EM}em` }}
            title={unreceivedIsOwn
              ? '気象庁は震度5弱以上と推定していますが、震度が届いていません（未入電）'
              : 'この範囲に、震度が届いていない地点があります'}
          >
            {unreceivedIsOwn ? '（未入電）' : '（未入電あり）'}
          </small>
        )}
      </span>
      {/* 地名は左寄せ。`＊` は電文が名前の末尾へ置く印なので、離さず名前に続ける。
          開閉を持つ行では、地名だけが寄せの当たり判定になる（`labelFocus`）。 */}
      <span className={`min-w-0 ${depth === 0 ? 'text-white' : 'text-secondary'}`}>
        <span
          title={nonJma ? NON_JMA_MARK_TITLE : undefined}
          {...(labelFocus ? {
            role: 'button' as const,
            tabIndex: 0,
            onClick: (e: React.MouseEvent) => { e.stopPropagation(); labelFocus() },
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); labelFocus() }
            },
            className: 'cursor-pointer hover:underline',
          } : {})}
        >
          {label}
        </span>
        {nonJma && <span title={NON_JMA_MARK_TITLE}>{NON_JMA_MARK}</span>}
      </span>
      {/* 右端は開閉の記号だけ。 */}
      <span className="flex items-center whitespace-nowrap text-secondary">
        <span className="w-[1em] text-center text-[0.75rem]">{canExpand ? <DisclosureCaret open={isOpen} /> : ''}</span>
      </span>
    </div>
  )
}

/** 押せる所（開閉の行・札・ボタン・地図へ寄せる名前・見出しの段・帯）。ここで起きたクリックは地のクリックに数えない。 */
/** 閉じた行で組まない補足の空の形。 */
const NO_COMMENTS: ReturnType<typeof jmaCommentGroups> = { groups: [], showHeadings: false }

const INTERACTIVE_IN_CARD = 'button, a, input, select, textarea, summary, [role="button"], [tabindex], .cursor-pointer, .quake-open-head, .quake-pin'

/**
 * 開いたカードの地を押したか。押せる所の中のクリックと、字を選んだ後の指の離しは数えない
 * （観測点の名前をなぞって写そうとしただけで地図が動かないように）。
 */
function isPlainBackgroundClick(e: React.MouseEvent<HTMLElement>): boolean {
  const target = e.target as Element | null
  if (!target) return false
  // 探すのはカードの内側だけ（一覧の枠などカードの外の祖先が押せる印を持っても、地のクリックを潰さない）
  const hit = target.closest(INTERACTIVE_IN_CARD)
  if (hit && e.currentTarget.contains(hit)) return false
  const selection = window.getSelection?.()
  return !selection || selection.isCollapsed
}

/** 広い組で見出しの段と震度の枠を貼りつける上限（一覧の見える高さに対する割合。→ `data-stick-tall`）。 */
const STICK_MAX_SHARE = 0.4

/**
 * 開いたカードの節（各地の震度・長周期地震動）の頭を、一覧の見える範囲の上端へ巻く。
 * 上に貼りついているもの（一覧の見出しの行・左右分割で貼りつく見出しの段と震度の枠・狭い画面の帯）の
 * 下へ着地させる（重なると節の頭が隠れる）。端末で動きを減らす設定なら一息に飛ぶ。
 */
function scrollOpenSectionIntoView(section: HTMLElement) {
  const root = scrollParentOf(section)
  const card = section.closest<HTMLElement>(`[${QUAKE_CARD_KEY_ATTR}]`)
  if (!root || !card) {
    log.warn('[地震タブ] 節へ巻けない（巻く箱かカードが見つからない）')
    return
  }
  let cover = listHeadPx(section)
  const stick = card.querySelector<HTMLElement>('.quake-stick')
  if (stick && getComputedStyle(stick).position === 'sticky') {
    cover = Math.max(cover, finitePx(getComputedStyle(stick).top) + stick.getBoundingClientRect().height)
  }
  const pin = card.querySelector<HTMLElement>('.quake-pin')
  if (pin && getComputedStyle(pin).display !== 'none') {
    cover = Math.max(cover, finitePx(getComputedStyle(pin).top) + pinBandHeight(pin, root))
  }
  // 貼りついたものの下端に節の頭がくっつかないよう、少し空けて着地させる
  const top = root.scrollTop + section.getBoundingClientRect().top - root.getBoundingClientRect().top - cover - 6
  if (!Number.isFinite(top)) {
    log.warn('[地震タブ] 節へ巻く位置を計算できない', { cover })
    return
  }
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  root.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' })
}

/** `12.5px` を数へ。読めない値（`auto` など）は 0（貼りついていない・位置を持たない扱い）。 */
function finitePx(v: string): number {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/** 上に貼りついて残る一覧の見出しの行と日付の区切りの高さ（`scroll-margin-top` と同じ値を読むので単位を問わない）。 */
function listHeadPx(el: HTMLElement): number {
  const card = el.closest<HTMLElement>(`[${QUAKE_CARD_KEY_ATTR}]`)
  return card ? finitePx(getComputedStyle(card).scrollMarginTop) : 0
}

/**
 * 狭い画面の帯の高さ。出たことがあれば帯が測った値（`data-band-h`）。まだ一度も出ていない
 * （震度の枠を押して初めて巻く、がまさにこれ）ときは、同じ一覧の畳んだ行の高さで代える ——
 * 帯は畳んだ行と同じ中身なので、折り返しの段が同じなら同じ高さになる。
 */
function pinBandHeight(pin: HTMLElement, root: HTMLElement): number {
  const measured = Number(pin.dataset.bandH)
  if (Number.isFinite(measured) && measured > 0) return measured
  const row = root.querySelector<HTMLElement>(`button[${QUAKE_CARD_KEY_ATTR}]`)
  return row ? row.getBoundingClientRect().height : 0
}

/**
 * 震度・長周期の一覧の 1 行の共通の作り（見本 opened.html の .ir）。3 列の格子で、最初の列の幅は
 * 呼ぶ側が決める（震度 36px・長周期 52px）。字下げは段ごとに 10px ずつ、文字は段ごとに 0.5px ずつ小さく
 * （2026-11-01 選択「この形にする (Recommended)」。最長の観測点名 12 文字＋＊が 1 行に収まる詰め方）。
 *
 * 行の高さ（上下 3px の余白・最低 28px）は指で押しやすい高さとして保つ（2026-11-06 ユーザー選択「元に戻す」、
 * 理由の発言「タップしづらいので」）。
 *
 * 左端の縦線は、この報でこの行（または配下）が動いた印。**印が無くても幅を取る**（透明で置く）。
 * 付いたり消えたりで地名の位置がずれると、一覧を目で追っているときに行がまとめて動いて見える。
 */
const QUAKE_ROW_CLASS = 'grid items-center gap-x-1 border-b border-border/60 py-[3px] pr-1 leading-[1.3]'
function quakeRowStyle(depth: 0 | 1 | 2 | 3, mark: UpdateStatus | undefined): React.CSSProperties {
  return {
    minHeight: '1.75rem',
    paddingLeft: `${depth * 0.625}rem`,
    fontSize: `calc(var(--qk-f) - ${0.5 + depth * 0.5}px)`,
    borderLeft: `3px solid ${mark ? UPDATE_MARK_COLOR[mark] : 'transparent'}`,
  }
}

/**
 * 観測点の行を開いたときに出す、周期ごとの内訳（2026-10-25 ユーザー選択「行を開ける形 (Recommended)」、
 * 語は「今の語のまま (Recommended)」）。**地図の観測点の吹き出しと同じ行・同じ文**（→ `lpgmPeriodRows`・
 * `LPGM_PERIODS_HEADING`・`LPGM_PERIODS_NOTE`）。電文は区域や県の段に内訳を持たないので、開けるのは観測点だけ。
 */
function LpgmPeriodList({ periods, depth }: { periods: readonly LpgmPeriodBand[]; depth: 1 | 2 }) {
  // 観測点の行より一段深く字下げする（行の字下げは段ごとに 10px。→ `quakeRowStyle`）
  return (
    <div className="pr-2 pb-1 text-[0.75rem] roomy:text-[0.875rem]" style={{ paddingLeft: `${(depth + 1) * 0.625}rem` }}>
      <div className="text-secondary">{LPGM_PERIODS_HEADING}</div>
      {lpgmPeriodRows(periods).map((r, i) => (
        <div key={i} className="flex items-center gap-1.5 leading-relaxed">
          <span className="w-[2.5em] text-right text-secondary">{r.label}</span>
          {r.lgInt !== null ? (
            <span
              className="inline-block min-w-[1.5em] px-1 text-center font-bold rounded-sm"
              style={{ background: getLpgmClassColor(r.lgInt), color: readableTextColor(getLpgmClassColor(r.lgInt)) }}
            >
              {r.lgInt}
            </span>
          ) : (
            <span className="inline-block min-w-[1.5em] text-center text-secondary">−</span>
          )}
          <span className="tabular-nums text-secondary">{r.sva}</span>
        </div>
      ))}
      <div className="mt-0.5 text-secondary">{LPGM_PERIODS_NOTE}</div>
    </div>
  )
}

/**
 * 長周期地震動の 1 行。都道府県・一次細分区域・観測点の 3 段で共有する
 * （電文が持つ段数。震度一覧の 4 段から市町村を除いた形）。
 *
 * **見た目の規約は `IntensityRow` と揃える。** 段の区別に使うのは字下げ・文字の大きさと、
 * 地名の文字色（県の行だけ白、下の 2 段はグレー）。
 * **階級の色（`getLpgmClassColor`）は値だけで決め、段では変えない** —— 段の区別に流用すると、
 * 色が二通りの意味を持つ。並べる震度も値によらずグレーで、こちらは階級の補足として置いている。
 */
function LpgmRow({ label, lgInt, int, nonJma, depth, expandKey, expanded, onToggle, onFocus, mark }: {
  label: string
  lgInt: number
  /** その範囲の最大震度。階級と並べると「揺れは小さいのに高層階が大きく揺れた」形が出る */
  int?: IntensityScale
  nonJma?: boolean
  /** 字下げの段（0＝都道府県）。 */
  depth: 0 | 1 | 2
  /** 開閉の鍵。`null` なら開けない行。 */
  expandKey: string | null
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
  /**
   * 開閉を持たない行（＝観測点の行）を押したときの動作。地図をその地点へ寄せる。
   * 扱いは `IntensityRow` の同名 props と同じ（開閉があればそちらが取る）。
   */
  onFocus?: () => void
  /** この報でこの行（または配下）が動いたか（→ {@link IntensityRow} の同名プロップ）。 */
  mark?: UpdateStatus
}) {
  const canExpand = expandKey != null
  const isOpen = canExpand && expanded.has(expandKey)
  // 行の主アクション。開閉があればそちらが取る（`IntensityRow` と同じ）。
  const activate = canExpand ? () => onToggle(expandKey) : onFocus
  // 開閉を持つ行（県・区域）では、寄せを地名の部分へ移す。
  const labelFocus = canExpand ? onFocus : undefined
  const classColor = getLpgmClassColor(lgInt)
  return (
    <div
      {...(activate ? {
        role: 'button' as const,
        tabIndex: 0,
        ...(canExpand ? { 'aria-expanded': isOpen } : {}),
        onClick: (e: React.MouseEvent) => { e.stopPropagation(); activate() },
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); activate() }
        },
      } : {})}
      data-quake-row
      className={`${QUAKE_ROW_CLASS}${activate ? ' cursor-pointer hover:bg-white/5 quake-press-row' : ''}`}
      style={{ ...quakeRowStyle(depth, mark), gridTemplateColumns: '3.25rem 1fr auto' }}
    >
      {/* 階級の札（52px の欄。見本 opened.html の .lgg）。節の見出しが「長周期地震動」なので「長周期」は添えない。 */}
      <span>
        <span
          className="inline-block rounded-[3px] px-1.5 font-bold leading-[1.4]"
          style={{ fontSize: 'var(--qk-fs)', background: classColor, color: readableTextColor(classColor) }}
        >
          {getLpgmClassLabel(lgInt)}
        </span>
      </span>
      <span className={`min-w-0 ${depth === 0 ? 'text-white' : 'text-secondary'}`}>
        {/* 気象庁以外が運用する観測点の印。震度一覧・地図の吹き出しと同じ扱い。 */}
        <span
          title={nonJma ? NON_JMA_MARK_TITLE : undefined}
          {...(labelFocus ? {
            role: 'button' as const,
            tabIndex: 0,
            onClick: (e: React.MouseEvent) => { e.stopPropagation(); labelFocus() },
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); labelFocus() }
            },
            className: 'cursor-pointer hover:underline',
          } : {})}
        >
          {label}
        </span>
        {nonJma && <span title={NON_JMA_MARK_TITLE}>{NON_JMA_MARK}</span>}
      </span>
      {/* 右端に、その範囲の最大震度と開閉の記号。震度は階級の補足（「揺れは小さいのに高層階が大きく揺れた」
          形が出る）なので、値によらずグレーで置く。 */}
      <span className="flex items-center gap-1.5 whitespace-nowrap text-secondary">
        {int !== undefined && <span className="text-[0.75rem]">震度{getIntensityLabel(int)}</span>}
        <span className="w-[1em] text-center text-[0.75rem]">{canExpand ? <DisclosureCaret open={isOpen} /> : ''}</span>
      </span>
    </div>
  )
}

/** issue.type に応じたバッジの Tailwind クラスを返す。 */
function issueTypeBadgeClass(type: IssueType): string {
  switch (type) {
    case '震度速報':
    case '震源情報':                         return 'bg-amber-900 text-amber-300'
    case '震源・震度情報':
    case '各地の震度情報':
    case '顕著な地震の震源要素更新のお知らせ': return 'bg-blue-900/60 text-blue-300'
    case '遠地地震':                          return 'bg-purple-900/60 text-purple-300'
    default:                                  return 'bg-panel text-secondary'
  }
}

/** 一覧の行の情報名の字色。札の色分け（{@link issueTypeBadgeClass}）と同じ組み分けで、地を塗らず字だけ色を付ける。 */
function issueTypeTextColor(type: string): string {
  switch (type) {
    case '震度速報':
    case '震源情報':                         return '#fcd34d'
    case '震源・震度情報':
    case '各地の震度情報':
    case '顕著な地震の震源要素更新のお知らせ': return '#93c5fd'
    case '遠地地震':                          return '#d8b4fe'
    default:                                  return '#94a3b8'
  }
}

/**
 * 一覧の行で、地震の時刻を日時として読めなかったときに時刻の列へ出す語。
 * （2026-11-02 選択「不明 (Recommended)」。→ docs/quake-tab-redesign.md「決まっていること」）
 */
const QUAKE_LIST_TIME_UNKNOWN = '不明'

interface Props {
  quake: JMAQuake
  /**
   * この報で動いた欄と行の印。**ライブで受けた続報にだけ付く**（→ `utils/quakeUpdateMark.ts`）。
   *
   * 履歴から組んだカードや、そのカードで最初に見た報には付かない。前report が無ければ
   * 全欄・全行が「初出」になり、印が画面を埋めるだけで何も指さないため。
   */
  /**
   * **任意にしない。** 渡し忘れても画面は正常に見え、印が出ないことに気づけない
   * （呼び出し元が増えたときに黙って抜ける）。印が無いときは空の印を渡す。
   */
  marks: QuakeCardMarks | undefined
  /**
   * 長周期地震動の一覧の印。**震度一覧とは別に受け取る。**
   *
   * 2 つの一覧はカードの中で切り替えて出るが、行の鍵（`area:` / `st:`）は同じ名前空間を
   * 使うので、1 つにまとめると同じ区域名の行どうしで印が混ざる。
   */
  lpgmMarks: QuakeCardMarks | undefined
  isSelected?: boolean
  /**
   * 選ばれたカードにだけ渡す、選択が呼ばれるたびに進む番号（選ばれていないカードは 0）。
   * 選んだまま畳んでいても、これが進んだら開き直す（同じ地震の続報・読み上げ・津波タブからのリンク。
   * 2026-11-03 選択「どれが来ても開き直す (Recommended)」）。
   */
  reopenSignal: number
  /**
   * 押されたことを親へ伝える。**地震の鍵はこちらで作って渡す。**
   *
   * **親側で `() => onSelect(key)` と包まない**（`onToggleDistribution`・
   * `onToggleUnreceived` も同じ）——毎レンダー新しい関数になり、このカードの
   * {@link memo} が素通りする。波形を繋いでいる間は 0.3 秒ごとに親が描き直されるので、
   * そのたびにカードが 7 日ぶん全部描き直されることになる。
   */
  onSelect?: (eventKey: string) => void
  lpgm?: JMALpgm
  activeLpgmEventId?: string | null
  onToggleLpgm?: (eventId: string) => void
  /**
   * 長周期地震動の節を見せる求めの番号（求めが無い・このカードの番でなければ 0）。進んだら、開いたカードの
   * 長周期の節を、長周期の札を押したときと同じ位置へ巻く（2026-11-06 ユーザー選択「長周期の節へ巻く
   * (Recommended)」「同じく巻く (Recommended)」。長周期地震動観測情報の受信と、長周期の通知を押したとき）。
   */
  lpgmFocusSeq: number
  /**
   * **この地震の**推計震度分布図（引き当て済み。無ければ null）。引き当ては一覧の側で行う
   * （→ `estimatedIntensityFor`）—— 一覧ごと渡すと、別の地震の分布が届くたびに全カードの
   * `memo` が素通りする。
   */
  estimatedIntensity?: JMAEstimatedIntensity | null
  /**
   * **この地震の**国際津波関連情報（WEPA60。引き当て済み・付かなければ空）。遠地地震のカードにだけ付く
   * （→ `internationalTsunamiIndex`）。**必須にしてある** —— 渡し忘れると英文の情報が黙って出なくなる。
   */
  internationalTsunamis: readonly JMAInternationalTsunami[]
  /** この地震の震度分布モードを開いているか。 */
  distributionActive?: boolean
  onToggleDistribution?: (eventKey: string) => void
  /** この地震の未入電の一覧を開いているか。 */
  unreceivedActive?: boolean
  onToggleUnreceived?: (eventKey: string) => void
  /**
   * 一覧の行をクリックしたときに、その場所へ地図を寄せる（1 点でも範囲でも）。観測点の行は観測点名も渡す
   * （座標が同じ観測点の吹き出しを取り違えないため。範囲の行は `null`）。
   */
  onFocusMap?: (positions: LatLng[], stationName: string | null) => void
  /**
   * いま気象庁が書いた文を読み上げている主題（読んでいなければ null）。
   * このカードの長周期の補足が対象なら、読み上げのあいだ開く（→ `useAutoOpenWhileSpeakingIn`）。
   *
   * **任意にしない**（理由は `EarthquakeTab` の同名 props）。
   */
  speakingTelegramTextSubject: string | null
  /**
   * この地震の区間について、自作地震計から読み返した合成波形（→ `useSeismoQuakeWaves`）。
   *
   * **空なら何も出さない。** 「記録が無い」「揺れを捉えていない」を画面へ出さないと
   * 決めてあるので（2026-09-29 のユーザー判断）、載せるものが無い＝枠ごと出ない。
   */
  seismoWaves?: readonly SeismoQuakeWave[]
  /**
   * ライブで自作地震計の波形を読み返せなかった（取り直している最中も含む）。**波形が 1 本も無いときだけ真。**
   * 「自作地震計: 波形を取得できなかった」を出す（2026-10-22 選択「取れなかったと出す (Recommended)」、文面と
   * 「取り直し中も出す」は 2026-10-24 ユーザー選択）。再生中に記録が無いときは偽のまま（09-29 の判断どおり何も出さない）。
   */
  seismoWaveFailed: boolean
  /** 波形を畳んでいるときに出すもの（設定「波形の表示」）。 */
  seismoWaveView: SeismoWaveCollapsedView
}

/**
 * 種別ヘッダーに出す「受け取った電文種別」。→ `quakeReportLabels`
 *
 * **報番号の見た目は緊急地震速報と共有する**（→ `components/SerialBadge.tsx`）。同じ器に出す
 * もので、別々に書くと片方だけ変わる。
 *
 * **鍵には並び順も混ぜる。** 同じ種別が 2 件並ばないことは統合の側（`utils/quakeMerge.ts` の
 * `mergeQuakeReports` が種別ごとに 1 件へ畳む）が保証しているが、**そこが崩れたときの症状が
 * 「種別が 1 つ黙って消える」になる** —— React は鍵が重なった要素を畳むだけで例外を投げない。
 */
/** 自作地震計の波形をライブで読み返せなかったときの 1 行（2026-10-24 ユーザー選択「取り直し中も出す (Recommended)」の文面）。 */
const SEISMO_WAVE_FAILED_TEXT = '自作地震計: 波形を取得できなかった'

/**
 * 「気象庁からの補足」の畳んだ行と、開いたときの中身（→ `utils/jmaCommentGroups.ts`）。
 *
 * **地震情報と長周期地震動観測情報で同じ部品を使う**（2026-11-01 選択「畳んで、読み上げで開く
 * (Recommended)」。畳んだ行の文面は「気象庁からの補足 ▸」で 2 つそろえる）。中身は 1 文 1 行で、
 * 種類が 2 つ以上あるときだけ中身で呼ぶ見出しを付ける。`extra` は中身の末尾に足すもの（長周期の
 * 詳細ページへのリンク）。
 *
 * 開閉は `<div role="button">` で作る（震度一覧の行と同じ作法）。押してもカードの選択は変えない。
 */
function JmaNotesFold({ open, onToggle, groups, showHeadings, extra }: {
  open: boolean
  onToggle: () => void
  groups: readonly JmaCommentGroup[]
  showHeadings: boolean
  extra?: React.ReactNode
}) {
  // 見出しと中身の間は中身の側の上の余白で取る（親の gap にすると、縮み終えた瞬間にその分だけ下が詰まる）
  return (
    <div className="flex flex-col">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onToggle() } }}
        className="cursor-pointer rounded bg-panel px-2.5 py-1.5 text-secondary hover:text-white"
        style={{ fontSize: 'var(--qk-fs)' }}
      >
        気象庁からの補足 <DisclosureCaret open={open} />
      </div>
      <Reveal open={open} data-jma-notes="" className="mt-1.5 flex w-full flex-col gap-2 rounded-lg bg-panel px-3 py-2 text-xs leading-relaxed text-secondary roomy:text-sm">{() => (<>
          {groups.map(g => (
            <div key={g.kind} className="flex flex-col gap-0.5">
              {showHeadings && <div data-jma-heading="" className="font-semibold text-[#cfd6dd]">{g.heading}</div>}
              {/* 自由付加文は全角空白で桁を揃えた表が入るので、行の中の空白を保つ */}
              {g.lines.map((line, i) => <div key={i} data-jma-line="" style={{ whiteSpace: 'pre-wrap' }}>{line}</div>)}
            </div>
          ))}
          {extra}
        </>)}</Reveal>
    </div>
  )
}

/** 津波電文から借りた値の欄に添える印。説明は {@link borrowedSourceNote} がカードへ 1 行出す。 */
const BORROWED_MARK = '※'

/**
 * 借りた値の欄へ添える印。
 *
 * **前に空白を置く。** 直前の文字（震央地名・「深さ」など）へ貼り付くと、名前の一部に見える。
 */
function BorrowedMark() {
  return <span className="ml-0.5 align-super text-[0.625rem] font-normal opacity-80">{BORROWED_MARK}</span>
}

/**
 * 借りた値の説明（→ `utils/borrowFromTsunami.ts`）。**常に 1 行**で、詳しい出どころは
 * ホバーの説明（`title`）へ回す。
 *
 * **「電文」「借りる」のような内部の言い回しを画面へ出さない。** 印が「どれが」を示すので、
 * 文は出どころを名指しするだけでよい。述語を足すと説明くさくなるうえ、開発側の語彙が混ざる。
 *
 * **震源と津波区分で行を分けない。** 借りる報は実際には別になりうる —— 震源は「震源を載せた
 * 最新の報」、区分は「等級を載せた最新の報」から採るため、能登の実電文では 16:22 と 16:12 に
 * 分かれる。だが読み手にとっては同じ津波の情報で、報の違いまで並べても判断は変わらない。
 *
 * **等級を名乗らない**（「津波警報より」と書くと大津波警報の地震で一段軽く見える。
 * → `docs/spec/quake-spec.md` §3）。正確な名乗りと発表時刻は `title` に持つ。
 */
function borrowedSourceNote(
  hypocenter: BorrowedFromTsunami | undefined,
  domesticTsunami: BorrowedFromTsunami | undefined,
): { text: string; title: string } | null {
  if (!hypocenter && !domesticTsunami) return null
  // **文として読めるように書く。** 「震源: 〜／津波区分: 〜」の列挙は開発者向けの体裁で、
  // ホバーを開いた利用者が読む文になっていない。
  const sentence = (src: BorrowedFromTsunami, what: string) => {
    const at = formatTimeMin(src.reportTime)
    // 時刻を読めない電文では時刻だけ落とす。文そのものは出す ——
    // どの情報が伝えたかは時刻が無くても伝わる。
    return at
      ? `${what}は${at}に発表された${src.infoName}で伝えられました。`
      : `${what}は${src.infoName}で伝えられました。`
  }
  const parts: string[] = []
  if (hypocenter) parts.push(sentence(hypocenter, '震源'))
  if (domesticTsunami) parts.push(sentence(domesticTsunami, '津波の有無'))
  return {
    text: `${BORROWED_MARK} 津波情報より`,
    title: parts.join(''),
  }
}

/**
 * 取消されたカードに重ねる表示。**開いた表示と畳んだ表示で同じ部品を使う。**
 *
 * 取消を受けたカードは選択から外れて押せなくなる（`App.tsx` が選択を外す）ので、利用者が目にするのは
 * ほぼ畳んだ表示だけ。かつては気象庁が書いた取消しの概要（電文の `Body/Text`）を開いた表示にだけ
 * 置いていて、**理由が画面に出る場面がほとんど無かった**。写しを 2 つ持つと片方だけ直る形になるので、
 * 1 つにまとめてある。
 */
/** 取消の覆いを出した瞬間に薄くから濃くする（`ref` に渡す。描き直すたびに付け直されて何度も動かないよう、関数を 1 つにする）。 */
function fadeOverlayOnMount(el: HTMLElement | null): void {
  if (el) fadeIn(el, CANCEL_FADE_MS)
}

/**
 * `fade`: 見ている間に取消が届いたときだけ真（2026-11-03 選択「取消の覆いをふわっと」。説明「履歴として最初から
 * 取消済みの地震は動かさない」）。
 */
function QuakeCancelOverlay({ cancelText, compact, fade }: { cancelText?: string; compact: boolean; fade: boolean }) {
  // 気象庁が書いた取消しの概要（電文の `Body/Text`）は、アプリが組み立てた文言ではないので
  // そのまま出す。オーバーレイは 10 秒で消えるが、理由を捨てる理由にはならない。
  if (compact) {
    // 閉じた行は高さが 1 行ぶんしか無いので、縦に 3 段積むと下が切れる。「取消」を左に置き、
    // 文の 2 行を右に積む（2026-11-03 選択「案 A：横に並べる (Recommended)」）。
    // 理由が長くて収まらないときは、右の列の中でスクロールできるようにしておく。
    // 角は丸めない（開いたカードの覆いと同じ）。行は四角いので、丸めると四隅だけ暗くならずに残る。
    return (
      <div ref={fade ? fadeOverlayOnMount : undefined} className="absolute inset-0 flex items-center justify-center gap-3 bg-black/70 z-10 px-3">
        <span className="flex-none font-black text-white" style={{ fontSize: '1.5rem', lineHeight: 1.1 }}>取消</span>
        <div className="flex flex-col min-w-0 max-h-full overflow-y-auto py-1">
          <span className="text-xs font-bold text-white/90">この地震情報は取り消されました</span>
          {cancelText && (
            <span className="text-white/80" style={{ fontSize: '0.75rem', lineHeight: 1.5, whiteSpace: 'pre-line' }}>{cancelText}</span>
          )}
        </div>
      </div>
    )
  }
  // 角は丸めない。開いたカードは四角い（角丸を持たない）ので、丸めると四隅 8px だけ暗くならずに残る。
  return (
    <div ref={fade ? fadeOverlayOnMount : undefined} className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 px-4">
      <span className="font-black text-white" style={{ fontSize: '3rem', lineHeight: 1.1 }}>取消</span>
      <span className="text-sm font-bold text-white/90 mt-1">この地震情報は取り消されました</span>
      {/* オーバーレイは `absolute inset-0` でカードの高さに固定される。**本文がそれを超えると
          覆いの上下へはみ出し、カードの外の行と重なる**（読み上げは長文を画面へ委ねる設計なので、
          読めなくなると理由がどこにも残らない）。この要素の中でスクロールできるようにしておく。 */}
      {cancelText && (
        <span className="mt-2 text-center text-white/80 overflow-y-auto" style={{ fontSize: '0.75rem', lineHeight: 1.5, whiteSpace: 'pre-line', maxHeight: '40%' }}>
          {cancelText}
        </span>
      )}
    </div>
  )
}

/**
 * 受け取った電文の名乗りを `/` でつないで出す。
 *
 * **長周期地震動は電文の名乗り（`Head/Title`）をそのまま足す**（2026-10-22 ユーザー承認
 * 「4-B 種別ヘッダー」）。地震情報の側は `issue.type`（種別）で、長周期は種別を持たないので
 * 名乗りで並べる。カード本体の帯は階級の見出しなので「長周期地震動」のまま短く残す。
 * 実電文の名乗りは「長周期地震動に関する観測情報」の 1 種類だけで、報ごとには変わらない。
 */
function QuakeReportHeading({ reports, fallback, lpgmInfoName, colored = false }: { reports?: QuakeReportRecord[]; fallback: IssueType; lpgmInfoName?: string; colored?: boolean }) {
  const labels = quakeReportLabels(reports, fallback)
  return (
    <>
      {labels.map((label, index) => (
        <Fragment key={`${index}:${label.type}`}>
          {index > 0 && ' / '}
          {/* 一覧の行では情報名ごとに報の種類の色で書く（2026-11-01 選択「色分けする (Recommended)」） */}
          <span style={colored ? { color: issueTypeTextColor(label.type) } : undefined}>
            {label.type}
            {label.count != null && <SerialBadge serial={label.count} />}
          </span>
        </Fragment>
      ))}
      {lpgmInfoName && (
        <>
          {labels.length > 0 && ' / '}
          {lpgmInfoName}
        </>
      )}
    </>
  )
}

/**
 * 国際津波関連情報（WEPA60）の英文だけから組んだカードの見出し（→ `JMAQuake.fromInternationalTsunami`）。地震情報の報を持たないので、
 * 報の名乗りを並べる {@link QuakeReportHeading} の代わりに使う。色は遠地地震の報と同じ。
 */
function InternationalTsunamiHeading() {
  return <span style={{ color: issueTypeTextColor('遠地地震') }}>{INTERNATIONAL_TSUNAMI_INFO_NAME}</span>
}

/**
 * 1 枚の地震カード。
 *
 * **`memo` で包む。** 自作地震計の波形を繋いでいる間、親（`EarthquakeTab`）は
 * 0.3 秒ごとに描き直される ——包まないと、そのたびに**関わりのないカードまで
 * 7 日ぶん全部**描き直される。効かせるために、押されたことを伝える 3 つの関数は
 * 親で包まず、**地震の鍵をこちら側で作って渡す**（→ {@link Props.onSelect}）。
 */
export const EarthquakeCard = memo(function EarthquakeCard({
  quake, isSelected: selected = false, reopenSignal, onSelect, lpgm, activeLpgmEventId, onToggleLpgm, lpgmFocusSeq,
  estimatedIntensity = null, internationalTsunamis, distributionActive = false, onToggleDistribution,
  unreceivedActive = false, onToggleUnreceived, onFocusMap, speakingTelegramTextSubject,
  marks, lpgmMarks, seismoWaves, seismoWaveFailed, seismoWaveView,
}: Props) {
  /** このカードの地震を指す鍵。**親へ返すときに使う。** */
  const eventKey = quakeEventKey(quake)
  // **畳むのはカードだけで、選択は外さない**（2026-11-03 選択「見出しも帯も閉じるだけ (Recommended)」。
  // 説明「選択・地図・ポップアップはそのまま。畳んだ行をもう一度押すと開き直し、地図は動かさない」）。
  // 開いて見せるのは、選ばれていて畳まれていないときだけ。別の地震が選ばれたら畳んだ印は捨てる。
  const [collapsed, setCollapsed] = useState(false)
  const rowRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (!selected) setCollapsed(false) }, [selected])
  useEffect(() => { if (reopenSignal !== 0) setCollapsed(false) }, [reopenSignal])
  const isSelected = selected && !collapsed
  // 取消の覆いを動かすのは、取消でない姿を一度でも描いた後に取消が届いたときの最初の 1 回だけ
  // （開いたカードが取消で閉じた行へ替わると覆いが付け直されるので、2 回目は動かさない）
  const sawUncancelledRef = useRef(!quake.cancelledAt)
  const cancelFadeShownRef = useRef(false)
  const fadeCancel = !!quake.cancelledAt && sawUncancelledRef.current && !cancelFadeShownRef.current
  useEffect(() => { if (quake.cancelledAt) cancelFadeShownRef.current = sawUncancelledRef.current }, [quake.cancelledAt])
  // カードを開く・畳むときの高さの動き（2026-11-03 選択「カードの開閉」。説明「行を押して開くとき、中身が下へ
  // 180ms ほどで伸びる。見出し・帯で畳むときは縮む」）。押した瞬間の高さを控え、描き替わった後にそこから動かす
  const openRootRef = useRef<HTMLDivElement>(null)
  const resizeFromRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const from = resizeFromRef.current
    resizeFromRef.current = null
    const el = isSelected ? openRootRef.current : rowRef.current
    if (from === null || !el) return
    const anim = growFrom(el, from, CARD_RESIZE_MS, CARD_RESIZE_ANIMATION_ID, true)
    // 開くときは、見出しの段より下の中身を薄くから出す。高さだけを伸ばすと、伸び始めに見出し文などの
    // 行が上半分だけ切れて見え、崩れたように見える（2026-11-03 発言「開いた瞬間崩れる瞬間が一瞬あります。」）
    if (anim && isSelected) {
      for (const child of Array.from(el.children)) {
        if (child instanceof HTMLElement && !child.matches('.quake-open-head, .quake-pin-track')) fadeIn(child, CARD_RESIZE_MS)
      }
    }
  }, [isSelected])
  // 控えた高さが使われずに残ったら（押しても開閉が変わらなかった）捨てる。残すと、後で別の経路で
  // 開閉が変わったときに古い高さから動く。上の effect より後に置く（同じ描き直しなら先に使われる）
  useLayoutEffect(() => { resizeFromRef.current = null })
  const collapseCard = () => {
    resizeFromRef.current = openRootRef.current?.getBoundingClientRect().height ?? null
    // 畳んだら、長周期の節を見せる求めは済んだことにする（後で開き直したときに古い求めで急に巻かない）
    lpgmFocusDoneRef.current = lpgmFocusSeq
    setCollapsed(true)
  }
  // 貼りつく帯から畳むと、カードが縮んで畳んだ行が画面の上へ抜けることがある。抜けたら行を一覧の頭へ戻す
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!collapsed || !row) return
    const root = scrollParentOf(row)
    // 一覧の見出しの行の下に潜っていても抜けたとみなす（着地の基準は scroll-margin-top と同じ値）
    if (root && row.getBoundingClientRect().top < root.getBoundingClientRect().top + listHeadPx(row)) row.scrollIntoView({ block: 'start' })
    // 押した見出し・帯は消えるので、フォーカスを畳んだ行へ移す（キーボードで畳んだ人が一覧の頭から辿り直さないように）
    row.focus({ preventScroll: true })
  }, [collapsed])
  /**
   * 印は**値の肩に置く点**で出す（→ `components/UpdateDot.tsx`）。文字色も器の色も触らない。
   *
   * **どの欄も同じ表し方にする。** 文字色で出していた頃は、文字そのものが区分の色である
   * 津波区分だけ塗り替えられず枠で囲んでいた。同じ「この報で動いた」を欄によって別の形で
   * 示すと、読み手は見た目の違いに意味があるのかを考えることになる。
   */
  const markDot = (field: QuakeUpdateField, size: 'sm' | 'md' | 'lg' = 'md', className = '') => {
    const status = marks?.facts.get(field)
    return status ? <UpdateDot status={status} size={size} className={className} /> : null
  }
  /**
   * 行の印。**配下に動いた行があれば親にも出す** —— 一覧は既定でどの段も畳んであるので、
   * 配下にだけ付けると「開かないと気づけない印」になる（→ `rowMarkOf`）。
   */
  const rowMark = (key: string, descendants: readonly string[] = []) =>
    marks ? rowMarkOf(key, descendants, marks.rows) : undefined
  const lpgmRowMark = (key: string, descendants: readonly string[] = []) =>
    lpgmMarks ? rowMarkOf(key, descendants, lpgmMarks.rows) : undefined
  const { earthquake, issue } = quake
  const { hypocenter, maxScale, domesticTsunami } = earthquake
  // 電文全体の最大震度が「5弱以上・未入電」だったとき、見出しにも「以上」を付ける。
  // 付けないと、実際にはもっと強い可能性があることが見出しから読み取れない。
  //
  // **値と語を分けて持つ。** 最大震度は大きく出す欄なので、語を同じ大きさで並べると
  // 「5弱以上」で桁数が倍になり、器に収まらず折り返す（畳んだ表示は 7rem 角に固定、
  // 開いた表示も横並びのラベルと競る）。**語は本体より小さく添える** —— EEW の予想最大震度
  // バナーが「程度以上」で同じ形を採っている（`RealtimeTab/index.tsx`）。
  // **語は縮められない**（気象庁の表現をそのまま使う決まり）ので、大きさで受ける。
  const maxScaleLabel = maxScale === -1 ? '?' : getIntensityLabel(maxScale)
  const maxScaleOrAbove = maxScale !== -1 && isMaxScaleUnreceived(maxScale, quake.points)
  const tsunamiInfo = formatDomesticTsunami(domesticTsunami, earthquake.domesticTsunamiCode)
  const hasLocation = hasKnownEpicenter(hypocenter.latitude, hypocenter.longitude)
  // **震央地名は名前の有無で出す**（座標の有無で決めない）。津波電文から借りた震源は名前があっても
  // 座標を読めないことがあり（`readHypocenterAreaDetail` が座標を落とす経路）、座標で決めると
  // 読み上げ・共有カード・タイトルは震央地名を言うのにカードだけ「震源調査中」になる。
  // 緯度・経度の行だけは座標の有無で出す。
  const epicenterLabel = hypocenter.name || '震源調査中'
  // 規模・深さは位置と別に判定する（→ `hasHypocenterFacts`）
  const hasFacts = hasHypocenterFacts(hypocenter)
  // 津波電文から借りた値の印と、その説明（→ `utils/borrowFromTsunami.ts`）。
  //
  // **借りた欄すべてに印を付け、説明はカードに 1 行だけ置く。** 欄ごとに「津波情報より」と
  // 書くと同じ語が並んで冗長になり、逆に 1 行へまとめるだけだと**どの欄に掛かるのかが消える**
  // （震源は名前・座標・規模・深さの 4 欄にまたがる）。印なら両方を満たせる —— `＊`（気象庁
  // 以外の観測点）と同じ流儀。
  //
  // **記号は `＊` と分ける。** あちらは観測点名の末尾に付き、こちらは震源と津波区分の欄に付く。
  // 出る場所も説明文も違うので混ざらないが、同じ記号にすると説明が 2 つ並んで読み手が迷う。
  const borrowedHypocenter = quake.hypocenterSource
  const borrowedDomesticTsunami = quake.domesticTsunamiSource
  // 説明は**常に 1 行**。詳しい出どころ（名乗り・発表時刻）はホバーの説明へ回す。
  const borrowedNote = borrowedSourceNote(borrowedHypocenter, borrowedDomesticTsunami)
  // 気象庁が添えた文の段落（電文の並び順。空の段落は持たない）。何も残らなければ枠ごと出さない。
  const forecastRest = quake.forecastText ? domesticTsunamiCardForecastText(quake.forecastText, earthquake.domesticTsunamiCode) : ''
  // 固定付加文の原文が無い報では、海外への津波の見通しを値から起こした文（→ `foreignTsunamiText`。
  // 文面は気象庁の固定付加文 0221〜0228 の原文）を出す。原文にはこの文が入っているので、
  // 原文があればそちらを使う（有無の判定は読み上げと同じで、空白だけの原文は「無い」側へ倒す。二重に出さない）。
  // 原文から津波の文を除いて空になっても、見通しへは倒さない。置き場所は固定付加文と同じ先頭の段落
  // （2026-10-29 ユーザー承認。→ docs/spec/quake-spec.md §3「地震カードには付加文を 1 つの枠で出す」）。
  const forecastParagraph = quake.forecastText?.trim() ? forecastRest : (quake.foreignTsunamiText ?? '')
  // 1 文 1 行・中身で呼ぶ見出しに組む（→ `jmaCommentGroups`）。海外への津波の見通しは津波の文として並ぶ。
  // 開いたカードでしか出さないので、閉じた行では組まない（一覧の全カードが描き直す回に、カードの数だけ回さない）
  const quakeComments = useMemo(() => isSelected
    ? jmaCommentGroups({ forecast: forecastParagraph, varComment: quake.varCommentText, free: quake.freeText })
    : NO_COMMENTS, [isSelected, forecastParagraph, quake.varCommentText, quake.freeText])
  // 気象庁が文面を変えて表と一致しなくなったら記録を残す（一致しないと札の下に津波の文が重なって出るだけで、
  // ほかに気づく手掛かりが無い）。描画中の副作用にしないよう effect で出し、間引きは記録側が持つ。
  const domesticTsunamiCode = earthquake.domesticTsunamiCode
  useEffect(() => {
    if (quake.forecastText) warnIfDomesticTsunamiSentenceMissing(domesticTsunamiCode, quake.forecastText)
  }, [quake.forecastText, domesticTsunamiCode])
  // 長周期の「観測情報の種類」から出す一文（→ `lpgmCategoryNote`）。
  // 条件と本文の両方で使うので一度だけ計算する。
  // **最大階級 0 の報でも階級 1 以上と同じ型で出す**（2026-10-30 ユーザー選択「階級 1 以上と同じ型
  // (Recommended)」・#1201）。種類が付いていれば一文を出し、付いていなければ空になる。
  // 見出し文が地域名を並べていれば括弧で添える（→ `lpgmCategoryNoteWithRegions`）。
  const categoryNote = lpgm ? lpgmCategoryNoteWithRegions(lpgm.category, lpgm.headline) : ''
  /** 補足の見出しを出すか（判定は読み上げ側の診断と共有する → `canOpenLpgmNotes`）。 */
  const hasLpgmNotes = canOpenLpgmNotes(lpgm)
  const lpgmComments = useMemo(() => isSelected
    ? jmaCommentGroups({ forecast: lpgm?.forecastText, varComment: lpgm?.varCommentText, free: lpgm?.freeFormText })
    : NO_COMMENTS, [isSelected, lpgm?.forecastText, lpgm?.varCommentText, lpgm?.freeFormText])
  // 震度分布ボタン。引き当ては一覧の側で済んでいる（→ {@link Props.estimatedIntensity}）。
  const matchedEstimated = estimatedIntensity
  const distributionState = estimatedIntensityAvailability(quake, matchedEstimated)
  // 推計の電文の震央補助表現が、このカードの補助表現と食い違うときだけ出す（→ `estimatedMarkMismatchNote`）
  const estimatedMarkNote = matchedEstimated ? estimatedMarkMismatchNote(matchedEstimated, quake.earthquake.hypocenter) : null
  // **描けるものが何も無いならボタンを出さない。** 公式が無く、観測点も 1 つも無い電文
  //（震度速報など区域しか持たないもの）では、押しても空の画面になるだけ。
  const canDrawDistribution = !!matchedEstimated || quake.points.some(p => !p.isArea)

  // **一覧の寄せはカードではなく一覧（`EarthquakeTab`）が行う。** 取消のあいだは選択中ではない
  // カードへ寄せる必要があり、カード自身は「いま選ばれているか」しか知らない
  // （→ `utils/quakeCardScroll.ts`）。一覧がカードを見つけるための印は `QUAKE_CARD_KEY_ATTR`。

  const stationData = useStationCoords()
  // 県・区域の行から地図へ寄せるための境界。**どちらも地図が既に読んでいるデータ**で、
  // ローダーがキャッシュを返すので通信は増えない（→ `usePrefectures`）。
  const prefectures = usePrefectures()
  const { data: subRegions } = useSubRegions()

  /**
   * 開いている段。**既定はどこも畳んである。**
   *
   * 電文は県・一次細分区域・市町村・観測点の 4 段を持つ（→ docs/spec/quake-spec.md §8
   * 「震度一覧は 4 段の入れ子」。観測点と市町村の紐付けは同 §5）。
   * 平らに並べると能登本震で県 45 行に対し区域 119 行・観測点 2829 行になり、カード 1 枚で
   * 画面が埋まる。見たいところだけ開く。
   *
   * **市町村の鍵は区域名と組にする** —— 同じ名前の市町村が別の区域にありうる。
   * 地震ごとに独立した状態（このコンポーネントが地震 1 件につき 1 つ作られる）。
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const lpgmNotesOpen = expanded.has(LPGM_NOTES_KEY)
  const setLpgmNotesOpen = (open: boolean) => setExpanded(prev => {
    const next = new Set(prev)
    if (open) next.add(LPGM_NOTES_KEY); else next.delete(LPGM_NOTES_KEY)
    return next
  })
  /**
   * **この地震の**長周期の補足をいま読み上げているか。
   *
   * 主題は電文の種別だけでなく地震の識別子まで含む（→ `telegramTextSubject`）。カードは
   * 複数並ぶので、種別だけで判定すると読んでいるのとは別の地震の補足まで開く。
   * **「いま選ばれているカード」で代用しない** —— 選択は受信した瞬間に動き、読み上げの
   * 順番とは独立している（未入電モードの自動開閉と同じ規約）。
   */
  const speakingLpgmNotes = !!lpgm
    && speakingTelegramTextSubject === telegramTextSubject('lpgm', lpgm.eventId)
  // 読み上げているあいだだけ開く（自分が開いた分だけ閉じる）。**状態は `expanded` が持つ**
  // ので、判定を書き写さず状態の持ち主を渡せる版を使う。
  //
  // **録画ツール向けの `subject` は `telegramTextSubject` を再利用しない。** あのヘルパーは
  // 読み上げ追従（`speakingLpgmNotes` の判定）専用の別の契約（`telegramText:lpgm:<id>`）を
  // 持っており、`docs/spec/recording-interface-spec.md` が定める `subject` の形式
  // （`lpgm:<id>`）とは違う。ここは仕様書の形式に直接合わせる。
  //
  // **`lpgm` が無いときの `'lpgm'` は実際には記録されない。** `speakingLpgmNotes` が
  // `!!lpgm` を含むため、`subject` が使われる（読み上げ開始の記録が走る）のは常に
  // `lpgm` が真のとき。型を満たすためだけの安全側の既定値。
  const setLpgmNotesOpenByUser = useAutoOpenWhileSpeakingIn(
    speakingLpgmNotes, lpgmNotesOpen, setLpgmNotesOpen,
    lpgm ? `lpgm:${lpgm.eventId}` : 'lpgm',
  )
  /**
   * 地震情報の補足。長周期と同じく既定で畳み、**この地震の**気象庁の文を読み上げているあいだだけ開く
   * （2026-11-01 選択「畳んで、読み上げで開く (Recommended)」。手で開いたものは閉じない）。
   * 主題は読む側と同じ関数で作る（→ `quakeTelegramTextTarget`）。録画ツール向けの `subject` は
   * 地震カードの鍵（`quake:<eventKey>`。→ docs/spec/recording-interface-spec.md）。
   */
  const quakeNotesOpen = expanded.has(QUAKE_NOTES_KEY)
  const setQuakeNotesOpen = (open: boolean) => setExpanded(prev => {
    const next = new Set(prev)
    if (open) next.add(QUAKE_NOTES_KEY); else next.delete(QUAKE_NOTES_KEY)
    return next
  })
  const speakingQuakeNotes = speakingTelegramTextSubject === telegramTextSubject('quake', quakeTelegramTextTarget(quake))
  const setQuakeNotesOpenByUser = useAutoOpenWhileSpeakingIn(
    speakingQuakeNotes, quakeNotesOpen, setQuakeNotesOpen, `quake:${eventKey}`,
  )

  /**
   * 未入電の点を切り分けた結果と、名前の解決に使う索引。**バッジとブロックで共有する。**
   * 別々に解決すると、片方だけが名前を引けたときに「印は出るのに地点が出ない」
   * （またはその逆）という自己矛盾が起きる。
   *
   * **区域は電文が言っているものを先に使う**（`EarthquakePoint.area`）。行の組み立て
   * （`buildIntensityRows`）と同じ優先順位にしておかないと、座標テーブルを引けない観測点で
   * **行には出るのに印だけ付かない**という食い違いになる。
   *
   * **それでも所属を引けない場合、印を付ける行が決まらない。** DMDATA は観測点を `pref: ''` で
   * 積むため、電文が観測点の区域を持たず、座標テーブルが未読み込みのあいだ（起動直後の
   * 数百 ms）や、電文の観測点がテーブルに無い場合は県も区域も引けない。そのときは印が出ないが、
   * **ブロックには地点名が出る**ので情報自体は失われない（→ docs/spec/quake-spec.md §4）。
   */
  const unreceivedIndexes = useMemo(() => {
    const stationPrefIndex = stationData ? stationPrefIndexOf(stationData) : null
    const areaPrefIndex = stationData ? areaPrefIndexOf(stationData) : null
    // 区域 → 県は**行の組み立てと同じ引き方を共有する**（`makeAreaPrefResolver`）。手で
    // 優先順位を揃えると、片方だけ直したときに黙ってずれる（実際にそれで、行は出るのに
    // 印だけ付かない状態を作った）。
    const prefOfArea = makeAreaPrefResolver(quake.cities ?? [], name => areaPrefIndex?.get(name) ?? null)
    const prefOf = (p: EarthquakePoint): string =>
      p.pref || prefOfArea(p.addr) || stationPrefIndex?.get(p.addr)
      || (p.area ? prefOfArea(p.area) ?? '' : '') || ''
    const regionOfStation = (p: EarthquakePoint): string | null => {
      if (p.area) return p.area
      const pref = prefOf(p)
      return pref && stationData ? lookupStationRegion(stationData, pref, p.addr) : null
    }
    const { stations, areas } = partitionUnreceivedPoints(quake.points, p => [
      regionOfStation(p) ?? '',
      prefOf(p),
    ])
    return { stationPrefIndex, areaPrefIndex, prefOf, regionOfStation, stations, areas }
  }, [quake.points, quake.cities, stationData])

  /**
   * 一覧の行を押したときに地図へ渡す寄り先。**押せるかどうかもこれで決める。**
   *
   * 判定と寄り先を別々に解決すると、片方だけ引けたときに「押せるのに動かない」（またはその逆）に
   * なる。津波の観測点の行が同じ規律で書かれている（→ docs/spec/tsunami-spec.md §9
   * 「観測点の行・区域名をクリックしたときの寄り先」）。
   *
   * **県名は行の親から採り、引けなければ名前から逆引きする。** 行の県は電文の `City` 由来の
   * ことがあり（`makeAreaPrefResolver`）、座標テーブルのキーと必ず揃うとは限らない。地図側
   * （`useQuakeLayerData` の `intensityMarkers`）は逆引きで引いているので、両方を試せば
   * 地図に点が立っている観測点は引ける。
   *
   * **観測点と区域は座標表の別の表に入っている**ので、どちらを引くかは呼び出し側が渡す
   * （`lookupPointCoords` の `isArea`）。震度一覧の行は観測点しか渡さないが、未入電の一覧には
   * 区域の行も並ぶ（→ `unreceivedPoints`）。
   *
   * **`＊`（気象庁以外が運用する観測点）は外さなくてよい。** 電文の読み取りで既に外れており
   * （`stripNonJmaMark`）、`EarthquakePoint.addr` は印の無い名前。戻しているのは表示のときだけ。
   */
  /**
   * 県・区域の外接矩形。**カードごとに作り直さない** —— 索引は入力の参照をキーにキャッシュされる
   * （`namedRingsBoundsIndex` / `subRegionBoundsIndex`）。境界は県 47 件・区域 192 件で
   * 合わせて 24 万点あり、カードの一覧は仮想化していないので、ここで走査すると**畳んだカードも
   * 含めて全枚数ぶん**繰り返すことになる。
   */
  const prefBounds = prefectures
    ? ringsBoundsIndex(prefectures, () => Object.entries(prefectures).map(([name, shape]) => [name, shape.rings] as const))
    : EMPTY_BOUNDS_INDEX
  const areaBounds = subRegions
    ? ringsBoundsIndex(subRegions, () => subRegions.map((r) => [r.name, r.rings] as const))
    : EMPTY_BOUNDS_INDEX

  const coordsOf = (pref: string, name: string, isArea = false): LatLng | null => {
    if (!stationData) return null
    const index = isArea ? unreceivedIndexes.areaPrefIndex : unreceivedIndexes.stationPrefIndex
    return lookupPointCoords(stationData, pref, name, isArea)
      ?? lookupPointCoords(stationData, index?.get(name) ?? '', name, isArea)
  }

  const focusHandlerFor = (pref: string, name: string, isArea = false): (() => void) | undefined => {
    if (!onFocusMap) return undefined
    const position = coordsOf(pref, name, isArea)
    return position ? () => onFocusMap([position], isArea ? null : name) : undefined
  }

  /**
   * 範囲の行（県・区域・市町村）の寄り先。
   *
   * **外接矩形の 2 点だけを渡す。** `fitToPositions` は受け取った点の外接矩形へ寄せるので、
   * 境界の全頂点を渡す必要が無い（区域 1 つで数百点になる）。
   */
  const focusBoundsHandler = (bounds: RingsBounds | null): (() => void) | undefined => {
    if (!onFocusMap || !bounds) return undefined
    const corners: LatLng[] = [[bounds.minLat, bounds.minLng], [bounds.maxLat, bounds.maxLng]]
    return () => onFocusMap(corners, null)
  }

  /**
   * 市町村の行の寄り先。**境界データが無いので配下の観測点の範囲で代用する。**
   *
   * 県・区域と違って市町村の境界は生成データに無く（`prefectures.json` / `subregions.json` の
   * どちらも持たない）、電文からも作れない。観測点を 1 つも引けない市町村は押せないままにする。
   */
  const focusCityHandler = (pref: string, stations: readonly IntensityStationRow[]): (() => void) | undefined => {
    if (!onFocusMap) return undefined
    const positions = stations
      .map((st) => coordsOf(pref, st.name))
      .filter((p): p is LatLng => p !== null)
    return positions.length > 0 ? () => onFocusMap(positions, null) : undefined
  }

  const intensityRows = useMemo((): IntensityRows => {
    if (!isSelected || !quake.points.length) return { rows: [], unplacedStations: [] }

    // 「未入電あり」の印は、**その範囲に未入電の地点が 1 つでもあるか**で出す。行の最大が
    // 未入電かどうかでは判定しない —— 区域・県の最大震度は配下の最大なので、1 点でも観測値が
    // 届けばそちらが勝つ。最大だけを見ると「最大は観測できたが別の地点は未入電」という
    // **最も起きやすい形**で印が消える（→ docs/spec/quake-spec.md §4）。
    // **ブロックと同じ切り分け結果から作る**（`unreceivedIndexes`）。別々に解決すると、
    // 片方だけが名前を引けたときに「印は出るのに地点が出ない」（またはその逆）になる。
    const { stationPrefIndex, areaPrefIndex, prefOf, regionOfStation, stations: unreceivedStations, areas: unreceivedAreaPoints } = unreceivedIndexes
    const unreceivedPrefs = new Set<string>()
    const unreceivedAreas = new Set<string>()
    const unreceivedCities = new Set<string>()
    for (const p of [...unreceivedStations, ...unreceivedAreaPoints]) {
      const pref = prefOf(p)
      if (pref) unreceivedPrefs.add(pref)
      // 区域点はそのまま。都道府県ロールアップ点（addr === pref）は県として既に数えている。
      // 区域の点かどうかは `isAreaPoint` で見分ける。
      if (p.isArea) { if (isAreaPoint(p, areaPrefIndex)) unreceivedAreas.add(p.addr) }
      else {
        const region = regionOfStation(p)
        if (region) {
          unreceivedAreas.add(region)
          // **市町村にも同じ条件で印を付ける。** 電文の `City/Condition` は市町村の最大が
          // 震度4以下のときしか出ないので、それだけに頼ると**強く揺れた市町村ほど印が消える**
          // （能登本震では 1343 市町村すべてで `Condition` が付いていない）。鍵の作り方は
          // 行の組み立てと共有する（`cityKey`）。
          if (p.city) unreceivedCities.add(cityKey(region, p.city))
        }
      }
    }

    // 組み立ては `buildIntensityRows` に置いてある（電文の点だけを扱う純関数として試せるように）。
    // ここでは座標テーブル由来の索引を渡すだけ。
    const order = stationData ? regionOrderIndexOf(stationData) : null
    return buildIntensityRows(quake.points, quake.cities ?? [], {
      areaPrefIndex,
      prefOfArea: name => areaPrefIndex?.get(name) ?? null,
      prefOfStation: name => stationPrefIndex?.get(name) ?? null,
      regionOfStation: (pref, addr) => (stationData ? lookupStationRegion(stationData, pref, addr) : null),
      unreceivedPrefs,
      unreceivedAreas,
      unreceivedCities,
      rank: name => regionOrderRank(name, order),
    })
  }, [isSelected, quake.points, quake.cities, stationData, unreceivedIndexes])
  const prefGroups = intensityRows.rows

  // **一覧のどこにも置けなかった観測点を記録する**（県も区域も引けない点。→ `buildIntensityRows`）。
  // 座標表の読み込み前は引けないのが普通なので、読み込んだ後に出す。**鍵に名前の顔ぶれを含める** ——
  // 地震ごと 1 回にすると、続報で置けない観測点が増えても記録が出ない。
  const loggedUnplacedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!stationData || intensityRows.unplacedStations.length === 0) return
    const key = JSON.stringify([quakeEventKey(quake), [...new Set(intensityRows.unplacedStations)].sort()])
    if (loggedUnplacedRef.current === key) return
    loggedUnplacedRef.current = key
    log.warn(`[quake] 県も区域も引けず震度一覧に置けなかった観測点 ${intensityRows.unplacedStations.length} 件: ${intensityRows.unplacedStations.join(', ')}`)
  }, [stationData, intensityRows, quake])

  /**
   * 「震度を入手していない地点」。**未入電は観測点 1 つ 1 つに付く事実**なので、地点名で見せる
   * （気象庁も市町村・地点名で発表する。→ docs/spec/quake-spec.md §4）。県や区域の行に印を
   * 付けるだけでは、地点 1 つの話が範囲全体の話に見えてしまう。
   *
   * 地点を持たない電文（震度速報は区域しか持たない）では区域名で出す。
   * 並びは読み上げと同じ気象庁の標準順 —— 電文が点を並べた順に画面を委ねない。
   */
  const unreceivedPoints = useMemo(() => {
    const empty = { groups: [] as UnreceivedPointGroup[], count: 0, unit: '地点' }
    // ボタンも一覧も展開表示（`isSelected`）の中にしか無い。畳んだカードで組んでも使い道が無く、
    // 一覧に並ぶカードの数だけ並べ替えが走る。
    if (!isSelected) return empty
    const { prefOf, regionOfStation, stations, areas } = unreceivedIndexes
    if (stations.length === 0 && areas.length === 0) return empty
    const order = stationData ? regionOrderIndexOf(stationData) : null
    const rank = (p: EarthquakePoint): number => (p.isArea
      ? regionOrderRank(p.addr, order)
      : regionOrderRank(regionOfStation(p) ?? prefOf(p), order))
    const ordered = [...stations, ...areas]
      .map((p, i) => ({ p, i, r: rank(p) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map(({ p }) => ({ addr: p.addr, nonJma: p.nonJma, isArea: p.isArea, pref: prefOf(p) }))
    const groups = groupUnreceivedPointNames(ordered)
    return {
      groups,
      count: groups.reduce((n, g) => n + g.names.length, 0),
      unit: unreceivedUnitLabel(stations.length > 0, areas.length > 0),
    }
  }, [isSelected, stationData, unreceivedIndexes])

  // 長周期地震動も震度一覧と同じく入れ子にする（電文が持つのは県 → 区域 → 観測点の 3 段で、
  // 市町村の段が無いぶん震度の 4 段より 1 つ浅い）。組み立ては `buildLpgmRows` に置いてあり、
  // ここでは座標表由来の索引を渡すだけ。
  const lpgmGroups = useMemo(() => {
    // **どのデータがあれば行が出るかは `buildLpgmRows` に決めさせる。** ここで「区域があるか」
    // 「観測点があるか」と条件を並べ直すと、向こうが受け皿を足したときに静かにずれる
    // （区域が全滅して県の値だけが残る電文が、ここで弾かれていた）。空なら空配列が返り、
    // 描画側の `lpgmGroups.length > 0` で落ちる。
    if (!isSelected || !lpgm) return []
    const areaPrefIndex = stationData ? areaPrefIndexOf(stationData) : null
    const order = stationData ? regionOrderIndexOf(stationData) : null
    return buildLpgmRows(lpgm.regions ?? [], lpgm.points ?? [], lpgm.prefs ?? [], {
      prefOfArea: name => areaPrefIndex?.get(name) ?? null,
      rank: name => regionOrderRank(name, order),
      onUnplaceableStation: name => noteUnplaceableLpgmStation(lpgm.id, name),
    })
  }, [isSelected, lpgm, stationData])

  // **一覧を組めなかったときは記録する**（2026-10-22 ユーザー選択「戻すときに記録を残す (Recommended)」）。
  // 長周期の欄には地域・観測点の行が無いまま出るだけで、組めなかったことは画面から分からない。
  // 同じ報で 1 回だけ残す（選択し直すたびに並ばないように）。
  const lpgmActiveHere = !!lpgm && !lpgm.cancelled && activeLpgmEventId === lpgm.eventId
  const lpgmFallbackNotedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isSelected || !lpgm || lpgm.cancelled || lpgmGroups.length > 0) return
    if (lpgmFallbackNotedRef.current === lpgm.id) return
    lpgmFallbackNotedRef.current = lpgm.id
    log.warn(`[lpgm] 長周期地震動の一覧を組めず、長周期の欄に地域・観測点の行を出せませんでした（${lpgm.id}・区域 ${lpgm.regions?.length ?? 0} 件・観測点 ${lpgm.points?.length ?? 0} 件・都道府県 ${lpgm.prefs?.length ?? 0} 件）`)
  }, [isSelected, lpgm, lpgmGroups])

  /**
   * 印の付いた行が見えるように、その祖先を自動で開く。
   *
   * **カードを畳んでいる間は判定ごと止める。** 行の木は選択中のカードでしか組み立てないので、
   * 通すと開く先が無いまま「この印は見た」だけが記録され、あとで開いても一度も展開しない。
   *
   * **印が消えたら、自分が開いた分だけ畳む。** 手で開いていた行まで閉じると、見ようとしていた
   * 中身を奪うことになる（読み上げ中の自動開閉と同じ規約）。手で閉じた行も追いかけない ——
   * 次の報で新しく印が付けば、そのときあらためて開く。
   *
   * **震度一覧と長周期は別々に進める。** 開閉の入れ物は共有するが、印の出どころは 2 つあり
   * （地震の報と長周期の報）別々のときに別々の参照へ変わる。1 つの真偽値へ畳むと、**長周期の報が
   * 届いただけで震度一覧の「手で閉じた行」が開き直す**（逆も同じ）。鍵の名前空間が分かれている
   * （長周期は `lpgm:` を冠する）ので、同じ集合へ順に当てても互いを踏まない。
   *
   * 開く行が多すぎる報では**何も開かない**（→ `AUTO_EXPAND_MAX_VISIBLE_ROWS`。上限は一覧ごと）。
   */
  const autoOpenedRef = useRef<{ rows: ReadonlySet<string>; lpgm: ReadonlySet<string> }>({ rows: new Set(), lpgm: new Set() })
  /** 前回この効果を走らせたときの印。**参照で比べる** —— 印は報ごとに作り直される。 */
  const seenMarksRef = useRef<{ marks?: QuakeCardMarks; lpgm?: QuakeCardMarks }>({})
  const rowsToExpand = useMemo(
    () => intensityRowsToExpand(prefGroups, marks?.rows),
    [prefGroups, marks],
  )
  const lpgmToExpand = useMemo(
    () => lpgmRowsToExpand(lpgmGroups, lpgmMarks?.rows),
    [lpgmGroups, lpgmMarks],
  )
  useEffect(() => {
    // **カードを畳んでいる間は何もしない。** `prefGroups` / `lpgmGroups` は選択中でなければ
    // 空配列を返すので、ここを通すと**開く先が無いまま「この印は見た」の記録だけが進む**。
    // あとでカードを開いても印の参照は変わっていないので `marksChanged` が偽になり、
    // **一度も自動で開かないまま終わる** —— 別のカードを見ている間に届いた続報という、
    // この仕掛けがいちばん効くはずの場面がちょうど抜ける。
    if (!isSelected) return
    // **印が新しくなった報でだけ開く**（理由は `mergeAutoExpanded`）。**2 つの出どころは
    // 別々に見る** —— 畳むと片方の報がもう片方の「手で閉じた行」を開き直す（上の JSDoc）。
    const rowsChanged = seenMarksRef.current.marks !== marks
    const lpgmChanged = seenMarksRef.current.lpgm !== lpgmMarks
    seenMarksRef.current = { marks, lpgm: lpgmMarks }
    // **更新関数の中で ref を書き換えない。** React は開発時に更新関数を 2 回呼んで純粋さを
    // 確かめるので、中で `autoOpenedRef` を書くと 2 回目が別の入力で走る。
    const byRows = mergeAutoExpanded({
      prev: expanded, want: rowsToExpand ?? EMPTY_KEYS,
      autoOpened: autoOpenedRef.current.rows, marksChanged: rowsChanged,
    })
    const byLpgm = mergeAutoExpanded({
      prev: byRows.next, want: lpgmToExpand ?? EMPTY_KEYS,
      autoOpened: autoOpenedRef.current.lpgm, marksChanged: lpgmChanged,
    })
    autoOpenedRef.current = { rows: byRows.autoOpened, lpgm: byLpgm.autoOpened }
    // 中身が変わらなければ同じ参照が返るので、そこで止まる（`expanded` を依存に入れても回らない）。
    if (byLpgm.next !== expanded) setExpanded(byLpgm.next)
  }, [isSelected, rowsToExpand, lpgmToExpand, marks, lpgmMarks, expanded])

  // 一覧の 1 行（見本 closed5）。閉じたカードと、開いたカードのスマホの帯（→ `QuakeOpenPin`）で同じものを使う。
  const quakeDate = readDateTime('quakeListRow', earthquake.time)
  const listRowFor = (lpgmTabbable: boolean) => (
  <QuakeListRow
    lpgmTabbable={lpgmTabbable}
    scale={maxScale}
    scaleLabel={maxScaleLabel}
    orAbove={maxScaleOrAbove}
    lpgmClass={lpgm && !lpgm.cancelled ? lpgm.maxClass : null}
    heading={quake.fromInternationalTsunami
      ? <InternationalTsunamiHeading />
      : <QuakeReportHeading reports={quake.reports} fallback={issue.type} colored />}
    chips={<>
      {quake.operationStatus && (
        <span className="shrink-0 rounded-[3px] px-1.5 font-bold leading-[1.55]" style={{ backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}>
          {quake.operationStatus}報
        </span>
      )}
      {isKnownCorrection(issue.correct) && (
        <span className="shrink-0 rounded-[3px] bg-yellow-900 px-1.5 font-bold leading-[1.55] text-yellow-300">
          {formatCorrectType(issue.correct)}
        </span>
      )}
    </>}
    tsunami={quake.fromInternationalTsunami ? null : { text: tsunamiInfo.text, color: tsunamiInfo.color, title: domesticTsunami === '警報等' ? TSUNAMI_WARNING_GROUP_TITLE : undefined }}
    time={quakeDate ? formatHourMinute(quakeDate) : QUAKE_LIST_TIME_UNKNOWN}
    name={epicenterLabel}
    magnitude={hasFacts ? { text: formatMagnitudeWithCondition(hypocenter.magnitude, hypocenter.magnitudeCondition, hypocenter.magnitudeType), value: hypocenter.magnitude } : null}
    depth={hasFacts ? { text: formatDepth(hypocenter.depth, hypocenter.depthAtLeast === true), value: hypocenter.depth } : null}
  />
  )
  // 開いたカードの開閉（報の一覧・気象庁からの補足）と、帯を出すかを見る震度の枠
  const [timelineOpen, setTimelineOpen] = useState(false)
  // 畳んだら報の一覧も閉じる（次に開いたとき、前に開いたままの一覧で始めない）
  useEffect(() => { if (!isSelected) setTimelineOpen(false) }, [isSelected])
  const factsRef = useRef<HTMLDivElement>(null)
  // 見出しの段の高さをカードへ書く（左右分割の広い組では、震度の枠をこの段のすぐ下へ貼りつける。→ index.css）。
  // 段は折り返して 2 行になることがあるので、決め打ちせずに測る
  const openHeadRef = useRef<HTMLDivElement>(null)
  // 震度の枠・長周期の札を押したときに巻く先（2026-11-03 選択「震度の枠→各地の震度へ」「長周期の札→長周期の節へ」）
  const intsSectionRef = useRef<HTMLDivElement>(null)
  const lpgmSectionRef = useRef<HTMLDivElement>(null)
  const toInts = () => { if (intsSectionRef.current) scrollOpenSectionIntoView(intsSectionRef.current) }
  const toLpgm = () => { if (lpgmSectionRef.current) scrollOpenSectionIntoView(lpgmSectionRef.current) }
  // 広い組で見出しの段と震度の枠を貼りつけるのは、貼りつく高さ（一覧の見出しの行＋見出しの段＋枠と値）が
  // 一覧の見える高さの 4 割までのときだけ。超えたら狭い組と同じ帯にする（2026-11-03 発言「並び方じゃなくて
  // 高さ見たほうがいいのかな」、選択「4 割まで (Recommended)」）。印（`data-stick-tall`）は CSS が見る（→ index.css）。
  // 測るのは貼りつけていてもいなくても同じ高さなので、印を付け替えても判定は往復しない
  useLayoutEffect(() => {
    const head = openHeadRef.current
    const facts = factsRef.current
    const card = head?.parentElement
    if (!isSelected || !head || !facts || !card) return
    const root = scrollParentOf(card)
    const measure = () => {
      const headH = head.getBoundingClientRect().height
      // 読むのは貼りつく震度の枠（`.quake-stick`）だけなので、そこへ書く。カードの根へ書くと、受け継ぐ中身
      // （開いた県の観測点まで）のスタイルを全部計算し直す
      facts.style.setProperty('--qk-open-head-h', `${headH}px`)
      const stuck = listHeadPx(card) + headH + facts.getBoundingClientRect().height
      const view = root?.clientHeight ?? 0
      card.toggleAttribute('data-stick-tall', view > 0 && stuck <= view * STICK_MAX_SHARE)
    }
    window.addEventListener('resize', measure)
    if (typeof ResizeObserver === 'undefined') {
      measure()
      return () => window.removeEventListener('resize', measure)
    }
    // ここで測らず、ResizeObserver の初回の呼び出しに任せる（見張りを始めると、その回の描画の前に一度呼ばれる）。
    // 描き替えた直後に高さを読むと、カードを開いた描き直しの中でレイアウトを 1 回余計に強いる
    const ro = new ResizeObserver(measure)
    ro.observe(head)
    ro.observe(facts)
    if (root) ro.observe(root)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [isSelected])
  // 長周期の節を見せる求め（→ `lpgmFocusSeq`）。巻けるのは、開いていて長周期の節が描かれているときだけ。
  // まだ巻けない（畳んでいたのを開き直す途中・長周期の電文が先に届いた）なら、巻けるようになった描き直しで巻く。
  // カードの開く動きが走っている間は、伸び終えてから巻く（途中の高さで測ると着地がずれる。→ useFollowScroll と同じ）
  const lpgmFocusDoneRef = useRef(0)
  const lpgmSectionShown = !!lpgm && !lpgm.cancelled
  useLayoutEffect(() => {
    const seq = lpgmFocusSeq
    if (seq === 0 || lpgmFocusDoneRef.current === seq || !isSelected || !lpgmSectionShown) return
    const section = lpgmSectionRef.current
    const root = openRootRef.current
    if (!section || !root) return
    lpgmFocusDoneRef.current = seq
    const resizing = root.getAnimations?.().filter(a => a.id === CARD_RESIZE_ANIMATION_ID && a.playState === 'running') ?? []
    if (resizing.length === 0) {
      scrollOpenSectionIntoView(section)
      return
    }
    void Promise.all(resizing.map(a => a.finished.catch(() => undefined))).then(() => {
      // 伸びている間に畳まれた・別の求めが来たなら巻かない
      if (section.isConnected && lpgmFocusDoneRef.current === seq) scrollOpenSectionIntoView(section)
    }).catch((err: unknown) => log.warn('[地震タブ] 長周期の節へ巻けなかった', err))
  }, [lpgmFocusSeq, isSelected, lpgmSectionShown])
  // 一覧に載せるのは、カードに紐づく電文すべて（2026-11-01 選択「紐づく電文のうち最新の発表時刻 (Recommended)」。
  // 地震情報・長周期・国際津波・推計震度分布図・値を借りた津波の電文）。借りた津波は震源と津波の有無で
  // 別の報になりうるので、同じ報（名前と時刻が同じ）は 1 行にまとめる。
  const borrowedTelegrams = useMemo(() => {
    const seen = new Set<string>()
    const out: { label: string; time: string }[] = []
    for (const src of [quake.hypocenterSource, quake.domesticTsunamiSource]) {
      if (!src) continue
      const key = `${src.infoName}|${src.reportTime}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ label: src.infoName, time: src.reportTime })
    }
    return out
  }, [quake.hypocenterSource, quake.domesticTsunamiSource])
  // **開いたカードでだけ組む**（閉じた行は一覧を出さない）。長周期は最新の 1 報だけを持つが、
  // 全期間の控え（2020-11〜2026-10・VXSE62 の地震 91 件）で同じ地震の 2 通目は 0 件だった
  // （2026-11-02 に数えた）ので、1 報で届いた報をすべて指している。推計震度分布図は置き換えた
  // 前の報の発表時刻を `previousTimes` に引き継いでいるので、それも並べる。
  const timeline = useMemo(() => !isSelected ? [] : quakeReportTimeline(quake, [
    ...(lpgm && !lpgm.cancelled ? [{ label: lpgm.infoName ?? '長周期地震動に関する観測情報', time: lpgm.time }] : []),
    ...internationalTsunamis.map(x => ({ label: '国際津波関連情報', time: x.time })),
    ...(estimatedIntensity
      ? [...(estimatedIntensity.previousTimes ?? []), estimatedIntensity.time].map(time => ({ label: '推計震度分布図', time }))
      : []),
    ...borrowedTelegrams,
  ]), [isSelected, quake, lpgm, internationalTsunamis, estimatedIntensity, borrowedTelegrams])

  if (isSelected) {
    const magColor = getMagnitudeColor(hypocenter.magnitude)
    const depthColor = getDepthColor(hypocenter.depth)
    // 開いたカード（見本 opened.html の open()。→ docs/quake-tab-redesign.md「決まっていること」）。
    // 上から: 見出しの行（押すと畳む・「更新」で報の一覧）→ 見出し文 → 震度の枠と震源の値（広い画面では
    // 一覧の上へ貼りつく）→ 気象庁からの補足 → 各地の震度 → 長周期地震動 → 国際津波関連情報 → 波形 → 官署。
    const lpgmShown = lpgm && !lpgm.cancelled ? lpgm : undefined
    const quakeTimeText = formatQuakeTime(earthquake.time)
    const lastTimeline = [...timeline].reverse().find(e => e.ms !== null)
    const tileBg = getIntensityColor(maxScale)
    const showObservedSeg = canDrawDistribution || !!lpgmShown
    const toObserved = () => {
      if (distributionActive) onToggleDistribution?.(eventKey)
      if (lpgmActiveHere && lpgm) onToggleLpgm?.(lpgm.eventId)
    }
    // 切り替えの 1 つ。カード全体は <button> ではないが、行の作法（`div role="button"`）に揃える。
    const segButton = (label: string, on: boolean, onClick: () => void, title?: string) => (
      <div
        key={label}
        role="button"
        tabIndex={0}
        aria-pressed={on}
        title={title}
        onClick={(e) => { e.stopPropagation(); onClick() }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onClick() } }}
        className={`cursor-pointer whitespace-nowrap px-2 py-[3px] ${on ? 'bg-[#24303d] text-white' : 'text-secondary hover:text-white'}`}
      >
        {label}
      </div>
    )

    return (
      <div
        {...{ [QUAKE_CARD_KEY_ATTR]: eventKey }}
        ref={openRootRef}
        // 地（押せる所の外）を押すと、地図をこの地震の全体へ寄せ直す（2026-11-03 選択「開いたカードの地を押す
        // (Recommended)」。前の作りでは開いたカード全体が 1 つのボタンで、どこを押しても寄せ直していた）
        onClick={quake.cancelledAt ? undefined : (e) => { if (isPlainBackgroundClick(e)) onSelect?.(eventKey) }}
        // `isolate`: 取消の覆い（z-10）と中で貼りつく段をこのカードの中に閉じる。閉じないと、一覧の見出しの行（z-[4]）・
        // 日付の区切り（z-[3]）と同じ重なりで比べられ、巻いたとき覆いがその上へ被る
        className="quake-open relative isolate border-b border-border bg-card"
        style={{ padding: '4px var(--qk-pad) 16px', fontSize: 'var(--qk-f)', boxShadow: `inset 3px 0 0 ${tileBg}` }}
      >
        {quake.cancelledAt && <QuakeCancelOverlay cancelText={quake.cancelText} compact={false} fade={fadeCancel} />}
        {/* スマホ幅では、震度の枠が画面の外へ出たら閉じた行と同じ帯を上に貼りつける（2026-11-02 選択「畳んだ行の帯」） */}
        <QuakeOpenPin targetRef={factsRef} onActivate={quake.cancelledAt ? undefined : collapseCard} onLpgmActivate={lpgmShown ? toLpgm : undefined}>{listRowFor(!!lpgmShown && !quake.cancelledAt)}</QuakeOpenPin>
        {/* 見出しの行。押すと畳む（選択は外さない）。 */}
        <div ref={openHeadRef} className="quake-open-head flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-border bg-card py-2" style={{ fontSize: 'var(--qk-fs)' }}>
          <button
            type="button"
            aria-expanded={true}
            onClick={quake.cancelledAt ? undefined : collapseCard}
            className="flex min-w-0 items-baseline gap-2.5 text-left"
          >
            <span className="text-[#9fb3c8]">▾</span>
            <b className="font-semibold text-[#cfd6dd]" style={{ fontSize: 'var(--qk-f)' }}>
              {quake.fromInternationalTsunami
                ? <InternationalTsunamiHeading />
                : <QuakeReportHeading reports={quake.reports} fallback={issue.type} lpgmInfoName={lpgm?.infoName} colored />}
            </b>
          </button>
          {/* 電文が自分で名乗っている運用種別（`Control/Status`）。訓練・試験のときだけ出す。 */}
          {quake.operationStatus && (
            <span className="rounded-sm px-1.5 font-bold" style={{ backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}>
              {quake.operationStatus}報
            </span>
          )}
          {isKnownCorrection(issue.correct) && (
            <span className="rounded-sm bg-yellow-900 px-1.5 font-bold text-yellow-300">{formatCorrectType(issue.correct)}</span>
          )}
          {lastTimeline && lastTimeline.ms !== null && (
            <button
              type="button"
              aria-expanded={timelineOpen}
              onClick={() => setTimelineOpen(v => !v)}
              className="whitespace-nowrap rounded border border-border px-1.5 text-[#9fb3c8] hover:text-white"
            >
              更新 {formatTimelineTime(lastTimeline.ms)} <DisclosureCaret open={timelineOpen} glyph="▾" turn={180} />
            </button>
          )}
        </div>
        <Reveal open={timelineOpen} className="mt-1.5 mb-0.5 rounded-md border border-border px-2.5 py-1 text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>{() => (<>
            {timeline.map((e, idx) => (
              <div key={idx} className={`flex justify-between gap-3 py-[3px] ${idx > 0 ? 'border-t border-border/60' : ''}`}>
                <span>{e.label}</span>
                <span className="tabular-nums">{e.ms !== null ? formatTimelineTime(e.ms) : QUAKE_LIST_TIME_UNKNOWN}</span>
              </div>
            ))}
          </>)}</Reveal>

        {/* 一部の取消（震源情報まで進んだカードに震度速報だけの取消が届いた等）。カードは残し、
            取り消された情報の名前と、気象庁が書いた理由（`Body/Text`）をそのまま出す
            （2026-10-15 ユーザー承認「見出しの下に一行＋理由（推奨）」）。取り消された内容は
            当て直しでカードから消えているので、**ここが消えたことを伝える唯一の場所**。 */}
        {quake.retractedReports?.map(r => (
          <div key={`${r.issueType}#${r.reportTime}`} className="border-b border-border py-1.5 text-yellow-300">
            <div className="font-bold">{r.issueType}は取り消されました</div>
            {r.cancelText && (
              <div className="mt-0.5 text-yellow-300/80" style={{ whiteSpace: 'pre-line', fontSize: 'var(--qk-fs)' }}>{r.cancelText}</div>
            )}
          </div>
        ))}

        {/* 見出し文（`Head/Headline/Text`）。電文のまま出す。 */}
        {quake.headline && <div className="pt-1 text-[#cfd6dd]">{quake.headline}</div>}

        {/* 震度の枠と震源の値。広い画面では一覧の上へ貼りつく（→ index.css の quake-stick） */}
        <div ref={factsRef} className="quake-stick bg-card">
          <div className="grid border-b border-border py-2" style={{ gridTemplateColumns: 'var(--qk-big) 1fr', gap: 'var(--qk-fact-gap)' }}>
            {/* 前の版の形：濃い地・震度の色の縁・「最大震度」・白い極太の数字。右の文字の列に合わせて縦に伸ばし、
                中身は上下の中央（2026-11-03 選択「B2：縦に伸ばし中身は中央 (Recommended)」）。
                押すと各地の震度へ、長周期の札を押すと長周期地震動の節へ巻く（同日選択「震度の枠→各地の震度へ」
                「長周期の札→長周期の節へ」） */}
            <div
              role="button"
              tabIndex={0}
              onClick={toInts}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toInts() } }}
              className="quake-tile relative box-border flex cursor-pointer flex-col self-stretch overflow-hidden rounded-md"
              style={{ ...quakeTileColors(maxScale), width: 'var(--qk-big)' }}
            >
              <div data-tile className="quake-tile-part flex flex-1 flex-col items-center justify-center gap-1 py-1 leading-none">
                <span className="font-semibold" style={{ fontSize: 'var(--qk-fs)', color: liftForContrast(getIntensityColor(maxScale), getIntensityBgColor(maxScale)) }}>最大震度</span>
                <span className="font-black" style={{ fontSize: 'calc(var(--qk-big-f) * 0.75)' }}>
                  <TileScaleLabel label={maxScaleLabel} />
                </span>
                {/* 「以上」は本体より小さく添える（→ `maxScaleOrAbove` の注記） */}
                {maxScaleOrAbove && <span className="text-[0.8rem] font-bold">以上</span>}
              </div>
              {lpgmShown && (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); toLpgm() }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toLpgm() } }}
                  className="quake-tile-part quake-tile-lpgm flex items-center justify-center font-bold text-white"
                  style={{ height: 'var(--qk-band-h)', fontSize: 'var(--qk-band-f)', backgroundColor: getLpgmClassColor(lpgmShown.maxClass), borderTop: '1px solid rgba(0,0,0,.35)' }}
                >
                  {getLpgmClassLabel(lpgmShown.maxClass).replace('階級', '長周期')}
                </div>
              )}
              {markDot('maxScale', 'md', 'absolute right-1 top-1')}
            </div>
            <div className="min-w-0">
              {/* **印は名前を出しているときだけ。** 名前が無い報では固定文言「震源調査中」が出るので、
                  そこへ印を当てると**文言そのものが新しくなった**ように読める。 */}
              <div className="font-extrabold leading-tight text-white" style={{ fontSize: 'var(--qk-name)' }}>
                {epicenterLabel}
                {borrowedHypocenter && hypocenter.name && <BorrowedMark />}
                {hypocenter.name && markDot('hypocenterName', 'md', 'align-top ml-1')}
              </div>
              {/* 震央補助表現と緯度・経度は震央地名の直下（どちらも「どこで起きたか」）。補助表現は文が
                  別の文へ変わったときだけ印を付ける（2026-10-19 ユーザー承認「1 で」）。 */}
              {(hypocenter.nameFromMark || hasLocation) && (
                <div className="mt-0.5 text-secondary">
                  {hypocenter.nameFromMark && (
                    <span className="mr-3 inline-block whitespace-nowrap">
                      {formatNameFromMark(hypocenter.nameFromMark)}
                      {borrowedHypocenter && <BorrowedMark />}
                      {markDot('nameFromMark', 'sm', 'align-top ml-1')}
                    </span>
                  )}
                  {hasLocation && (
                    <span className="inline-block whitespace-nowrap tabular-nums">
                      {formatCoordinate(hypocenter.latitude, hypocenter.longitude)}
                      {borrowedHypocenter && <BorrowedMark />}
                      {markDot('coordinate', 'sm', 'align-top ml-1')}
                    </span>
                  )}
                </div>
              )}
              {/* 震源を決めた機関（`Hypocenter/Source`）。津波カードと同じ文面（2026-10-22 ユーザー承認「6-A 津波タブと同じ」）。 */}
              {hypocenter.source && (
                <div className="text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>{formatHypocenterSource(hypocenter.source)}</div>
              )}
              <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
                <div>
                  {quakeTimeText ? (
                    <>
                      <span className="block leading-tight text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>
                        {quake.fromInternationalTsunami ? QUAKE_ORIGIN_TIME_LABEL : QUAKE_ARRIVAL_TIME_LABEL}
                      </span>
                      <b className="font-bold tabular-nums leading-tight" style={{ fontSize: 'var(--qk-val)' }}>{quakeTimeText}</b>
                    </>
                  ) : (
                    <b className="font-bold leading-tight" style={{ fontSize: 'var(--qk-val)' }}>{QUAKE_ARRIVAL_TIME_UNKNOWN}</b>
                  )}
                </div>
                {/* 国内津波情報。「津波警報等」だけは語に何が含まれるか説明を添える（→ `formatDomesticTsunami`）。
                    国際津波関連情報だけのカードには出さない（英文に国内の津波の区分は無い。→ quake-spec.md §3） */}
                {!quake.fromInternationalTsunami && <div title={domesticTsunami === '警報等' ? TSUNAMI_WARNING_GROUP_TITLE : undefined}>
                  <span className="block leading-tight text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>津波</span>
                  <b className="font-bold leading-tight" style={{ fontSize: 'var(--qk-val)', color: tsunamiInfo.color }}>
                    {tsunamiInfo.text}
                    {borrowedDomesticTsunami && <BorrowedMark />}
                    {markDot('domesticTsunami', 'sm', 'align-top ml-1')}
                  </b>
                </div>}
                {hasFacts && (
                  <>
                    <i className="h-0 basis-full" />
                    <div>
                      {/* 見出しは種別の名前、値は記号つき（2026-10-23 ユーザー承認「まあそれで行きましょう」）。→ `magnitudeHeading` */}
                      <span className="block leading-tight text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>
                        {magnitudeHeading(hypocenter.magnitudeType)}
                        {borrowedHypocenter && <BorrowedMark />}
                      </span>
                      {/* 「M8を超える巨大地震」のような文は字だけ縮める。行の大きさは深さの欄と同じに保ち、
                          並んだ値と下端（基準線）と色の線の長さを揃える。 */}
                      <b className="font-bold tabular-nums leading-tight" style={{ fontSize: 'var(--qk-val)' }}>
                        <i className="mr-1.5 inline-block h-[0.9em] w-1 rounded-[2px] align-[-0.05em]" style={{ backgroundColor: magColor }} />
                        <span style={hypocenter.magnitudeCondition && !hasMagnitude(hypocenter.magnitude) ? { fontSize: '0.7em' } : undefined}>
                          {formatMagnitudeWithCondition(hypocenter.magnitude, hypocenter.magnitudeCondition, hypocenter.magnitudeType)}
                        </span>
                        {markDot('magnitude', 'md', 'align-top ml-1')}
                      </b>
                    </div>
                    <div>
                      <span className="block leading-tight text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>
                        深さ
                        {borrowedHypocenter && <BorrowedMark />}
                      </span>
                      <b className="font-bold leading-tight" style={{ fontSize: 'var(--qk-val)' }}>
                        <i className="mr-1.5 inline-block h-[0.9em] w-1 rounded-[2px] align-[-0.05em]" style={{ backgroundColor: depthColor }} />
                        {formatDepth(hypocenter.depth, hypocenter.depthAtLeast === true)}
                        {markDot('depth', 'md', 'align-top ml-1')}
                      </b>
                    </div>
                  </>
                )}
          {/* 借りた値の説明。**印を付けた欄より後ろへ置く** —— 記号を見てから意味を探すので、
              説明が先にあると「何の話か」が分からないまま読むことになる。 */}
                {borrowedNote && (
                  <div className="-mt-1 basis-full text-secondary" style={{ fontSize: 'var(--qk-fs)' }} title={borrowedNote.title}>
                    {borrowedNote.text}
                  </div>
                )}

              </div>
            </div>
          </div>
          {/* 貼りついている間だけ下端に出す境の線と影（→ index.css の quake-stick-edge） */}
          <i aria-hidden className="quake-stick-edge" />
        </div>

        {/* 気象庁が添えた文は畳んで置き、読み上げのあいだ開く（→ `JmaNotesFold`） */}
        {quakeComments.groups.length > 0 && (
          <div className="mt-1.5">
            <JmaNotesFold
              open={quakeNotesOpen}
              onToggle={() => setQuakeNotesOpenByUser(!quakeNotesOpen)}
              groups={quakeComments.groups}
              showHeadings={quakeComments.showHeadings}
            />
          </div>
        )}

        {/* 国際津波関連情報（WEPA60）。付加文の下に置き（2026-11-01 選択「それぞれ自分の欄を持つ (Recommended)」）、
            報ごとに見出しの行で開閉する。英文だけのカードでは初めから開き、地震情報のカードでは閉じて置く
            （2026-11-05 ユーザー発言「遠地地震とかはそれしか無いから開いていいけど、地震情報はほかに情報があるのに
            押されて見えなくなるので」、選択「英文だけのカードだけ開く」）。鍵が `expanded` にあるのは初めの開き方から
            押して変えた報 */}
        {internationalTsunamis.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {internationalTsunamis.map(x => {
              const key = internationalTsunamiFoldKey(x.id)
              const open = expanded.has(key) !== (quake.fromInternationalTsunami === true)
              return (
                <div key={x.id} className="w-full rounded-lg border border-border bg-panel px-3 py-1 text-xs text-secondary roomy:text-sm">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={(e) => { e.stopPropagation(); toggle(key) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); toggle(key) } }}
                    className="cursor-pointer py-1 text-white"
                  >
                    国際津波関連情報（英文）<span className="ml-2 text-secondary">{x.title}</span> <DisclosureCaret open={open} />
                  </div>
                  <Reveal open={open}>{() => (
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words pb-2 font-mono leading-relaxed">{x.text}</pre>
                  )}</Reveal>
                </div>
              )
            })}
          </div>
        )}

        {/* 各地の震度。見出しの右で地図の見せ方を切り替える（見本の「観測点・推計震度分布・長周期」） */}
        <div ref={intsSectionRef} className="mt-1.5 flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <h4 className="m-0 font-semibold text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>各地の震度</h4>
            {showObservedSeg && (
              <div className="flex divide-x divide-border overflow-hidden rounded border border-border" style={{ fontSize: 'var(--qk-fs)' }}>
                {segButton('観測点', !distributionActive && !lpgmActiveHere, toObserved)}
                {canDrawDistribution && segButton(
                  distributionState === 'official' ? '推計震度分布' : '簡易推定',
                  distributionActive,
                  () => onToggleDistribution?.(eventKey),
                  distributionState === 'official'
                    ? '気象庁が地盤の揺れやすさまで考慮して推計した震度の分布です'
                    : '観測点の震度をこのアプリが補間した目安です。気象庁の推計とは精度が違います',
                )}
                {lpgmShown && segButton('長周期', lpgmActiveHere, () => onToggleLpgm?.(lpgmShown.eventId))}
              </div>
            )}
          </div>
          {estimatedMarkNote && (
            <div className="text-xs text-secondary roomy:text-sm">{estimatedMarkNote}</div>
          )}

          {/* 震度を入手していない地点（クリックで一覧を差し替え、地図に印を出す）。
              **再掲だったブロックをこのボタンへ畳んである。** 未入電の観測点は震度一覧の入れ子の
              中にも入っており、県・区域の「未入電あり」バッジがそこへ辿る導線になっている。
              実測で 60 件のとき上下分割でパネル可視高の 142% を占めていたので、件数だけ常に見せて
              地点名は開いたときに出す。 */}
          {unreceivedPoints.count > 0 && (
            <div
              role="button"
              tabIndex={0}
              aria-pressed={unreceivedActive}
              onClick={(e) => { e.stopPropagation(); onToggleUnreceived?.(eventKey) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onToggleUnreceived?.(eventKey) } }}
              title="気象庁が震度5弱以上と推定しているのに、震度が届いていない地点です。押すと一覧と地図に出します"
              className={`w-full rounded-lg py-1 px-3 flex items-center justify-between gap-2 border transition-colors cursor-pointer hover:opacity-80 roomy:py-2 roomy:px-4 ${
                unreceivedActive
                  ? 'bg-gray-500/25 border-gray-400 outline-solid outline-2 outline-offset-2 outline-gray-400'
                  : 'bg-panel border-border'
              }`}
            >
              <span className="text-xs font-medium text-white roomy:text-sm">
                震度を入手していない{unreceivedPoints.unit}
              </span>
              <span className="text-xs font-bold text-secondary roomy:text-sm">
                {unreceivedPoints.count}{unreceivedPoints.unit}
              </span>
            </div>
          )}

          {(() => {
            // 未入電の一覧（トグルオン時は震度一覧と差し替える）。
            //
            // **4 段の入れ子にしない。** 全部が同じ「5弱以上」なので段を作っても分かれる情報が
            // 無く、60 件のときに段を開いて回る手間だけが残る。平らに並べ、どこの話かは県の
            // 見出しが示す（→ `groupUnreceivedPointNames`）。
            if (unreceivedActive && unreceivedPoints.count > 0) {
              return (
                <div className="flex flex-col gap-1 pt-1 border-t border-white/10">
                  {/* **推定したのは気象庁**であることを書く。このアプリは強震モニタ由来の
                      値にも「推定」を使っており（リアルタイムタブ）、主語が無いと
                      「アプリが推定した値」と取り違えられる。 */}
                  <div className="text-[0.6875rem] text-secondary roomy:text-[0.8125rem]">
                    気象庁は震度5弱以上と推定していますが、震度が届いていません（未入電）
                  </div>
                  {unreceivedPoints.groups.map((group, idx) => (
                    <div
                      key={group.pref || `unknown-pref-${idx}`}
                      className="rounded-sm px-2 py-1"
                      style={{ backgroundColor: idx % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent' }}
                    >
                      {/* 県を引けなかった点は見出しを出さずに並べる（名前は出す）。所属が
                          分からないことは、地点名を落とす理由にならない。 */}
                      {group.pref && (
                        <div className="text-[0.75rem] roomy:text-[0.875rem] font-bold text-white">
                          {group.pref}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.8125rem] roomy:text-[1rem] text-white">
                        {/* 気象庁以外が運用する観測点には電文どおり `＊` を付ける。震度一覧・
                            地図の吹き出しと同じ扱い（→ `withNonJmaMark`）。 */}
                        {/* 地名を押すと地図がその地点（区域なら代表点）へ寄る。震度一覧の
                            観測点の行と同じ引き当てで、寄り先を作れる名前だけが押せる
                            （→ `focusHandlerFor`・docs/spec/quake-spec.md §8）。
                            **`＊` まで含めて 1 つの当たり判定にする** —— 印は名前の一部で、
                            そこだけ押せないと境目が利用者に分からない。 */}
                        {group.names.map(({ name, nonJma, isArea }) => {
                          const focus = focusHandlerFor(group.pref, name, isArea)
                          return (
                            <span
                              key={name}
                              title={nonJma ? NON_JMA_MARK_TITLE : undefined}
                              {...(focus ? {
                                role: 'button' as const,
                                tabIndex: 0,
                                onClick: (e: React.MouseEvent) => { e.stopPropagation(); focus() },
                                onKeyDown: (e: React.KeyboardEvent) => {
                                  if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); focus() }
                                },
                                className: 'cursor-pointer hover:underline',
                              } : {})}
                            >
                              {withNonJmaMark(name, nonJma)}
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )
            }

            if (prefGroups.length === 0) return null
            // 未入電の注記を描く行が 1 つでもあれば、震度の欄を広げる（→ `intensityValueColumn`）
            const unreceivedLayout = intensityRowsShowUnreceivedNote(prefGroups)

            // 市町村に紐付かない観測点の行（区域の直下・県の直下の両方で使う）。
            const stationRow = (st: IntensityStationRow, depth: 1 | 2 | 3, pref: string) => (
              <IntensityRow
                key={st.name}
                label={st.name}
                scale={st.scale}
                unreceived={st.unreceived}
                unreceivedIsOwn={st.unreceived}
                nonJma={st.nonJma}
                mark={rowMark(rowMarkKey.station(st.name))}
                depth={depth}
                unreceivedLayout={unreceivedLayout}
                expandKey={null}
                expanded={expanded}
                onToggle={toggle}
                onFocus={focusHandlerFor(pref, st.name)}
              />
            )
            // 区域の行と配下（市町村・観測点）。県の下では depth 1、県を引けない区域
            // （→ `IntensityOrphanRegionRow`）は最上段なので depth 0 から始める。
            // `pref` は観測点の寄り先を引くのに使う（県を引けない区域では空）。
            const regionTree = (region: IntensityRegionRow, depth: 0 | 1, pref: string) => (
              <Fragment key={region.name}>
                <IntensityRow
                  label={region.name}
                  scale={region.scale}
                  unreceived={region.unreceived}
                  hasUnreceived={region.hasUnreceived}
                  mark={rowMark(rowMarkKey.area(region.name), regionDescendantKeys(region))}
                  depth={depth}
                  unreceivedLayout={unreceivedLayout}
                  expandKey={region.cities.length > 0 || region.stations.length > 0 ? `area:${region.name}` : null}
                  expanded={expanded}
                  onToggle={toggle}
                  onFocus={focusBoundsHandler(areaBounds.get(region.name) ?? null)}
                />
                <Reveal open={expanded.has(`area:${region.name}`)}>{() => (<>
                    {region.cities.map(city => (
                      <div key={city.name}>
                        <IntensityRow
                          label={city.name}
                          scale={city.scale}
                          unreceived={city.unreceived}
                          unreceivedIsOwn={city.unreceived}
                          hasUnreceived={city.hasUnreceived}
                          mark={rowMark(rowMarkKey.city(region.name, city.name), city.stations.map(st => rowMarkKey.station(st.name)))}
                          depth={(depth + 1) as 1 | 2}
                          unreceivedLayout={unreceivedLayout}
                          expandKey={city.stations.length > 0 ? `city:${region.name}/${city.name}` : null}
                          expanded={expanded}
                          onToggle={toggle}
                          onFocus={focusCityHandler(pref, city.stations)}
                        />
                        <Reveal open={expanded.has(`city:${region.name}/${city.name}`)}>{() => (<>{city.stations.map(st => stationRow(st, (depth + 2) as 2 | 3, pref))}</>)}</Reveal>
                      </div>
                    ))}
                    {/* 市町村に紐付かない観測点（市町村を読めなかった観測点）。
                        → `IntensityRegionRow.stations` */}
                    {region.stations.map(st => stationRow(st, (depth + 1) as 1 | 2, pref))}
                  </>)}</Reveal>
              </Fragment>
            )

            const groupKey = (row: typeof prefGroups[number]) => row.kind === 'pref' ? `pref:${row.pref}` : `area:${row.name}`
            return (
              <div className="quake-ints border-t border-border/60">
                {/* 塊ごとに子は 2 つ（見出しの行・開いた中身）。広い画面ではこの 2 段で左右をそろえる（→ index.css） */}
                {prefGroups.map(row => (
                  <div key={groupKey(row)}>
                    {row.kind === 'area' ? regionTree(row, 0, '') : (
                      <>
                        <IntensityRow
                          label={row.pref}
                          scale={row.scale}
                          unreceived={row.unreceived}
                          hasUnreceived={row.hasUnreceived}
                          mark={rowMark(rowMarkKey.pref(row.pref), [
                            ...row.regions.flatMap(r => [rowMarkKey.area(r.name), ...regionDescendantKeys(r)]),
                            ...row.cities.map(c => rowMarkKey.city('', c.name)),
                            ...row.stations.map(st => rowMarkKey.station(st.name)),
                          ])}
                          depth={0}
                          unreceivedLayout={unreceivedLayout}
                          expandKey={row.regions.length > 0 || row.cities.length > 0 || row.stations.length > 0 ? `pref:${row.pref}` : null}
                          expanded={expanded}
                          onToggle={toggle}
                          onFocus={focusBoundsHandler(prefBounds.get(row.pref) ?? null)}
                        />
                        <Reveal open={expanded.has(`pref:${row.pref}`)} className="quake-sub" style={{ borderLeftColor: getIntensityColor(row.scale) }}>{() => (<>
                            {row.regions.map(region => regionTree(region, 1, row.pref))}
                            {/* 区域が決まらない市町村（見出しにだけある市町村）。観測点と同じく県の直下へ置く */}
                            {row.cities.map(city => (
                              <IntensityRow
                                key={`city:${city.name}`}
                                label={city.name}
                                scale={city.scale}
                                unreceived={city.unreceived}
                                unreceivedIsOwn={city.unreceived}
                                hasUnreceived={city.hasUnreceived}
                                mark={rowMark(rowMarkKey.city('', city.name))}
                                depth={1}
                                unreceivedLayout={unreceivedLayout}
                                expandKey={null}
                                expanded={expanded}
                                onToggle={toggle}
                                onFocus={focusCityHandler(row.pref, city.stations)}
                              />
                            ))}
                            {/* 区域を引けない観測点（県は分かっている）。長周期の一覧と同じく県の直下へ置く */}
                            {row.stations.map(st => stationRow(st, 1, row.pref))}
                          </>)}</Reveal>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )
          })()}
        </div>

        {/* 長周期地震動（電文の値・一覧・補足）。地図の塗りは上の切り替えで出す */}
        {lpgmShown && (
          <div ref={lpgmSectionRef} className="mt-1.5 flex flex-col gap-1">
            <h4 className="m-0 flex items-center gap-2 font-semibold text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>
              長周期地震動
              {/* 長周期の電文が名乗る運用種別。訓練・試験のときだけ、地震カードと同じ札を出す（2026-11-03 ユーザー選択
                  「地震カードと同じ札を出す (Recommended)」。新しい文言は足さない） */}
              {lpgm?.operationStatus && (
                <span className="rounded-sm px-1.5 font-bold" style={{ backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}>
                  {lpgm.operationStatus}報
                </span>
              )}
            </h4>
          {/* 震源・規模・全国の最大震度・地震発現時刻は、この欄には出さない。発表が最も新しい報の値をカードの上段へ当てている
              （→ `utils/latestQuakeFacts.ts`。2026-11-03 ユーザー選択「発表時刻が最も新しい報 (Recommended)」の説明
              「長周期の欄の震源の行は外し」）。見出し文（`Head/Headline/Text`）は長周期のことなので電文のまま出す */}
          {lpgm && !lpgm.cancelled && lpgm.headline && (<div className="text-[#cfd6dd]">{lpgm.headline}</div>)}
          {/* 電文の「観測情報の種類」（`LgCategory`）が伝えているのは、階級を観測した地域の中に
              震度が小さい地域があるかどうか。**分類番号は出さず意味だけ書く**（→ `lpgmCategoryNote`）。
              **この一文だけは畳まない。** 1 行しかないうえ、その地震でしか言えない事実で、
              下の折りたたみに入れても縮む量はほとんど変わらない。 */}
          {lpgm && !lpgm.cancelled && categoryNote && (
            <div className="text-secondary" style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
              {categoryNote}
            </div>
          )}
          {/* 気象庁からの補足は畳んで置く。中身は付加文 3 種 —— 固定（`ForecastComment/Text`。
              この地震について気象庁が添える定型文で、実電文では緊急地震速報の発表の有無を
              伝えている）・その他の固定（`VarComment/Text`）・自由（`FreeFormComment`。階級ごとの
              揺れの言い換え）—— と、気象庁の詳細ページ（`Comments/URI`）への導線。

              **地震情報の補足と同じく既定で畳み、読み上げのあいだだけ開く**（2026-11-01 選択「畳んで、
              読み上げで開く (Recommended)」。→ docs/spec/quake-spec.md §8「気象庁からの補足は畳んで置く」）。

              **「解説」の語を使わない。** 南海トラフ地震関連解説情報のバナーと同じ画面に並ぶため、
              語幹が被ると別の情報だと読み取れない。

              開閉は `<div role="button">` で作る（カード自体が `<button>` なので入れ子にできない。
              震度一覧の行と同じ作法）。 */}
          {/* **アプリが出せないもの（波形・スペクトル）の在りかを電文自身が示している**ので、
              詳細ページ（`Comments/URI`）への導線を補足の末尾に残す。自由付加文も同じ URL を
              文中で案内しているため、畳む単位は付加文 3 種と導線で 1 つにまとめている。 */}
          {hasLpgmNotes && lpgm && !lpgm.cancelled && (
            <JmaNotesFold
              open={lpgmNotesOpen}
              onToggle={() => setLpgmNotesOpenByUser(!lpgmNotesOpen)}
              groups={lpgmComments.groups}
              showHeadings={lpgmComments.showHeadings}
              extra={lpgm.uri && (
                <a
                  href={lpgm.uri}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-blue-400 underline w-fit"
                  style={{ overflowWrap: 'anywhere' }}
                >
                  気象庁の詳細ページ（波形・スペクトル）
                </a>
              )}
            />
          )}

          {lpgmGroups.length > 0 && (() => {
              // 観測点の行。内訳を持つ観測点は開けて、開くと周期ごとの内訳を出す（→ `LpgmPeriodList`）。
              // 開閉があると行を押すのは開閉になり、地図への寄せは観測点名へ移る（県・区域の行と同じ作法）。
              // 開閉の鍵は県と区域で区切る（区域の分からない観測点は区域を空にする）。同じ名前の観測点が
              // 別の区域・県にあっても、片方を開いたらもう片方まで開く、ということが起きないように
              const lpgmStationNode = (st: LpgmStationRow, prefName: string, areaName: string, depth: 1 | 2) => {
                const stationKey = st.periods ? `lpgm:station:${prefName}:${areaName}:${st.name}` : null
                return (
                  <Fragment key={st.name}>
                    <LpgmRow
                      label={st.name}
                      lgInt={st.lgInt}
                      int={st.int}
                      nonJma={st.nonJma}
                      mark={lpgmRowMark(rowMarkKey.station(st.name))}
                      depth={depth}
                      expandKey={stationKey}
                      expanded={expanded}
                      onToggle={toggle}
                      onFocus={focusHandlerFor(prefName, st.name)}
                    />
                    <Reveal open={!!stationKey && !!st.periods && expanded.has(stationKey)}>{() => (<>{st.periods && <LpgmPeriodList periods={st.periods} depth={depth} />}</>)}</Reveal>
                  </Fragment>
                )
              }
              return (
                <div className="quake-ints border-t border-border/60">
                  {/* 最上段は都道府県か、都道府県を引けなかった区域（→ `LpgmPrefRow.kind`）。
                      **鍵に段の種別を入れる** —— 区域名と県名は一致しうる（実データの「奈良県」）。 */}
                  {lpgmGroups.map(prefRow => {
                    const topKey = `lpgm:${prefRow.kind}:${prefRow.name}`
                    return (
                    <div key={topKey}>
                      <LpgmRow
                        label={prefRow.name}
                        lgInt={prefRow.maxLgInt}
                        int={prefRow.maxInt}
                        mark={lpgmRowMark(rowMarkKey.pref(prefRow.name), [
                          ...prefRow.areas.flatMap(a => [rowMarkKey.area(a.name), ...a.stations.map(st => rowMarkKey.station(st.name))]),
                          ...prefRow.stations.map(st => rowMarkKey.station(st.name)),
                        ])}
                        depth={0}
                        expandKey={prefRow.areas.length > 0 || prefRow.stations.length > 0 ? topKey : null}
                        expanded={expanded}
                        onToggle={toggle}
                        onFocus={focusBoundsHandler(prefBounds.get(prefRow.name) ?? null)}
                      />
                      <Reveal open={expanded.has(topKey)} className="quake-sub" style={{ borderLeftColor: getLpgmClassColor(prefRow.maxLgInt) }}>{() => (<>
                          {prefRow.areas.map(area => (
                            <div key={area.name}>
                              <LpgmRow
                                label={area.name}
                                lgInt={area.maxLgInt}
                                int={area.maxInt}
                                mark={lpgmRowMark(rowMarkKey.area(area.name), area.stations.map(st => rowMarkKey.station(st.name)))}
                                depth={1}
                                expandKey={area.stations.length > 0 ? `lpgm:area:${area.name}` : null}
                                expanded={expanded}
                                onToggle={toggle}
                                onFocus={focusBoundsHandler(areaBounds.get(area.name) ?? null)}
                              />
                              <Reveal open={expanded.has(`lpgm:area:${area.name}`)}>{() => (<>{area.stations.map(st => lpgmStationNode(st, prefRow.name, area.name, 2))}</>)}</Reveal>
                            </div>
                          ))}
                          {/* 区域が分からない観測点（→ `LpgmPrefRow.stations`）。 */}
                          {prefRow.stations.map(st => lpgmStationNode(st, prefRow.name, '', 1))}
                        </>)}</Reveal>
                    </div>
                    )
                  })}
                </div>
              )
          })()}
          </div>
        )}


        <div className="mt-1.5">
          {/* 自作地震計が捉えたこの地震の区間（→ `useSeismoQuakeWaves`）。
              **記録が無ければ枠ごと出ない** —— 渡ってくるのは載せるものがあるときだけ。
              ライブで読み返せなかったときだけ、その旨を 1 行出す（`seismoWaveFailed`）。 */}
          {seismoWaveFailed && (seismoWaves === undefined || seismoWaves.length === 0) && (
            <div className="text-xs text-secondary mt-1">{SEISMO_WAVE_FAILED_TEXT}</div>
          )}
          <QuakeSeismoWave
            waves={seismoWaves ?? []}
            view={seismoWaveView}
            quakeLabel={`${formatQuakeTimeLabeled(earthquake.time)} ${epicenterLabel}`}
          />
        </div>

        {/* 官署（2026-11-01 ユーザー選択「官署を別の行へ (Recommended)」・2026-10-30 選択「編集官署の隣に同じ形で (Recommended)」）。
            電文を編集した官署は常に出す（2026-10-22 ユーザー承認「3-B 編集官署 …」・docs/spec/quake-spec.md §8）。 */}
        {(issue.editorialOffice || issue.publishingOffice) && (
          <div className="mt-4 flex flex-wrap items-center gap-x-2 text-secondary" style={{ fontSize: 'var(--qk-fs)' }}>
            {issue.editorialOffice && <span className="whitespace-nowrap">編集官署 {issue.editorialOffice}</span>}
            {issue.publishingOffice && <span className="whitespace-nowrap">発表官署 {issue.publishingOffice}</span>}
          </div>
        )}
      </div>
    )
  }

  /* 非選択時：一覧の 1 行（見本 closed5。→ `QuakeListRow`） */
  return (
    <button
      ref={rowRef}
      {...{ [QUAKE_CARD_KEY_ATTR]: eventKey }}
      type="button"
      // 選んだまま畳んだ行は、押すと開き直すだけ（地図は動かさない）
      onClick={quake.cancelledAt ? undefined : () => {
        resizeFromRef.current = rowRef.current?.getBoundingClientRect().height ?? null
        if (selected) setCollapsed(false)
        else onSelect?.(eventKey)
      }}
      // 選んでいることは aria-current で伝える（押すと開き直すだけなので、押した状態の札にはしない）
      aria-current={selected ? 'true' : undefined}
      aria-expanded={false}
      // `isolate`: 取消の覆い（z-10）を行の中に閉じる（理由は開いたカードの箱と同じ）
      className={`relative isolate block w-full border-b border-border text-left transition-colors ${quake.cancelledAt ? 'cursor-default' : 'cursor-pointer hover:bg-white/5 quake-press-row'}`}
      // 選んだまま畳んだ行は、見本 opened.html の選ばれた行（.r.sel）の形で出す
      style={{ padding: '7px var(--qk-pad)', ...(selected ? { backgroundColor: '#16191d', boxShadow: `inset 3px 0 0 ${getIntensityColor(maxScale)}` } : {}) }}
    >
      {quake.cancelledAt && <QuakeCancelOverlay cancelText={quake.cancelText} compact fade={fadeCancel} />}
      {listRowFor(false)}
    </button>
  )
})
