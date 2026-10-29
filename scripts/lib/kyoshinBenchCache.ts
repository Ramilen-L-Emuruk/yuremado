// 強震モニタの評価台（bench-kyoshin）の控えの置き場所。評価台・助走の計測・平常のゆらぎの表・調査スクリプトで共有する。
//
// 既定はメインの checkout の `.cache/kyoshin-bench`（ワークツリーから走らせても同じ場所）。
// 前はリポジトリ直下の `.probe-cache` に置いていたので、そちらに控えが残っていて移し先が無ければ知らせる。
// 環境変数 `KYOSHIN_BENCH_CACHE` を渡せば、そちらを使う（相対なら作業ディレクトリから）。
import path from 'node:path'
import { cacheDir } from './cacheDir.mjs'

export function kyoshinBenchCacheDir(): string {
  const override = process.env.KYOSHIN_BENCH_CACHE
  if (override !== undefined && override !== '') return path.resolve(override)
  return cacheDir('kyoshin-bench', { legacy: ['.probe-cache'] })
}
