import { useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { getIntensityColor, getIntensityBgColor, getDepthColor, getMagnitudeColor } from '../../utils/intensity'
import { getLpgmClassColor, getLpgmClassLabel } from '../../utils/lpgm'
import type { QuakeListSort, QuakeSortKey } from '../../utils/quakeListView'

/**
 * 地震一覧の閉じた行（見本 closed5。→ docs/quake-tab-redesign.md「決まっていること」）。
 *
 * 左に震度の枠（長周期の階級があれば下端に帯）、上の段に情報名・札・津波、下の段に時刻・震央地名・規模・深さ。
 * **改行はしない**（2026-11-01「最大まで長くなっても改行はしないようにしたいですね。」）。それでも入らない
 * ときだけ、札を 1 段下げる・規模と深さを 1 段下げる（はみ出しを測って切り替える）。
 *
 * スマホ幅の開いたカードで上に貼りつく帯も、この行と同じ作りを使う（2026-11-02 選択「畳んだ行の帯」）。
 */
export interface QuakeListRowProps {
  /**
   * 長周期の札を Tab で止まれるようにするか。狭い画面の帯でだけ真（帯の中で札を押すと長周期の節へ巻く。
   * → `QuakeOpenPin` の `onLpgmActivate`）。閉じた行では行全体が 1 つのボタンなので止めない。
   */
  lpgmTabbable: boolean
  /** 震度の色を引く値（`maxScale`。不明は -1）。 */
  scale: number
  /** 枠に出す震度の文字（例「5弱」「?」）。 */
  scaleLabel: string
  /** 「以上」を添えるか（最大震度が 5弱以上・未入電）。 */
  orAbove: boolean
  /** 長周期地震動の最大階級（無ければ null）。 */
  lpgmClass: number | null
  /** 上の段の情報名（色分けした要素を渡す）。 */
  heading: ReactNode
  /** 上の段の札（訓練報・訂正）。 */
  chips: ReactNode
  /** 津波の文と色。null なら出さない（国際津波関連情報だけのカード。英文に国内の津波の区分は無い）。 */
  tsunami: { text: string; color: string; title?: string } | null
  /**
   * 上の段の情報名の後ろに添える日付（「11/07」）。時刻以外で並べたときだけ渡し、時刻順は null
   * （時刻順は日付の区切りがあるので要らない。2026-11-07 ユーザー選択「上の段に出す (Recommended)」）。
   */
  date: string | null
  /** 時刻（HH:MM）。 */
  time: string
  /** 震央地名。 */
  name: string
  /** 規模の文（説明つき）。null なら規模の欄を空ける。 */
  magnitude: { text: string; value: number } | null
  /** 深さの文。null なら深さの欄を空ける。 */
  depth: { text: string; value: number } | null
}

/** 行と同じ列の割り付け（見出しの行と閉じた行で揃える）。 */
const LIST_COLUMNS = 'var(--qk-tile-w) var(--qk-col-t) 1fr minmax(var(--qk-col-m), max-content) var(--qk-col-d)'

/** 見出しの列と、押したときの並べ替えの欄（2026-11-07 ユーザー原文「すべて昇順降順は選べるようにしたい。」）。 */
const HEADER_COLUMNS: readonly { key: QuakeSortKey; label: string; right: boolean; asc: string; desc: string }[] = [
  { key: 'scale', label: '震度', right: false, asc: '小さい順', desc: '大きい順' },
  { key: 'time', label: '時刻', right: false, asc: '古い順', desc: '新しい順' },
  // 震央地名コードの順。コードは北の地方から振られている（遠地は最後）
  { key: 'region', label: '震央地名', right: false, asc: '北から順', desc: '南から順' },
  { key: 'magnitude', label: '規模', right: true, asc: '小さい順', desc: '大きい順' },
  { key: 'depth', label: '深さ', right: true, asc: '浅い順', desc: '深い順' },
]

/**
 * 一覧の先頭の列の見出し（見本の .hdr）。**押すとその欄で並べ替え、もう一度押すと向きを返す**（→ `nextQuakeListSort`）。
 * 並べている欄には向きの印（▲ 小さい順・▼ 大きい順）を添える。
 */
export function QuakeListHeader({ sort, onSort }: { sort: QuakeListSort; onSort: (key: QuakeSortKey) => void }) {
  return (
    // 巻いても上に残す（日付の区切りがこの下に、開いたカードの帯・枠はさらにその下に貼りつく。高さは index.css の --qk-head-h）
    <div
      className="sticky top-0 z-[4] grid items-center border-b border-border bg-panel text-[11px] text-secondary"
      style={{ gridTemplateColumns: LIST_COLUMNS, columnGap: 'var(--qk-gap)', padding: '0 var(--qk-pad)', height: 'var(--qk-head-h)' }}
    >
      {HEADER_COLUMNS.map(c => {
        const on = sort.key === c.key
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={on}
            // 並べている欄だけ向きを読み上げに伝える（▲▼ は読ませない。2026-11-07 選択「向きを伝える (Recommended)」）
            aria-label={on ? `${c.label} ${sort.dir === 'asc' ? c.asc : c.desc}` : undefined}
            onClick={() => onSort(c.key)}
            className={`flex items-center gap-0.5 whitespace-nowrap hover:text-white ${c.right ? 'justify-end' : ''} ${on ? 'text-white' : ''}`}
          >
            {c.label}
            {on && <span aria-hidden="true" className="text-[9px]">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 日付の区切り（見本の .day）。巻いても一覧の見出しの行の下に貼りつき、次の日の区切りに押し上げられる
 * （束ねるのは `EarthquakeTab`。2026-11-05 ユーザー発言「普通にヘッダ(震度 時刻 震央地名 規模 深さ)の下に張り付くイメージ」）。
 * 高さは `--qk-day-h` で決め打つ（開いたカードの帯・枠はこの下に貼りつくので、高さが分かっていないと重なる）。
 * 地の色を敷くのは、下を流れる行が透けないようにするため。
 */
export function QuakeListDayLabel({ label }: { label: string }) {
  return (
    <div className="sticky z-[3] flex items-end border-b border-border/60 bg-app text-secondary" style={{ top: 'var(--qk-head-h)', height: 'var(--qk-day-h)', padding: '0 var(--qk-pad) 3px', fontSize: 'var(--qk-fs)' }}>
      {label}
    </div>
  )
}

/**
 * 震度の値（「5強」なら「5」と「強」）。数字はそのままの大きさで、「弱」「強」だけ小さく添える
 * （2026-11-03 選択「B2：縦に伸ばし中身は中央 (Recommended)」。見本の案 B は弱・強を数字の 0.55 倍で添える）。
 * 揺れ検知の「0未満」の「未満」も同じく 0.55 倍で添える（2026-11-05 ユーザー発言「未満だけ小さくしたら」、続く選択
 * 「数字の横に 0.55 倍 (Recommended)」）。
 * 値の本体（`data-tile-value`）は 1 つの要素のまま —— 「以上」はこれとは別の要素で添える（→ `maxScaleOrAbove`）。
 */
export function TileScaleLabel({ label }: { label: string }) {
  const m = /^(.*?)(弱|強|未満)$/.exec(label)
  return (
    <span data-tile-value className="whitespace-nowrap">
      {m ? <>{m[1]}<span style={{ fontSize: '0.55em' }}>{m[2]}</span></> : label}
    </span>
  )
}

/**
 * 震度の枠の色（開いたカードの大きな枠・閉じた行・帯の小さな枠で共通）。前の版の形：震度の濃い地に、
 * 震度の色の縁と白い字（2026-11-03 選択「Bがいいですが、正方形にしかできないの？」→「B2：縦に伸ばし中身は中央
 * (Recommended)」、小さな枠は「小さな枠もそろえる」）。
 */
export function quakeTileColors(scale: number): { backgroundColor: string; border: string; color: string } {
  return { backgroundColor: getIntensityBgColor(scale), border: `2px solid ${getIntensityColor(scale)}`, color: '#ffffff' }
}

export function QuakeListRow({ lpgmTabbable, scale, scaleLabel, orAbove, lpgmClass, heading, chips, tsunami, date, time, name, magnitude, depth }: QuakeListRowProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLSpanElement>(null)
  const headingRef = useRef<HTMLSpanElement>(null)
  const chipsRef = useRef<HTMLSpanElement>(null)
  // 入らないときだけ段を下げる。**描いてから測る**（文字の幅は字体と UI 倍率で変わるので、文字数では決められない）。
  const [dropChips, setDropChips] = useState(false)
  const [dropValues, setDropValues] = useState(false)
  /** 最後に測った中身と幅。どちらかが変わったら段を一度戻して測り直す。 */
  const measuredFor = useRef<string | null>(null)
  const [widthTick, bumpWidth] = useReducer((n: number) => n + 1, 0)
  // **描くたびに測る**（依存を置かない）。札と見出しは要素で渡されるので、中身が変わったかは描いた文字で見る。
  // 段を下げる側にしか動かさないので、下げた後の描き直しで測り直しても往復しない。
  useLayoutEffect(() => {
    const row = rowRef.current
    const top = topRef.current
    const nm = nameRef.current
    if (!row || !top || !nm) return
    const key = [
      widthTick, headingRef.current?.textContent, chipsRef.current?.textContent,
      tsunami?.text, name, magnitude?.text, depth?.text,
    ].join('|')
    if (key !== measuredFor.current) {
      measuredFor.current = key
      // 中身か幅が変わった: 一度戻し、戻した形で次の描き直しのときに測る（描く前なので画面には出ない）
      if (dropChips || dropValues) {
        setDropChips(false)
        setDropValues(false)
        return
      }
    }
    if (!dropChips && top.scrollWidth > top.clientWidth + 1) setDropChips(true)
    if (!dropValues && (row.scrollWidth > row.clientWidth + 1 || nm.scrollWidth > nm.clientWidth + 1)) setDropValues(true)
  })
  useLayoutEffect(() => {
    const row = rowRef.current
    // ResizeObserver の無い環境（テストの jsdom）では、描いたときだけ測る
    if (!row || typeof ResizeObserver === 'undefined') return
    let lastWidth = row.getBoundingClientRect().width
    const ro = new ResizeObserver(([entry]) => {
      // **幅が変わったときだけ**測り直す（広がったときに段を戻すため）。
      // 段を下げると行の高さも変わり見張りが鳴るが、それで戻すと入らずにまた下げ、毎フレーム往復して行が震える
      const width = entry.contentRect.width
      if (Math.abs(width - lastWidth) < 0.5) return
      lastWidth = width
      bumpWidth()
    })
    ro.observe(row)
    return () => ro.disconnect()
  }, [])

  // 段の割り振り（見本の .droptop / .drop と同じ）: 札を下げると時刻の段が 1 つ下がり、
  // 規模と深さを下げると、その下にもう 1 段できる。左の枠は全段にまたがる。
  const nameRow = dropChips ? 3 : 2
  const valueRow = dropValues ? nameRow + 1 : nameRow
  const tileSpan = valueRow
  return (
    <div
      ref={rowRef}
      className="grid items-center gap-y-[3px]"
      style={{
        gridTemplateColumns: LIST_COLUMNS,
        columnGap: 'var(--qk-gap)',
      }}
    >
      <div
        className="col-start-1 box-border flex flex-col items-center justify-center overflow-hidden rounded-[5px] font-black leading-none"
        style={{ gridRow: `1 / ${tileSpan + 1}`, width: 'var(--qk-tile-w)', height: 'var(--qk-tile-h)', ...quakeTileColors(scale) }}
      >
        <div data-tile className="flex flex-1 w-full flex-col items-center justify-center" style={{ fontSize: lpgmClass !== null ? 'calc(var(--qk-tile-f) - 3px)' : 'var(--qk-tile-f)' }}>
          <TileScaleLabel label={scaleLabel} />
          {orAbove && <small className={lpgmClass !== null ? 'text-[8.5px]' : 'mt-0.5 text-[10px]'}>以上</small>}
        </div>
        {lpgmClass !== null && (
          <div
            data-tile-lpgm
            tabIndex={lpgmTabbable ? 0 : undefined}
            className="flex h-[15px] w-full items-center justify-center text-[10.5px] font-bold tracking-[.02em] text-white"
            style={{ backgroundColor: getLpgmClassColor(lpgmClass), borderTop: '1px solid rgba(0,0,0,.35)' }}
          >
            {getLpgmClassLabel(lpgmClass).replace('階級', '長周期')}
          </div>
        )}
      </div>
      <div ref={topRef} className="col-start-2 col-end-6 row-start-1 flex min-h-[18px] items-center gap-1.5" style={{ fontSize: 'var(--qk-fs)' }}>
        <span ref={headingRef} className="min-w-0 flex-1 whitespace-nowrap">{heading}{date !== null && <span data-col="date" className="ml-1.5 tabular-nums text-secondary">{date}</span>}</span>
        {!dropChips && <span ref={chipsRef} className="contents">{chips}</span>}
        {tsunami && <span className="whitespace-nowrap font-bold" style={{ color: tsunami.color }} title={tsunami.title}>{tsunami.text}</span>}
      </div>
      {dropChips && (
        <div className="col-start-2 col-end-6 row-start-2 flex justify-end gap-1.5" style={{ fontSize: 'var(--qk-fs)' }}><span ref={chipsRef} className="contents">{chips}</span></div>
      )}
      <span data-col="time" className="col-start-2 tabular-nums text-secondary" style={{ gridRow: nameRow, fontSize: 'var(--qk-f)' }}>{time}</span>
      {/* 震央地名。規模と深さを下の段へ下げても欄に入らないときは、1 行のまま末尾を「…」で省き、全文は `title` で
          持たせる（2026-11-05 ユーザー選択「B 「…」で省く」。全文の出し方とスマホの扱いは docs/quake-tab-redesign.md の表）。
          省いても `scrollWidth` は全文の幅のままなので、段を下げる判定は変わらない */}
      <span ref={nameRef} title={name} className="col-start-3 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-bold text-white" style={{ gridRow: nameRow, fontSize: 'var(--qk-f)' }}>{name}</span>
      <span className="flex items-center justify-end gap-1.5 whitespace-nowrap tabular-nums" style={{ gridRow: valueRow, gridColumn: dropValues ? '3 / 5' : '4', fontSize: 'var(--qk-f)' }}>
        {magnitude && <><i className="inline-block h-[1.05em] w-1 rounded-[2px]" style={{ backgroundColor: getMagnitudeColor(magnitude.value) }} />{magnitude.text}</>}
      </span>
      <span className="col-start-5 flex items-center justify-end gap-1.5 whitespace-nowrap" style={{ gridRow: valueRow, fontSize: 'var(--qk-f)' }}>
        {depth && <><i className="inline-block h-[1.05em] w-1 rounded-[2px]" style={{ backgroundColor: getDepthColor(depth.value) }} />{depth.text}</>}
      </span>
    </div>
  )
}
