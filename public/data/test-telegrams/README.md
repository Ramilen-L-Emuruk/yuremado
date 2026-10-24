# テストボタンが流す電文

設定タブのテストボタンは、ここに置いた電文を**本物の受信経路（パーサー）へ通して**画面に出す。
どのボタンがどれを何秒おきに流すかは [`src/utils/testTelegramScripts.ts`](../../../src/utils/testTelegramScripts.ts) が持つ。

**手で組んだ内部データではなく電文を置いているのは、テストボタンを実機確認の入口にするため。**
内部データを直接組み立てる形だと、パーサーが実電文を 1 件も読めなくてもボタンは動いて見える
（→ CLAUDE.md「読み取りの変更はリプレイで確かめる」）。

## 出どころ

| 置き場所 | 本数 | 出どころ | ライセンス |
|---|---|---|---|
| `nii/` | 41 | 国立情報学研究所「気象庁防災情報XMLデータベース」（CPS-IIP, Asanobu KITAMOTO）が収集した実電文 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja) |
| `jma-sample/` | 24 | 気象庁「[防災情報XMLフォーマット 技術資料](https://xml.kishou.go.jp/tec_material.html)」のサンプル電文（`jmaxml_20260917_Samples.zip`） | 公共データ利用規約 第1.0版 |
| `synthetic/` | 2 | 推計震度分布図の二進電文（BUFR）。配布されているものが無いので自前で組んだ | — |

**DMDATA.JP から取った電文は置かない。** 規約第15条で二次配信が制限されており、このリポジトリは
GitHub Pages で公開している（とくに緊急地震速報）。ここにある緊急地震速報は、どれも気象庁の
サンプル電文か、サンプル電文を書き換えたもの。

## ファイル名

- `nii/` は配信時のファイル名（`YYYYMMDDhhmmss_0_<電文種別>_<官署コード>.xml`）。
  データベースの収録分だけ UUID 形式のものがある
- `jma-sample/` は技術資料の章番号・例番号・版（`<章>_<例>_<枝番>_<版 YYMMDD>_<電文種別>.xml`）
- `synthetic/` は `estimated-intensity-<段>.bufr`（1 が初報、2 が続報。続報のほうが分布が広い）

## 実電文に無い形は、実電文を書き換えて作る

訓練報・取消・一部解除のように、実配信では滅多に出ない（または出せない）形は、
**上の実電文を土台に、必要な要素だけ書き換えて**作る。書き換えは台本の `rewrite` が実行時に行い、
置いたファイルそのものは配信されたまま残す（元電文との差分がコードとして読める）。

書き換えの部品は [`src/utils/testTelegramRewrite.ts`](../../../src/utils/testTelegramRewrite.ts)。

## 二進電文（BUFR）の作り直し

`synthetic/estimated-intensity-*.bufr` は `npm run build-test-estimated-intensity-bufr` で作り直す。
生成したものは本番の復号器へ通して、書き出した格子が読み戻せることを確かめてから保存する。
