# 網站 v10：頁首、頁尾與回報入口（設計）

視覺規格：`docs/prototypes/calculator-demo-v10.html`（2026-10-23 核可）。只改頁首、頁尾與「計算依據」視窗，其他沿用 v9。

## 為什麼

看完結果的人想追到源頭：確認數字怎麼算、回報問題或提需求，但頁面上沒有任何通往 GitHub repo 的路；深色模式只能跟著系統，無法手動切換；頁面也沒有表明這是國網中心的服務、去哪裡使用國網算力。

## 使用者時刻與入口位置

| 時刻 | 入口 |
| --- | --- |
| 任何時候想看原始碼、提需求 | 頁首右側 GitHub 圖示（提示「原始碼與問題回報（GitHub）」，新分頁） |
| 環境太亮／太暗、想換外觀 | 頁首右側外觀按鈕：跟隨系統／淺色／深色 |
| 看到某個數字起疑 | 「計算依據」視窗固定的底部：「這個數字看起來不對？回報（附上目前的設定）」 |
| 算完想知道去哪裡用國網算力 | 頁尾：國網 logo + 國家高速網路與計算中心 → iService 首頁 |
| 想回報一般問題 | 頁尾：GitHub、回報問題（issue 範本選擇頁） |

## 規格

- **頁首**：網站圖示（`favicon.svg`，22 px，裝飾用 `alt=""`）＋標題｜語言切換、外觀按鈕、GitHub 圖示按鈕（`type="text" size="small"`）。390 px 一行放得下，不換行不溢出。
- **外觀**：antd `Dropdown`（點擊開啟，可選中目前項）＋`Tooltip`（hover／focus，選單開著時隱藏）。圖示跟著選擇：`DesktopOutlined` 跟隨系統、`SunOutlined` 淺色、`MoonOutlined` 深色。預設跟隨系統；選擇存在 `localStorage`（`theme-mode`，每次存取 try/catch，失敗時回到跟隨系統），**不進網址與 store**：分享連結不能改掉對方的外觀。所有讀 `useDarkMode()` 的地方（App 主題、比較圖配色）都改讀這個結果。
- **頁尾**：分隔線之後，第一行左邊是 logo＋「國家高速網路與計算中心／使用國網算力：iService 服務入口」（整塊連到 `https://iservice.nchc.org.tw/nchc_service/index.php`），右邊是 GitHub 與回報問題（`/issues/new/choose`）。第二行保留資料版本、準確度、費用、P95。
- **Logo**：沿用 `public/nchc-logo.png`（白底黑字點陣圖）。淺色用 `mix-blend-mode: multiply` 去掉白底；深色用 `filter: invert(1) hue-rotate(180deg)` 加 `mix-blend-mode: screen`，變成白字、紅點保持紅色、沒有方框；`filter` 以共用 motion token 過渡。
- **回報數字**：連到 `/issues/new`，帶標題「數字疑問：<模型名稱>」，內文預填目前網址（網址就是完整設定）與「哪個數字不對、您預期的值與根據」的提示。不放 token 或任何網址以外的資料。
- 外部連結一律 `target="_blank" rel="noopener noreferrer"`；圖示只用 `@ant-design/icons`。
- 文字放在 `i18n`（zh-TW、en 兩份）。

## 不做

不加導覽列、關於頁或任何擠到計算主畫面的東西；外觀不進網址；不另做新的 logo 圖檔。

## 驗收

- 單元測試：外觀選擇會存入、重新整理後仍在、`localStorage` 拋錯時退回跟隨系統；GitHub、iService、回報連結的網址；回報網址帶目前網址。
- 真實瀏覽器：390／768／1024／1440 淺色與深色截圖，沒有橫向捲動，console 乾淨，logo 在深色下沒有白框。
