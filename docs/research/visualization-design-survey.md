# 視覺化設計調查（一）：學術文獻與設計原則

- **查證日期**：2026-10-19
- **查證標記**：
  - **[verified]**：本次已上網查證
  - **[memory]**：經典文獻，引用內容可信，但本次沒有重新確認網址
  - **「指引（推論）」**：我們依研究結果推論出、套用到本計算機的做法，**不是研究本身的結論**

## 1. 任務抽象與設計方法

- **Munzner 巢狀模型**
  - 出處：TVCG 2009，https://www.cs.ubc.ca/labs/imager/tr/2009/NestedModel/ ；專書《Visualization Analysis & Design》，https://www.cs.ubc.ca/~tmm/vadbook/ [memory]
  - 設計分四層：領域問題 → 資料/任務抽象 → 編碼與互動 → 演算法。**上層錯了，下層無法補救。**
- **Brehmer & Munzner 任務分類**
  - 出處：TVCG 2013，https://www.cs.ubc.ca/labs/imager/tr/2013/MultiLevelTaskTypology/ [memory]
  - 每個任務都用 why（為什麼做）/ how（怎麼做）/ what（輸入與輸出）來描述。
- **Shneiderman「The Eyes Have It」**
  - 出處：1996，https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf [memory]
  - 原則：先總覽，再縮放與過濾，細節按需顯示。

**指引（推論）**

- 六個問題對應到的抽象任務：

  | 問題 | 抽象任務 |
  |---|---|
  | Q1 量級 | 辨識 / 查詢 |
  | Q2 要幾台 | 逐平台查詢數值 |
  | Q3 哪個最省 | 比較，並找出極值 |
  | Q4 撐幾人、多快 | 查詢，並和門檻比較 |
  | Q5 瓶頸 | 在三種限制中辨識出卡住的那一個 |
  | Q6 放得下哪些模型 | 摘要 / 過濾 |

  這些幾乎都是「查詢 + 比較」，所以應該做成**答案優先的呈現型視圖**，不是開放式探索的 dashboard。
- 套用 Shneiderman 的原則：
  - 總覽：跨平台的答案視圖
  - 縮放與過濾：輸入控制項
  - 細節按需顯示：瓶頸分解、出處、假設

## 2. 視覺編碼效果

- **Cleveland & McGill 1984**
  - 出處：JASA，https://doi.org/10.1080/01621459.1984.10478080 [memory]
  - 判讀精確度由高到低：共同基線上的位置 > 非對齊位置 > 長度 > 角度 > 面積 > 體積 > 顏色。
- **Heer & Bostock 2010**
  - 出處：CHI，https://idl.uw.edu/papers/crowdsourcing-graphical-perception [memory]
  - 用群眾外包重現了上述排名，面積判讀明顯比位置和長度差。
- **Mackinlay 1986 APT**
  - 出處：https://doi.org/10.1145/22949.22950 [memory]
  - 兩條準則：
    - 表達性：只編碼資料本身，不多不少
    - 有效性：最重要的變數放在最精確的通道上

**指引（推論）**

- 要讓使用者比較的量（node 數、成本），用共同基線上的位置或長度來呈現。不用泡泡、圓餅、儀表。
- 平台是名目資料，用色相區分。出處狀態改用紋理、透明度或標章，不用色相。
- 瓶頸改成「記憶體 / 頻寬 / 算力」三者在同一把 0–100% 尺上的使用率對齊條，**最長的那根就是瓶頸**。
- 禁用雙 Y 軸。

## 3. 資料墨水、裝飾與記憶度

- **Tufte《The Visual Display of Quantitative Information》**
  - 出處：https://www.edwardtufte.com/book/the-visual-display-of-quantitative-information/ [memory]
  - 主張最大化資料墨水比、去除 chart junk、多用 small multiples。
- **Bateman et al. 2010「Useful Junk?」**
  - 出處：CHI，https://doi.org/10.1145/1753326.1753716 [memory]
  - 有裝飾的圖表判讀精確度不比素圖差，而且 2–3 週後的記憶更好。
- **Borkin et al. 2013**
  - 出處：http://vcg.seas.harvard.edu/publications/what-makes-a-visualization-memorable [memory]
  - 圖示和可辨識的物件能提高記憶度。2016 年的續作指出，**標題與文字是記憶與閱讀的首要來源**。
- **Haroz, Kosara & Franconeri 2015**：見第 8 節 [verified]。多餘的圖片會分散注意力；**承載資料的圖示**則沒有代價，還有好處。

**指引（推論）**

- 裝飾只在承載資料時才可以用。例如 node 圖示拿來當計數單位可以；裝飾用的機房照片不行。
- **圖表標題就寫答案句。**
- 能直接標示數值的地方就直接標，省掉圖例和格線。

## 4. 單一整合視圖 vs. 多個協調視圖 vs. 分頁

- **Baldonado, Woodruff & Kuchinsky 2000「Guidelines for Using Multiple Views」**
  - 出處：AVI，https://doi.org/10.1145/345513.345271 [memory]
  - 八條準則，其中兩條互相拉扯：
    - **節約**：視圖越少越好
    - **分解**：複雜資料應該拆開
- **Roberts 2007**
  - 出處：CMV 綜述，https://doi.org/10.1109/CMV.2007.20 [memory]
  - 用連動選取（linked brushing），可以讓多個視圖表現得像同一張圖。
- **Javed & Elmqvist 2012「Composite Visualization」**
  - 出處：https://doi.org/10.1109/PacificVis.2012.6183556 [verified，透過引用它的論文確認]
  - 五種組合方式：並排、整合、疊加、超載、巢狀。超載和巢狀省空間，但會增加視覺複雜度。
- **Gleicher et al. 2011「Visual Comparison」**
  - 出處：https://doi.org/10.1177/1473871611416549 [verified]
  - 所有比較設計都由三種手法組成：
    - **疊加**：適合共用座標、數量少的情況
    - **並排**：可擴展，但依賴記憶
    - **明示差異**：直接標出關係，例如「便宜 3.2 倍」

**指引（推論）**

- **一個畫面、不用分頁。** 分頁等於在時間上並排，對記憶的負擔最大。
- 但「一張圖」應該理解為**一個主答案視圖，加上 1–2 個始終可見、彼此連動的對齊視圖**，而不是把所有東西塞進一個超載的符號。
- 各平台共用單位（node、成本、速度），可以對齊在同一張圖。瓶頸的單位不同（%），做成每列底下的對齊條帶。
- 「哪個最省」直接在圖上標出（「最省」「成本為最省者的 N 倍」）。
- 各視圖連動，平台的順序和顏色在所有地方保持一致。

## 5. 轉場動畫

- **Heer & Robertson 2007「Animated Transitions in Statistical Data Graphics」**
  - 出處：https://idl.uw.edu/papers/animated-transitions [memory]
  - 相關視圖之間用動畫轉場，比直接跳轉更容易看出變化。
  - 建議做法：
    - **分階段**：每個階段只做一種變化
    - **物件恆常**：同一個物件在變化過程中保持可辨識
    - 動作簡單可預測，時長約 1 秒
- **Robertson et al. 2008「Effectiveness of Animation in Trend Visualization」**
  - 出處：https://faculty.cc.gatech.edu/~stasko/papers/infovis08-anim.pdf [verified]
  - **用於分析時，動畫效果最差**；small multiples 更準。用於簡報時，動畫最快也最受喜愛，但錯誤較多。
- **Tversky, Morrison & Bétrancourt 2002「Animation: Can It Facilitate?」**
  - 出處：https://doi.org/10.1006/ijhc.2002.1017 [memory]
  - 動畫很少勝過等價的靜態圖。只有在兩個條件同時成立時才有幫助：
    - 一致性：畫面上的變化和概念上的變化相符
    - 可理解性：夠慢、夠簡單，最好能由使用者控制
- **Chevalier, Dragicevic & Franconeri 2014**
  - 出處：https://visualcognition.psych.northwestern.edu/publications/ChevalierDragicevicFranconeri2014.pdf [verified]
  - **錯開各元素的起始時間（stagger），對追蹤沒有幫助，甚至有害。**
- **Chevalier et al. 2016「Animations 25 Years Later」**：[unverified] 動畫在介面中扮演的角色分類，例如維持脈絡、吸引注意。

**指引（推論）**

- 動畫**只用於使用者改變輸入所引發的狀態轉換**，不能是承載比較或不確定性的唯一媒介。
- 每次 300–700 ms，緩入緩出。每個階段只做一種變化，例如先調整座標軸，再更新長條。
- 同一組物件一起移動，不錯開。
- 支援 `prefers-reduced-motion`。動畫結束後的靜態畫面必須能獨立讀懂。
- 轉換結束後，短暫標示變化之處，例如「瓶頸：記憶體 → 頻寬」閃一次。

## 6. 可探索的解說與直接操作

- **Bret Victor**
  - 〈Explorable Explanations〉：http://worrydream.com/ExplorableExplanations/ [memory]
  - 〈Up and Down the Ladder of Abstraction〉：https://worrydream.com/LadderOfAbstraction/ [verified]
  - 內容：反應式文件、可拖拉的內嵌數字、在具體例子和抽象之間來回切換。
- **Ahlberg, Williamson & Shneiderman 1992「Dynamic Queries」**
  - 出處：https://doi.org/10.1145/142750.143054 [memory]
  - 滑桿與即時（< 100 ms）更新的畫面緊密耦合，能提升速度和理解，對新手尤其明顯。
- **Hohman, Conlen, Heer & Chau 2020「Communicating with Interactive Articles」**
  - 出處：https://distill.pub/2020/communicating-with-interactive-articles/ [verified]
  - 互動能降低認知負擔，但互動有成本，讀者可能跳過。**核心訊息必須不靠互動也看得到。**

**指引（推論）**

- 輸入控制項緊鄰圖表，即時回饋。
- **預設狀態就要回答問題**，互動只用來精修。
- 答案句裡的數字做成可拖拉的，例如「服務 **50** 人使用 **Llama 70B** 需要…」，把文字和控制項合而為一。
- 提供「人數 → 所需 node」的階梯小圖，讓使用者看到在哪個人數會多一台。

## 7. 給一般大眾的不確定性呈現

- **Hullman, Resnick & Adar 2015「Hypothetical Outcome Plots」**
  - 出處：https://doi.org/10.1371/journal.pone.0142444 [verified]
  - 比較 2–3 個量時，用動畫逐一抽樣呈現可能結果（HOP），效果勝過誤差線。
- **Kay et al. 2016「When(ish) is my bus?」**
  - 出處：https://idl.uw.edu/papers/when-ish-is-my-bus [verified]
  - 提出 quantile dotplot。
- **Fernandes et al. 2018**
  - 出處：https://mucollective.northwestern.edu/files/2018-UncertainBusDecisions-CHI.pdf [verified]
  - quantile dotplot 和 CDF 讓決策接近最佳（約 97%），優於點估計和文字區間。**文字描述的效果，會受引用哪個區間影響。**
- **Padilla, Kay & Hullman「Uncertainty Visualization」**：[部分 unverified]
  - 用離散的次數框架來呈現，對一般使用者有幫助；區間常被誤讀為硬界限。
- **Hullman 2020「Why Authors Don't Visualize Uncertainty」**
  - 出處：https://arxiv.org/abs/1908.01697 [verified]
- **Few「Bullet Graph」**
  - 出處：https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf [memory]
  - 一根緊湊的條：主數值，加上定性分區和目標標記，用來取代儀表。

**指引（推論）**

- 我們的不確定性只有兩個情境（預期 / 保守），在**同一個標記上呈現範圍**即可。
- node 數是整數，用**離散單位**表示：例如實心圖示 2 個，加上空心圖示 1 個代表保守估計。這屬於次數框架。
- **明確寫出決策規則**，例如「預算請以保守數字編列」。
- 主視圖不用 HOP，因為它需要靠動畫承載資料。
- 速度用 bullet graph 呈現：每人 tok/s，對照「比閱讀慢 / 舒適 / 即時」三個分區，再加一個目標標記。

## 8. ISOTYPE 與單位圖示

- **Neurath, ISOTYPE** [memory]：數量用重複的相同圖示表示，**不用放大縮小的圖示**。
- **Haroz, Kosara & Franconeri 2015「ISOTYPE Visualization」**
  - 出處：CHI，https://tableau.com/sites/default/files/2023-01/Haroz_CHI_2015.pdf [verified]
  - 承載資料的圖示沒有效能代價，對工作記憶和投入度還有幫助。數量小時容易比較。
- **Drucker & Fernandez 2015「Unit Visualizations」**
  - 出處：https://www.microsoft.com/en-us/research/publication/a-unifying-framework-for-animated-and-interactive-unit-visualizations/ [memory]
  - 每筆資料保持為一個標記，這讓動畫轉場可以維持物件恆常。

**指引（推論）**

- **各平台的 node 數正好是 ISOTYPE 的理想情境**：小整數，而且有實體意義。
  - 一台一個圖示，從共同左緣對齊排列，列長就同時是一根長條。
  - 一定要同時標出數字。
  - 超過約 20–30 台時，改用「×N」或長條。
- 每個 node 圖示可以再細分成 GPU 格子，用「卡住的那種資源」的填滿程度來回答「為什麼要這麼多」。

## 9. Dashboard 與一眼可讀

- **Few《Information Dashboard Design》** [memory]
  - 放在一個畫面內，一眼看到重點，用比較和目標提供脈絡。
  - 避免儀表和裝飾；顏色只用於警示。
- **Sarikaya et al. 2018「What Do We Talk About When We Talk About Dashboards?」**
  - 出處：https://tableau.com/sites/default/files/2023-01/DashboardsConspiracy_final.pdf [verified]
  - 決策型 dashboard 和察覺型 dashboard 不同；溝通型和分析型也不同。
- **Bach et al. 2022「Dashboard Design Patterns」**
  - 出處：https://arxiv.org/abs/2205.00757 [verified]
  - 分析了 144 個 dashboard，整理出 8 組設計模式，並討論各種取捨。

**指引（推論）**

- 這是**決策支援 / 敘事型 dashboard**，不是分析型。
- 版面順序：左上角放頭條（量級 + 建議平台 + node 數），接著是比較視圖，再來是瓶頸和模型適配。
- 色彩節制：平台色調低飽和；只用一個強調色標示「建議 / 最省」，一個警示色標示「放不下」。
- Q1–Q4 都要在筆電首屏內看得到，**絕不放進另一個分頁**。

## 10. 讓抽象數字有體感

- **Chevalier, Vuillemot & Gali 2013「Using Concrete Scales」**
  - 出處：https://hal.inria.fr/hal-00851733 [verified]
  - 把陌生的量和熟悉的物件連結，手法包括單位化、錨定、類比。
- **Hullman et al. 2018「Concrete Re-expression Strategies」**
  - 出處：https://mucollective.northwestern.edu/files/2018-MeasurementsConcreteReexpressions-CHI.pdf [verified]
  - 這類改寫被評為更有幫助，也提升了事後估計的準確度。
- **Riederer, Hofman & Goldstein 2018「To Put That in Perspective」**：CHI 2018 [作者與會議已確認，內容未讀]
- **Barrio, Goldstein & Hofman 2016「Improving Comprehension of Numbers in the News」** [memory]
  - 加上「透視句」，能改善回憶、估計和找錯。

**指引（推論）**

- 量級改寫成熟悉的單位，例如「約一個機櫃」「約等於國網 N 台現有 node」。
- 速度改寫成人的尺度，例如「約每秒 X 字，比一般閱讀快」。閱讀速度的數值**必須另外查證出處**才能使用。
- 記憶體改寫成「權重佔 140 GB，約 1.75 張 H100 的記憶體」。

## 11. 出處與信任

- **Elhamdadi et al. 2023「Vistrust」**
  - 出處：https://vcg.seas.harvard.edu/publications/20231023-vistrust [verified]
  - 信任由認知與情感兩部分組成，視覺複雜度會影響信任。
- **Xiong, Padilla, Grayson & Franconeri 2019**
  - 出處：https://doi.org/10.2312/trvis.20191186 [verified]
  - **清晰度、揭露、完整性**會預測使用者選擇哪個工具；揭露程度也預測信任評分。屬初步結果。
- **找不到專門研究「出處標章」的對照實驗。** 我們的標章設計是從「揭露」研究推論而來。

**指引（推論）**

- 每個數字都有小而一致的出處標記，並且使用冗餘通道（符號 + 線型），不只靠顏色區分：
  - 官方 / 實測：實線
  - 推算 / 推估：虛線或斜紋
- 完整出處放在細節按需顯示。
- **依可信度調整視覺重量**：推估值用較淡或斜紋呈現，讓使用者一眼看出答案裡哪部分最軟。

---

## 綜合原則

1. **答案優先。** 預設狀態就用頭條句加主視圖回答 Q1–Q4（Shneiderman；Hohman；Borkin 2016）。
2. **一個畫面、少數協調視圖、零分頁**（Baldonado；Roberts；Gleicher）。
3. **要比較的量，一律用共同基線上的位置或長度**（Cleveland & McGill；Heer & Bostock；Mackinlay）。
4. **node 數用單位圖示，並對齊成長條**（Neurath；Haroz）。
5. **「哪個最省」直接標出來**（Gleicher）。
6. **不確定性用同一標記上的離散範圍呈現，並寫出決策規則**（Fernandes；Kay；Few）。
7. **規模、速度、記憶體、成本都做具體改寫**（Chevalier 2013；Hullman 2018；Barrio 2016）。
8. **動畫只用於狀態轉換**：分階段、約 0.5 秒、物件恆常、不錯開、支援減少動態（Heer & Robertson；Chevalier 2014；Tversky）。
9. **控制項緊鄰圖表，即時回饋**（Ahlberg & Shneiderman；Victor）。
10. **出處與假設按需揭露，畫面上只留輕量標記**（Xiong 2019；Vistrust）。

**要做**

- 標題就是答案句。
- 平台順序與顏色全頁一致。
- 直接標示數值與單位。
- 預期值與保守值放在同一列。
- 瓶頸 = 三根對齊使用率條中最長的那根，並用文字點名。
- 放不下的方案明確標示並寫出原因，不要直接省略。

**不要做**

- 用分頁承載核心答案。
- 用雙軸、圓餅、儀表、泡泡、依面積縮放的圖示。
- 放沒有承載資料的裝飾。
- 讓動畫承載靜態畫面沒有的資訊；錯開動畫；超過 1 秒的轉場。
- 只靠顏色表達狀態。
- 只給點估計。
- 把關鍵答案藏在 hover 或互動後面。

## 研究與產品目標的衝突（需要產品負責人判斷）

1. **「一張圖回答所有問題」**
   - 研究支持「一個畫面」，但不一定支持「一個符號」。六個問題的單位不同（node、成本、tok/s、%、GB、模型清單），硬塞進同一張圖會導致雙軸或超載符號，判讀效果較差（Gleicher；Javed & Elmqvist；Cleveland & McGill；Mackinlay）。
   - **調和方案**：
     - 主體是「每平台一列」的整合複合圖：單位圖示 + 成本 + 速度 bullet + 瓶頸條帶，對齊後讀起來就是一張圖。
     - 模型適配（Q6）的列是「模型」不是「平台」，做成連動的緊湊副視圖。
2. **「最少的圖呈現最多資訊」**
   - Tufte 自己提倡 small multiples，Robertson 2008 也顯示：要比較得準，多張對齊的小圖勝過一張密集的大圖。
   - Baldonado 的「節約」與「分解」兩條準則本來就互相權衡。
3. **「轉場動畫」**
   - 研究支持把動畫用在狀態轉換（Heer & Robertson）。
   - 但用於分析和比較時，動畫不如靜態圖（Robertson 2008；Tversky 2002），花俏的錯開動畫也沒有幫助（Chevalier 2014）。
4. **「一眼看懂」vs.「呈現不確定性與出處」**
   - 省略不確定性會導致錯誤決策（Hullman 2020）。
   - 解法是在同一標記上緊湊地呈現（Fernandes），而不是拿掉。

## 未查證或已更正的項目

- Chevalier 2016：會議與作者是憑記憶寫的。
- Padilla 等人「Uncertainty Visualization」：網址未確認。
- 「Put your money where your mouth is」查無此篇，應為 Riederer 2018「To Put That in Perspective」，但其內容未讀。
- 出處標章：沒有直接的實證研究，相關指引是從揭露研究推論而來。
- 標 [memory] 的網址與 DOI 都沒有重新確認。
- Robertson 2008、Haroz 2015、Sarikaya 2018、Bach 2022：只讀了摘要層級，沒有看效果量。
