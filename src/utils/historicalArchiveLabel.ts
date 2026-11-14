// 収録済みの地震（ローカル履歴アーカイブ）の名前を画面の言語に合わせる。
//
// 目録（`public/data/historical-archives/index.json`）の `label` は日本語のまま持ち、言語ごとの名前は辞書の
// `settings.replay.archives.names` に `id` を鍵で置く。表に無い地震（目録へ後から足したもの）は目録の `label` のまま出す。
import type { Messages } from '../i18n/messages'

export function historicalArchiveLabel(
  archive: { readonly id: string; readonly label: string },
  w: Pick<Messages['settings']['replay']['archives'], 'names'>,
): string {
  return Object.prototype.hasOwnProperty.call(w.names, archive.id) ? w.names[archive.id] : archive.label
}
