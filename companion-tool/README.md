# Theatre Cue 本機伴侶（Local Companion）

在**你自己的電腦**上執行的小工具：用 `ffmpeg` 把電腦裡的音訊／影片檔批次轉成 WAV、MP3 或 MP4，
並把進度即時回報給網頁。網頁再把轉好的檔案上傳到專案（Set Cue 或 Studio）。

- 只處理**你電腦裡已有的檔案**，不負責下載任何網址。
- 不需要任何金鑰：轉好的檔案由網頁自己上傳，伴侶工具不碰你的帳號。
- 沒有第三方套件，只用 Node.js 內建功能。

## 安裝

1. 安裝 [Node.js](https://nodejs.org)（18 以上）。
2. 安裝 ffmpeg：
   - macOS：`brew install ffmpeg`
   - Windows：`winget install ffmpeg`
   - Linux：`sudo apt install ffmpeg`

## 啟動

```bash
node companion-tool/server.mjs
```

預設會建立並監看 `~/Theatre-Cue-Inbox`，轉好的檔案放在裡面的 `converted/`。
啟動後終端機會顯示 **配對碼**（例如 `a1b2c3`），到網頁的轉檔工具 →「🖥 本機伴侶」貼上一次即可。

常用選項：

```bash
node companion-tool/server.mjs --watch ~/Desktop/素材        # 指定監看資料夾
node companion-tool/server.mjs --auto wav                    # 新檔案一放進去就自動轉成 WAV
node companion-tool/server.mjs --token mypass                # 固定配對碼（或環境變數 COMPANION_TOKEN）
node companion-tool/server.mjs --origin https://你的網址      # 額外允許自己部署的網頁來源
node companion-tool/server.mjs --ffmpeg /usr/local/bin/ffmpeg # 指定 ffmpeg 位置
```

也可以：`npm run companion`（在專案根目錄）。

## 在網頁裡使用

Set Cue 編輯面板的「🛠 轉檔工具」或 Studio 音軌右鍵「🛠 轉檔後匯入」→ 上方切到 **🖥 本機伴侶**：

1. 右上角燈號 🟢 表示已連線；🔴 表示尚未啟動（畫面會顯示啟動指令）。
2. 勾選監看資料夾裡的檔案，或按「加入電腦裡的檔案」把檔案放進去。
3. 選格式與選項（MP3 品質、聲道、取樣率、平均音量），按「轉檔並加入專案」。
4. 進度條即時顯示；完成後網頁會下載轉好的檔案並上傳到專案。

## 瀏覽器相容性

- **Chrome / Edge / Firefox**：可以從 https 網頁連到本機 `http://localhost:3333`。
  Chrome 會先送一個「私有網路存取」預檢，伴侶已經回應。
- **Safari**：不允許 https 網頁連 http 的 localhost（混合內容），請改用 Chrome / Edge / Firefox 操作這部分，
  或改用網頁內建的「🌐 瀏覽器轉檔」。
- 伴侶只在**執行它的那台電腦**上可用；手機、平板請用瀏覽器轉檔。

## 安全

- 只監聽 `127.0.0.1`（本機），區網其他裝置連不到。
- 只接受網頁自己的來源（CORS 白名單），並且需要配對碼。
- 只讀寫監看資料夾，檔名不能跳出資料夾（`../` 會被擋）。
- 一次轉一個檔案，其餘排隊；可以隨時取消。

## API（給進階使用者）

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/health` | 是否在執行（不需配對碼） |
| GET | `/info` | ffmpeg 版本、資料夾 |
| GET | `/files` | 監看資料夾裡的影音檔 |
| PUT | `/inbox/<檔名>` | 把檔案放進資料夾 |
| POST | `/convert` | `{ "file": "檔名", "options": { "format": "mp3\|wav\|mp4", "bitrate": 192, "channels": "keep\|mono\|stereo", "sampleRate": "keep\|44100\|48000", "normalize": false } }` |
| GET | `/jobs/<id>` | 工作狀態 |
| GET | `/jobs/<id>/events` | Server-Sent Events：進度、完成、錯誤 |
| GET | `/jobs/<id>/file` | 下載轉好的檔案 |
| DELETE | `/jobs/<id>` | 取消 |

除 `/health` 外都要帶 `X-Companion-Token`（SSE 可用 `?token=`）。

## 測試

```bash
cd companion-tool && npm test
```

測試用一個假的 ffmpeg，不需要真的安裝 ffmpeg。
