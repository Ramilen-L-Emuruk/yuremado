// 自作地震計ホストの接続状態を、設定の窓に出す 1 行へ直す。
//
// **繋がらない理由を 1 つへ潰さない。** 設定はトグルと URL の 2 つなので、
// 繋がらない状態が「切っている」「URL が空」「URL の形が違う」「ホストが応えない」の
// 4 通りある。ここを「繋がりません」の一語にすると、利用者は何を直せばよいか
// 分からない —— トグルを持つ形にした代償はここで払う（`useSettings.ts` の
// `seismoEnabled` の説明）。
//
// **文の形は自作地震計のホストの管理コンソールと揃える**（2026-10-13 ユーザー承認）。
// 状態は言い切り、内訳は「: X」、次にすることは丁寧形の 1 文で続ける
// （「応答がない。ホストが起動しているか確かめてください」）。括弧は使わない。

import { SEISMO_STATUS_TIMEOUT_MS, type SeismoHostCheck } from '../../services/seismoStream'

/**
 * 画面に出す前の状態。**`SeismoHostCheck` に、通信する手前で決まる 4 つを足したもの。**
 *
 * **`ok` の枝は、画面が読む 4 つだけを `Pick` で取る。** `SeismoHostCheck` の `ok` を
 * そのまま並べると、あちらへ項目が増えるたびにこのファイルの試験まで直すことに
 * なる（作る側が全部の項目を埋めさせられる）—— 画面が読むのは観測点の一覧・
 * 割り当て済みの観測点の数・センサーの数だけで、押し出しを寄せるための割り当ては使わない。
 */
export type SeismoUiStatus =
  /** トグルが切れている。 */
  | { readonly kind: 'disabled' }
  /** URL が空。 */
  | { readonly kind: 'no-url' }
  /** URL の形が違う（スキームの書き忘れなど）。 */
  | { readonly kind: 'invalid' }
  /** 問い合わせている途中。 */
  | { readonly kind: 'checking' }
  | Pick<Extract<SeismoHostCheck, { kind: 'ok' }>, 'kind' | 'stations' | 'sensorCount' | 'assignedStationCount'>
  | Exclude<SeismoHostCheck, { kind: 'ok' }>

export type SeismoStatusTone = 'ok' | 'problem' | 'muted'

export interface SeismoStatusLine {
  readonly text: string
  readonly tone: SeismoStatusTone
}

/**
 * 状態を 1 行へ直す。
 *
 * **失敗の詳細（`detail`）は画面へ出さない。** `fetch` が返す文面
 * （`Failed to fetch` 等）は利用者の行動に繋がらないので、代わりに
 * 「何を確かめればよいか」を書く。詳細は記録へ出る（`seismoStream.ts`）。
 */
export function seismoStatusLine(status: SeismoUiStatus): SeismoStatusLine {
  switch (status.kind) {
    case 'disabled':
      return { text: '—', tone: 'muted' }
    case 'no-url':
      return { text: 'ホストのURLを入力してください', tone: 'muted' }
    case 'invalid':
      return { text: 'URLの形式が正しくない。http:// または https:// から入力してください', tone: 'problem' }
    case 'checking':
      return { text: '確認中…', tone: 'muted' }
    case 'ok': {
      // **観測点の数は設定の割り当てから数える**（2026-10-19 ユーザー承認「割り当てから数える (推奨)」）。
      // 届いたセンサーから数えると、ホストの起動直後や基板が黙っている間は 0 になり、
      // 設定が済んでいるのに「未設定」と出る。割り当てを返さない古いホストだけ、従来どおり
      // 届いたセンサーから組んだ観測点で数える。
      const stationCount = status.assignedStationCount ?? status.stations.length
      // **0 件のときは別の文にする。** 「接続済み: 観測点 0・センサー 0」は、
      // 文字だけ見ると成功か異常か判らない —— ホストは動いているが観測点の設定が
      // まだ、という状態なので、それを名指しする。
      if (stationCount === 0) {
        return { text: '接続済み: 観測点は未設定', tone: 'ok' }
      }
      // **割り当てはあるのに 1 つも届いていない。** 「センサー 0」と出すと、センサーを
      // 繋いでいないのか、繋いだのに届いていないのかが読めない。
      if (status.sensorCount === 0) {
        return { text: `接続済み: 観測点 ${stationCount}・まだ届いていない`, tone: 'ok' }
      }
      // **観測点とセンサーの本数を出す。** 「繋がった」だけでは、繋いだ先が
      // 自分の意図したホストかを確かめられない。センサーの数は届いているもの。
      return {
        text: `接続済み: 観測点 ${stationCount}・センサー ${status.sensorCount}`,
        tone: 'ok',
      }
    }
    case 'unreachable':
      // **ブラウザから分かる範囲の理由で分ける**（2026-10-22 選択「分かる理由を出す (Recommended)」、文面は
      // 2026-10-24 選択「3 つともその文でよい (Recommended)」）。分からないときは従来の 1 文のまま。
      //
      // **確かめることは 1 つに絞る。** ホーム画面から開く前提は、この行の上にある
      // 常時表示の但し書き（「要：ホーム画面に追加してから開く」）が受け持つ ——
      // 両方に書くと確認事項が 2 つに膨らみ、狭いパネルで折り返して読みにくくなる。
      switch (status.reason) {
        case 'timeout':
          return {
            text: `応答がない: ${Math.round(SEISMO_STATUS_TIMEOUT_MS / 1000)}秒待って打ち切った。ホストが起動しているか確かめてください`,
            tone: 'problem',
          }
        case 'mixed-content':
          return {
            text: '繋げない: このページは https なので http のホストへは繋げない。https:// のURLを入力してください',
            tone: 'problem',
          }
        case 'offline':
          return { text: '繋げない: この端末がオフライン。ネットワークに繋いでください', tone: 'problem' }
        case 'unknown':
          return { text: '応答がない。ホストが起動しているか確かめてください', tone: 'problem' }
      }
    case 'http-error':
      return { text: `応答がエラー: HTTP ${status.status}`, tone: 'problem' }
    case 'unreadable':
      return { text: '応答を読めない。URLが地震計のホストを指しているか確かめてください', tone: 'problem' }
  }
}

/**
 * 読めない押し出しが届いていることを伝える 1 行（2026-10-22 選択「設定タブに出す (Recommended)」、文面は 2026-10-24
 * 選択「その文でよい (Recommended)」）。件数はこの接続先での累計。**版の食い違い**がいちばんありそうな原因なので、それを確かめさせる。
 */
export function seismoUnreadableLine(count: number): string {
  return `読めないデータが届いている: ${count} 件。ホストとアプリの版が合っているか確かめてください`
}

export const SEISMO_STATUS_TONE_CLASS: Record<SeismoStatusTone, string> = {
  ok: 'text-green-400',
  problem: 'text-red-400',
  muted: 'text-secondary',
}
