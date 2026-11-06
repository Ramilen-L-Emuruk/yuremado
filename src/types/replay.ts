// リプレイ（過去の電文を時系列に流し直す機能）の共通型。
//
// 取得元は複数あるが、再生の仕組みは共通なのでここに型を置く。
//   - DMDATA の日次アーカイブ（services/dmdataReplay.ts）
//   - ローカル履歴アーカイブ: 収録済み JSON（services/localArchiveReplay.ts）
//   - テストボタン: 読んだ電文を「いま」へ寄せたもの（utils/testScenarioReplay.ts）
import type {
  AppEvent, JMAQuake, JMATsunami, JMALpgm, JMANankai, JMANankaiCommentary, JMAKohatsu,
  JMAQuakeNotice, JMAEarthquakeCount, JMAEstimatedIntensity, JMAInternationalTsunami, TelegramLogEntry,
} from './earthquake'

export type ReplayPayload =
  | { kind: 'event'; event: AppEvent }
  | { kind: 'lpgm'; data: JMALpgm }
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'nankaiCommentary'; data: JMANankaiCommentary }
  | { kind: 'kohatsu'; data: JMAKohatsu }
  | { kind: 'quakeNotice'; data: JMAQuakeNotice }
  | { kind: 'earthquakeCount'; data: JMAEarthquakeCount }
  /** 推計震度分布図（IXAC41）。**唯一の二進電文**で、分割配信されるため結合してから読む */
  | { kind: 'estimatedIntensity'; data: JMAEstimatedIntensity }
  /** 国際津波関連情報（WEPA60）。**唯一の平文の電文** */
  | { kind: 'internationalTsunami'; data: JMAInternationalTsunami }

export interface ReplayEntry {
  payload: ReplayPayload
  /** この電文を発火させる再生時刻。 */
  replayTime: Date
  /** true なら音・通知を鳴らさずに状態だけ復元する（初期状態の再現に使う）。 */
  silent?: boolean
  /**
   * 電文ログへ積む行。電文から組んだものでなければ `null`。
   *
   * **任意（`?`）にしない。** 電文を組む経路を新しく足したとき、渡し忘れると
   * その経路の電文だけ電文ログに出なくなる —— 画面からは「届かなかった」のと
   * 見分けが付かず、例外もログも出ない。必須にしておけば型検査が落とす。
   *
   * `null` を書くのは「電文を読んで組んだものではない」ときだけ（統合の結果として
   * 作り直したカード・合成のイベント）。
   */
  logEntry: TelegramLogEntry | null
}

/**
 * 電文ログにだけ積む行。**地図・カード・音・読み上げには何も流さない。**
 *
 * 再生はライブと同じに電文ログへ積む（2026-11-04 ユーザー選択「ライブと同じに積む (Recommended)」。
 * 2026-10-23 選択「今回は載せない（推奨）」を覆したもの）。取り込まない電文（捨てた試験報・扱わない種類・
 * 取り込まない側の緊急地震速報・結合待ちの断片）と、読めなかった電文がここへ入る。
 * 読めなかった電文は、これとは別に取りこぼし（`skippedByDay`）にも数える —— 行を積むことと、取りこぼしに数えることは別。
 */
export interface ReplayLogOnlyEntry {
  /** 行を積む再生時刻（その電文を受信した時刻。窓の判定と同じ値）。 */
  replayTime: Date
  logEntry: TelegramLogEntry
}

/**
 * 取得結果。取りこぼしの件数を呼び出し元へ返すため、電文の配列だけでなく
 * 「読めなかったもの」の数も添える。ログにしか出さないと、UI 上は
 * 「静かな時間帯だった」のか「取りこぼした」のかを区別できない。
 */
export interface ReplayFetchResult {
  entries: ReplayEntry[]
  /**
   * 電文ログにだけ積む行（→ {@link ReplayLogOnlyEntry}）。再生時刻の昇順。
   *
   * **`entries` へ混ぜない。** `entries` は画面へ流す電文で、初期状態の組み立て・取得元どうしの突き合わせ・
   * 「対象電文 0 件」の判定がその中身を読む。行だけのものを混ぜると、それらが読む中身の型ごと変わる。
   *
   * **任意（`?`）にしない**（理由は `ReplayEntry.logEntry` と同じ）。電文を読まない取得元（ローカル履歴アーカイブ）は空の配列を返す。
   */
  logOnlyEntries: ReplayLogOnlyEntry[]
  /**
   * 取り込めなかった電文の数（目録エントリの異常・本体の破損・パース失敗の合計）を
   * **JST 日ごとに**持つ。
   *
   * 件数ひとつにしない理由は `utils/telegramLoss.ts` の `skippedByDay`（同じ日を二度読んだ
   * ときに二重計上せず、別の日の分は失わないため）。日が辿れないものは `UNKNOWN_SKIP_DAY`。
   */
  skippedByDay: ReadonlyMap<string, number>
  /**
   * 読めなかった取得元の識別子（1 つでも成功していれば例外にはしない）。
   *
   * アーカイブはその URL、アーカイブがまだ無い日を埋める当日経路は引けなかった一覧
   * （`live-telegram:<日>` 等）と全報を引けなかった EEW イベント（`eew:<eventId>`）。
   * その日ぶんが丸ごと読めなかった場合は `live:<JST 日付>`。
   *
   * 件数ではなく識別子を返すのは、呼び出し元が重複を除けるようにするため。本編と初期状態は
   * 日付範囲が重なるので同じアーカイブを両方が読む。取得自体は `archiveCache` により 1 回だが、
   * 件数で返すと呼び出し元が単純合算して実数の 2 倍を表示してしまう。
   *
   * **429 の窓で見送った取得元はここへ入れない**（→ `rateLimitedSources`）。
   */
  failedArchiveUrls: string[]
  /**
   * 429 の窓が明けるまで取りに行かなかった取得元の識別子（DMDATA の取得だけが入れる）。
   *
   * **`failedArchiveUrls` と分ける。** 混ぜると 3 つが壊れる:
   *
   * 1. **利用者に打てる手が違う。** 取得の失敗は再読み込みで直りうるが、こちらは窓が明けるまで
   *    （最長 30 分）待つのが正しい。同じ枠にすると「再読み込みで取得し直します」という
   *    案内が嘘になる
   * 2. **全滅判定の分母が変わる。** 「使おうとした取得元がすべて読めなかった」ときだけ例外に
   *    する仕組みは認証切れ・全断を捕まえるためのもので、こちら側の意図的な見送りを混ぜると、
   *    窓が広いあいだ**取れていた分ごと捨てる**
   * 3. 表示側が文面を分けられない
   */
  rateLimitedSources: string[]
  /**
   * 429 の窓が明けるまで取りに行かなかった**電文**の数。
   *
   * **`rateLimitedSources`（取得元）とは単位が違う**ので別に持つ。`skipped` と
   * `failedArchiveUrls` を分けているのと同じ理由で、表示側は「取得元N件」
   * 「電文N件」と単位を分けて出すため、混ぜると文面が嘘になる。
   *
   * **`skipped` にも数えない。** あちらは恒久的に失ったもので、こちらは待てば取れる。
   */
  rateLimitedTelegrams: number
  /**
   * 読めなかった取得元（`failedArchiveUrls`・`rateLimitedSources` の識別子）のうち、**その日の分を丸ごと
   * 失ったもの**と、その日（日本時間の `YYYY-MM-DD`）。DMDATA の取得だけが入れる。
   *
   * 載るのは、その日のアーカイブの束を読めなかった・429 で見送った、当日経路の一覧を引けなかった・
   * その日の当日経路が丸ごと失敗した、のいずれか。地震 1 つ分だけ失った印（`eew:<eventId>`）は載せない。
   *
   * 鍵を入れた人の再生が、鍵で読めなかった日だけを中継の警報で埋めるのに使う（→ `services/replaySources.ts`）。
   * 識別子は日を持たない（アーカイブの URL）ので、日は取得する側でしか分からない。
   */
  lostSourceDays: ReadonlyMap<string, string>
}

/**
 * 地震カードの履歴を復元した結果。
 *
 * 「初期状態」（`ReplayFetchResult`）とは目的が違う。あちらは指定時刻の時点で発表中だった
 * 津波・EEW を再現するための遡り（24 時間）で、こちらは**カードの一覧をライブ接続時と
 * 同じ厚みにする**ための遡り（DMDATA は 7 日を読み切る。24 時間のまま
 * カードを作ると静かな日ほど一覧が痩せる）。初期状態に足す 24 時間より前の
 * 津波・帯・長周期もここから取る（→ `useReplayController` の `assemblePreWindowMaterial`）。
 *
 * 電文は統合前の生の配列で返す。同一イベントの続報どうしの畳み込みは、ライブの履歴取得と
 * 同じ `mergeQuakeHistory` に任せる（経路ごとに畳み込み方が分かれると結果が食い違う）。
 */
export interface QuakeHistoryResult {
  quakes: JMAQuake[]
  /**
   * 同じ遡り幅で拾った津波電文（古い順）。
   *
   * **「いま発表中か」の判定は呼び出し側が持つ。** 期限の引き継ぎ・解除の照合・失効の予約は
   * イベント単位の判断で、電文を集めるここには置けない
   * （→ `tsunami-spec.md` §3「有効期限は報ではなく津波に付く」）。
   *
   * **地震の件数で打ち切らない。** 発表中の津波は数日前に出たものが続いていることがあり、
   * 地震のカードが揃った日で切ると拾えない。
   */
  tsunamis: JMATsunami[]
  /**
   * さらに古い方に在庫がありそうか。
   *
   * 「もっと見る」の出し分けに使う。**判定の材料はアーカイブの目録だけ** —— この窓に
   * アーカイブが 1 件でもあれば、その手前にも配信元が日次でファイルを作っている。
   * 目録が空になるのは在庫の端（契約の保存開始＝地震津波関連は 2020-11-18）に達したときで、
   * そこで自然に止まる。
   *
   * **当日経路の日は数えない。** あれは「アーカイブがまだ生成されていない直近」を埋めるもので、
   * 在庫の端とは無関係。数えると、在庫が尽きた窓でも当日経路の日が残って真を返し続け、
   * 押しても何も増えないボタンが永久に残る。
   *
   * **この判定は「配信元のアーカイブに 1 窓ぶん（`HISTORY_WINDOW_DAYS`）を超える連続した
   * 欠落が無い」ことを前提にしている。** 前提が崩れると、在庫の途中でボタンが止まり、それより
   * 古い実在のデータへ二度と到達できない。**そういう欠落が実在するかは確かめていない**
   * （窓の中の飛び飛びの欠落は `log.warn` で記録するが、窓が丸ごと空になる形はここで止まる）。
   *
   * **打ち切ったときは真にしない** —— あれは「もう要らない」で、在庫が残っているかとは別の話。
   */
  hasMore: boolean
  /**
   * 地震を取り込んだ最古の JST 日（`YYYY-MM-DD`）。1 件も読まなかったときは `null`。
   *
   * **次にどこから続きを読むかを決める値。** 呼び出し側はこの日の手前を次の窓の上端にする
   * （→ `useEarthquakes` の `historyCursorRef`）。これが無いと「もっと見る」は毎回同じ範囲を
   * 最初から読み直すことになり、遡るほど 1 回の解析量が増える。
   *
   * **入るのは「最後まで読み切った日」だけ。** 次は含まない。
   *
   * - **取得に失敗した日**（本体のダウンロード失敗・429・`telegrams.json` の欠落・目録の
   *   解析失敗・当日経路の例外）。窓は重ならないので、失敗した日を跨いでカーソルを進めると
   *   **その日は二度と要求されない**。とくに 429 は待てば取れるものなので、跨ぐと設計意図
   *   （窓が明けるまで待つ）ごと失われる
   *
   * **個々の電文の解析失敗（`skipped`）は日の失敗に数えない。** 壊れた 1 通のためにその日を
   * 読み直しても、次も同じ 1 通で失敗するだけ。
   */
  oldestLoadedDay: string | null
  /**
   * 地震カードと同じ遡り幅で復元する、地震情報以外の電文（長周期は地震ごとに最新 1 通へ畳み、帯は電文ごと。古い順）。
   *
   * **初期状態（24 時間）では足りないものがここへ入る。** 長周期地震動は地震ごとに紐づくので
   * カードの一覧と同じ厚みが要り、帯（地震回数・お知らせ・南海トラフ臨時情報／解説情報・
   * 後発地震注意情報）は 24 時間より長く画面に出続ける。**種別の列挙は
   * `HISTORY_EXTRA_TYPES` が単一情報源。** どれも取得済みのアーカイブに入っているので、
   * 拾うだけで追加の通信は要らない。
   *
   * 津波は入れない（報を跨いで生死を判定するので全報が要る。別の欄 `tsunamis` で渡す）。
   * 緊急地震速報も入れない（初期状態へは足さない。理由は `assemblePreWindowMaterial`）。
   * 推計震度分布図は入れる（地震ごとに持つので、遡った地震のカードにも分布が付く）。
   */
  extras: ReplayEntry[]
  /** 取り込めなかった電文の数を **JST 日ごとに**（理由は `ReplayFetchResult.skippedByDay`）。 */
  skippedByDay: ReadonlyMap<string, number>
  /**
   * 読めなかった取得元の識別子。
   *
   * アーカイブはその URL、アーカイブがまだ無い日を埋める当日経路は `live:<JST 日付>`。
   * 両者を 1 本の集合で持つのは全滅判定（共通原因の検出）を成立させるため
   * （`dmdataReplay.ts` の `liveSourceId` 参照）。
   *
   * **429 の窓で見送った取得元はここへ入れない**（→ `rateLimitedSources`）。
   */
  failedArchiveUrls: string[]
  /**
   * 429 の窓が明けるまで取りに行かなかった取得元の識別子（DMDATA の取得だけが入れる）。
   *
   * 分ける理由は `ReplayFetchResult.rateLimitedSources` と同じ。
   */
  rateLimitedSources: string[]
  /** 429 の窓で見送った**電文**の数（単位が違うので取得元とは別に持つ）。 */
  rateLimitedTelegrams: number
}

/**
 * リプレイの開始時に復元する地震カードの履歴。{@link QuakeHistoryResult} に、再生中の
 * 「もっと見る」で続きを読む口を足したもの。
 *
 * **続きの読み方は取得元が決める**ので、取得元ごとの口をここで包んで渡す（DMDATA はカーソル、
 * ローカル履歴アーカイブは続きを持たない）。受け手（`useEarthquakes`）は取得元を知らずに、押されたらこれを呼ぶだけでよい。
 * 受け手がライブの「もっと見る」の経路を使うと、ライブの最新履歴を読んで再生時刻より未来の地震が
 * 一覧へ混ざる。
 *
 * ライブの起動時の履歴はこの形を通らない（続きはフックが自分で読む）ので、続きの口は
 * `QuakeHistoryResult` には持たせていない。
 */
export interface ReplayQuakeHistoryResult extends QuakeHistoryResult {
  /**
   * さらに古い方を読む。**読む先が無ければ `null`**（「もっと見る」を出さない）。
   *
   * 返す結果にも同じ口が付く（押すたびに 1 つ先へ進む）。ローカル履歴アーカイブは収録範囲の外を
   * 持たないので常に `null`。
   *
   * @param signal 止める合図（再生の停止・始め直しで立つ）
   */
  loadMore: ((signal: AbortSignal | null) => Promise<ReplayQuakeHistoryResult>) | null
}
