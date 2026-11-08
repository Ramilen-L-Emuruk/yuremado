# ワークツリーの扱い（詳しい手順）

主に `CLAUDE.md`「変更時の基本フロー」から引く詳しい手順。いつ開くかは `CLAUDE.md`「ワークツリーの詳しい扱い」に書いてある。文中の「CLAUDE.md「…」」はリポジトリ直下の `CLAUDE.md` の節を指す。

## マージ後の自己クリーンアップ（任意）

実装セッションを開いたまま待つ場合、自分のブランチがマージされるのを監視して、自分でワークツリーを片付けてよい。**自分のワークツリーは自分で消すのが最も確実**（他セッションのロックに阻まれないため）。

**ただし条件が 1 つある。**

> **監視に入る前に必ず `ExitWorktree(action: "keep")` でワークツリーを出ること。**
> 居座ったままだとリリースセッションが `git worktree remove` に失敗する。**片付けを速くするつもりが、かえって妨げることになる。**

監視を始める前に `git branch --show-current` が `main` を返すことを確認する（ワークツリーを出られているかの機械的な確認）。そのうえで `Monitor` を **`timeout_ms: 1800000`（30 分）** で起動する。

**`Monitor` に「期限なし」の指定は無い。** 30 分で必ず切れて期限切れの通知が来るので、**まだ待つ必要があるなら張り直す**（`Monitor` 自身の説明もそう定めている）。`timeout_ms` はパラメータ定義上 3600000 まで書けるが、**渡しても 30 分へ切り詰められる**（2026-09-30 実測。戻り値が `expires in 30m` を返した）。期限が来ると監視のコマンドごと止まるので、張り直しても古いループが裏に残ることはない。

> 2026-09-30: この節はかつて `Monitor` を `persistent: true` で起動すると書いていたが、**そのパラメータは存在せず、渡した値は黙って捨てられていた**（受け取るのは `command` / `ws` / `description` / `timeout_ms` の 4 つだけ）。このプロジェクトのトランスクリプト（`~/.claude/projects/<プロジェクト>/*.jsonl`・371 本）を `grep` で数えると、`persistent: true` 付きの呼び出しが 42 回に対して期限切れの通知（`event count` を含む行）が 40 回・「再アーム」が 41 回とほぼ 1 対 1 で、**実際には既定の 5 分ごとに切れては張り直していた**（`timeout_ms` は 42 回すべて既定の 300000 のまま）。下のループは `sleep 120` なので、**2 回目の待機を終えた直後から 3 回目の待機中に切れていた**ことになる（240〜360 秒の間）。**存在しないパラメータは失敗として現れない** —— 効いているかどうかは、渡した値ではなく戻り値で確かめること。

```bash
cd <リポジトリのトップレベル>
fails=0
while true; do
  sleep 120
  # ready/ が消えた場合、理由は 2 つある。取り違えると作業場を消す
  git rev-parse --verify --quiet ready/<type>/<name> >/dev/null || {
    if git rev-parse --verify --quiet worktree/<type>/<name> >/dev/null; then
      echo "REVERTED-TO-WORKTREE: 作業中へ戻されました。何もせず監視を終了します"
    else
      echo "ALREADY-CLEANED: ready/<type>/<name>"
    fi
    exit 0
  }
  if git fetch --quiet 2>/dev/null; then
    fails=0
  else
    fails=$((fails + 1))
    [ "$fails" -ge 5 ] && {
      echo "WATCH-ERROR: git fetch が5回連続で失敗しました。監視を終了します"
      exit 1
    }
    continue
  fi
  git merge-base --is-ancestor ready/<type>/<name> origin/main 2>/dev/null && {
    echo "MERGED-AND-PUSHED: ready/<type>/<name>"
    exit 0
  }
done
```

ポーリング間隔が「監視モード」（60 秒）より緩いのは、待つ対象が違うため。あちらはブランチの出現、こちらは push の完了を待つ。

**`timeout_ms` が 30 分・`sleep 120` なので、1 回の監視で 15 回ポーリングする。** それで決着しなければ期限切れの通知が来るので、まだ待つなら張り直す。

**ループが黙って回り続ける状態を作らないこと。** 上の 2 つの脱出口がそれを担っている。

- **ブランチが先に消された場合** — リリース側が手順 7 まで済ませた。`ALREADY-CLEANED` で正常終了する。これが無いと `merge-base` が「そんなオブジェクトは無い」で失敗し続け、仕事が終わったのに監視だけが気づかず回り続ける
- **`git fetch` が恒久的に失敗する場合**（資格情報の失効・ネットワーク断） — 5 回連続で `WATCH-ERROR` を出して終了する。これが無いと永久に無音で回る

> この検知は**リリース手続きのマージが `--no-ff` であること**に依存している（ブランチの tip が履歴上の祖先として残るため）。マージ方式を変える場合はこの節も見直すこと。

> **見るのは `main` ではなく `origin/main`。ここを間違えると作業が消える。**
> ローカルの `main` はリリース手続きの**マージ**の時点で更新される。しかしその後の**統合後の検証**で不具合が見つかれば、`git reset --hard origin/main` でマージごと破棄されうる。`main` を見て発火すると、**破棄される前にブランチとワークツリーを消してしまい、作業内容を指す ref が一つも残らない**。`origin/main` は push 成功後にしか進まないため、これを条件にすれば確定後にのみ発火する。

通知の種類ごとに動きが変わる。

| 通知 | 意味 | すること |
|---|---|---|
| `MERGED-AND-PUSHED` | リリースが確定した | 下記の片付けへ進む |
| `REVERTED-TO-WORKTREE` | ユーザーが「まだ直したい」で作業中へ戻した | **何もしない。** 作業を再開する場所なので消してはならない |
| `ALREADY-CLEANED` | リリース側が既に片付けた | 何もしない |
| `WATCH-ERROR` | `git fetch` が繰り返し失敗した | ユーザーに報告する |

`MERGED-AND-PUSHED` の場合の片付け:

1. `git worktree list` で**自分のワークツリーがまだ残っているか確認する**
2. **AskUserQuestion で削除してよいか確認する。** 他の削除経路（リリース手順 7・取りこぼし検出）はすべて確認を課している。ここだけ無確認にする理由はない
3. 承認後、ワークツリーは下記「ワークツリーを消す前に、ジャンクションを外す」のコマンドで消し、ブランチは `git branch -d` で消す
4. **既に無ければ何もしない。** リリースセッションが先に片付けただけであり、エラーではない
5. 確認した直後にリリースセッションが消すこともある。**削除のコマンドが `ALREADY-GONE` を出しても正常**として扱う（`git worktree list` にも無いことを確かめる）

**これは「うまくいけば早く片付く」という上積みにすぎない。** 監視が働かなくても、次のリリースの取りこぼし検出（`/release` スキル手順 1）で必ず回収される。先着順でよく、競合を調停する仕組みは要らない。

## ワークツリーに入れないとき・入ったまま他を触れないとき

**`EnterWorktree(path: ...)` が拒否されることがある。** ある別のリポジトリで 2026-08-22 に次の形で拒否された（別のリポジトリでは 2026-10-20 に `EnterWorktree(path: ...)` が通っている。どの条件で拒否されるかは確かめていない）。

> Refusing to use ... as an isolation worktree: the protected checkout ... has git metadata that could not be resolved

拒否されても止まらない。手順 2 の Step 1 の作成だけ済ませ、以降は**入らずに絶対パスで扱う**。

- git: `git -C <ワークツリーの絶対パス> <サブコマンド>`
- ファイル: Read / Edit / Write に絶対パスを渡す
- ビルド・テスト: 宛先をコマンドの中で指す（`npm --prefix <パス>`・`<パス>/node_modules/.bin/vitest run --root <パス>` など）。`cd <パス> && <コマンド>` は、許可設定に当たらず確認待ちになったり、`&&` の複合コマンドとして止められたりする（[`docs/dev/command-pitfalls.md`](../../docs/dev/command-pitfalls.md)「作業ディレクトリはコマンドの中で固定する」）
- サブエージェント: プロンプトにワークツリーの絶対パスを書く
- 入っていないので `ExitWorktree` も要らない（`git worktree add` で作っただけのワークツリーには作用せず、`No-op: there is no active EnterWorktree session to exit.` を返す）

**入ったセッションからは、他のワークツリーやメインの checkout を対象にした git 操作が拒否されることがある。** `git -C <別のパス>` も `cd <別のパス> && git ...` も拒否された。サブエージェントも同じ制約を受ける（レビューのエージェントが `git diff` を取れず、ファイルを全文読んで代えた例がある）。拒否されなかったのは `git worktree add`・`git worktree list`・ビルドとテスト。同じ配布先では、`&&` で繋いだ複合コマンドや、`sed -n "$(...)"` のように実行時に値が決まるコマンドも拒否された（単純なコマンドに割るか、Grep ツールで代える）。

- **1 セッション 1 ワークツリーを原則にする。** 入ったら、そのワークツリーの作業をコミットまで済ませる。入ったまま別のワークツリーを切って続きを書くと、実装・検証・レビューまで終えてからコミットだけ打てなくなる（実際に起きた）
- **複数のワークツリーを横断する作業**（積んだブランチをまとめて扱う・依存先のリポジトリでビルドする等）は、**入らずに**リポジトリのトップレベルを作業ディレクトリにしたまま、絶対パスで扱う（この形で 6 本のワークツリーを扱い、マージ・リリース・片付けまで終えた例がある）
- それでも入ったセッションからコミットが要るときは、コミットメッセージをファイルへ書き出し、`git -C <ワークツリーの絶対パス> commit -a -F <メッセージのファイル>` をユーザーに実行してもらう。引用符・改行の問題が起きない（`-a` は追跡済みのファイルだけを拾うので、新しいファイルがあれば先に `git add` してもらう）

## 孤児のディレクトリをまとめて消すとき

`git worktree list` に載っていないのにディレクトリだけ残っているもの（孤児）を、まとめて片付けることがある。**削除を実行する直前に `git worktree list` を取り直し、そこに載っているものを除外する。** 調べたときに作った削除対象の一覧を、そのまま実行に使わない。

- **調べてから消すまでの間に、他のセッションがワークツリーを作ることがある。** 孤児と判定した 22 個を数分後に消したら対象が 23 個に増えており、その間に別のセッションが作った作業中のワークツリーの中身を消した例がある（ブランチとコミットは無事だったが、未コミットの作業は戻らなかった）
- 除外の一覧は、直前に取った `git worktree list` の出力から作る。名前を書き並べた配列を使い回さない
- **空に近いディレクトリで `git -C <ディレクトリ> status` や `git log` を叩くと、メインのリポジトリの結果が返る**（親を遡って `.git` を見つけるため）。「変更なし」に見えても、それは対象の状態ではない。中身の有無は `ls -A` で直接見る
- ロックで削除が弾かれたディレクトリが出たら、「守られた」ではなく「消しかけた」と考え、中身が残っているかを確かめる
- ブランチも消すなら、直前に `git worktree list --porcelain` でそのブランチを使っているワークツリーが無いことを確かめてから `-d` で消す。**`ready/*` はリリースの待ち行列なので消さない**
- 消す一覧はユーザーへ提示し、承認を得てから消す
- 消し方は 1 つずつ、下記「ワークツリーを消す前に、ジャンクションを外す」のコマンドを通す。孤児は登録が無いので最後の `git worktree remove` が失敗して `WORKTREE-REMOVE-FAILED` が出る（git は `is not a working tree` と返す）。`JUNCTION-STILL-THERE`・`CHECK-FAILED` が出なかったことが、ジャンクションが外れた確認になる
- **`Remove-Item -LiteralPath <ディレクトリ> -Recurse -Force` へ進むのは、次の 3 つが揃ったものだけ。** `WORKTREE-REMOVE-FAILED` が出た・git の返事が `is not a working tree` だった・**その 1 件を消す直前に取り直した** `git worktree list` に載っていない。1 つでも欠けたら消さずに、その 1 件をユーザーへ提示する

## ワークツリーを消す前に、ジャンクションを外す

**Windows では、ワークツリーの中のフォルダ（`node_modules`・ビルド出力・依存のキャッシュなど）をメインの checkout へのジャンクションにしたまま `git worktree remove` を掛けると、git はジャンクションを辿り、メイン側の中身を消す。** 終了コードは 0 で、警告も出ない。

ジャンクションは、Windows のフォルダを別の場所へ向ける仕掛け（シンボリックリンクの一種で、管理者権限なしで張れる）。依存のインストールを省くために張ることがある（張ること自体は禁じない）。ただし git にもエクスプローラーにも普通のフォルダに見えるので、消すときに中まで再帰する。**張ったら、手放す前に外すこと。** 張り方は問わない。見分け方と外し方だけ知っていればよい。

**ワークツリーは、どの経路でも下のコマンドで消す。** 素の `git worktree remove` は叩かず、`ExitWorktree(action: "remove")` でも消さない（後者がジャンクションを外すかは確かめていない。外す保証が無いので使わない）。いまある経路は次のとおり（**消す経路を新しく足したら、ここへも足すこと**）。

- 手順 12 の選択肢 2
- 上記「マージ後の自己クリーンアップ」（手順 12 の選択肢 1 で、マージを監視して自分で後片付けするとき）
- 上記「孤児のディレクトリをまとめて消すとき」
- `/release` スキルの手順 7、および手順 1 の残骸の回収（取りこぼし・放置されたワークツリー）
- [`verification-recipes.md`](verification-recipes.md)「常時表示用の端末で性能を確かめる（ユーザーが指示したとき）」の計測用のワークツリー

**Windows では、リポジトリのトップレベルで PowerShell から下のコマンドを実行する**（Windows PowerShell 5.1 で確かめてある。Claude Code なら PowerShell のツールで実行する。Bash からしか呼べない環境なら、自分で呼び出し方を組み立てずにユーザーへ実行を頼む）。ワークツリーの中のジャンクションをすべて外し、**外れたことを確かめてから**消す。**途中で何か 1 つでも失敗したら、消さずに止まる。** Windows 以外では外すものが無いので、`git worktree remove .claude/worktrees/<name>` で消してよい（git はシンボリックリンクをリンクとして消す、という前提。Windows 以外では確かめていない）。

```powershell
$target = '.claude/worktrees/<name>'
try {
  if (-not (Test-Path -LiteralPath $target)) {
    "ALREADY-GONE: $target"
  } else {
    $wt = (Resolve-Path -LiteralPath $target -ErrorAction Stop).Path
    if ((Get-Item -LiteralPath $wt -Force -ErrorAction Stop).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw "ワークツリーのルート自体がジャンクションになっている: $wt"
    }
    Get-ChildItem -LiteralPath $wt -Recurse -Force -Directory -Attributes ReparsePoint -ErrorAction Stop |
      ForEach-Object { [System.IO.Directory]::Delete($_.FullName, $false) }
    $left = @(Get-ChildItem -LiteralPath $wt -Recurse -Force -Directory -Attributes ReparsePoint -ErrorAction Stop)
    if ($left.Count -gt 0) {
      "JUNCTION-STILL-THERE（ワークツリーは消さない）:"; $left.FullName
    } else {
      git worktree remove $wt
      if ($LASTEXITCODE -eq 0) { "WORKTREE-REMOVED: $wt" } else { "WORKTREE-REMOVE-FAILED（終了コード $LASTEXITCODE）" }
    }
  }
} catch {
  "CHECK-FAILED（ワークツリーは消さない）: $($_.Exception.Message)"
}
```

- **結果は最後に出る 1 行で読む。** 消えたのは `WORKTREE-REMOVED` が出たときだけ。それ以外（何も出ないときを含む）は消えていないとみなす。`ALREADY-GONE` は「そのパスに何も無い」で、他の経路が先に片付けただけなら正常。**ただしパスの書き間違い・トップレベル以外での実行でも出る**ので、`git worktree list` にもそのワークツリーが無いことを確かめてから正常と読む。list に残っていたら、状況をユーザーに提示する
- **見つけ方はフォルダの属性（ReparsePoint）。** ジャンクションも、向け先が消えた宙吊りのものも拾う。`Get-ChildItem -Recurse` は**拾ったジャンクションの中へは降りない**ので、深さの上限を置かなくても向け先（メイン側）までは走らない。git が辿ってしまうのはフォルダのリンクだけなので、ファイルのリンク（`core.symlinks` を有効にしたリポジトリが追跡しているものなど）は `-Directory` で対象から外し、git に任せる
- 外すのは `[System.IO.Directory]::Delete(<絶対パス>, $false)` に限る。ジャンクションそのものだけを消し、向け先には触れない。**ほかの消し方（`rm -r`・`Remove-Item -Recurse` など）を試して代えないこと**。絶対パス（`FullName`）を渡すのは、.NET が PowerShell の現在の場所を見ないため
- **`-ErrorAction Stop` と `try` で、一覧が取れない（読めないフォルダがある等）・外せない・ルート自体がジャンクション、といった失敗をすべて `CHECK-FAILED` へ落とす。** 失敗を見過ごして `git worktree remove` へ進む経路を作らない
- **`JUNCTION-STILL-THERE`・`CHECK-FAILED` が出たら、ワークツリーは消えていない。** 出た内容をユーザーに提示する
- `WORKTREE-REMOVE-FAILED` が出ても `--force` で押し通さない。扱いは呼び出し元の経路の決まりに従う。**別のシェルが掴んでいて消せないときに `Remove-Item -Recurse -Force` へ切り替えるのも、このコマンドでジャンクションが残っていないことを確かめた後に限る**（残ったまま掛けると、ジャンクションを辿ってメイン側の中身まで消しうる）
- 消し終えたら、メイン側の向け先（`node_modules` なら `node_modules/.bin`）が残っていることを確かめる。**無くなっていたら、メイン側が既に削られている**（このコマンドを通さずに消した経路がある）。インストールし直して戻し、ユーザーに報告する
- ワークツリーの中にいるセッションからは実行しない（先に `ExitWorktree(action: "keep")` で抜ける）。`powershell` や `git worktree remove` の実行で許可を求められるのは正常で、許可設定へ足して黙らせない

**素の `git worktree remove` で消えた分は戻らない。** 上のコマンドは、消す行を表示に置き換えて確かめてある（2026-10-20。入れ子・宙吊りのジャンクションが外れて向け先が残ること、外せないもの・読めないフォルダ・ルート自体がジャンクションのときに `CHECK-FAILED` で止まること、パスが無いときに `ALREADY-GONE` になること）。素の `git worktree remove` で向け先が全部消えることは、使い捨てのリポジトリで確かめてある（2026-10-06）。

素の `git worktree remove` は、実際の環境では別のプロセスが掴んでいるファイルのところで止まり、途中まで消える（下の注記）。最後まで消えても途中で止まっても、消えた分は戻らない。

> 2026-10-06: メインの checkout で `npx vitest` が「認識されていません」になった。調べると、メインの `node_modules` から `.bin`・`.package-lock.json` と、名前順で `@babel`〜`@playwright` までが消えていた。消えたのは、dev サーバーが掴んでいたネイティブモジュール（`@rollup/rollup-win32-x64-msvc`）の手前まで。そこで止まったとみられる。ジャンクションを張ったワークツリーを外さずに片付けたためと考えられるが、消したのがどの片付けだったか、そのとき画面に何が出たかは記録が無い。`npm install` で戻した。
