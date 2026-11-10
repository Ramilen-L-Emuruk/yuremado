import { memo } from 'react'
import type { DockChip, EewDockItem, TsunamiDockItem } from '../../utils/alertDock'

/**
 * どのタブからでも見える、発表中の緊急地震速報と津波の帯。
 *
 * **場所を取って置く帯で、浮かべない。** 上下分割（スマホ）ではパネルの一番下（ナビの上）、左右分割ではパネルの
 * 一番上に、パネルの幅いっぱいに付ける。角丸・外側の余白は付けず、一覧との境目に線を引く（2026-11-09 ユーザー選択
 * 「H 境目の線あり (Recommended)」）。区分は左の太い帯の色で示す（地震タブの開いたカードの左の帯と同じ作り）。
 *
 * 今いるタブの項目は呼び出し側で外す（速報はリアルタイムタブ、津波は津波タブ）。押すとそのタブへ移る。
 * 値の組み立ては `utils/alertDock.ts`。
 */
interface Props {
  eews: readonly EewDockItem[]
  tsunami: TsunamiDockItem | null
  onOpen: (tab: 'realtime' | 'tsunami') => void
}

const LABEL = 'text-secondary text-[11.5px]'
const VALUE = 'text-white text-[12.5px] font-bold'

function Chip({ chip }: { chip: DockChip }) {
  return (
    <span className="whitespace-nowrap rounded-[3px] px-[5px] text-[12px] font-extrabold leading-[18px]" style={{ backgroundColor: chip.bg, color: chip.fg }}>
      {chip.text}
    </span>
  )
}

/** 名目と値の塊。**塊の中では折り返さない**（折り返すのは塊と塊の間だけ） */
function Unit({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1 whitespace-nowrap">{children}</span>
}

function Bar({ color, text }: { color: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <i className="inline-block h-[1.05em] w-1 rounded-[2px]" style={{ backgroundColor: color }} />
      <span className="text-white text-[12.5px]">{text}</span>
    </span>
  )
}

function StatusChip({ text }: { text: string }) {
  return (
    <span className="whitespace-nowrap rounded-[3px] px-1.5 text-[11px] font-bold leading-[17px]" style={{ backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}>
      {text}
    </span>
  )
}

/** 1 件の帯。見出しの段（区分・札・最大の値。更新時刻は右上に固定）と、値の段を並べる。 */
function Row({ accent, title, titleColor, status, chips, updated, onClick, body, children }: {
  accent: string; title: string; titleColor: string; status: string | null; chips: DockChip[]; updated: string | null
  onClick: () => void
  /** 値の段が残るか。狭い画面（上下分割）と広い画面（左右分割）で分ける —— 観測・第 1 波・警報の地域は広い画面だけ */
  body: { narrow: boolean; wide: boolean }
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full bg-card px-2.5 pb-[5px] text-left transition-colors hover:bg-white/5 motion-reduce:transition-none"
      style={{ borderLeft: `5px solid ${accent}` }}
    >
      {/* 値の段が 1 つも無い件は、見出しの下の線と隙間を付けない（下の余白だけが空いて見えるため） */}
      <span
        className={`flex items-start gap-2 py-1 ${body.narrow ? 'mb-1 border-b' : 'mb-0 border-b-0'} ${body.wide ? 'side:mb-1 side:border-b' : 'side:mb-0 side:border-b-0'}`}
        style={{ borderBottomColor: `${accent}55` }}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-[3px]">
          <b className="whitespace-nowrap text-[12.5px] font-extrabold leading-[18px]" style={{ color: titleColor }}>{title}</b>
          {status && <StatusChip text={status} />}
          {chips.length > 0 && <span className="inline-flex items-center gap-1 whitespace-nowrap">{chips.map(c => <Chip key={c.text} chip={c} />)}</span>}
        </span>
        {updated && <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] leading-[18px] text-secondary">更新 {updated} ›</span>}
      </span>
      <span className={`flex-col gap-[3px] ${body.narrow ? 'flex' : 'hidden'} ${body.wide ? 'side:flex' : 'side:hidden'}`}>{children}</span>
    </button>
  )
}

/** 値の段。塊と塊の間で折り返す */
function Line({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return <span className={`flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 ${className}`}>{children}</span>
}

/** 登録地点の段の塊。**段の中で割らない**ため、入り切らなければ段ごと次の行へ送る（2026-11-09 ユーザー選択「ホームは割らず行ごと送る (Recommended)」） */
function HomeBlock({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5">{children}</span>
}

function AlertDockInner({ eews, tsunami, onOpen }: Props) {
  if (eews.length === 0 && !tsunami) return null
  return (
    <div className="flex shrink-0 flex-col gap-px border-t-2 bg-[#2a2d38] side:border-t-0 side:border-b-2" style={{ borderColor: '#4b5263' }}>
      {tsunami && (
        <Row accent={tsunami.accent} title={tsunami.title} titleColor={tsunami.titleColor} status={tsunami.status}
          chips={tsunami.chip ? [tsunami.chip] : []} updated={tsunami.updated} onClick={() => onOpen('tsunami')}
          body={{ narrow: tsunami.home !== null, wide: tsunami.home !== null || tsunami.observed !== null || tsunami.firstWave !== null }}>
          {(tsunami.observed || tsunami.firstWave) && (
            // 観測の最大波と第 1 波の到達は広い画面だけ（2026-11-09 ユーザー発言「津波増やしすぎてゴチャゴチャ」）
            <Line className="hidden side:flex">
              {tsunami.observed && <Unit><span className={LABEL}>最大波</span><span className={VALUE}>{tsunami.observed.value}</span><span className={LABEL}>（{tsunami.observed.station}）</span></Unit>}
              {tsunami.firstWave && <Unit><span className={LABEL}>第1波到達</span><span className={VALUE}>{tsunami.firstWave.first}</span>{tsunami.firstWave.rest > 0 && <span className={LABEL}>ほか {tsunami.firstWave.rest} 区域</span>}</Unit>}
            </Line>
          )}
          {tsunami.home && (
            <Line>
              <HomeBlock>
                <Unit>
                  <span className={LABEL}>登録地点</span><span className={VALUE}>{tsunami.home.zone}</span>
                  <Chip chip={tsunami.home.grade} />
                  {tsunami.home.height && <><span className={LABEL}>予想の高さ</span><Chip chip={tsunami.home.height} /></>}
                </Unit>
                {(tsunami.home.arrival || tsunami.home.rest > 0) && (
                  <Unit>
                    {tsunami.home.arrival && <>{tsunami.home.arrival.label && <span className={LABEL}>{tsunami.home.arrival.label}</span>}<span className={VALUE}>{tsunami.home.arrival.text}</span></>}
                    {tsunami.home.rest > 0 && <span className={`${LABEL} ml-1`}>ほか {tsunami.home.rest} 区域</span>}
                  </Unit>
                )}
              </HomeBlock>
            </Line>
          )}
        </Row>
      )}
      {eews.map((e, i) => (
        <Row key={e.key} accent={e.accent} title={e.title} titleColor={e.titleColor} status={e.status}
          chips={e.chips} updated={e.updated} onClick={() => onOpen('realtime')}
          body={{ narrow: e.hypocenter !== null || e.home !== null, wide: e.hypocenter !== null || e.home !== null || (i === 0 && e.warning !== null) }}>
          {e.hypocenter && (
            <Line>
              <Unit><span className={LABEL}>震源</span><span className={VALUE}>{e.hypocenter.name}</span></Unit>
              {e.hypocenter.magnitude && <Bar color={e.hypocenter.magnitude.color} text={e.hypocenter.magnitude.text} />}
              {e.hypocenter.depth && <Bar color={e.hypocenter.depth.color} text={e.hypocenter.depth.text} />}
            </Line>
          )}
          {i === 0 && e.warning && (
            // 警報の都道府県は広い画面だけ。区切りと名目は速報カードの「警報:」の行と同じ（RealtimeTab）
            <Line className="hidden side:flex">
              <Unit>
                <span className="text-[11.5px] font-bold text-red-300">警報:</span>
                <span className="text-[12.5px] text-white">{e.warning.shown.join(' / ')}</span>
                {e.warning.rest > 0 && <span className={LABEL}>ほか {e.warning.rest}</span>}
              </Unit>
            </Line>
          )}
          {e.home && (
            <Line>
              <HomeBlock>
                <Unit>
                  <span className={LABEL}>登録地点</span><span className={VALUE}>{e.home.area}</span>
                  {e.home.chip && <><span className={LABEL}>予想</span><Chip chip={e.home.chip} /></>}
                </Unit>
                {/* 秒数は等幅の数字にして、1 秒ごとの幅の揺れで段が折り返し直さないようにする */}
                <Unit><span className={LABEL}>主要動</span><span className={`${VALUE} tabular-nums`}>{e.home.shake}</span></Unit>
              </HomeBlock>
            </Line>
          )}
        </Row>
      ))}
    </div>
  )
}

/**
 * **中身が変わったときだけ描き直す。** 主要動の残り秒数の元（`swaveArrival`）は 100ms ごとに作り直されるが、
 * 帯に出る値は 1 秒に 1 回しか変わらない。値を比べて、同じなら描き直さない（呼び出し側の `useMemo` は
 * 入力の参照が変わるたびに新しい物を返すため、参照の比較では止まらない）。
 */
export const AlertDock = memo(AlertDockInner, (a, b) =>
  a.onOpen === b.onOpen && JSON.stringify(a.eews) === JSON.stringify(b.eews) && JSON.stringify(a.tsunami) === JSON.stringify(b.tsunami))
