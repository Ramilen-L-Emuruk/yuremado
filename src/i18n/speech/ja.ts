import type { DomesticTsunami, DomesticTsunamiCode, ForeignTsunamiCode, IntensityScale, InternationalTsunamiEvaluation, QuakeRetractedReport, TsunamiGrade } from '../../types/earthquake'
import type { InternationalTsunamiSpeechParts, QuakeOccurrencePart, QuakeOccurrenceTexts } from '../speechWords'
import { TSUNAMI_GRADE_NAME, TSUNAMI_ALL_LIFTED_SENTENCE, fallbackEvacuationAction } from '../../utils/tsunami'
import { ja as jaMessages } from '../messages/ja'
import { getIntensityLabel, getIntensityLabelWithApproxAbove } from '../../utils/intensity'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import { DOMESTIC_TSUNAMI_CODE_TEXT } from '../../utils/domesticTsunamiComment'
import { EVALUATION_SPEECH, INTERNATIONAL_TSUNAMI_NAME } from '../../utils/internationalTsunamiSpeech'
import { japaneseClockText, type TimeSignalClock, type TimeSignalPhrase } from '../../utils/timeSignal'

/** 時刻。**分を 0 で埋めない**（「06分」を「ぜろろくふん」と桁で読むため。画面の時刻とは別） */
const time = (hour: number, minute: number) => `${hour}時${minute}分`
/**
 * 日付。**1 日だけ「ついたち」と書く。**
 *
 * 合成エンジンは `1日` を「いちにち」と読む（日付としては誤り）。句区切り辞書で直そうとすると、
 * 期間を指す「1日程度」「1日おきに」まで拾ってしまう —— 辞書は文字列しか見ないので、日付か
 * 期間かを区別できない。**読み上げの関数が組む文は日付だと確定している**ので、ここで読みへ直せば曖昧さが残らない。
 *
 * **2 日以降は仮名で書かない。** エンジンがかえって崩す（実測: `じゅうしちにち` は
 * `ジュウ[1] | シチニチ[2]` で頭高が反転し、`にじゅういちにち` は `ニジュウイチニ | チ` と
 * 途中で割れる）。あちらは読みが正しく抑揚だけの問題なので、句区切り辞書で核を直す。
 */
const day = (d: number) => (d === 1 ? 'ついたち' : `${d}日`)

/** 震源名と深さの間（地震の発生の文と、津波の文の震源の句が使う） */
const hypocenterDepthSep = '、'

/** 津波の観測点の句の述語の語幹（更新・観測） */
const STEM_UPDATED = 'へ更新'
const STEM_OBSERVED = 'を観測'

/**
 * 読み上げの文の語表（日本語）。読み上げの関数の組（`utils/ttsText.ts` の `createSpeechText`）が文面をここから引く。
 *
 * **値は声になる文字列そのもの。一字でも変えると読み上げが変わる**（句読点は区切りと間に効く）。
 * 画面の辞書（`messages/ja.ts`）と同じく、ほかの言語の語表はこの形（`SpeechWords`）に合わせて書き、
 * キーの欠け・余り・関数の引数の違いは型チェックで落ちる。
 *
 * **語順は関数で吸う。** 値を差し込む文は、差し込む値を引数に取る関数にする（言語ごとに置く位置が違うため）。
 * 既読と追従の鍵（`SpeechRef`）は語表に置かない。鍵は言語によらない値で持つ（→ `utils/ttsFollow.ts`）。
 */
export const jaSpeech = {
  common: {
    /** 名前を並べるときの区切り */
    listSep: '、',
    /**
     * 文と文を続けるときの区切り。日本語と中国語は句点のあとに何も挟まない。英語など語を空白で分ける言語は空白を挟む
     * （挟まないと「…Warning.Maximum …」と 1 語に繋がる）
     */
    sentenceSep: '',
    /**
     * 気象庁が書いた文（取消の理由など）の代わりに読む文。**日本語は気象庁の文をそのまま読むので null。**
     * 日本語以外では気象庁の文を訳せないので、文の在処を伝える（2026-11-17 ユーザー選択「電文ログにあると言う (Recommended)」）
     */
    telegramTextElsewhere: null as string | null,
    /** 震度の呼び方（「5弱」など） */
    intensity: (scale: IntensityScale) => getIntensityLabel(scale),
    time,
    day,
    /** 日付つきの時刻 */
    dayTime: (d: number, hour: number, minute: number) => `${day(d)}${time(hour, minute)}`,
    /**
     * 取消の理由（電文の文）を別の発話で読むときの前置き。`infoName` は情報の名前で、呼び出し側（`useLiveEventHandler.ts`）が
     * 組の名前（`ttsText.ts` の `INFO_NAME`・`reportNameToSay`）から引いて渡す。日本語以外の組はこの前置きを使わない
     * （理由の文を読まないので手前で null が返る）
     */
    cancelReasonLead: (infoName: string) => `${infoName}が取り消された理由をお伝えします。`,
    /** 情報の名乗り（初報） */
    issued: (label: string) => `${label}。`,
    /** 情報の名乗り（続報） */
    updated: (label: string) => `${label}が更新されました。`,
    /** 発生時刻（名乗りの後ろ） */
    atAround: (time: string) => `${time}頃、`,
    /** 文と文をつなぐ「また、」 */
    also: 'また、',
    /** 日付と時（地震回数の区間） */
    dayHour: (d: number, hour: number) => `${day(d)}${hour}時`,
    /** 気象庁が書いた文を読む前置き。`label` は情報の名前 */
    telegramTextLead: (label: string) => `${label}について、気象庁の発表文をお伝えします。`,
  },
  lpgm: {
    /** 情報の名前 */
    label: '長周期地震動に関する観測情報',
    /** 取消 */
    retracted: '長周期地震動に関する観測情報は取り消されました。',
    /** 発生時刻（名乗りの後ろ） */
    occurredAt: (time: string) => `${time}頃発生した地震で、`,
    /**
     * 階級ごとの句（`names` は `quake.regionSep` で並べた地名）。`isFirst` は先頭の組か（2 組目から短く言う言語が使う。
     * 地震情報の `quake.intensityLead` の `isMax` と同じ形）。組と組の間は `quake.intensityGroupSep(false)`、最後に `quake.observedTail` が続く
     */
    classAt: (cls: number, names: string, _isFirst: boolean) => `階級${cls}を${names}`,
    /** 地名つきの文 */
    regions: (regionText: string) => `長周期地震動${regionText}`,
    /** 地名を作れないときの文 */
    maxClassOnly: (cls: number) => `長周期地震動階級${cls}を観測しました。`,
  },
  special: {
    /** 南海トラフ地震臨時情報の名前 */
    nankaiLabel: '南海トラフ地震臨時情報',
    /** 調査中のきっかけ。キーは地震関連情報番号コード */
    nankaiTrigger: {
      '111': '監視領域内でマグニチュード6.8以上の地震が発生した',
      '112': 'ひずみ計で有意な変化を観測した',
      '113': '通常とは異なる現象を観測した',
    } as Record<string, string>,
    nankaiRetracted: '南海トラフ地震臨時情報は取り消されました。',
    nankaiEnded: '南海トラフ地震臨時情報、調査終了。南海トラフ地震の発生可能性は通常の範囲内でした。',
    /** 調査中（きっかけが分かれば添える） */
    nankaiInvestigating: (trigger: string | undefined) =>
      `南海トラフ地震臨時情報、調査中。${trigger ? `${trigger}ため、` : ''}南海トラフ地震の発生可能性について調査しています。今後の情報に注意してください。`,
    nankaiMajorWarning: '南海トラフ地震臨時情報、巨大地震警戒。南海トラフ地震の想定震源域内で大規模な地震が発生しました。直ちに防災対応をとってください。',
    nankaiMajorAdvisory: '南海トラフ地震臨時情報、巨大地震注意。南海トラフ地震の想定震源域内で地震が発生しました。防災対応の確認をしてください。',
    nankaiOther: '南海トラフ地震臨時情報。南海トラフ地震に関する臨時情報が発表されました。今後の情報に注意してください。',
    /** 南海トラフ地震関連解説情報の名前 */
    commentaryLabel: '南海トラフ地震関連解説情報',
    commentaryRetracted: '南海トラフ地震関連解説情報は取り消されました。',
    commentaryRegular: '南海トラフ地震関連解説情報。南海トラフ沿いの地震に関する評価検討会の定例会合による調査結果が発表されました。',
    /** 臨時の解説（`serial` は見出し文の号数） */
    commentary: (serial: string | undefined) =>
      `南海トラフ地震関連解説情報${serial ? `、第${serial}号` : ''}。南海トラフ地震の想定震源域の状況について解説情報が発表されました。`,
    /** 地震回数に関する情報の名前 */
    countLabel: '地震回数に関する情報',
    countRetracted: '地震回数に関する情報は取り消されました。',
    countLead: '地震回数に関する情報。',
    /** 区間が読めないとき */
    countSpanUnknown: 'これまで',
    /** 区間（`from`・`to` は日付と時） */
    countSpan: (from: string, to: string) => `${from}から${to}まで`,
    countFeltOnly: (span: string, felt: number) => `${span}に、震度1以上を観測した地震は${felt}回です。`,
    countOccurred: (span: string, count: number) => `${span}に、地震が${count}回発生しています。`,
    countFeltOf: (felt: number) => `このうち、震度1以上を観測したのは${felt}回です。`,
    countFeltNone: 'このうち、震度1以上を観測したものはありません。',
    /** 地震・津波に関するお知らせの名前 */
    noticeLabel: '地震・津波に関するお知らせ',
    noticeRetracted: '地震・津波に関するお知らせは取り消されました。',
    noticeLead: '地震・津波に関するお知らせ。',
    /**
     * 見出し文のある報。`headline` は気象庁の見出し文で、気象庁の文を読まない言語（`common.telegramTextElsewhere` が null でない）には
     * 読み上げの関数の組が null を渡す（その言語は見出し文の代わりに在処の文を言う）
     */
    noticeWithHeadline: (headline: string | null) => (headline === null ? '地震・津波に関するお知らせ。' : `地震・津波に関するお知らせ。${headline}。`),
    /** 北海道・三陸沖後発地震注意情報の名前 */
    kohatsuLabel: '北海道・三陸沖後発地震注意情報',
    kohatsuRetracted: '北海道・三陸沖後発地震注意情報は取り消されました。',
    /**
     * 見出し文（気象庁の文。情報の名前を抜いて句点で終えたもの）つき。見出し文が無ければ空の文字列。気象庁の文を読まない言語には、
     * 見出し文があるとき null が来る（その言語は見出し文の位置で在処の文を言う。空の文字列なら在処の文も言わない）
     */
    kohatsu: (headline: string | null) =>
      `北海道・三陸沖後発地震注意情報。${headline ?? ''}今後、大規模地震の発生可能性が平常時より高まっています。防災対応の確認をしてください。`,
    /** 推計震度分布図（`time` は発生時刻。読めなければ null） */
    estimatedIntensity: (time: string | null, isNew: boolean) =>
      `${time ? `${time}頃発生した地震について、` : ''}気象庁の推計震度分布図${isNew ? 'を受信しました' : 'が更新されました'}。`,
  },
  quake: {
    /**
     * 地名を並べるときの区切り（観測した地域・未入電の地名。階級ごとの句の間は `common.listSep`）。日本語は `listSep` と同じ。
     * 地名の訳がコンマを含む言語では別の区切りにする（2026-11-17 ユーザー選択「「; 」で区切る (Recommended)」）
     */
    regionSep: '、',
    /**
     * 観測した地域の階級と階級の間（`fresh` は続報で初めて観測した地域の文か）。日本語は句の区切りで、述語「で観測しました。」を
     * 最後の句と共有する。英語などは階級ごとに文を切る（2026-11-17 ユーザー選択「階級ごとに文を切る (Recommended)」）
     */
    intensityGroupSep: (_fresh: boolean) => '、',
    /** 「震度5弱以上・未入電」を件数だけで言う文（地名を読まない設定） */
    unreceivedCountOnly: (count: number, unit: UnreceivedUnit) => `${count}${unit}では、震度5弱以上と推定されますが、未入電です。`,
    /** 未入電の地名を上限で落とした分 */
    unreceivedOmitted: (count: number, unit: UnreceivedUnit) => `、ほか${count}${unit}`,
    /** 未入電の地名に続く述語（区域名へ丸めたとき） */
    unreceivedTailPartial: 'では、一部の地点で震度5弱以上と推定されますが、未入電です。',
    /** 未入電の地名に続く述語 */
    unreceivedTail: 'では、震度5弱以上と推定されますが、未入電です。',
    /** 階級ごとの句の頭（最大の階級だけ「最大」を付ける） */
    intensityLead: (isMax: boolean, intensity: string) => `${isMax ? '最大' : ''}震度${intensity}を`,
    /** 観測した地名を上限で落とした分 */
    regionsOmitted: (count: number) => `、ほか${count}地域`,
    /** 観測した地名の文の締め */
    observedTail: 'で観測しました。',
    /** 続報で、初めて観測した地域の文の頭 */
    fresh: '新たに',
    /** 続報で、震度が上がった地域の文に続けて、初めて観測した地域の文の頭 */
    freshAfterUpgraded: 'また、新たに',
    /** 規模（震源の句の中） */
    magnitudeOf: (magnitude: string) => `マグニチュード${magnitude}の`,
    /** 規模が数値でないときの述部。キーは電文の表記 */
    magnitudeConditionPredicate: {
      'Ｍ不明': '不明です。',
      'Ｍ８を超える巨大地震': '8を超える巨大地震とみられます。',
    },
    /** 知らない表記の述部（表記をそのまま読む） */
    // 気象庁の文を読まない言語は表記を読まずに「数値で発表されていない」と言い、在処の文は読み上げの関数の組が
    // 発話の末尾に 1 度だけ足す（→ `ttsText.ts` の `withElsewhereForUnknownMagnitude`）
    magnitudeConditionUnknown: (body: string) => `${body}です。`,
    /** 規模が数値でないときの文 */
    magnitudeIs: (predicate: string) => `マグニチュードは${predicate}`,
    /** 規模が数値でない値へ更新されたときの文 */
    magnitudeAmended: (predicate: string) => `マグニチュードが更新されました。${predicate}`,
    /** 深さ 0（震源の句の中） */
    depthVeryShallowPlace: 'ごく浅い場所',
    /** 深さ（震源の句の中）。`atLeast` は「以上」か空 */
    depthOf: (km: number, atLeast: string) => `深さ${km}キロメートル${atLeast}`,
    /** 深さが下限だけ分かるとき */
    depthAtLeast: '以上',
    /** 深さの更新（数値） */
    depthAmendKm: (km: number, atLeast: string) => `震源の深さ${km}キロメートル${atLeast}`,
    /** 深さの更新（ごく浅い。後ろに文が続く形） */
    depthAmendVeryShallowContinuing: '震源の深さはごく浅く',
    /** 深さの更新（値で言い切る形） */
    depthAmendIs: (value: string) => `震源の深さは${value}`,
    /** 地名を作れなかったときの最大震度（未入電） */
    maxScaleOnlyUnreceived: (intensity: string) => `最大震度${intensity}以上と推定されますが、未入電です。`,
    /** 地名を作れなかったときの最大震度 */
    maxScaleOnly: (intensity: string) => `最大震度${intensity}を観測しました。`,
    /** 情報の名前 */
    label: {
      intensityReport: '震度速報',
      distant: '遠地地震に関する情報',
      epicenter: '震源情報',
      quake: '地震情報',
    },
    /** 震源名が変わった続報 */
    hypocenterAmended: (name: string) => `震源は${name}に更新されました。`,
    /** 規模が変わった続報 */
    magnitudeAmendedTo: (magnitude: string) => `マグニチュードは${magnitude}に更新されました。`,
    /** 深さが変わった続報 */
    depthAmendedTo: (depth: string) => `震源の深さは${depth}に更新されました。`,
    /** 地域ごとの最大震度が下がった・消えた続報（下がった値は読まない。2026-10-19 ユーザー承認「言い切りを外す (推奨)」） */
    observedIntensityUpdated: '観測された震度が更新されました。',
    /** 観測点だけが増えた続報 */
    stationsAddedRegionsSame: '観測地点が追加されましたが、地域ごとの最大震度は変わっていません。',
    /** 観測点の震度だけが変わった続報 */
    stationsUpdatedRegionsSame: '観測された震度が更新されましたが、地域ごとの最大震度は変わっていません。',
    /** 何も変わらない続報 */
    noChange: '内容に変わりはありません。',
    /** 震度速報の続報で何も変わらないとき */
    intensityNoChange: '観測した震度に変わりはありません。',
    /** 震源情報の続報で何も変わらないとき */
    hypocenterNoChange: '震源の内容に変わりはありません。',
    /** 震源要素更新のお知らせの冒頭（`time` は発生時刻。読めなければ null） */
    prominentAmendHead: (time: string | null, epicenter: string) =>
      `顕著な地震の震源要素更新のお知らせ。${time ? `${time}頃発生した` : ''}${epicenter}の地震について、`,
    /** 震源要素更新のお知らせで、深さと規模の間 */
    amendSep: '、',
    /** 震源要素更新のお知らせの規模 */
    magnitudeValue: (magnitude: string) => `マグニチュード${magnitude}`,
    /** 震源要素更新のお知らせの締め */
    amendedTail: 'に更新されました。',
    /** 震源要素更新のお知らせで、言える値が無いとき */
    hypocenterElementsAmended: '震源要素が更新されました。',
    /** 深さの値（更新の文の中） */
    depthKm: (km: number, atLeast: string) => `${km}キロメートル${atLeast}`,
    /** 取消（最初の報の時刻が分かるとき） */
    cancelledAt: (time: string) => `${time}に発表された地震情報は取り消されました。`,
    /** 取消 */
    cancelled: '地震情報は取り消されました。',
    /** 種類を名指しした取消（`name` は {@link reportName} で引いた情報の名前） */
    reportCancelledAt: (name: string, time: string) => `${time}に発表された${name}は取り消されました。`,
    reportCancelled: (name: string) => `${name}は取り消されました。`,
    /** 種類を名指しした取消で言う情報の名前。キーは取り消された報の種別。日本語は電文の種別の名前のまま */
    reportName: {
      '震度速報': '震度速報',
      '震源情報': '震源情報',
      '震源・震度情報': '震源・震度情報',
      '各地の震度情報': '各地の震度情報',
      '顕著な地震の震源要素更新のお知らせ': '顕著な地震の震源要素更新のお知らせ',
      '遠地地震': '遠地地震',
      'その他': 'その他',
      '長周期地震動に関する観測情報': '長周期地震動に関する観測情報',
    } satisfies Record<QuakeRetractedReport['issueType'], string>,
    /** 震源名と深さの間 */
    hypocenterDepthSep,
    /**
     * 発生の文の並び（時刻の句の後ろ）。「石川県能登地方、深さ10キロメートルを震源とするマグニチュード6.5の地震が発生しました。」
     * 震源名が無ければ震源の句ごと、規模が無ければ規模の句を省く。規模が数値でないときは、文の後ろに規模の文を続ける
     */
    occurrence: (t: QuakeOccurrenceTexts): QuakeOccurrencePart[] => [
      ...(t.name !== undefined
        ? [
          { kind: 'name' } as const,
          ...(t.depth !== undefined ? [{ kind: 'text', text: hypocenterDepthSep } as const, { kind: 'depth' } as const] : []),
          { kind: 'text', text: 'を震源とする' } as const,
        ]
        : []),
      ...(t.magnitude !== undefined ? [{ kind: 'magnitude' } as const] : []),
      { kind: 'text', text: '地震が発生しました。' },
      ...(t.magnitudeSentence !== undefined ? [{ kind: 'magnitudeSentence' } as const] : []),
    ],
    /** 津波の区分ごとの文（区分を決めたコードを持たないとき）。キーは電文の区分 */
    domesticTsunami: {
      'なし': 'この地震による津波の心配はありません。',
      '若干の海面変動': 'この地震により、日本の沿岸では若干の海面変動があるかもしれませんが、被害の心配はありません。',
      '調査中': 'この地震による津波の有無を調査中です。',
      '海面変動の可能性': '震源が海底のため、津波が発生するおそれがあります。',
      '注意報': '現在津波注意報を発表中です。',
      '警報等': '現在津波警報等を発表中です。',
      '不明': '津波情報は不明です。',
    } satisfies Record<DomesticTsunami, string>,
    /**
     * 津波の区分を決めた固定付加文のコードごとの文。気象庁のコード表の文を読む。0211 だけは括弧書きを除いた文
     * （2026-10-23 ユーザー選択「気象庁の原文を読む (Recommended)」）
     */
    domesticTsunamiCode: {
      ...DOMESTIC_TSUNAMI_CODE_TEXT,
      '0211': '津波警報等を発表中です。',
    } satisfies Record<DomesticTsunamiCode, string>,
    /**
     * 遠地地震の 022x 系のコードごとの文（気象庁のコード表の文）。**日本語の読み上げはこの表を読まない** —— 日本語は付加文の
     * 原文をそのまま読む。日本語以外は原文の代わりにこの表の訳を読む（2026-11-17 ユーザー選択「022x の文を訳して読む (Recommended)」）。
     * この表の文は、訳した文を原文と同じ順に並べるとき、原文の中の位置を探すのにも使う（→ `ttsText.ts` の `translatedForecastSegments`。
     * 一字でも変えると位置が見つからず、並びが崩れる）
     */
    foreignTsunamiCode: {
      '0221': '太平洋の広域に津波発生の可能性があります。',
      '0222': '太平洋で津波発生の可能性があります。',
      '0226': '震源の近傍で津波発生の可能性があります。',
      '0228': '一般的に、この規模の地震が海域の浅い領域で発生すると津波が発生することがあります。',
    } satisfies Record<ForeignTsunamiCode, string>,
  },
  tsunami: {
    /** 津波情報の名前（気象庁の文を読む前置き） */
    infoLabel: '津波情報',
    /** 等級の呼び名（画面と同じ語。不明は名前を言わない） */
    gradeName: TSUNAMI_GRADE_NAME satisfies Record<TsunamiGrade, string>,
    /** 予想・観測の波高の表記（全角・「ｍ」）を読む形へ（「1メートル」） */
    heightToSpeech: (description: string) => description
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/．/g, '.')
      .replace(/(\d)\s*[mｍ]/g, '$1メートル'),
    /**
     * 数値で表せない予想波高（気象庁の「巨大」「高い」）を文に馴染む言い方に直す表。活用が違うので表記ごとに持つ。
     * 表になければそのまま読む
     */
    nonNumericHeight: {
      巨大: '巨大な津波',
      高い: '高い津波',
    } as Record<string, string>,
    /** 観測した波高に「以上」を補う（画面の辞書と同じ付け方） */
    heightLabel: { height: (description: string, over: boolean) => jaMessages.tsunami.height(description, over) },
    /**
     * 区域名どうしの区切り（予想波高の文・等級の文）。区域名の訳がコンマを含む言語では、区域の切れ目を聞き分けられる区切りにする
     * （地震情報の `quake.regionSep` と同じ考え方）
     */
    areaSep: '、',
    /** 予想波高の組（同じ波高の区域の並び）どうしの区切り */
    heightGroupSep: '、',
    /** 観測点の文で、区域名と観測点名の間 */
    districtStationSep: '、',
    /** 観測点の文で、観測点どうし・区域の組どうしの区切り */
    stationSep: '、',
    /** 区域名の後ろの予想波高。予想と観測を言い分ける言語は、ここで「予想」を言う */
    forecastHeightAt: (height: string) => `で${height}`,
    /** 観測点名の後ろの観測した波高（欠測の前に観測できていた分の文） */
    observedHeightAt: (height: string) => `で${height}`,
    /** 波高を並べた文の締め */
    heightsExpected: 'が予想されています。',
    /** 波高が無い区域にも同じ等級が出ている */
    alsoIssued: (grade: string) => `にも${grade}が発表されています。`,
    /** 下位の等級の区域を、波高つきで挙げる文の頭 */
    issuedForAreasBelow: (grade: string) => `次の地域に${grade}が発表されています。`,
    /** 区域名の後ろ（発表されている） */
    issuedFor: (grade: string) => `に${grade}が発表されています。`,
    /** 区域名の後ろ（発表された） */
    issuedForAreas: (grade: string) => `に${grade}が発表されました。`,
    /** 最上位の等級の発表（波高つきの文の頭） */
    gradeIssued: (grade: string) => `${grade}が発表されました。`,
    /** 引き下げ（波高つきの文の頭） */
    downgradedBelow: (grade: string) => `${grade}に切り替えられました。現在、次の地域に${grade}が発表されています。`,
    /** 引き下げ（区域名の前） */
    downgradedLead: (grade: string) => `${grade}に切り替えられました。現在、`,
    /** 区域の解除（区域名の後ろ） */
    areaLifted: (grade: string) => `の${grade}が解除されました。`,
    /** 前の等級を読めない解除区域の呼び名（2026-10-24 ユーザー選択「「津波警報等が解除」 (Recommended)」） */
    warningsEtc: '津波警報等',
    /** 区域の等級が動いた（区域名の後ろ） */
    areaGradeChanged: (from: string, to: string, raised: boolean) => `の${from}が${to}に${raised ? '引き上げられました' : '切り替えられました'}。`,
    /** 予想波高だけが変わった報の頭 */
    forecastHeightChanged: '予想される津波の高さが変わりました。',
    /**
     * 気象庁の付加文が採れなかったときの避難の呼びかけ（画面と同じ文）。気象庁の文を読まない言語はいつもこれ。
     * 日本語の画面の辞書を引く `fallbackEvacuationAction` は日本語の語表だけが使う（ほかの言語は自分の画面の辞書を引く）
     */
    fallbackEvacuation: (grade: TsunamiGrade) => fallbackEvacuationAction(grade),
    /** 原因地震の震源の文の頭（1 つ目の地震） */
    sourceLead: 'この地震の震源は',
    /** 原因地震の震源の文の頭（2 つ目以降の地震） */
    sourceLeadOther: 'また、もう一つの地震の震源は',
    /** 原因地震の規模の前 */
    sourceMagnitudeLead: '、マグニチュードは',
    /** 原因地震の規模の数値（小数点の読み方が違う言語はここで直す） */
    sourceMagnitude: (magnitude: string) => magnitude,
    /** 原因地震の文の締め */
    sourceTail: 'です。',
    /** 原因地震の震源名が変わった */
    sourceHypocenterAmended: (first: boolean, name: string) => `${first ? 'この地震の' : 'もう一つの地震の'}震源は${name}に更新されました。`,
    /** 原因地震の規模が変わった */
    sourceMagnitudeAmendedTo: (first: boolean, magnitude: string) => `${first ? 'この地震の' : 'もう一つの地震の'}マグニチュードは${magnitude}に更新されました。`,
    /** 原因地震の規模が数値でない値へ変わった */
    sourceMagnitudeAmended: (first: boolean, predicate: string) => `${first ? 'この地震の' : 'もう一つの地震の'}マグニチュードが更新されました。${predicate}`,
    /** 原因地震の深さが変わった */
    sourceDepthAmendedTo: (first: boolean, depth: string) => `${first ? 'この地震の' : 'もう一つの地震の'}震源の深さは${depth}に更新されました。`,
    /**
     * 失効時刻（等級を名乗る文の後ろ。値の前）。`time` は後ろに続く時刻の文字列（時刻の前の語が時で変わる言語が使う。
     * ポルトガル語・スペイン語の 1 時台の冠詞）
     */
    expiryLead: (grade: string, _time: string) => `この${grade}の失効時刻は、`,
    /** 失効時刻（値の後ろ） */
    expiryTail: 'です。',
    /**
     * 失効時刻が動いた（値の前）。`extended` は延びたか（早まったなら偽）。延長か変更かを時刻の前で言う言語は、ここで言う
     * （2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 15 節。日本語は値の後ろの `expiryExtended`・`expiryChanged` で言う）。
     * `time` は {@link expiryLead} と同じ
     */
    expiryChangeLead: (grade: string, _extended: boolean, _time: string) => `${grade}の失効時刻が、`,
    /** 失効時刻が延びた（値の後ろ。2026-10-24 ユーザー選択「延長と言う (Recommended)」） */
    expiryExtended: 'に延長されました。',
    /** 失効時刻が早まった（値の後ろ） */
    expiryChanged: 'に変更されました。',
    /** 誤って発表した報の取消 */
    retracted: '津波警報等は誤って発表されたため取り消されました。',
    /** 津波予報の失効 */
    expired: '津波予報は失効しました。',
    /** 全区域の解除（通知の文面と同じ） */
    allLifted: TSUNAMI_ALL_LIFTED_SENTENCE,
    /** 津波情報（VTSE51）だけの取消 */
    infoRetracted: '津波情報は取り消されました。',
    /** 沖合の津波観測に関する情報（VTSE52）だけの取消 */
    offshoreRetracted: '沖合の津波観測に関する情報は取り消されました。',
    /** 第 1 波の押し引き（電文の「押し」「引き」）。無ければ「第一波」 */
    firstWaveKind: (initial: string | undefined) => (initial ? `${initial}波` : '第一波'),
    /**
     * 観測点の波高の句。`firstWave` は織り込む第 1 波、`at` は最大波の時刻、`value` は波高、`updated` は前に読んだ波高から
     * 上がったか（偽なら初めての観測）。述語の語幹（`stemUpdated`・`stemObserved`）を句のどこに置くかは言語が決める
     */
    heightClause: (firstWave: { time: string; initial: string } | null, at: string | null, value: string, updated: boolean) =>
      `で${firstWave ? `、${firstWave.time}に${firstWave.initial}が到達し、` : ''}${at ? `${at}に` : ''}${value}${updated ? STEM_UPDATED : STEM_OBSERVED}`,
    /** 観測情報の名乗り（日本語は後ろに気象庁の見出し文が続く。気象庁の文を読まない言語は在処の文が続く） */
    observationInfoLead: '津波観測に関する情報。',
    /** 最大波が上がった観測点の文の頭 */
    maxWaveUpdatedLead: '次の地点で最大波が更新されました。',
    /** 初めて観測した観測点の文の頭 */
    newlyObservedLead: '新たに、次の地点で津波を観測しました。',
    /** 述語の語幹（更新。`heightClause` が句に入れる） */
    stemUpdated: STEM_UPDATED,
    /** 述語の語幹（観測。`heightClause` が句に入れる） */
    stemObserved: STEM_OBSERVED,
    /** 述語の結び（更新） */
    tailUpdated: 'されました。',
    /** 述語の結び（観測・確認） */
    tailObserved: 'しました。',
    /** 上限で落とした観測点（観測） */
    omittedObserving: (n: number) => `ほか${n}地点でも観測しています。`,
    /** 上限で落とした観測点（到達） */
    omittedArrival: (n: number) => `ほか${n}地点でも到達を確認しています。`,
    /** 上限で落とした観測点（時刻の更新） */
    omittedUpdated: (n: number) => `ほか${n}地点でも更新されています。`,
    /** 上限で落とした観測点（欠測。観測点そのものの状態なので「も」） */
    omittedMissing: (n: number) => `ほか${n}地点も欠測となっています。`,
    /** 上限で落とした観測点（警報に相当する津波） */
    omittedWarningLevel: (n: number) => `ほか${n}地点でも津波警報に相当する津波を観測しています。`,
    /** 到達確認の文の頭（第 1 波の時刻を読める地点があるとき） */
    arrivalLead: '次の地点で津波の到達を確認しました。',
    /** 第 1 波を織り込んだ句 */
    firstWaveObservedClause: (time: string, initial: string) => `で${time}に${initial}を観測`,
    /** 第 1 波が訂正された句 */
    firstWaveUpdatedClause: (time: string, initial: string) => `で${time}の${initial}へ更新`,
    /** 到達だけを確認した句 */
    arrivalConfirmedClause: 'で到達を確認',
    /** 到達だけを確認した文の結び（地点名の後ろ） */
    arrivalConfirmedTail: 'で到達を確認しました。',
    /** 到達した地点の最大波高（観測中） */
    maxHeightObserving: '最大波高は観測中です。',
    /** 到達した地点の最大波高（微弱） */
    maxHeightWeak: '最大波高は微弱です。',
    /** 時刻だけが更新された句（時刻が読めなければ null） */
    updatedAtClause: (at: string | null) => (at ? `で${at}へ更新` : 'で更新'),
    /** 最大波の時刻の更新の文の頭 */
    maxHeightTimeLead: '次の地点で最大波の観測時刻が更新されました。',
    /** 最大波の時刻の更新（地点名の後ろ） */
    maxHeightTimeTail: 'で、最大波の観測時刻が更新されました。',
    /** 欠測の観測点の最大波の時刻の更新の文の頭（2026-10-24 ユーザー選択「欠測を前に置く (Recommended)」） */
    missingMaxHeightTimeLead: '欠測となっている観測点で、最大波の観測時刻が更新されました。',
    /** 欠測の観測点（地点名の前） */
    missingPrefix: '欠測となっている',
    /** 第 1 波の訂正の文の頭 */
    firstWaveUpdatedLead: '次の地点で第一波が更新されました。',
    /** 第 1 波の到達の文の頭 */
    firstWaveArrivedLead: '次の地点で第一波の到達を確認しました。',
    /** 変化の無い観測情報 */
    observationNoChange: '津波観測に関する情報。観測された波高に変わりはありません。',
    /** 読んだ波高より下がった観測点がある観測情報（下がった値は読まない。2026-10-19 ユーザー承認） */
    observationLowered: '津波観測に関する情報が発表されました。',
    /** 満潮時刻の報の名乗り（電文が見出し文を持たないとき。気象庁の文を読まない言語はいつもこれ） */
    tideFallbackHeadline: '各地の満潮時刻と津波到達予想時刻をお知らせします。',
    /** 満潮時刻の報で変わったもの */
    tide: {
      tide: '満潮時刻が更新されました。',
      arrival: '津波の到達状況が更新されました。',
      arrivalTime: '津波の到達予想時刻が更新されました。',
      none: '内容に変わりはありません。',
    },
    /** 欠測の前に観測できていた分の文の頭 */
    missingObservedLead: 'これまでに',
    /** 欠測の前に微弱な津波を観測していた観測点 */
    weakTsunamiAt: 'で微弱な津波',
    /** 欠測の前に観測できていた分の文の結び */
    missingObservedTail: 'を観測したのち、欠測となっています。',
    /** 欠測（地点名の後ろ。場所の「で」を付けない） */
    missingTail: 'は欠測となっています。',
    /** 警報に相当する津波を観測している（地点名の後ろ） */
    warningLevelTail: 'では、津波警報に相当する津波を観測しています。',
  },
  eew: {
    /** 情報の名前（取消の理由を別の発話で読むときの前置きに渡す） */
    label: '緊急地震速報',
    /** 予報から警報へ切り替わった報の冒頭 */
    upgrade: '緊急地震速報に切り替わりました。',
    /** 警報の対象地方を読む文の締め（句点は文の側で足す） */
    warningRegionsClosing: '強い揺れに警戒してください',
    /** 予想最大長周期地震動階級が 0 の報 */
    lpgmClassZero: '予想最大階級0。',
    /** 取消（最初の報の時刻が分かるとき） */
    cancelledAt: (time: string) => `${time}に発表された緊急地震速報は取り消されました。`,
    /** 取消 */
    cancelled: '緊急地震速報は取り消されました。',
    /** 報の種類ごとの冒頭（震央地名の前に置く） */
    lead: {
      forecast: '地震動予報、',
      warning: '緊急地震速報、',
      hypocenterUpdate: '震源を更新、',
    },
    /** 震央地名が無いときの冒頭だけの文 */
    leadAlone: (lead: string) => lead.replace(/、$/, '。'),
    /** 冒頭と震央地名 */
    leadWithEpicenter: (lead: string, epicenter: string) => `${lead}${epicenter}で地震。`,
    /** 警報の対象地方の名前（電文の名前） */
    warningRegionName: (name: string) => name,
    /** 対象地方が加わった報 */
    warningRegionsAdditional: (names: string, closing: string) => `新たに、${names}でも${closing}。`,
    /** 対象地方 */
    warningRegions: (names: string, closing: string) => `${names}では${closing}。`,
    /** 予想震度を出せない理由ごとの文 */
    noForecast: {
      singleStation: '単独点処理のため、予想震度なし。',
      deep: '深発地震のため、予想震度なし。',
      /** 電文が言い切った最大予想震度 0（2026-10-30 ユーザー選択「予想最大震度 0 (Recommended)」） */
      belowScale1: '予想最大震度0。',
      unknown: '予想震度なし。',
    },
    /** 予想最大震度（上限が定まらない報は「以上」を付ける） */
    maxScale: (scale: number, orAbove: boolean) => `予想最大震度${getIntensityLabelWithApproxAbove(scale, orAbove)}。`,
    /** 予想最大長周期地震動階級（「程度以上」は気象庁の表現） */
    maxLpgmClass: (cls: number, over: boolean) => `予想最大階級${cls}${over ? '程度以上' : ''}。`,
  },
  kyoshin: {
    /**
     * 揺れ検知（2026-10-31 ユーザー選択「地名だけ・1回 (Recommended)」）。`name` は声にする区域名で、決まらない
     * （区域の境界データを取れなかった）ときは null（地名を言わない）
     */
    detected: (name: string | null) => (name ? `${name}で揺れを検知。` : '揺れを検知。'),
    /**
     * 別の地点の揺れ検知（同日ユーザー選択「境を直してから読む (Recommended)」）。区域が決まらないときは「別の地点でも」
     * （同日「埋める・取れない時は「別の地点でも」 (Recommended)」）
     */
    otherRegion: (name: string | null) => (name ? `${name}でも揺れを検知。` : '別の地点でも揺れを検知。'),
  },
  internationalTsunami: {
    /** 情報の名前（名乗りは `common.issued`・`common.updated` で組む） */
    label: INTERNATIONAL_TSUNAMI_NAME,
    /** 通信試験の報 */
    communicationsTest: `${INTERNATIONAL_TSUNAMI_NAME}の通信試験です。`,
    /** 津波発生の可能性（`EVALUATION`）の言い方。キーは電文の英文の 5 種 */
    evaluation: EVALUATION_SPEECH satisfies Record<InternationalTsunamiEvaluation, string>,
    /**
     * 発生時刻（日本時間の日・時・分）。日本語は 1 日も「1日」と書く（中継のプッシュ通知と同じ文。→ `utils/internationalTsunamiSpeech.ts`。
     * 地震情報の `common.dayTime` は「ついたち」と書くので借りない）
     */
    when: (d: number, hour: number, minute: number) => `${d}日${hour}時${minute}分`,
    /** 地震カードに結べなかったときの震源（電文の震央の位置） */
    coordinate: (lat: number, lon: number) =>
      `${lat < 0 ? '南緯' : '北緯'}${Math.abs(lat).toFixed(1)}度、${lon < 0 ? '西経' : '東経'}${Math.abs(lon).toFixed(1)}度`,
    /**
     * 名乗りの後ろの本文。**日本語は中継のプッシュ通知と同じ文**（`utils/internationalTsunamiSpeech.ts` の `internationalTsunamiBody`。
     * あちらは中継へ写して使うので、このファイルから読まない）。欠けた要素は句ごと落とす
     */
    body: (p: InternationalTsunamiSpeechParts) => {
      const subject = `${p.when ? `${p.when}頃、` : ''}${p.where ? `${p.where}で` : ''}発生した${p.depthKm !== null ? `深さ${p.depthKm}キロメートル、` : ''}${p.magnitude !== null ? `マグニチュード${p.magnitude}の` : ''}地震`
      return p.evaluation !== null
        ? `${subject}について、${p.evaluation}と発表されました。`
        : `${subject}について、${INTERNATIONAL_TSUNAMI_NAME}が発表されました。`
    },
  },
  timeSignal: {
    /**
     * 時報の文（2026-11-04 ユーザー選択の 4 形。既定は「15時30分です」）。`hour`・`minute` は端末の現地時刻。
     * 正時は分を読まない。12 時間制は 0〜11 時に午前・午後を付ける（正午は「午後0時」）
     */
    say: (phrase: TimeSignalPhrase, hour: number, minute: number, clock: TimeSignalClock): string => {
      const t = japaneseClockText(hour, minute, clock)
      switch (phrase) {
        case 'oshirase': return `${t}をお知らせします`
        case 'desu': return `${t}です`
        case 'narimashita': return `${t}になりました`
        case 'bare': return t
      }
    },
  },
}
