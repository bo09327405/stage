# 觀眾直播（Audience Live Camera）設定

影像走 Cloudflare Realtime SFU：攝影師手機只上傳一份，所有觀眾從 Cloudflare 拉流，人數不受攝影師手機上行限制。
Firebase 只存協調資料（`versions/{vid}/live/{instanceId}`）。

## 一次性設定
1. Cloudflare Dashboard → Realtime → SFU → Create App，記下 App ID 與 App Secret。
2. （建議）同頁建立 TURN key，讓封鎖 UDP 的網路也能連上。
3. `wrangler.toml` 的 `[vars]` 加上 `CF_REALTIME_APP_ID = "<App ID>"`（TURN 的 `CF_TURN_KEY_ID` 亦同）。
4. `npx wrangler secret put CF_REALTIME_APP_SECRET`（TURN：`CF_TURN_KEY_TOKEN`）。
5. `npm run worker:deploy`。
6. `npm run rules:build`，再部署 `database.rules.json`（新增 `live` 節點規則）。

未設定時，攝影師手機會看到「直播伺服器連線失敗」，觀眾依 Cue 的備用處理顯示。
