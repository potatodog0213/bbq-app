馬鈴吉碳烤｜點餐速度、辣度與頁面跳轉修正

本次只需要更新以下兩個檔案：
1. index.html
2. supabase/functions/customer-orders/index.ts

不需要新增資料表、不需要新增欄位、不需要執行 SQL，也不需要重新部署 customer-order-reminders。

一、檔案放置
- ZIP 根目錄的 index.html 覆蓋專案根目錄 index.html
- ZIP 內 supabase/functions/customer-orders/index.ts 覆蓋專案同路徑檔案

二、部署 Edge Function
在專案根目錄 PowerShell 執行：

npx.cmd --yes supabase@latest functions deploy customer-orders --project-ref gyonwgjafukzlmnosykt

三、推送網站

 git add index.html supabase/functions/customer-orders/index.ts
 git commit -m "加速線上訂單並調整辣度選擇"
 git push

四、更新內容
- 店家訂單工作台首次驗證改為並行，初次載入訂單數量由 100 筆縮至最新 50 筆，減少首屏資料量。
- 客人送單成功回應不再等待店家推播逐一發送；訂單寫入成功後即回應，推播由 Edge Runtime 背景處理。
- 歷史訂單查詢避免重複請求，背景更新間隔調整為 30 秒。
- 客人頁面在 HTML 初始載入時即隱藏管理首頁與管理導覽，避免短暫閃現後台。
- 取餐分鐘清單顯示 00～55，每 5 分鐘一格；17 點 00～25 及 02 點 05～55 會停用，維持 17:30～隔日 02:00 的營業時段。
- 客人先選辣度，再點餐點；相同餐點不同辣度會分開計算、分開送出，後台訂單明細也會分成不同列。
- 餐點管理未設定的品項預設開放辣度；若開放辣度，至少需勾選一種辣度。
- 辣度管理介面重新整理，今日餐點供應區即時顯示總品項數及今日供應品項數。

五、檢查
- HTML 內嵌 JavaScript 語法檢查通過。
- customer-orders Edge Function TypeScript 語法解析通過。
- 尚未連線到實際 Supabase 專案進行部署與真實訂單測速；實際速度仍受資料庫查詢、網路與部署狀態影響。
