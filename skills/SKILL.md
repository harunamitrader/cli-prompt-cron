# cli-prompt-cron-ui スキル

**スキル名**: `cli-prompt-cron-ui`
**説明**: AI CLI cron デーモン + ブラウザダッシュボードの管理スキル

Claude Code・Gemini CLI・Codex 向けのスケジュール実行ジョブを管理します。
ジョブファイルは `~/.cli-prompt-cron-ui/jobs/` に JSON 形式で保存されます。
変更は即座に反映されます（デーモン再起動不要）。

---

## 操作一覧

### 1. ジョブ追加

`~/.cli-prompt-cron-ui/jobs/<名前>.json` を作成します。

```json
{
  "cron": "0 9 * * *",
  "command": "claude --allowedTools \"Write\" -p 'タスクを実行してください'",
  "timezone": "Asia/Tokyo",
  "active": true
}
```

**フィールド説明:**

| フィールド  | 型      | 必須 | 説明                                                    |
|------------|---------|------|---------------------------------------------------------|
| `cron`     | string  | ✓    | cron 式（5フィールド形式）                               |
| `command`  | string  | ✓    | 実行するシェルコマンド                                   |
| `timezone` | string  |      | タイムゾーン。省略時は `Asia/Tokyo` を推奨              |
| `active`   | boolean |      | `false` で一時停止（デフォルト: `true`）                 |

#### ⚠️ 権限の確認（重要）

ジョブ追加時、ユーザーのプロンプトに **権限（`--allowedTools` 等）の指定がない場合**、必ずユーザーに確認してから作成してください。

**確認メッセージの例:**
```
このジョブに必要な権限を指定してください：

① 権限なし（テキスト生成のみ、ツール使用なし）
   → フラグ不要。最も安全。

② ファイル書き込みのみ
   → --allowedTools "Write"

③ シェルコマンド実行のみ
   → --allowedTools "Bash"

④ Web検索のみ
   → --allowedTools "WebSearch"

⑤ 複数ツール（例: ファイル読み書き）
   → --allowedTools "Read,Write"

⑥ 全権限スキップ（危険・サンドボックス環境専用）
   Claude Code: --dangerously-skip-permissions
   Gemini CLI:  --yolo
   Codex:       --dangerously-bypass-approvals-and-sandbox

どれにしますか？（わからない場合は①を推奨）
```

ユーザーが選択した権限を `command` フィールドに反映してジョブを作成します。

### 2. ジョブ停止

対象ジョブの JSON ファイルを開き、`active` を `false` に変更します。

```json
{
  "cron": "0 9 * * *",
  "command": "claude -p 'タスクを実行してください'",
  "timezone": "Asia/Tokyo",
  "active": false
}
```

### 3. ジョブ再開

対象ジョブの JSON ファイルを開き、`active` を `true` に戻します。

### 4. ジョブ削除

`~/.cli-prompt-cron-ui/jobs/<名前>.json` を削除します。

```bash
rm ~/.cli-prompt-cron-ui/jobs/<名前>.json
```

### 5. ジョブ一覧確認

```bash
ls ~/.cli-prompt-cron-ui/jobs/
```

### 6. ログ確認

実行ログは日付ごとにファイルに記録されます。

```
~/.cli-prompt-cron-ui/logs/YYYY-MM-DD.log
```

```bash
# 今日のログを表示
cat ~/.cli-prompt-cron-ui/logs/$(date +%Y-%m-%d).log

# リアルタイム監視
tail -f ~/.cli-prompt-cron-ui/logs/$(date +%Y-%m-%d).log

# ログ一覧
ls ~/.cli-prompt-cron-ui/logs/
```

### 7. 実行結果確認

実行結果は `~/.cli-prompt-cron-ui/results/` に JSON 形式で保存されます。

```bash
# 結果ファイル一覧
ls ~/.cli-prompt-cron-ui/results/

# 特定の結果を確認
cat ~/.cli-prompt-cron-ui/results/<ファイル名>.json
```

### 8. ダッシュボード起動

```bash
node /path/to/cli-prompt-cron-ui/start.js
```

起動後、ブラウザが自動で開き `http://localhost:3300` のダッシュボードが表示されます。
手動でアクセスする場合は `http://localhost:3300` を開いてください。

---

## cron 式チートシート（JST / Asia/Tokyo 基準）

| cron 式          | 実行タイミング                       |
|-----------------|-------------------------------------|
| `0 9 * * *`     | 毎朝 9:00                           |
| `0 8 * * 1`     | 毎週月曜 8:00                       |
| `0 12 * * 1-5`  | 平日（月〜金）12:00（ランチタイム） |
| `0 18 * * *`    | 毎日 18:00                          |
| `0 0 1 * *`     | 毎月 1 日 0:00                      |
| `*/30 * * * *`  | 30 分ごと                           |
| `0 9,18 * * *`  | 毎日 9:00 と 18:00                  |
| `0 0 * * 0`     | 毎週日曜 0:00（週次レポート等）     |
| `0 7 * * 1-5`   | 平日 7:00（朝のブリーフィング）     |
| `0 23 * * *`    | 毎日 23:00（日次まとめ）            |

---

## コマンド例

```bash
# Claude Code
"command": "claude -p 'タスクの内容をここに記述'"

# Gemini CLI
"command": "gemini -p 'タスクの内容をここに記述'"

# Codex
"command": "codex 'タスクの内容をここに記述'"

# プロジェクトディレクトリ内で実行
"command": "cd /path/to/project && claude -p 'このプロジェクトをレビューして'"

# 複合コマンド
"command": "cd /path/to/project && git pull && claude -p '変更内容を要約して'"
```

---

## 注意事項

- `command` フィールドはシェルコマンドとして実行されます。信頼できる内容のみ記述してください。
- デーモンが起動していない場合、スケジュールされたジョブは実行されません。
- タイムゾーンを省略するとサーバーのローカル時刻が使用されます。日本時間で動作させる場合は `"timezone": "Asia/Tokyo"` を明示的に指定してください。
- ダッシュボードはデフォルトでポート `3300` を使用します。
