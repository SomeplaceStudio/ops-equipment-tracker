# OPS 設備追蹤

Someplace Studio 永和空間（14.5 坪）的設備清單追蹤工具。
單一 HTML 檔的靜態網頁 PWA，部署在 GitHub Pages，可加到手機主畫面離線使用。

流程：**選品 → 設計師確認 → 夥伴確認 → 進場**

## 功能

- 依分區（接待區／攝影棚區／梳化間／廁所／辦公室）切換清單
- 每項設備記錄品牌、品名、價格、數量、尺寸、顏色材質、規格備註、商品連結、照片
- 8 段狀態流程（待確認 → 已安裝／退回重選），自動留下狀態變更時間軸
- 設計師 / 夥伴各一格意見欄，可標記「已確認 / 需討論」並留言
- 卡片可**編輯**、**刪除**，也可用左側握把拖曳排序
- 頂部即時累計金額與各狀態占比長條圖
- 照片自動壓縮（長邊 1000px、JPEG 82%）後存下，不必先修圖

## 資料存在哪裡

資料存在**瀏覽器本機的 localStorage**（key：`ops:equip:v2`），沒有後端、不會上傳。

這代表：

- 資料綁在「這台裝置 + 這個瀏覽器」，換手機或換瀏覽器看不到同一份清單
- 清除瀏覽器資料 / 網站資料會一併清掉
- localStorage 上限約 5MB。照片是 base64 存的，一張壓縮後約 60–150KB，大約可放 **30–60 筆含照片的設備**。滿了會跳出提示，此時新增或修改不會被寫入，請先刪掉幾筆含照片的項目

要多人共用同一份清單的話，需要另外接後端（Firebase / Supabase 之類），目前版本沒有。

## 本機開發

需要用 HTTP 起服務（Service Worker 不能在 `file://` 下運作）：

```bash
python3 -m http.server 8080
```

然後開 http://localhost:8080

## 部署

推到 GitHub 後，在 repo 的 **Settings → Pages** 把 Source 設為 `Deploy from a branch`，
branch 選 `main` / 資料夾 `/ (root)`，儲存後約一分鐘即可上線。

改版後如果瀏覽器還是舊畫面，把 `sw.js` 裡的 `VERSION` 加一再推一次。

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `index.html` | 全部的畫面、樣式與邏輯 |
| `manifest.json` | PWA 設定（名稱、顏色、圖示） |
| `sw.js` | Service Worker，離線快取 |
| `icon-*.png` / `apple-touch-icon.png` | 各尺寸圖示 |
| `.nojekyll` | 讓 GitHub Pages 原樣輸出，不跑 Jekyll |
