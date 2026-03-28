# cli-prompt-cron スキル

## あなたの役割

あなたの仕事は `data/jobs/` 内の JSON ファイルを作成・編集・削除することだけです。
コマンドの実行、ログの記録、結果の保存はすべてデーモンが自動で行います。あなたが関与する必要はありません。

**やっていいこと:**
- `data/jobs/` 内の JSON ファイルの作成・編集・削除
- `data/jobs/` `data/logs/` `data/results/` の内容の読み取り
- デーモンの起動（`node start.js`）

**やってはいけないこと:**
- スクリプトファイル（.sh, .bat, .ps1, .py 等）の作成
- ラッパー、ヘルパー、補助ファイルの作成
- コマンドの最適化や独自の工夫
- `data/jobs/` 以外へのファイル書き込み

ユーザーの指示はそのまま `command` フィールドに入れてください。デーモンがシェル経由で実行します。

---

## パスの解決

このファイル（SKILL.md）の親ディレクトリの親がプロジェクトルートです。
すべてのファイル操作は、そのプロジェクトルートからの絶対パスで行ってください。

```
<プロジェクトルート> = このSKILL.mdの場所から ../.. （親の親）
<プロジェクトルート>/data/jobs/    ← ジョブファイル（あなたが編集する唯一の場所）
<プロジェクトルート>/data/logs/    ← 実行ログ（読み取り専用）
<プロジェクトルート>/data/results/ ← 実行結果（読み取り専用）
```

---

## ジョブ追加

`<プロジェクトルート>/data/jobs/<名前>.json` を作成します。

```json
{
  "cron": "0 9 * * *",
  "command": "gemini -p 'ユーザーが指定したプロンプト'",
  "timezone": "Asia/Tokyo",
  "active": true
}
```

| フィールド  | 型      | 必須 | 説明 |
|------------|---------|------|------|
| `cron`     | string  | ✓    | cron 式（5フィールド形式） |
| `command`  | string  | ✓    | シェルコマンド（デーモンがそのまま実行する） |
| `timezone` | string  |      | タイムゾーン（省略時は `Asia/Tokyo` を推奨） |
| `active`   | boolean |      | `false` で一時停止（デフォルト: `true`） |

### command の組み立て方

ユーザーの指示をそのまま CLI コマンドにしてください。余計な加工はしないこと。

| CLI | コマンド形式 |
|-----|-------------|
| Gemini CLI | `gemini -p 'プロンプト'` |
| Codex | `codex exec 'プロンプト'` |
| Claude Code | `claude -p 'プロンプト'` |

**例:** ユーザーが「毎朝9時にGeminiに『ニュースまとめて』と送って」と言ったら：

```json
{
  "cron": "0 9 * * *",
  "command": "gemini -p 'ニュースまとめて'",
  "timezone": "Asia/Tokyo",
  "active": true
}
```

これだけで完了。スクリプトを作ったり、出力をパイプしたりしないこと。

### 権限の確認

ユーザーのプロンプトに権限（`--allowedTools` 等）の指定がない場合、作成前にユーザーに確認してください。

```
このジョブに必要な権限を選んでください：

① 権限なし（テキスト生成のみ）→ フラグ不要
② ファイル書き込み → --allowedTools "Write"
③ シェルコマンド実行 → --allowedTools "Bash"
④ Web検索 → --allowedTools "WebSearch"
⑤ 複数ツール → --allowedTools "Read,Write"
⑥ 全権限スキップ（危険）
   Claude Code: --dangerously-skip-permissions
   Gemini CLI:  --yolo
   Codex:       --dangerously-bypass-approvals-and-sandbox

わからない場合は①を推奨
```

### Claude Code のシステムプロンプト

Claude Code ジョブには確認要求を抑制するため以下を含めてください：

```
claude --system-prompt "Execute the task immediately. Do not ask for confirmation or clarification." -p 'プロンプト'
```

---

## ジョブ停止

JSON ファイルの `active` を `false` に変更します。

## ジョブ再開

JSON ファイルの `active` を `true` に戻します。

## ジョブ削除

JSON ファイルを削除します。

## ジョブ一覧

`<プロジェクトルート>/data/jobs/` の内容を表示します。

## ログ確認

`<プロジェクトルート>/data/logs/YYYY-MM-DD.log` を読みます。

## 実行結果確認

`<プロジェクトルート>/data/results/` の内容を読みます。

## ダッシュボード起動

```bash
node <プロジェクトルート>/start.js
```

---

## cron 式チートシート

| cron 式 | 実行タイミング |
|---------|---------------|
| `0 9 * * *` | 毎朝 9:00 |
| `0 8 * * 1` | 毎週月曜 8:00 |
| `0 12 * * 1-5` | 平日 12:00 |
| `*/30 * * * *` | 30 分ごと |
| `* * * * *` | 毎分 |
| `0 9,18 * * *` | 毎日 9:00 と 18:00 |
