# 視覺化設計調查（二）：優秀互動計算機與 explorable 案例

- **查證日期**：2026-10-19
- **標記**：**[V]** 表示本次已查證，**[M]** 表示憑既有知識、本次未重新查證（視同未查證）。
- **限制**：FiveThirtyEight 已在 2025 年關站，web.archive.org 也無法存取，所以 NYT 與 538 作品的版面細節多數屬於 [M]。

## 案例

| # | 案例 | 網址 | 核心手法 | 對我們的啟示 |
|---|---|---|---|---|
| 1 | NYT〈Is It Better to Rent or Buy?〉（2014，Bostock & Tse） | https://www.nytimes.com/interactive/2014/upshot/buy-rent-calculator.html | **輸入本身就是圖表**：每個輸入都有一條敏感度曲線，滑桿就畫在曲線上；頂部固定一句答案加一個數字 [M]。房貸專家 Guttentag 評為「看過最好的租買計算機」[V](https://news.inman.com/2014/05/22/new-york-times-raises-the-bar-on-rent-vs-buy-calculators/) | 滑桿畫在自己的敏感度曲線上，同時回答「如果…會怎樣」與「這個參數重不重要」，不需要另開面板 |
| 2 | NYT〈You Draw It〉（2015） | https://www.nytimes.com/interactive/2015/05/28/upshot/you-draw-it-how-family-income-affects-childrens-college-chances.html | 讀者先畫下自己的猜測，再揭曉真實資料。Malofiej 24 Best of Show [V](https://www.snd-e.com/themed/snde/files/docs/207/049/m24_nota_prensa.pdf) | 「猜猜 500 人需要幾張 H100」，再用動畫揭曉答案 |
| 3 | NYT 選舉指針（2016–2020） | — | 指針在不確定範圍內抖動，引發強烈反感，之後改成可以關閉 [V](https://www.niemanlab.org/2020/11/bad-polls-fake-news-and-that-damned-needle-heres-how-the-media-covered-a-twisty-election-night/) | **只在輸入改變時才動畫**，不要用環境式的持續抖動 |
| 4 | NYT〈How Not to Be Misled by the Jobs Report〉 | [V](https://statschat.org.nz/2014/05/02/excellent-display-of-sampling-error-by-new-york-times) | 用 HOP 呈現抽樣誤差 | 不必用統計術語，也能讓人理解不確定性 |
| 5 | NYT〈How Much Hotter Is Your Hometown〉（2018） | [V](https://journalism.co.uk/news/nyt-uses-data-visualisation-to-bring-climate-change-home-literally-/s2/a727570) | 個人化：使用者的輸入成為圖上的標註點 | 把使用者自己的需求直接標在圖上 |
| 6 | FiveThirtyEight 2020 預測 | [V](https://flowingdata.com/2020/08/12/fivethirtyeight-launches-2020-election-forecast) | 從 4 萬次模擬中抽 100 個結果畫成點群；頭條用文字（「favored」）而不是百分比；附文字摘要 | 用離散的次數框架加上文字結論，這是向一般大眾呈現不確定性證據最強的做法 |
| 7 | 538〈Hack Your Way to Scientific Glory〉 | [V](https://forrt.org/curated_resources/hack-your-way-to-scientific-glory/)；替代版 https://stats.andrewheiss.com/hack-your-way/ | 幾個切換鈕加一張圖，判定結果即時更新 | 二元判定標章加上背後的數量 |
| 8 | Gapminder Trendalyzer | https://www.gapminder.org/tools/ | 單一動畫圖。Robertson 2008（2018 年獲 Test of Time）發現動畫用於分析效果最差、用於簡報最受喜愛 [V](https://faculty.cc.gatech.edu/~stasko/papers/infovis08-anim.pdf) | 動畫只用於使用者引發的狀態轉換，並**保留前一狀態的殘影**方便比較 |
| 9 | Our World in Data Grapher | https://ourworldindata.org/grapher/life-expectancy | 同一個框架內收納圖、地圖、表格、出處；OWID 獲 2019 Lovie 獎 [V](https://ourworldindata.org/we-won-the-lovie-award) | 出處與假設放在同一框架內，一鍵可達 |
| 10 | R2D3〈A Visual Introduction to Machine Learning〉 | http://www.r2d3.us/visual-intro-to-machine-learning-part-1/ | 捲動驅動，同一批點持續變形。Webby 2016 提名；IIB 2019 銅獎 [V](https://informationisbeautifulawards.com/news/485-information-is-beautiful-awards-2019-the-winners) | 物件恆常：讀者始終知道自己在看什麼 |
| 11 | Parable of the Polygons（Vi Hart & Nicky Case） | https://ncase.me/polygons/ | 可拖拉的單位圖加上即時指標 [V] | 單位圖示：一個符號代表一台機器或一個人，任何人都數得出來 |
| 12 | Bret Victor〈Ten Brighter Ideas〉 | https://worrydream.com/TenBrighterIdeas/ | 反應式文件：句子裡的數字可以拖拉，結論即時重算 [V] | **把輸入放進答案句裡**，句子同時是控制項與結論 |
| 13 | TensorFlow Playground | https://playground.tensorflow.org | 整個模型一個視圖，+/- 控制就放在它所改變的部位旁邊 [V](https://arxiv.org/abs/1708.03788) | 控制項放在它所影響的圖形部位旁 |
| 14 | Polo Club Transformer Explainer | https://poloclub.github.io/transformer-explainer/ | 單一流程圖，可原地展開細節。IEEE VIS 2024 Best Poster [V](https://arxiv.org/abs/2408.04619) | **語意縮放**：原地展開細節，不切換面板 |
| 15 | Bycroft〈LLM Visualization〉 | https://bbycroft.net/llm | GPT-2 與 GPT-3 以 1:1 比例並列 [V](https://github.com/bbycroft/llm-viz) | 用同一比例畫模型和記憶體，「放不放得下」比讀數字更快看出來 |
| 16 | Distill.pub | https://distill.pub/2020/communicating-with-interactive-articles/ | 整理了互動文章的各種技巧與證據 | 參考文獻 |
| 17 | UK 2050 Pathways Calculator | https://www.gov.uk/2050-pathways-analysis | 40 個調整桿，每個是 1–4 的離散選項加一行說明；輸出是堆疊面積圖加「是否達標」判定；狀態寫進網址 [V/M] | 多參數用緊湊的離散選擇加合理預設；判定與數量並列；網址可分享 |
| 18 | SemiAnalysis InferenceX | https://inferencex.semianalysis.com | 「每 GPU 吞吐量 vs 每人速度」Pareto 前緣；在固定速度門檻下排名 [V](https://inferencex.semianalysis.com/glossary/interactivity) | 物理上的核心權衡就是這個，但對一般使用者太抽象。要轉譯成「在你選的速度下，每台能服務 N 人」，原圖放專家檢視 |
| 19 | Artificial Analysis | https://artificialanalysis.ai | 在散佈圖上以陰影標出「最佳象限」[V] | 好的區域直接畫在圖上，判定變成空間位置 |
| 20 | ApX VRAM calculator | https://apxml.com/tools/vram-calculator | 記憶體分成權重與 KV，對照容量線，判定放不放得下 [V] | 最接近的競品，限制是只看單機、同時人數很少 |
| 21 | Lenovo LLM Sizing Tool | https://lenovopress.lenovo.com/lp2487-lenovo-llm-sizing-tool | 用使用情境預設自動帶入參數 [V] | 不要一開始就要求使用者填 token 數 |
| 22 | PCPartPicker | https://pcpartpicker.com/list/ | 相容性橫幅加上即時功耗估計 [V]；綠 / 黃 / 紅三態，附可展開的說明 [M] | 三態判定加原因，再加一個附餘裕的主要資源數字 |
| 23 | Google Project Sunroof | https://sunroof.withgoogle.com | 物理量估計受信任，價格與節省估計被批評 [V](https://midwestrenew.org/?p=58947) | **物理量和價格類數字在視覺上要分開**，價格類必須顯示假設 |
| 24 | Apple 比較 Mac 機型 | https://www.apple.com/mac/compare/ [M] | 同樣順序的對齊列 | 對齊列是最不需要讀圖能力的跨平台比較方式 |
| 25 | macOS 儲存空間橫條 / WinDirStat [M] | — | 一根分段橫條回答「什麼佔了空間、還剩多少」；treemap 則看不出剩餘空間 | 記憶體組成用橫條，不用 treemap |

## 綜合

### (1) 一個視圖回答多個問題的共通手法

1. **輸入放進視覺裡**：滑桿畫在敏感度曲線上（#1）、控制項放在受影響的部位旁（#13）、答案句裡的數字可拖拉（#12）。
2. **一張圖內每個方案一列，欄位對齊**（#24、#9、#18）。
3. **用單位圖示表示數量**（#11、#6）。
4. **用同一比例的實體條表示容量**（#15、#25、#20）：每台機器的符號內是一根堆疊記憶體條，填滿程度就是判定。
5. **答案直接標在圖上**（#1、#19、#6）：例如「3 × H200 · 以閱讀速度服務 520 人 · 受記憶體限制」，不另外做結果卡。
6. **用陰影標出好壞區與門檻線**：把目標（速度門檻、需求人數）畫成參考線，讓每一列都跟它比。
7. **原地展開細節**（#14、#9）：點選某一列就在原處展開瓶頸分解。
8. **轉場保持物件恆常，並留下前一狀態的殘影**（#10、#8）。
9. **狀態可以分享**（#17、#9）：所有參數寫進網址。

### (2) 要避免的做法

- 分頁或面板切換。
- 環境式、抖動的動畫；分析用途的自動播放動畫（#3；Robertson 2008）。
- 對一般讀者先給機率或百分比（#6 刻意先給文字）。
- 把專家座標軸當主圖（#18）。
- 一開始就要求填技術參數（#21）。
- 隱藏「為什麼放得下或放不下」（#22）。
- 物理量與價格類數字用同樣的視覺可信度呈現（#23）。
- 用 treemap 回答容量問題（#25）。

### (3) 判定加數量的呈現方式

- 一句話加一個數字（#1）。
- 三態標章加可展開的原因（#22、#7）。
- 用門檻線或陰影區，讓判定變成標記相對於線的位置（#20、#19、#17）。

### (4) 給一般使用者看的不確定性與假設

- 用次數框架，不用誤差線（Fernandes 2018；Hullman 2015）。
- 用敏感度呈現不確定性（#1）。
- 先用文字表達保留程度（#6），例如「約 500 人（依對話長度可能在 350–650 之間）」。
- 假設放在同一框架內（#9、#12、#17）。
- 實測值和推估值在視覺上區分（#23）。
- 只在使用者改變輸入時才做動畫（#3）。
