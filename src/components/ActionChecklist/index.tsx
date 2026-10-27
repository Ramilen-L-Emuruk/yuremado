// 地震の直後に出す行動チェックリスト。
//
// 【なぜ画面の上に出すか】下端は特別情報バナー（`SpecialInfoBanner`）が使っており、あちらは
// `:last-child` で下端の余白を付けているため子を足せない。加えてこれは「いま動くための情報」で、
// 揺れの最中に届くこともある。目に入る位置を優先して上端へ置く。左上・右上に重ねたものと重ならない
// よう、その下（外枠の上の余白。`WRAPPER_CLASS`）から始める（地図が低いときを除く。→ `checklistTopPadding`）。地図が低いときは下端の帯と
// 地図の高さを分け合い、中でスクロールする（置き場所は `App` の地図に重ねる縦並び）。
//
// **上の余白は固定にしない。** 左上の列は異常の行（取得状況・描画の不調・地震計の繋がり・更新の札）で、
// 右上は観測点 1 つにつき 1 行で縦に伸びる。
//
// 【畳んだ状態で 3 つだけ見せる】揺れた直後に読めるのはせいぜいそのくらい。残りは開いてもらう。

import { useState } from 'react'
import { log } from '../../utils/logger'
import {
  IMMEDIATE_ACTIONS,
  EMERGENCY_KIT,
  CHECKLIST_SOURCES,
  COLLAPSED_ACTION_COUNT,
} from '../../utils/actionChecklist'
import { getIntensityLabel } from '../../utils/intensity'
import type { ChecklistScope } from '../../utils/actionChecklistTrigger'
import { NEARBY_RADIUS_KM } from '../../utils/nearbyStations'

/** どの経路で出たか。文言を変えるために持つ。 */
export type ChecklistReason = 'eew' | 'kyoshin' | 'quake'

interface Props {
  reason: ChecklistReason
  /** 判定のもとになった震度階級（気象庁の値）。 */
  scale: number
  /**
   * 実際にどの範囲で判定したか（→ `ChecklistScope`）。見出しの言い回しと、見出しの下の 1 行に使う。
   * **地点を登録しているかではない** —— 地点があっても全国基準へ倒れることがある。
   */
  scope: ChecklistScope
  /** 畳んでいるか。true なら小さなボタンだけを出す。 */
  collapsed: boolean
  onDismiss: () => void
  onRestore: () => void
  /**
   * 地図の上端から、上の隅の列の下端＋隙間までの高さ（px）。帯はここから始める（→ `WRAPPER_CLASS` の注記）。
   */
  topInset: number
  /** 地図の高さ（px）。上の余白の上限に使う。測れていなければ `null`（上限を掛けない）。 */
  areaHeight: number | null
  /** 地図の下端側にいま出ているもの（上限で残す高さを決める）。 */
  below: ChecklistBelow
}

/**
 * 見出し。**EEW だけ地点の有無で言い分ける。**
 *
 * 「来ます」は読み手のところへ揺れが向かうという意味になるため、全国のどこかで予想が出ている
 * だけの状態で使うと嘘になる。一方「観測しています」「ありました」は場所を主張しない事実の
 * 記述なので、地点が無くてもそのまま成り立つ。
 */
const HEADLINE: Record<ChecklistReason, { scoped: string; global: string }> = {
  eew: { scoped: '強い揺れが来ます', global: '強い揺れが予想されています' },
  kyoshin: { scoped: '強い揺れを観測しています', global: '強い揺れを観測しています' },
  quake: { scoped: '強い揺れがありました', global: '強い揺れがありました' },
}

/**
 * 帯の見出し。**判定に実際に使った範囲で言い分ける** —— ホーム地点の周りで判定したとき（`near`・`nearArea`・`nearDetected`）だけ
 * 場所を主張する言い方にし、全国基準へ倒れたとき・地点が無いとき（`nationwide`）は場所を主張しない言い方にする。
 */
export function checklistHeadline(reason: ChecklistReason, scope: ChecklistScope): string {
  return scope !== 'nationwide' ? HEADLINE[reason].scoped : HEADLINE[reason].global
}

/**
 * 見出しの下に添える 1 行。どの経路の・どの範囲の値で出したかを短く言う
 * （2026-10-25 ユーザー選択「この文面で直す (Recommended)」）。
 */
const SOURCE_LABEL: Record<ChecklistReason, string> = {
  eew: '緊急地震速報',
  kyoshin: '強震モニタ',
  quake: '地震情報',
}

export function checklistBasisText(reason: ChecklistReason, scope: ChecklistScope): string {
  const source = SOURCE_LABEL[reason]
  if (scope === 'nationwide') return `${source}・全国の最大`
  if (reason === 'eew') {
    return scope === 'nearDetected'
      ? `${source}・ホーム地点から ${NEARBY_RADIUS_KM}km 以内で検知`
      : `${source}・ホーム地点の地域の予想`
  }
  if (reason === 'kyoshin') return `${source}・ホーム地点から ${NEARBY_RADIUS_KM}km 以内`
  // 区域の点（震度速報など）で判定したときは、円ではなく区域名の一致で引いている（2026-10-25 選択「観測点と区域で分ける」）
  if (scope === 'nearArea') return `${source}・ホーム地点の地域`
  return `${source}・ホーム地点から ${NEARBY_RADIUS_KM}km 以内の観測点`
}

/**
 * 帯と畳んだボタンで共有する外枠。
 *
 * **自分では絶対配置しない。** 置き場所は呼び出し側（`App`）が持つ縦並びで、下端の凡例・
 * 特別情報バナーと地図の高さを分け合う。ここで `absolute` や画面基準の上限（`dvh`）を持つと、
 * 地図が低いときに下端の帯とぶつかる。
 *
 * 上の余白（`topInset`）: 地図の上の隅の列（更新時刻・自作地震計の帯ほか）の下から始める。
 * 隅の列は異常の行や観測点の数で縦に伸びるので、固定の値では足りない —— `App` が列の下端を測って渡す。
 * 3rem を下限にするのは、隅の列が 1 行のときの見え方を変えないため。**余白はこの外枠に持たせ、
 * `App` の縦並びの器には持たせない** —— 器に置くと、チェックリストが無いときも下端の帯から余白を奪う。
 *
 * 入れ子の `flex-col`: 縦並びで縮められたとき、中の帯が縮んでスクロールできるようにする
 * （`max-h-full` では親の高さが確定しないことがあり、効かない）。
 */
const WRAPPER_CLASS = 'px-2 flex flex-col items-center'

/**
 * 開いた帯の外枠だけに置く下限。上の余白（`topInset`）＋ 見出し 1 行ぶん（2.5rem）。
 *
 * **下限は値で書く。** 縦並びの子は何も書かない（`auto`）と中身の高さで止まって縮まず、
 * `min-h-0` にすると見出しまで潰れて、地図がごく低いときに帯が黙って見えなくなる。
 * 畳んだボタンは縮ませない（`shrink-0`）ので要らない —— 付けるとボタンの下に透明な空白が残り、
 * 下端の帯の縮みしろを奪う。
 */
const HEADLINE_MIN_HEIGHT = '2.5rem'

/** 地図の下端側にいま出ているもの。上の余白の上限を、出ているものの分だけ残して決める。 */
export interface ChecklistBelow {
  /** 凡例。`min-h-0` でも上の余白（0.6rem）までしか縮まない。 */
  legend: boolean
  /** 共有ボタンの行（チェックリストが出ている間は 2.75rem）。 */
  shareRow: boolean
  /** 共有ボタンの行が画面の下端に付く（スマホの横画面ではホームインジケータ分だけ高くなる）。 */
  shareRowAtScreenBottom: boolean
  /** 特別情報バナー。見出し 1 行（2.5rem）より縮まない。 */
  banner: boolean
}

/** 下側へ残す高さ（rem）。帯自身の見出し 1 行（2.5rem）に、出ているものの縮まない分を足す。 */
export function checklistBottomReserveRem(below: ChecklistBelow): number {
  return 2.5 + (below.legend ? 0.6 : 0) + (below.shareRow ? 2.75 : 0) + (below.banner ? 2.5 : 0)
}

/**
 * 下側へ残す高さ（CSS の長さ）。共有ボタンの行が画面の下端に付くときは、行が高くなる分
 * （`shareButtonRowHeightClass` と同じ「ホームインジケータ − 0.5rem」）も残す。この分は横画面以外でも足すので、
 * ホームインジケータのある縦画面ではその分だけ多めに残る（重なりを許す側には倒れない）。
 */
function bottomReserve(below: ChecklistBelow): string {
  const rem = `${Number(checklistBottomReserveRem(below).toFixed(2))}rem`
  return below.shareRow && below.shareRowAtScreenBottom && !below.banner
    ? `${rem} + max(0px, env(safe-area-inset-bottom, 0px) - 0.5rem)`
    : rem
}

let warnedNonFinite = false

/**
 * 上の余白。隅の列が 1 行のとき（下端は上から約 34px）と同じ 3rem を下限にする。
 *
 * **上限は「地図の高さ − 下側へ残す高さ」。** 隅の列が高く地図が低いと、隅の下から始めるだけで帯の下限が地図を
 * 使い切り、下端の特別情報バナーが地図の外へ押し出される。そのときは帯が隅の列の下のほうに重なるのを受け入れ、
 * バナーの見出しを残す（2026-10-27 ユーザー選択「バナーを優先 (Recommended)」）。
 *
 * 非有限の値をそのまま `px` にすると宣言ごと捨てられ、余白が 0 になって黙って隅の列に重なる。0 として扱い、記録する。
 */
export function checklistTopPadding(topInset: number, areaHeight: number | null, below: ChecklistBelow): string {
  let inset = topInset
  if (!Number.isFinite(inset)) {
    if (!warnedNonFinite) {
      warnedNonFinite = true
      log.warn('[layout] 行動チェックリストの上の余白に数でない値が渡された（下限の 3rem で出す）', { topInset })
    }
    inset = 0
  }
  if (areaHeight === null || !Number.isFinite(areaHeight)) return `max(3rem, ${inset}px)`
  // 残す高さは足し算になりうるので、括弧で包んでから引く（包まないと足した分の符号が逆になる）
  return `max(3rem, min(${inset}px, ${areaHeight}px - (${bottomReserve(below)})))`
}

/**
 * 震度の見せ方。**強震モニタ経路だけ指標名を添える。**
 *
 * この経路が見ているのは強震モニタのリアルタイム震度で、気象庁が発表する計測震度とは別の指標。
 * 揺れの継続時間まで見る計測震度に対して 1〜2 秒の窓で出す速報値なので、**同じ地震でも高く振れる**
 * （実測: 発表が震度1 の地震の震源から 8km で 5弱相当、発表6強 の地震で震度7相当）。「震度7」と
 * だけ書くと、同じ画面の地震カードに出ている発表震度と食い違って見える。
 *
 * 名前は横に伸ばさず上へ小さく乗せる。「リアルタイム震度5弱」を 1 行で書くと帯と畳んだボタンが
 * 間延びして地図を覆う。緊急地震速報は予想値・地震情報は発表値なので、そちらは「震度○」のまま。
 */
function ScaleText({ reason, label }: { reason: ChecklistReason; label: string }) {
  if (reason !== 'kyoshin') return <>震度{label}</>
  return (
    <>
      <span className="block text-[0.65em] leading-tight opacity-90">リアルタイム</span>
      震度{label}
    </>
  )
}

/** 読み上げ・`aria-label` 用の文字列。表示（`ScaleText`）と同じ内容を 1 行で言う。 */
function scaleAriaText(reason: ChecklistReason, label: string): string {
  return reason === 'kyoshin' ? `リアルタイム震度${label}` : `震度${label}`
}

/**
 * 震度の表示に確保する幅（「震度5弱」の 4 文字ぶん）。
 *
 * 震度ラベルは階級によって 1〜2 文字で揺れる（「7」と「6弱」）。成り行きの幅にすると、揺れが
 * 強まって階級が上がるたびに帯とボタンの幅が動く。**強震モニタ経路では毎秒変わりうる**ので、
 * 常に最大幅を確保して動かないようにする。`em` はフォントサイズ基準なので UI 倍率にも追従する。
 *
 * 上に乗る「リアルタイム」は 0.65em × 6 文字 = 約 3.9em なので、この幅に収まる。
 *
 * バッジ側は `box-sizing: border-box` で左右のパディング（`px-1.5` = 0.75rem）も幅に含まれるため、
 * その分を足す。
 */
const SCALE_WIDTH_BADGE = 'text-center min-w-[calc(4em+0.75rem)]'
const SCALE_WIDTH_PLAIN = 'inline-block text-center min-w-[4em]'

function CloseIcon() {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    >
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 畳んだボタンの目印。チェックの付いた紙で「読むもの」だと分かるようにする。 */
function ChecklistIcon() {
  return (
    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" strokeLinecap="round" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 14l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ActionChecklist({ reason, scale, scope, collapsed, onDismiss, onRestore, topInset, areaHeight, below }: Props) {
  const [open, setOpen] = useState(false)
  const [kitOpen, setKitOpen] = useState(false)

  const shown = open ? IMMEDIATE_ACTIONS : IMMEDIATE_ACTIONS.slice(0, COLLAPSED_ACTION_COUNT)
  const label = getIntensityLabel(scale)

  // 畳んだ状態。**消さずにボタンを残す** —— 余震のたびに帯が出直すのは邪魔だが、読み返したく
  // なることはある。震度を添えるのは、畳んでいる間に届いた揺れの大きさが分かるようにするため。
  if (collapsed) {
    return (
      <div className={`${WRAPPER_CLASS} shrink-0`} style={{ paddingTop: checklistTopPadding(topInset, areaHeight, below) }}>
        <button
          className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-950/90 border border-red-400/80 shadow-lg text-white/90 hover:text-white hover:bg-red-900/90"
          onClick={onRestore}
          aria-label={`${scaleAriaText(reason, label)}の行動チェックリストを開く`}
        >
          <ChecklistIcon />
          <span className="text-xs font-bold whitespace-nowrap">
            <span className={SCALE_WIDTH_PLAIN}><ScaleText reason={reason} label={label} /></span> 行動チェック
          </span>
        </button>
      </div>
    )
  }

  return (
    <div
      className={WRAPPER_CLASS}
      style={{ paddingTop: checklistTopPadding(topInset, areaHeight, below), minHeight: `calc(${checklistTopPadding(topInset, areaHeight, below)} + ${HEADLINE_MIN_HEIGHT})` }}
    >
      {/* w-fit で中身の幅に合わせる。畳んだ状態は 3 行しかないので、固定幅にすると横に間延びして
          地図を無駄に覆う。展開すれば中身が増えて自然に広がり、max-w-2xl で頭打ちにする。 */}
      <div className="pointer-events-auto w-fit max-w-2xl min-h-0 max-h-[70dvh] overflow-y-auto overflow-x-hidden overscroll-x-none rounded-lg bg-red-950/95 border-2 border-red-400 shadow-lg">
        <div className="px-3 py-2 flex items-start gap-2">
          {/* 判定の根拠は見出しの下に 1 行だけ。仕組みの説明は設定の窓の「出す最低震度」の項目に置いてある。 */}
          <div className="min-w-0 flex-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
            <span className={`text-xs font-bold text-white px-1.5 py-0.5 rounded-sm bg-red-500 shrink-0 ${SCALE_WIDTH_BADGE}`}>
              <ScaleText reason={reason} label={label} />
            </span>
            <span className="text-white text-sm font-bold leading-tight">
              {checklistHeadline(reason, scope)}
            </span>
            <span className="basis-full text-white/70 text-xs leading-tight">{checklistBasisText(reason, scope)}</span>
          </div>
          <button
            className="text-white/70 hover:text-white p-1 -m-1 shrink-0"
            onClick={onDismiss}
            aria-label="チェックリストを閉じる"
          >
            <CloseIcon />
          </button>
        </div>

        <ol className="px-3 pb-1 space-y-1.5">
          {shown.map((item, i) => (
            <li key={item.text} className="flex gap-2">
              <span className="text-red-300 text-sm font-bold shrink-0 tabular-nums">{i + 1}.</span>
              <div className="min-w-0">
                <p className="text-white text-sm font-bold leading-tight">{item.text}</p>
                {item.detail && open && (
                  <p className="text-white/70 text-xs leading-relaxed mt-0.5">{item.detail}</p>
                )}
              </div>
            </li>
          ))}
        </ol>

        <button
          className="w-full px-3 py-1.5 flex items-center justify-center gap-1 text-white/80 hover:text-white text-xs"
          onClick={() => setOpen(v => !v)}
        >
          {open ? '閉じる' : `続きを見る（全 ${IMMEDIATE_ACTIONS.length} 項目）`}
          <ChevronIcon open={open} />
        </button>

        {open && (
          <div className="px-3 pb-2">
            <button
              className="w-full py-1.5 flex items-center justify-between gap-2 text-left border-t border-red-400/40"
              onClick={() => setKitOpen(v => !v)}
            >
              <span className="text-white text-sm font-bold">避難するとき持ち出すもの</span>
              <ChevronIcon open={kitOpen} />
            </button>
            {kitOpen && (
              <div className="space-y-1.5 pb-1">
                <p className="text-white/70 text-xs leading-relaxed">
                  両手が空くリュックにまとめ、軽くコンパクトに。持病の薬・杖・乳幼児用品など、
                  必要なものは各自で足してください。
                </p>
                {EMERGENCY_KIT.map(group => (
                  <div key={group.label}>
                    <p className="text-red-300 text-xs font-bold">{group.label}</p>
                    <p className="text-white/90 text-xs leading-relaxed">{group.items.join('・')}</p>
                  </div>
                ))}
              </div>
            )}
            <p className="text-white/50 text-xs leading-relaxed border-t border-red-400/40 pt-1.5 mt-1">
              出典:{' '}
              {CHECKLIST_SOURCES.map((s, i) => (
                <span key={s.url}>
                  {i > 0 && '／'}
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-white/80">
                    {s.label}
                  </a>
                </span>
              ))}
              。実際の避難は気象庁・自治体の指示に従ってください。
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
