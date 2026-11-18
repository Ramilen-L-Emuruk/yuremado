/**
 * 公開観測点（気象庁の広帯域地震計）の名前の読み仮名。名前の訳（`scripts/build-public-station-names.ts`）を作る元。
 *
 * 読みは、日本語の名前と同じ気象庁の観測点一覧（地震・火山月報（カタログ編）の付録「地震観測点」。
 * 例: https://ds.data.jma.go.jp/eqev/data/bulletin/catalog/appendix/stkyushu.html ）の「観測点名(英語)」の列
 * （Kamikawaasahi・Sadogashimaginzan のように空白なしで書かれている）から起こした。
 * 名前は語の切れ目（県名・島名と地区の名前の境）で分けて持つ。英字の言語はこの切れ目に空白を入れ、
 * 韓国語も空白で区切る（震度観測点の訳と同じ。`docs/spec/data-sources-spec.md` §6「公開観測点の名前の訳」）。
 *
 * 鍵は `public-stations.json` の `nameJa`（`scripts/build-public-stations.ts` の `NAMES_JA` の値）。
 * 名前が増えたら、ここに読みを足さないと `scripts/build-public-station-names.test.ts` が落ちる。
 */
export interface PublicStationReading {
  /** 名前を語の切れ目で分けたもの（つなげると `nameJa` に戻る） */
  readonly parts: readonly string[]
  /** `parts` と同じ切れ目で分けた読み仮名（片仮名） */
  readonly kana: readonly string[]
}

export const PUBLIC_STATION_READINGS: Readonly<Record<string, PublicStationReading>> = {
  上川朝日: { parts: ['上川', '朝日'], kana: ['カミカワ', 'アサヒ'] },
  父島三日月山: { parts: ['父島', '三日月山'], kana: ['チチジマ', 'ミカヅキヤマ'] },
  えりも: { parts: ['えりも'], kana: ['エリモ'] },
  恵庭: { parts: ['恵庭'], kana: ['エニワ'] },
  岐阜黒川: { parts: ['岐阜', '黒川'], kana: ['ギフ', 'クロカワ'] },
  八丈島三根: { parts: ['八丈島', '三根'], kana: ['ハチジョウジマ', 'ミツネ'] },
  広島西城: { parts: ['広島', '西城'], kana: ['ヒロシマ', 'サイジョウ'] },
  宮城丸森: { parts: ['宮城', '丸森'], kana: ['ミヤギ', 'マルモリ'] },
  高知物部: { parts: ['高知', '物部'], kana: ['コウチ', 'モノベ'] },
  南大東島池之沢: { parts: ['南大東島', '池之沢'], kana: ['ミナミダイトウジマ', 'イケノサワ'] },
  大分中津江: { parts: ['大分', '中津江'], kana: ['オオイタ', 'ナカツエ'] },
  沖縄国頭: { parts: ['沖縄', '国頭'], kana: ['オキナワ', 'クニガミ'] },
  佐渡島銀山: { parts: ['佐渡島', '銀山'], kana: ['サドガシマ', 'ギンザン'] },
  静岡相良: { parts: ['静岡', '相良'], kana: ['シズオカ', 'サガラ'] },
  鹿児島錫山: { parts: ['鹿児島', '錫山'], kana: ['カゴシマ', 'スズヤマ'] },
  青森天間林: { parts: ['青森', '天間林'], kana: ['アオモリ', 'テンマバヤシ'] },
  対馬上県: { parts: ['対馬', '上県'], kana: ['ツシマ', 'カミアガタ'] },
  京都和知: { parts: ['京都', '和知'], kana: ['キョウト', 'ワチ'] },
  茨城八郷: { parts: ['茨城', '八郷'], kana: ['イバラキ', 'ヤサト'] },
  与那国島: { parts: ['与那国島'], kana: ['ヨナグニジマ'] },
}
