// 手元の長期震源カタログ（年ごとの JSON と目次）の置き場所。メインの checkout の `.cache/hypocenter-catalog/`。
//
// アプリは中継の公開バケット（data.yuremado.com/h/）から読み、毎日の書き足しは中継の Cron が行う（docs/relay-server-design.md §0 の
// 2026-10-29 の行）。手元の写しは、生成スクリプト（`build-hypocenter-catalog`）が書き、評価台・秒の補い・履歴アーカイブの生成が読む
// （置き場所は 2026-11-06 ユーザー選択「.cache へ移す (Recommended)」）。中継へ上げるのもここから（中継の README「長期震源カタログ」）。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cacheDir } from './cacheDir.mjs'

/** 置き場所（作られていなくても返す。生成スクリプトが書き出す先） */
export function hypocenterCatalogDir(): string {
  return cacheDir('hypocenter-catalog')
}

/**
 * 読む側が使う置き場所。**目次が無ければ投げる** —— 黙って「カタログに地震が無い」として進むと、評価台の数や
 * 補った秒が、生成していない端末でだけ静かに変わる。
 */
export function requireHypocenterCatalogDir(): string {
  const dir = hypocenterCatalogDir()
  if (!existsSync(join(dir, 'index.json'))) {
    throw new Error(`長期震源カタログが手元にありません（${dir}）。先に npm run build-hypocenter-catalog を流してください（1919 年からの全年は数十分かかります）`)
  }
  return dir
}
