馬鈴吉碳烤 PWA 安裝版

檔案內容：
- index.html：原始系統，只增加 PWA 安裝設定與 Service Worker 註冊
- manifest.json：App 名稱、圖示、顯示方式
- service-worker.js：App 外殼快取與新版更新策略
- icons/：由使用者提供的 Logo 製作的安裝圖示

部署方式：
1. 解壓縮本資料夾。
2. 將 index.html、manifest.json、service-worker.js 與 icons 資料夾放到 GitHub Pages 網站根目錄（與原本 index.html 同一層）。
3. 以新 index.html 覆蓋原本 index.html；其他原有網站檔案不要刪除。
4. 推送 GitHub，並確認網站使用 HTTPS。
5. Android：用 Chrome 開啟網站，選單中選「安裝應用程式」或「加入主畫面」。
6. iPhone：用 Safari 開啟網站，點分享 → 加入主畫面；如有「以網頁 App 方式打開」請開啟。

注意：PWA 不是原生 APK/IPA。Supabase 資料與登入仍需網路；Service Worker 不快取 Supabase/API 回應。
