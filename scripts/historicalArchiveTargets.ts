// ローカル履歴アーカイブ 4 本の設定（取得日・収録範囲・警報が出た地震の一覧・再生の起点・既知の欠け）。
//
// **生成スクリプト（build-historical-archive-*.ts）と取得スクリプト（fetch-wayback-fc-hist.ts・
// fetch-pub-hist.ts）は、どれもここを読む。** 以前は 3 か所に同じ値を書き写していて、片方だけ直すと
// 取得した範囲と生成する範囲が黙ってずれた。
import type { EewEventSpec } from './localEarthquakeArchiveBuilder'

/**
 * 既知の欠けの種類。
 *
 * - `fc-hist-unavailable`: 予報の発表状況（fc_hist）の目録には載っているが、Wayback Machine が本体を
 *   返さなかった地震（警報が出た地震でもなければ、pub_hist でも補えない）
 * - `no-forecast`: fc_hist のページは読めたが、予測震度を 1 報も持たない地震（深発地震で確認済み）
 * - `no-normal-report`: fc_hist のページに、検知の行と取消の行しか無い地震（通常の報が 0 件）
 * - `no-cdx-date`: fc_hist の目録を引けていない日。その日の予報だけで終わった地震は入らない
 */
export type EewGapKind = 'fc-hist-unavailable' | 'no-forecast' | 'no-normal-report' | 'no-cdx-date'

export interface KnownGap {
  kind: EewGapKind
  /** 地震ごとの欠けは EventID。日ごとの欠け（`no-cdx-date`）は持たない */
  eventId?: string
  /** 日本時間の日付（`YYYYMMDD`） */
  date: string
  reason: string
}

export interface ArchiveTarget {
  id: string
  /** fc_hist だけにある地震の entry.id の接頭辞。後ろに EventID が付く */
  idBase: string
  /** pub_hist の個別ページの親 URL */
  pubHistBase: string
  /** 気象庁の発表状況ページで確認済みの、この地震活動で緊急地震速報（警報）が発表された地震 */
  pubHistEvents: EewEventSpec[]
  /** 電文一覧・fc_hist の目録を引く日（`YYYYMMDD`・日本時間） */
  dates: string[]
  /** 収録範囲。終わりは含まない（半開区間。`coveredRangesFromDates` と同じ） */
  windowStart: Date
  windowEnd: Date
  /**
   * 設定の窓の「再生」ボタンの起点（index.json の firstEventTime。ボタンはこの 1 分前から再生する）。
   * 窓の他の地震は収録だけして、起点にはしない。値は窓の全地震を入れる前の index.json の firstEventTime
   * そのまま（2026-10-25 ユーザー選択「前の起点に戻す (Recommended)」）
   */
  replayStartTime: string
  /**
   * 既知の欠け。**ここに無い欠けが生成で出たら止まる。ここにあるのに出なかった欠けも止まる**（一覧を
   * 実態とずらさないため）。アーカイブ JSON の形は変えない —— 欠けは仕様書（settings-pwa-spec.md §6
   * 「収録の限界」）とこの一覧に残す（2026-10-25 ユーザー選択「一覧＋5 件を取り直す」）
   */
  knownGaps: KnownGap[]
}

const ev = (idPrefix: string, dir: string): EewEventSpec => ({ idPrefix, dir })
const noCdx = (date: string): KnownGap => ({ kind: 'no-cdx-date', date, reason: 'fc_hist の目録を引けていない（Wayback の応答が空または 504）' })
const noCdxArchived = (date: string): KnownGap => ({ kind: 'no-cdx-date', date, reason: 'fc_hist の控えが Wayback に無い' })
const gap = (kind: EewGapKind, eventId: string, reason: string): KnownGap => ({ kind, eventId, date: eventId.slice(0, 8), reason })

const DEEP_NO_FORECAST = '予測震度の欄が全報「---」（深発地震）'

export const ARCHIVE_TARGETS = {
  '2016-kumamoto': {
    id: '2016-kumamoto',
    idBase: '2016kumamoto',
    pubHistBase: 'https://www.data.jma.go.jp/eew/data/nc/pub_hist/2016/04',
    pubHistEvents: [
      ev('2016kumamoto-foreshock', '20160414212638'), ev('2016kumamoto-as01', '20160414220739'),
      ev('2016kumamoto-as02', '20160414223846'), ev('2016kumamoto-as03', '20160415000349'),
      ev('2016kumamoto-mainshock', '20160416012510'), ev('2016kumamoto-as04', '20160416014412'),
      ev('2016kumamoto-as05', '20160416014601'), ev('2016kumamoto-as06', '20160416030315'),
      ev('2016kumamoto-as07', '20160416035558'), ev('2016kumamoto-as08', '20160416041512'),
      ev('2016kumamoto-as09', '20160416071139'), ev('2016kumamoto-as10', '20160416074226'),
      ev('2016kumamoto-as11', '20160416094838'), ev('2016kumamoto-as12', '20160416112859'),
      ev('2016kumamoto-as13', '20160416142706'), ev('2016kumamoto-as14', '20160416160204'),
      ev('2016kumamoto-as15', '20160417193033'), ev('2016kumamoto-as16', '20160418204204'),
      ev('2016kumamoto-as17', '20160419175215'),
    ],
    // 警報が出た 19 件（前震 4/14 21:26 〜 誘発地震 4/19 17:52）を漏れなく含むよう、最後の地震の
    // 翌日 0 時（日本時間）まで取る。日付と収録範囲は必ず連動させる（収録範囲より後の EEW は再生できない）
    dates: ['20160414', '20160415', '20160416', '20160417', '20160418', '20160419'],
    windowStart: new Date('2016-04-14T12:00:00+09:00'),
    windowEnd: new Date('2016-04-20T00:00:00+09:00'),
    // 前震（4/14 21:26）の緊急地震速報の第1報
    replayStartTime: '2016-04-14T12:26:42.500Z',
    // 2026-10-25 の生成の記録: EEW は fc_hist 142 地震・pub_hist 3 地震（4/14 の 3 件）。fc_hist の発生時刻は
    // 震源カタログで 122 地震を補い（うち 21 地震は候補が複数）、20 地震は EventID の時刻で代えた（うち 11 地震は
    // 取消の地震で、震源要素の表に位置が無い）。取消の地震は 11、その取消前の報（震央地名が空）は 21 報。
    // fc_hist から報を作れず pub_hist で補った地震・通常の報が無い地震はどちらも 0
    knownGaps: [
      noCdx('20160414'),
      gap('no-forecast', '20160415002615', DEEP_NO_FORECAST),
      gap('no-forecast', '20160419110312', DEEP_NO_FORECAST),
      gap('no-forecast', '20160419162409', DEEP_NO_FORECAST),
    ],
  },
  '2016-tottori': {
    id: '2016-tottori',
    idBase: '2016tottori',
    pubHistBase: 'https://www.data.jma.go.jp/eew/data/nc/pub_hist/2016/10',
    pubHistEvents: [ev('2016tottori-mainshock', '20161021140724'), ev('2016tottori-as01', '20161021145318')],
    // 警報級の余震は本震当日の 1 件のみで津波も無いため、本震当日＋翌日（訂正報・改定報の余地）を取る
    dates: ['20161021', '20161022'],
    windowStart: new Date('2016-10-21T00:00:00+09:00'),
    windowEnd: new Date('2016-10-23T00:00:00+09:00'),
    // 本震（10/21 14:07）に先立つ 12:12 の地震の震度速報
    replayStartTime: '2016-10-21T12:13:00+09:00',
    // 2026-10-25 の生成の記録: EEW は fc_hist 21 地震（2017 年に控えられたページで、発生時刻が秒まで書かれている）。
    // 20 地震はページの値をそのまま使い、秒の無い 1 地震（20161021145318）は震源カタログで補った
    knownGaps: [noCdx('20161022')],
  },
  '2018-osaka': {
    id: '2018-osaka',
    idBase: '2018osaka',
    pubHistBase: 'https://www.data.jma.go.jp/eew/data/nc/pub_hist/2018/06',
    pubHistEvents: [ev('2018osaka-mainshock', '20180618075838')],
    // 警報級の余震・津波が無く単発の地震のため、本震当日＋翌日（訂正報・改定報の余地）を取る
    dates: ['20180618', '20180619'],
    windowStart: new Date('2018-06-18T00:00:00+09:00'),
    windowEnd: new Date('2018-06-20T00:00:00+09:00'),
    // 本震（6/18 7:58）の緊急地震速報の第1報
    replayStartTime: '2018-06-17T22:58:41.900Z',
    knownGaps: [noCdxArchived('20180618'), noCdxArchived('20180619')],
  },
  '2018-iburi': {
    id: '2018-iburi',
    idBase: '2018iburi',
    // 年月をまたぐので、親 URL に年月を含めず、ディレクトリ名の側に年/月を持たせる
    pubHistBase: 'https://www.data.jma.go.jp/eew/data/nc/pub_hist',
    pubHistEvents: [
      ev('2018iburi-mainshock', '2018/09/20180906030805'), ev('2018iburi-as01', '2018/09/20180906061139'),
      ev('2018iburi-as02', '2018/10/20181005085853'), ev('2018iburi-as03', '2019/02/20190221212246'),
    ],
    // 警報が出た 4 件それぞれの前後 1〜2 日だけを取る（169 日分を続けて取るのは配信元への負荷・
    // 実行時間の両面で非現実的。間の日は「無かった」のではなく取っていない。→ coveredRanges）。
    // 収録範囲の終わりは最終日の翌日 0 時（その日の 00:00 にすると、その日の電文がすべて範囲外になる）
    dates: ['20180906', '20180907', '20181005', '20181006', '20190221', '20190222'],
    windowStart: new Date('2018-09-06T00:00:00+09:00'),
    windowEnd: new Date('2019-02-23T00:00:00+09:00'),
    // 本震（9/6 3:08）の緊急地震速報の第1報
    replayStartTime: '2018-09-05T18:08:10.400Z',
    knownGaps: ['20180906', '20180907', '20181005', '20181006', '20190221', '20190222'].map(noCdxArchived),
  },
} satisfies Record<string, ArchiveTarget>

export type ArchiveId = keyof typeof ARCHIVE_TARGETS
export const ARCHIVE_IDS = Object.keys(ARCHIVE_TARGETS) as ArchiveId[]
