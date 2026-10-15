# 儲存架構：DAW Studio 用 R2，觀眾互動與 Set Cue 用 Cloudinary

兩套系統分開，各自負責一部分：

| | DAW Studio（學生作業） | 觀眾互動與 Set Cue |
|---|---|---|
| 結構資料／即時共編 | Firebase Realtime Database：`projects/{pid}/studios`（含復原歷史） | Firebase Realtime Database：`projects/{pid}/uploads`、cue 清單 |
| 檔案 | Cloudflare R2：`theatre/daw/...` | Cloudinary：`theatre/{pid}`、各 Cue 指定的資料夾、`theatre/cues/Default` |
| API 路由 | `/api/r2/*` | `/api/cloudinary/*` |
| 金鑰 | `R2_*`（只在伺服器端） | `VITE_CLOUDINARY_*`（unsigned preset），`CLOUDINARY_API_*`（選用，只在伺服器端） |

兩套系統之間只有一條路：`POST /api/r2/import`。它把本帳號 Cloudinary 上的 Set Cue 檔案**複製**一份到 Studio 的 R2 資料夾，方向只能從 Cloudinary 到 R2。Studio 專案只會引用 R2 上的副本。

## API 路由

### `/api/r2/*`（DAW Studio）
- `GET /status`
- `POST /upload?key=theatre/…`
- `GET|HEAD /o/<key>`：串流讀取，支援 Range
- `GET /list?prefix=theatre/…&kind=media|raw`
- `POST /import?key=theatre/…&url=https://res.cloudinary.com/<本帳號>/…`

只能存取 `theatre/` 底下的路徑。

### `/api/cloudinary/*`（觀眾互動與 Set Cue）
- `GET /status`：會回傳 `retention: "permanent"`
- `GET /folder?path=theatre/…`：用 Admin Search API 列出資料夾
- `GET /moderation?type=image|video&publicId=theatre/…`：查詢 AI 審查結果

**刻意不提供**刪除、invalidate、清除快取這類路由。

## 觀眾上傳流程
1. 觀眾在互動上傳 Cue 中，用內建相機或錄音功能上傳，或用 **Cloudinary Upload Widget** 上傳影片、音效檔或照片。
   - 所有上傳都使用 unsigned preset。
   - 每個檔案都會帶標籤 `theatre-audience`、`project_*`、`version_*`、`cue_*`、`audience_*`。
   - context 欄位會寫入 `project`、`version`、`cue`、`audience` 和 `retention=permanent`。
2. 上傳的回應裡如果有 `moderation`，就用它決定審查狀態：
   - AI 通過：`approved`
   - AI 拒絕：`rejected`
   - 其他情況（沒有 AI 結果、還在排隊）：`pending`，等待操作員在收件匣「待審」分頁核准或拒絕。
3. **只有 `approved` 的檔案可以建立 Cue 或在 Set Cue 中選用。** 未通過審查的圖片在主控台會以模糊方式顯示。
4. Cue 播放時使用 Cloudinary 動態轉檔後的網址：
   - 照片：`f_auto,q_auto,c_limit,w_1920,h_1920`
   - 錄音：轉成 `.mp3`
   - 影片：`q_auto,vc_h264,c_limit,w_1920` 並轉成 `.mp4`
   - 縮圖：`c_fill,w_360,h_360`

## 永久保留政策
- 程式中沒有任何地方會刪除 Cloudinary 上的觀眾檔案。
- 收件匣的「隱藏」只是在記錄上加 `hidden: true`，隨時可以取消。
- 刪除專案時，觀眾上傳記錄會移到 `audienceArchive/{pid}`，不會被刪除。

## 需要在 Cloudinary Console 確認的設定
到 Settings → Upload → Upload presets，找到 `VITE_CLOUDINARY_UPLOAD_PRESET` 對應的 preset，逐項確認：

1. **Signing mode：Unsigned。**
2. **Moderation：** 選擇 AI 審查，例如 `aws_rek`（Amazon Rekognition AI Moderation add-on，需要先在 Add-ons 啟用）。影片可用 `aws_rek_video` 或 `google_video_moderation`，也可以選 `manual`。
   - unsigned 上傳無法從瀏覽器指定 moderation，**必須設在 preset 上**。
3. **不要**設定任何自動刪除或到期：
   - 不要設 `auto expiration` 或 backup 之外的清除規則。
   - 不要用排程或 Webhook 呼叫 `destroy` 或 `delete_resources`。
4. **不要**勾選 `invalidate`。
5. Allowed formats 要包含觀眾會上傳的格式：jpg、png、heic、webp、mp4、mov、webm、mp3、wav、m4a、ogg。
6. （選用）在 `.env.local` 設定 `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`。設定後，收件匣的「↻」可以向 Cloudinary 查詢排隊中的 AI 審查結果。

## Firestore
目前 Studio 的結構資料與即時共編使用 **Firebase Realtime Database**，與整個系統相同。這部分已支援多人同時編輯、斷線狀態偵測，以及 20 步的復原／重做。

Firestore 資料庫雖然存在，但目前的安全規則拒絕未登入的讀寫，而且專案沒有啟用匿名登入，所以前端無法連線。若要改用 Firestore，必須先在 Firebase Console 完成這兩項：
- 啟用 Authentication 的登入方式，例如匿名登入。
- 部署允許已登入使用者讀寫 `studios/{id}` 的 Firestore 規則。
