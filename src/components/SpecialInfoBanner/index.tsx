import { useAutoOpenWhileSpeaking } from '../../hooks/useAutoOpenWhileSpeaking'
import { telegramTextSubject } from '../../utils/ttsFollow'
import type {
  EarthquakeInfoMeta, JMANankai, JMANankaiCommentary, JMAKohatsu, JMAQuakeNotice, JMAEarthquakeCount,
  TelegramOperationStatus,
} from '../../types/earthquake'
import { EarthquakeCountDetail, earthquakeCountHeadline } from './EarthquakeCountDetail'
import type { SpecialInfoBanners } from './useSpecialInfoBanners'

interface Props {
  /**
   * 帯の束の状態（`useSpecialInfoBanners`）。**描くのは `visible`（閉じた電文を除いたもの）だけ。**
   * 閉じた状態を呼び出し側が持つので、共有ボタンの置き場所も同じ「いま出ている帯」で決められる。
   */
  banners: SpecialInfoBanners
  /**
   * いま気象庁が書いた文を読み上げている電文の主題（`telegramText:<kind>`。読んでいなければ null）。
   * 帯は自分が対象なら中身を開く（→ `useAutoOpenWhileSpeaking`）。
   */
  speakingTelegramTextSubject: string | null
  /**
   * 気象庁が書いた文の読み上げに参考情報（`Appendix`）を含める設定か（→ `telegramTextToSpeak` の
   * `earthquakeInfoAppendix`）。真なら、南海トラフ・後発地震の帯は文を読んでいる間「この種類の情報について」も開く
   * （2026-10-24 ユーザー選択「読む間は開く (Recommended)」）。
   */
  readsAppendix: boolean
  /**
   * 帯の束がいま画面の下端に接しているか。地図の下に波形が出ていれば、帯は地図の中にあって
   * 下端には届かないので false。真のときだけ下端の余白（`SAFE_BOTTOM`）を付ける —— ただし
   * 余白が効くのは `sideShort` の画面だけで、縦積みや PC では真でも付かない。
   */
  atScreenBottom: boolean
}

// 閉じた電文の id の覚え方（localStorage のキー・書式の揃え方）は useSpecialInfoBanners.ts にある。

function NankaiIcon() {
  return (
    <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    </svg>
  )
}

function CommentaryIcon() {
  return (
    <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

// お知らせ（VZSE40）の印。拡声器。地震そのものではなく「運用のお知らせ」なので、
// 他の 3 枚が使う警告・文書・情報のいずれとも重ならない形にする。
function NoticeIcon() {
  return (
    <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
    </svg>
  )
}

// 地震回数の印。棒グラフ（数を数えている情報であることを形で示す）。
function CountIcon() {
  return (
    <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  )
}

function KohatsuIcon() {
  return (
    <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function nankaiColors(kindName: string): { bg: string; border: string; badge: string } {
  if (kindName === '巨大地震警戒') return { bg: 'bg-red-900/95',    border: 'border-red-500',    badge: 'bg-red-500' }
  if (kindName === '巨大地震注意') return { bg: 'bg-orange-900/95', border: 'border-orange-400', badge: 'bg-orange-400' }
  return                                  { bg: 'bg-yellow-900/95', border: 'border-yellow-400', badge: 'bg-yellow-400' }
}

// 下端の safe-area（ホームインジケータ）を避けるための余白。帯を並べる包みに付け、最後の帯へ効かせる。
// **色の付いた箱の内側に入る。** 余白は最後の帯自身の padding になるので、背景色は画面下端まで届く。
//   包みや外側のラッパーの padding にすると帯ごと持ち上がり、下に地図が覗いて隙間に見える。
// 最後の 1 枚だけ … 5 枚同時に出うるため、余白が要るのは下端に接する最後の 1 枚だけ。上の帯にも入れると
//   帯と帯の間に隙間ができる。並び順を JS 側で数えると種類が増えたときに追従漏れを起こすので、
//   :last-child に判定させて実際に最後へ描画された要素だけに効かせる。
// sideShort: … 横向きかつ高さ 600px 以下（主にスマホの横画面）。縦積みでは地図の下につまみ・パネル・ナビが
//   続いて下端に届かない。iPad の横画面は余白を取らない（→ docs/spec/architecture-spec.md §4 規則 2）。
//   env() は要素の位置に関わらず値を返すため、どちらも条件で表す必要がある。
// atScreenBottom: … 地図の下に波形が出ているときは、帯は画面の下端に届かないので付けない。
const SAFE_BOTTOM = 'sideShort:[&>*:last-child]:pb-[env(safe-area-inset-bottom,0px)]'

/**
 * 地図の右下の共有ボタンを包む要素の、下の位置のクラス。帯の下端の余白と同じ条件で下端の safe-area を避ける
 * （→ docs/spec/architecture-spec.md §4）。帯が出ていればボタンは帯のすぐ上に載り、下端に届くのは帯の側なので避けない。
 * **クラス名は字面のまま書く**（Tailwind は文字列をそのまま拾う。組み立てると生成されない）。
 */
export function shareButtonBottomClass(bannerShown: boolean, atScreenBottom: boolean): string {
  return !bannerShown && atScreenBottom
    ? 'bottom-2 sideShort:bottom-[max(0.5rem,env(safe-area-inset-bottom,0px))]'
    : 'bottom-2'
}

export function SpecialInfoBanner({ banners, speakingTelegramTextSubject, readsAppendix, atScreenBottom }: Props) {
  /**
   * この帯の文をいま読み上げているか。**主題は `telegramText:<電文の kind>`**
   * （→ `useLiveEventHandler` の `speakTelegramText`）。
   */
  const speaking = (kind: string) => speakingTelegramTextSubject === telegramTextSubject(kind)
  // **閉じた帯しか残っていなければ何も描かない**（外枠の下限 2.5rem だけが空で残らないように）
  if (!banners.shown) return null
  const { nankai, nankaiCommentary, kohatsu, quakeNotice, earthquakeCount } = banners.visible

  return (
    // **自分では絶対配置しない。** 地図の下端へ積む枠は呼び出し側（`App`）が持っており、
    // この帯と凡例（`MapLegend`）が同じ縦並びに入る。帯が出れば凡例が押し上がる。
    // 自前で `absolute bottom-0` を持つと凡例の上に重なって隠す。
    // `flex-col`: 呼び出し側の縦並びが地図の高さで縮めたとき、下のスクロール領域まで縮みが
    // 届くようにする。これが無いと中身の高さで止まり、地図の上へはみ出す。
    // **縮むのは 2.5rem（帯の見出し 1 行ぶん）まで。** 0 まで縮めると、地図がごく低いときに
    // 南海トラフ臨時情報が記録も印も残さずに消える（はみ出していた頃より気づきにくい）。
    // 下限は値で書く —— 何も書かない（`auto`）と縦並びの子は中身の高さで止まり、縮まない。
    // 帯が 1 枚も無ければこのコンポーネント自体が何も描かないので、下限も場所を取らない。
    <div className="w-full min-h-10 flex flex-col pointer-events-none">
      {/* max-h で高さが制約されるためこの要素自身がスクロール領域になる。overflow-y だけを auto に
          すると overflow-x も auto に格上げされ横スクロールしてしまうため、明示的に塞ぐ。
          **上限は 2 つ掛かる。** 画面の 40%（`max-h-[40dvh]`。地図が高くても帯が地図を覆いすぎ
          ないため）と、呼び出し側の縦並びが地図の高さから決める残り（`min-h-0` で縮む）。
          前者だけでは地図が低いときに地図の上へはみ出す（→ docs/spec/architecture-spec.md §4）。
          南海トラフ臨時情報は先頭なので、縮んでもスクロールの先頭に残る。
          単位は vh ではなく dvh。vh は iOS の PWA だとビューポートではなく画面全体の高さを指すため。
          SAFE_BOTTOM はここの直接の子の最後に効くので、バナー以外をこの中に足さないこと。 */}
      <div className={`pointer-events-auto min-h-0 max-h-[40dvh] overflow-y-auto overflow-x-hidden overscroll-x-none${atScreenBottom ? ` ${SAFE_BOTTOM}` : ''}`}>
        {/* 南海トラフの 2 枚（臨時情報とその解説情報）を隣り合わせる。臨時情報の発表期間中は
            解説情報が毎日届いて両方が同時に出るため、間に別の事象（後発地震＝北海道・三陸沖）を
            挟むと同じ事象の話が分断されて読みにくい。重さの順よりこちらを優先する。 */}
        {nankai && <NankaiBanner nankai={nankai} speaking={speaking('nankai')} readsAppendix={readsAppendix} />}
        {nankaiCommentary && <CommentaryBanner commentary={nankaiCommentary} speaking={speaking('nankaiCommentary')} readsAppendix={readsAppendix} onDismiss={() => banners.dismiss('nankaiCommentary')} />}
        {kohatsu && <KohatsuBanner kohatsu={kohatsu} speaking={speaking('kohatsu')} readsAppendix={readsAppendix} />}
        {earthquakeCount && <EarthquakeCountBanner count={earthquakeCount} speaking={speaking('earthquakeCount')} onDismiss={() => banners.dismiss('earthquakeCount')} />}
        {/* お知らせ（運用連絡）は最後。上の 4 枚は「いま起きている・起こりうる地震」の話で、
            こちらは観測点の入電停止・配信試験といった裏方の連絡。同時に出たときに
            事象の話を先に読ませる。 */}
        {quakeNotice && <NoticeBanner notice={quakeNotice} speaking={speaking('quakeNotice')} onDismiss={() => banners.dismiss('quakeNotice')} />}
      </div>
    </div>
  )
}

/**
 * 南海トラフ・後発地震の帯を開いたときの中身。
 *
 * **3 つの帯（臨時情報・解説情報・後発地震注意情報）で同じものを同じ順に出す。**
 * 別々に書いていたため「解説情報だけが要約を出していて、臨時情報と後発地震は出していない」
 * という食い違いができていた。項目を足すときはここへ足せば 3 つとも揃う。
 *
 * 並びの理由:
 * 1. **要約**（気象庁が書いた一文）—— 本文は 1000 字を超えることがあり、先に結論を置く
 * 2. **本文**
 * 3. **次の情報**（`NextAdvisory`）—— 続報を待つべきかの判断に直結する。**南海トラフだけが持つ**
 *    （後発地震注意情報の電文はこの要素を持たない）。見出しに「今後」「発表」を使わないのは、
 *    直後に来る電文の文が「今後は……発表します」で始まり、同じことを 2 回言って見えるため
 * 4. **この種類の情報について**（`Appendix`）—— 制度の解説。**電文ごとに変わらない固定文**で
 *    長いため畳んでおく。初めてこの情報を受け取る人には要るが、毎報そのまま積むと本文が埋もれる。
 *    「この情報について」ではなく「この種類の」と冠するのは、**今回届いた発表の補足ではなく
 *    制度そのものの説明**だと分かるようにするため
 */
function EarthquakeInfoDetail({ info, speakingAppendix, subject, footer }: {
  info: EarthquakeInfoMeta & { body: string }
  /**
   * いま参考情報を含む文を読み上げているか。真のあいだ「この種類の情報について」を開く
   * （開き方の規約は帯の本文と同じ `useAutoOpenWhileSpeaking`。自分が開いた分だけ読み終わりで閉じる）。
   */
  speakingAppendix: boolean
  /** 録画ツール向けの記録に載せる主題（電文の種別）。`:appendix` を付けて本文の開閉と分ける */
  subject: string
  footer: React.ReactNode
}) {
  const [appendixOpen, setAppendixOpen] = useAutoOpenWhileSpeaking(speakingAppendix && !!info.appendix, `${subject}:appendix`)
  return (
    <div className="px-3 pb-2">
      {info.summary && (
        <p className="text-white text-xs font-medium leading-relaxed whitespace-pre-wrap mb-1">{info.summary}</p>
      )}
      {info.body && (
        <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-1">{info.body}</p>
      )}
      {info.nextAdvisory && (
        <div className="mb-1 border-l-2 border-white/30 pl-2">
          <p className="text-white/60 text-[0.6875rem] font-bold mb-0.5">次の情報</p>
          <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap">{info.nextAdvisory}</p>
        </div>
      )}
      {info.appendix && (
        <div className="mb-1">
          <button
            className="text-white/70 hover:text-white text-[0.6875rem] underline decoration-dotted underline-offset-2"
            onClick={() => setAppendixOpen(!appendixOpen)}
          >
            この種類の情報について{appendixOpen ? '（閉じる）' : '（開く）'}
          </button>
          {appendixOpen && (
            <p className="text-white/80 text-[0.6875rem] leading-relaxed whitespace-pre-wrap mt-1">{info.appendix}</p>
          )}
        </div>
      )}
      {footer}
    </div>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}

/**
 * 電文が自分で名乗っている運用種別（`Control/Status`）の印。訓練・試験のときだけ出す。
 *
 * **バナーで出る種別ほど訓練報の割合が高い。** 実電文を数えたところ、後発地震注意情報は
 * 訓練 5 / 通常 2、南海トラフ臨時情報は訓練 4 / 通常 4 だった（発表頻度が低いぶん、これまでに
 * 配信されたものに占める訓練の割合が大きい）。印が無いと、訓練の「巨大地震注意」が本物と
 * 同じ顔で出る。
 *
 * 本文にも「＊＊＊これは訓練です＊＊＊」と書かれることがあるが、**帯は畳まれていることが多い**
 * ので、開かなくても分かるところに出す。
 */
function OperationStatusBadge({ status }: { status?: TelegramOperationStatus }) {
  if (!status) return null
  return (
    <span
      className="text-xs font-bold px-1.5 py-0.5 rounded-sm shrink-0"
      style={{ backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}
    >
      {status}報
    </span>
  )
}

function NankaiBanner({ nankai, speaking, readsAppendix }: { nankai: JMANankai; speaking: boolean; readsAppendix: boolean }) {
  // 読み上げているあいだだけ開く（自分が開いた分だけ閉じる）
  const [open, setOpen] = useAutoOpenWhileSpeaking(speaking, 'nankai')
  const { bg, border, badge } = nankaiColors(nankai.kindName)

  return (
    <div className={`${bg} border-t-2 ${border}`}>
      <button
        className="w-full px-3 py-2 flex items-center gap-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <NankaiIcon />
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold text-white px-1.5 py-0.5 rounded-sm ${badge}`}>
            {nankai.kindName}
          </span>
          <OperationStatusBadge status={nankai.operationStatus} />
          <span className="text-white text-sm font-bold leading-tight truncate">{nankai.headline}</span>
        </div>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <EarthquakeInfoDetail info={nankai} speakingAppendix={speaking && readsAppendix} subject="nankai" footer={
          <p className="text-white/60 text-xs">
            発表: {new Date(nankai.reportDateTime).toLocaleString('ja-JP')}
          </p>
        } />
      )}
    </div>
  )
}

function KohatsuBanner({ kohatsu, speaking, readsAppendix }: { kohatsu: JMAKohatsu; speaking: boolean; readsAppendix: boolean }) {
  const [open, setOpen] = useAutoOpenWhileSpeaking(speaking, 'kohatsu')

  return (
    <div className="bg-blue-900/95 border-t-2 border-blue-400">
      <button
        className="w-full px-3 py-2 flex items-center gap-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <KohatsuIcon />
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          {/* **情報名の札は置かない。** 南海トラフの帯は気象庁のキーワード（「巨大地震注意」等）を
              札に出すが、後発地震注意情報にはそれに当たる語が無い。情報名を入れると、すぐ隣の
              見出し（電文の `Head/Headline/Text`。実電文は「北海道・三陸沖後発地震注意情報」）と
              同じ文字列が 2 つ並ぶ。**幅は足りる**（390px 幅でも札 186px・行 314px で収まり、
              見出しが次行へ回るだけ）が、同じ言葉を二度読ませる意味が無い。 */}
          <OperationStatusBadge status={kohatsu.operationStatus} />
          <span className="text-white text-sm font-bold leading-tight truncate">{kohatsu.headline}</span>
        </div>
        <ChevronIcon open={open} />
      </button>
      {open && (
        // **期限は出さない**（2026-10-19 ユーザー選択「発表時刻だけにする (Recommended)」）。
        // 電文に期限の要素は無く、帯を 7 日で畳むのはアプリの都合（`expireAt`）。これを「まで有効」と
        // 言い切ると、気象庁が定めた期間のように読める。注意を呼びかける期間は気象庁の本文が語っている。
        <EarthquakeInfoDetail info={kohatsu} speakingAppendix={speaking && readsAppendix} subject="kohatsu" footer={
          <p className="text-white/60 text-xs">
            発表: {new Date(kohatsu.reportDateTime).toLocaleString('ja-JP')}
          </p>
        } />
      )}
    </div>
  )
}

// 南海トラフ地震関連解説情報の帯。
//
// 臨時情報（NankaiBanner）とは色もバッジも分けている。あちらの黄／橙／赤は段階の重さを表すが、
// 解説情報は段階を持たないため、警戒度を読み取られない情報色（teal）にしている。
//
// 有効期限は出さない。内部では発表から 7 日で畳んでいるが、それは帯を常駐させないための
// 表示上の都合であって、気象庁が期限を定めているわけではない（後発地震注意情報の帯の 7 日も同じ）。
function CommentaryBanner({ commentary, speaking, readsAppendix, onDismiss }: { commentary: JMANankaiCommentary; speaking: boolean; readsAppendix: boolean; onDismiss: () => void }) {
  const [open, setOpen] = useAutoOpenWhileSpeaking(speaking, 'nankaiCommentary')
  return (
    <div className="bg-teal-900/95 border-t-2 border-teal-400">
      {/* 展開トグルと閉じるボタンを横に並べる。button の入れ子は不正な HTML になるため、
          他の帯のように全体を 1 つの button で覆うことはできない */}
      <div className="w-full px-3 py-2 flex items-center gap-2">
        <button
          className="min-w-0 flex-1 flex items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
        >
          <CommentaryIcon />
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold text-white px-1.5 py-0.5 rounded-sm bg-teal-500 shrink-0">
              {commentary.serialName}
            </span>
            <OperationStatusBadge status={commentary.operationStatus} />
            <span className="text-white text-sm font-bold leading-tight truncate">{commentary.headline}</span>
          </div>
          <ChevronIcon open={open} />
        </button>
        <button
          className="shrink-0 p-1 text-white/70 hover:text-white"
          onClick={onDismiss}
          aria-label="解説情報を閉じる"
        >
          <CloseIcon />
        </button>
      </div>
      {open && (
        <EarthquakeInfoDetail info={commentary} speakingAppendix={speaking && readsAppendix} subject="nankaiCommentary" footer={
          <p className="text-white/60 text-xs">
            発表: {new Date(commentary.reportDateTime).toLocaleString('ja-JP')}
          </p>
        } />
      )}
    </div>
  )
}

// 地震・津波に関するお知らせ（VZSE40）の帯。
//
// 中身は観測点の入電停止・配信試験・訓練の予告といった**運用連絡**で、地震そのものの発表ではない。
// そのため色は無彩色（slate）にして、他の 3 枚（黄／橙／赤＝段階の重さ・teal＝南海トラフの解説・
// 青＝後発地震）のどれとも警戒度を取り違えられないようにしている。
//
// 本文は `Body/Text` の自由文ひとつきり。要約も次回発表予定も持たないので `EarthquakeInfoDetail`
// は通さない。**改行と全角スペースをそのまま出す** —— 気象庁は「記」から始まる箇条書きを
// 全角スペースの字下げで組んでおり、詰めると期間や連絡先の対応が崩れる。
//
// 有効期限（発表から 7 日）は出さない。解説情報と同じく帯を常駐させないための表示上の都合で、
// 気象庁が定めた期限ではない。
function NoticeBanner({ notice, speaking, onDismiss }: { notice: JMAQuakeNotice; speaking: boolean; onDismiss: () => void }) {
  // 本文を読み上げている間は開く（他の帯と同じ。読み上げは設定で有効にしたときだけ）
  const [open, setOpen] = useAutoOpenWhileSpeaking(speaking, 'quakeNotice')
  return (
    <div className="bg-slate-800/95 border-t-2 border-slate-400">
      {/* 展開トグルと閉じるボタンを横に並べる（button の入れ子は不正な HTML になるため） */}
      <div className="w-full px-3 py-2 flex items-center gap-2">
        <button
          className="min-w-0 flex-1 flex items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
        >
          <NoticeIcon />
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold text-white px-1.5 py-0.5 rounded-sm bg-slate-500 shrink-0">
              お知らせ
            </span>
            <OperationStatusBadge status={notice.operationStatus} />
            <span className="text-white text-sm font-bold leading-tight truncate">{notice.headline}</span>
          </div>
          <ChevronIcon open={open} />
        </button>
        <button
          className="shrink-0 p-1 text-white/70 hover:text-white"
          onClick={onDismiss}
          aria-label="お知らせを閉じる"
        >
          <CloseIcon />
        </button>
      </div>
      {open && (
        <div className="px-3 pb-2">
          {notice.body && (
            <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-1">{notice.body}</p>
          )}
          {/* 自由付加文は本文の後に空行を挟んで原文のまま出す（2026-10-19 ユーザー承認
              「本文に続けて出す (推奨)」）。空行は段落の間（`mt-3`）で表す */}
          {notice.freeText && (
            <p className={`text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-1 ${notice.body ? 'mt-3' : ''}`}>{notice.freeText}</p>
          )}
          <p className="text-white/60 text-xs">
            発表: {new Date(notice.reportDateTime).toLocaleString('ja-JP')}
          </p>
        </div>
      )}
    </div>
  )
}

// 地震回数に関する情報（VXSE60）の帯。
//
// **タブのカードではなく帯にしている。** 群発は日をまたいで続く「状況」で、地震カードのように
// 1 件ずつ増える「出来事」ではない。しかも群発の最中は小さな地震で揺れ検知が繰り返し発火して
// リアルタイムタブへ画面を持っていくので、地震情報タブへ置くと**いちばん見たいときに見えない**。
// 帯は地図に重ねて出るのでどのタブからも読める。
//
// 色は青緑（cyan）。南海トラフの解説（teal）とは隣り合わないので紛れにくく、
// 段階の重さを表す黄／橙／赤とも、運用連絡の無彩色とも別に見える。
function EarthquakeCountBanner({ count, speaking, onDismiss }: { count: JMAEarthquakeCount; speaking: boolean; onDismiss: () => void }) {
  const [open, setOpen] = useAutoOpenWhileSpeaking(speaking, 'earthquakeCount')
  return (
    <div className="bg-cyan-900/95 border-t-2 border-cyan-400">
      {/* 展開トグルと閉じるボタンを横に並べる（button の入れ子は不正な HTML になるため） */}
      <div className="w-full px-3 py-2 flex items-center gap-2">
        <button
          className="min-w-0 flex-1 flex items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
        >
          <CountIcon />
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold text-white px-1.5 py-0.5 rounded-sm bg-cyan-600 shrink-0">
              地震回数
            </span>
            <OperationStatusBadge status={count.operationStatus} />
            {/* **電文の見出しではなく累積の数字を出す。** 電文の見出しは「地震回数に関する情報を
                お知らせします。」で、畳んだままでは何も伝わらない */}
            <span className="text-white text-sm font-bold leading-tight truncate">
              {earthquakeCountHeadline(count)}
            </span>
          </div>
          <ChevronIcon open={open} />
        </button>
        <button
          className="shrink-0 p-1 text-white/70 hover:text-white"
          onClick={onDismiss}
          aria-label="地震回数を閉じる"
        >
          <CloseIcon />
        </button>
      </div>
      {open && <EarthquakeCountDetail count={count} />}
      {open && (
        <p className="px-3 pb-2 text-white/60 text-xs">
          発表: {new Date(count.reportDateTime).toLocaleString('ja-JP')}
        </p>
      )}
    </div>
  )
}
