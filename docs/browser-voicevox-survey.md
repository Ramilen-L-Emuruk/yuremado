# ブラウザの中で VOICEVOX の声を合成できるか（調査）

いまの読み上げは、利用者が自分で VOICEVOX エンジンを立て、PWA から HTTP で叩いている（`src/utils/voicevox.ts`）。
エンジンを立てずに、ブラウザの中だけで同じ声を出せる手段があるかを調べた記録。

**読者は、読み上げ（`src/utils/voicevox.ts`・[`audio-tts-spec.md`](spec/audio-tts-spec.md)）の出し方を変えようとする開発者。**
調べたのは 2026-10-26（日本時間）で、外の状況（配布物・Issue）は変わりうる。日付・件数は、ことわりが無ければその日の時点の値。読み直すときは §5 の出典を引き直すこと。
読み上げをどこで合成するかは、中継の設計（[`relay-server-design.md`](relay-server-design.md)）の読み上げの段の前提にもなる。

## 用語

| 語 | 意味 |
|---|---|
| VOICEVOX エンジン | 利用者が立てる HTTP の合成サーバー。いまアプリが叩いている相手 |
| VOICEVOX CORE | エンジンの中で合成を担うライブラリ（`VOICEVOX/voicevox_core`）。アプリへ組み込んで使える |
| VVM | 声のモデルのファイル（`VOICEVOX/voicevox_vvm`）。話者ごとにどのファイルに入っているかが決まっている |
| ONNX Runtime | モデルを動かす実行系。CORE は VOICEVOX 版のもの（`voicevox_onnxruntime`）を使う |
| WASM | WebAssembly。ブラウザの中でネイティブに近い速さでコードを動かす形式 |
| Open JTalk | 日本語の文を読み・アクセントへ解析するライブラリ。CORE も中で使う |

## 0. 決まっていること

**ここでいうユーザーは、開発者（リポジトリの所有者）。** 日付は日本時間。行ごとに、問いとユーザーの答えを、その場の問答から原文のまま写す。

| 決まっていること | 原文 |
|---|---|
| 読み上げは、各プラットフォームのネイティブアプリを作り、CORE を組み込む方向で進める（2026-10-26） | 問い「読み上げ（中継の段 4）をどう進める？ 公式の声のモデルは VOICEVOX 版の ONNX Runtime でしか読めず、その WASM 版は配られていないため、ブラウザの中だけで公式の声を出す手段は今は無い。」（選択肢は「今のまま (Recommended)」「中継側で合成して配る」「別の音声合成を控えに」「iOS アプリに組み込む」。最後の説明は「iOS アプリに CORE を組み込む。…」）への自由記述の答え「それぞれのネイティブアプリを作成し組み込みたいです。」（「中継の段 4」は、中継の設計で読み上げを扱う段） |

## 1. 結論

**公式の声をブラウザの中だけで合成する手段は、2026-10-26 時点で無い。自前で組む道も、声のモデルの規約で塞がっている。**

1. 公式の VVM（0.17.0）は、中身が独自の形式（vv-bin）で、VOICEVOX 版の ONNX Runtime でしか読めない。
   素の ONNX Runtime に渡すと、CORE 自身が `This ONNX Runtime does not support "vv-bin" format` と断る
   （`crates/voicevox_core/src/core/infer/runtimes/onnxruntime.rs` の `ModelBytes::VvBin` の分岐）
2. VOICEVOX 版の ONNX Runtime は、`VOICEVOX/onnxruntime-builder` のビルド（`.github/workflows/build.yml`）が
   非公開のリポジトリからソースを取ってきて作っている（`PRODUCTION_REPOSITORY_URL` を使う段）。
   配布物は Android・iOS・Linux・macOS・Windows だけで、見た範囲（`voicevox_onnxruntime-1.17.3` と先行版の `1.23.2` の添付）に WASM 版は無い
3. CORE を WASM にする公式の作業は Issue `VOICEVOX/voicevox_core#491` で開いたまま（最終更新 2025-07-23）。
   `voicevox_core` の PR を `wasm`・`emscripten` で引いても 0 件だった

## 2. 候補ごとの判定

### 2.1 CORE の WASM 版

- 公式の配布は無い（§1 の 3）
- メンバーの試作の枝（`sevenc-nanashi/voicevox_core` の `add/wasm-build`、最終 2025-02-11）で、emscripten でのビルドは通っている。
  ただし動かしたのは試験用のモデル `sample.vvm` で、公式の声ではない。公式の VVM は §1 の 1・2 の理由で読めない
- 速さの記録は、その枝の README にある「ハローワールド」1 語で 5.4 秒（マルチスレッドの WASM）だけ。
  WebGPU は修正ビルドの後に速くなったとあるが、数値は外部の表にあって見られていない（未確認）

### 2.2 ONNX Runtime Web で VVM を直接動かす

**採れない。** 公式の VVM を素の ONNX Runtime で読むには vv-bin を解くしかなく、VVM の規約が禁じる
「逆コンパイル・リバースエンジニアリング」に当たると読んだ。規約の解釈を配布元に確かめてはいない。

### 2.3 Open JTalk の WASM 版

読み・アクセントの解析だけで、VOICEVOX の声は出せない。見つかったもの（`KoharuYuzuki/openjtalk-wasm`・
`philMorel/jpreprocess-wasm`）はどちらもスターが 0 で、前者は 2022 年から更新が無い。

## 3. 組み込むときに効く事実

ブラウザの外（ネイティブアプリ）で CORE を組み込むときにも、そのまま効く。

### 3.1 規約

- VVM の規約（VVM の配布物の README.txt）: 商用・非商用を問わず使える。アプリに組み込んで再配布できる。
  逆コンパイル・リバースエンジニアリングは禁止。作った音を使うときは「VOICEVOX:話者名」の表記が要る。
  話者ごとの規約もあり、四国めたんは「VOICEVOX:四国めたん」の表記で商用・非商用に使える
- VOICEVOX 版の ONNX Runtime の規約は、配布物の中の `TERMS.txt` にしか無い。2026-10-27 に読んだ結果は
  [`native-app-plan.md`](native-app-plan.md) §1.5（ONNX Runtime についてはアプリへ組み込んで再配布できる。条件はクレジット表記と、作った音声の利用を利用者に許すときの義務。ほかの同梱物の規約は同 §2）

### 3.2 大きさ

| もの | 大きさ | 出どころ |
|---|---|---|
| `0.vvm`（四国めたん ツンツン＝スタイル ID 6 を含む） | 59,308,488 バイト | `voicevox_vvm` 0.17.0 の添付 |
| Open JTalk の辞書（`open_jtalk_dic_utf_8-1.11.tar.gz`） | 23,646,843 バイト（展開後は約 102 MB） | `r9y9/open_jtalk` v1.11.1 の添付。展開後は 2026-10-14 に iPhone 用の部品を取ったときの実測 |

PWA の precache には入らない。上限は 1 ファイル 2 MiB で（[`precacheBudget.ts`](../scripts/precacheBudget.ts) の
`PRECACHE_MAX_FILE_BYTES`）、拾う拡張子にも入っていない（同 `PRECACHE_EXTENSIONS`）。

### 3.3 速さ

ネイティブの CORE 0.17.0 を iPhone 15 Pro Max で測ったとき（2026-10-14）、合成にかかる時間は音の長さの 0.52〜0.65 倍
（1.5 秒の句で約 0.95 秒）、モデルの読み込みは 614 ms、メモリは 313 MB だった。幅は句ごとの違いで、同じ句を何回測ったかは記録に残っていない。
測ったアプリはリポジトリの外に作ったので、この資料からは再現できない。

### 3.4 いまの組み立てとの対応

いまアプリはエンジンの `/audio_query`・`/accent_phrases`（`is_kana=true`）・`/mora_data`・`/synthesis` を使い、
辞書の句割り・アクセントの核を当てて組み立て直している（[`audio-tts-spec.md`](spec/audio-tts-spec.md) §3）。
CORE の C API（`voicevox_core.h`）には、これに当たる関数がある。

| エンジンの口 | CORE の関数 |
|---|---|
| `/audio_query` | `voicevox_synthesizer_create_audio_query` |
| `/accent_phrases`（`is_kana=true`） | `voicevox_synthesizer_create_accent_phrases_from_kana` |
| `/mora_data` | `voicevox_synthesizer_replace_mora_data` |
| `/synthesis` | `voicevox_synthesizer_synthesis` |

**関数がヘッダーにあることは確かめた（2026-10-26）。対応は名前と役割から読んだもので、同じ結果が返るかは動かして確かめていない。**

## 4. 決まっていないこと

| 決まっていないこと | 状態 |
|---|---|
| PWA の読み上げをどうするか（§0 の問いで選ばれなかった「今のまま」「中継側で合成して配る」「別の音声合成を控えに」を残すか） | 未決（ユーザー判断待ち） |

作る OS（iOS・Android・Windows・macOS）・PWA との関係（ネイティブで作り直す）・作る時期（中継の段 1a〜3b の後）は 2026-10-27 に決まった。原文と、ネイティブアプリ側に残る未決は [`native-app-plan.md`](native-app-plan.md)。

## 5. 出典

- [VOICEVOX/voicevox_core#491](https://github.com/VOICEVOX/voicevox_core/issues/491)（ブラウザ版の Issue）
- [voicevox_core `onnxruntime.rs`](https://github.com/VOICEVOX/voicevox_core/blob/main/crates/voicevox_core/src/core/infer/runtimes/onnxruntime.rs)
- [voicevox_core `voicevox_core.h`](https://github.com/VOICEVOX/voicevox_core/blob/main/crates/voicevox_core_c_api/include/voicevox_core.h)
- [VOICEVOX/onnxruntime-builder `build.yml`](https://github.com/VOICEVOX/onnxruntime-builder/blob/main/.github/workflows/build.yml) とリリース一覧
- [VOICEVOX/voicevox_vvm](https://github.com/VOICEVOX/voicevox_vvm)（規約と、VVM ファイルと話者の対応表は 0.17.0 の README.txt）
- [sevenc-nanashi/voicevox_core `add/wasm-build` の `example/wasm`](https://github.com/sevenc-nanashi/voicevox_core/tree/add/wasm-build/example/wasm)
- [KoharuYuzuki/openjtalk-wasm](https://github.com/KoharuYuzuki/openjtalk-wasm)
