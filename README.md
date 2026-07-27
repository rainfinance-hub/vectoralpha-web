# VectorAlpha 网络版美股选股器 · Universe Management Platform (V2)

基于 **Universe Engine（股票池引擎）** 架构的机构级美股选股 + 股票池管理系统，纯前端网页应用（也可选配 GitHub Actions 做云端定时扫描），核心特色：

- 16 类股票池统一管理（Core / ETF / Sector / Industry / Growth / Quality / Momentum / Watchlist / Portfolio / Earnings Watch / High RS / New Highs / Institutional Buying / CANSLIM Candidates / Minervini Candidates / Custom）
- 双信号框架分层组合：**三频共振**（周线/日线/短周期择时）+ **机构多因子**（Minervini趋势模板 / Weinstein阶段分析 / CANSLIM / RS相对强度）
- **历史特定日期回溯**：输入任意历史日期，还原当天真实的多周期信号状态，而不是给最新数据贴个日期标签
- 持仓/风控工作台、Webhook推送（Telegram/Discord/飞书）、GitHub Actions云端定时扫描
- **V2 新增（Universe Management Platform）**：浏览器内嵌真实 SQLite 数据库(sql.js) · Dynamic Universe Builder(自由组合条件筛选) · Master Universe 统一数据表 · 股票池集合运算(并集/交集/差集/快照) · Universe Statistics(多空分布/板块热力/市值分布) · Portfolio Risk Analytics(Open Risk/Portfolio Heat/相关性/Kelly/风险平价) · Signal Tracking(信号表现看板，自动追踪5/10/20/60/120日前瞻收益)
- 模块化设计：数据层/指标层/时间周期层/Universe引擎/信号引擎/数据库引擎/UI 完全解耦，方便替换或新增指标

---

## 一、目录结构

```
vectoralpha-web/
├─ index.html                 网页入口
├─ css/style.css               界面样式
├─ js/
│  ├─ data/                    数据层
│  │  ├─ alpacaClient.js        Alpaca REST客户端（1H/1D/1W K线、限流重试）
│  │  ├─ yahooFallback.js       Yahoo Finance 免费接口兜底
│  │  ├─ dataSource.js          统一数据门面（自动选择Alpaca/降级Yahoo）
│  │  ├─ fundamentals.js        Finnhub 基本面数据（可选）
│  │  └─ symbolLists.js         静态代码列表（S&P500/Nasdaq100/Dow30/ETF/行业龙头）
│  ├─ core/                    核心引擎
│  │  ├─ indicators.js          指标计算（SMA/EMA/RSI/MACD/ADX/ATR/OBV/CMF/布林带…；V2新增 dailyReturns/computeBeta/computeCorrelation）
│  │  ├─ timeframe.js           时间周期转换（日→周/月聚合、asOfDate截断）
│  │  ├─ universeEngine.js      Universe Engine（16类股票池注册表）
│  │  ├─ analysisPipeline.js    单只股票分析流水线（数据+指标+信号+评分）
│  │  ├─ scanEngine.js          实时扫描引擎（V2：扫描完成后自动写入 Master Universe + Signal Tracking）
│  │  ├─ historyEngine.js       历史回溯引擎（核心功能；V2：批量回溯同样自动写入 Signal Tracking）
│  │  ├─ riskWorkbench.js       持仓/风控工作台
│  │  ├─ notify.js              Webhook 通知
│  │  ├─ cloudSync.js           云端结果读取
│  │  ├─ db.js                  【V2新增】浏览器内嵌 SQLite 引擎（sql.js/WASM）+ IndexedDB 持久化，5张表的统一数据库门面
│  │  ├─ masterUniverseSync.js  【V2新增】Master Universe 同步（Alpaca全市场资产 + 扫描结果反哺，第2/3阶段）
│  │  ├─ universeBuilder.js     【V2新增】Dynamic Universe Builder：自由组合条件筛选 + 保存/管理查询（第1阶段）
│  │  ├─ universeOps.js         【V2新增】股票池集合运算：并集/交集/差集/去重/导入导出/快照（第5阶段）
│  │  ├─ universeStats.js       【V2新增】Universe Statistics：多空分布/板块热力/市值分布/评分分布（第4阶段）
│  │  ├─ riskAnalytics.js       【V2新增】Portfolio Risk Analytics：Open Risk/Heat/相关性/Kelly/波动率仓位/风险平价（第7阶段）
│  │  └─ signalTracking.js      【V2新增】Signal Tracking：信号记录 + 5/10/20/60/120日前瞻收益自动复核（第9阶段）
│  ├─ signals/                 信号引擎
│  │  ├─ resonance.js           三频共振框架
│  │  ├─ institutional.js       机构多因子框架（Minervini/Weinstein/CANSLIM/RS）
│  │  ├─ marketContext.js       市场环境（Market Regime + Sector Rotation）
│  │  ├─ qualityScore.js        质量评分
│  │  ├─ compositeScore.js      分层组合评分器
│  │  └─ derivedScores.js       【V2新增】Growth Score / Momentum Score 派生评分（供 Master Universe 与 Builder 使用）
│  └─ ui/
│     ├─ app.js                 界面控制器（V2：新增 Builder/Stats/Signals 三个页面控制器 + Universe Ops/Risk Analytics/DB设置 逻辑）
│     └─ helpContent.js         应用内帮助文案
├─ cloud/
│  └─ scan.mjs                  云端扫描脚本（Node，复用与浏览器相同的核心模块）
├─ .github/workflows/daily-scan.yml   GitHub Actions 定时扫描工作流
└─ package.json
```

---

## 二、环境配置

### 1. 获取 Alpaca API Key（必需，用于行情数据）

1. 打开 https://alpaca.markets/ 注册账号（免费）。
2. 进入 Dashboard，创建一个 **Paper Trading**（模拟盘）或 Live 账户下的 API Key（行情数据免费额度用 Paper 账户的 Key 即可，不需要入金）。
3. 记下 `API Key ID` 和 `Secret Key`。

> 免费额度用的是 IEX feed，覆盖主流美股的日线/小时线/周线历史数据，足够本系统使用。

### 2. 获取 Finnhub API Key（可选，用于基本面/质量评分/CANSLIM的C&A子项/财报日历）

1. 打开 https://finnhub.io/register 免费注册。
2. 免费额度有请求频率限制，扫描大股票池时基本面部分会明显变慢，可按需开关。

### 3. （可选）Webhook 推送

- **Telegram**：找 [@BotFather](https://t.me/BotFather) 创建一个 Bot，拿到 Token；把 Bot 加入你的群/或直接私聊获取 Chat ID。
- **Discord**：频道设置 -> 整合 -> Webhook -> 创建，复制 Webhook URL。
- **飞书**：群设置 -> 群机器人 -> 添加自定义机器人，复制 Webhook URL。

---

## 三、如何运行

本项目是纯静态前端（ES Modules），**不能直接双击 index.html 打开**（浏览器的模块安全策略会拦截 `file://` 协议下的 import），必须用一个本地/远程 HTTP 服务器打开。

### 方式A：本地临时服务器（最简单，用于自己测试）

在项目根目录下，任选一种：

```bash
# 方式1：Python（大多数系统自带）
python3 -m http.server 8080

# 方式2：Node（项目已内置一个极简脚本）
npm run serve
```

然后浏览器打开 `http://localhost:8080/`。

### 方式B：部署到 GitHub Pages / Cloudflare Pages / Vercel（推荐长期使用）

把整个项目 push 到你自己的 GitHub 仓库，然后：

- **GitHub Pages**：仓库 Settings -> Pages -> 选择分支 `main` / 根目录 -> 保存，几分钟后即可通过 `https://<user>.github.io/<repo>/` 访问。
- **Cloudflare Pages / Vercel**：直接导入该仓库，无需构建命令（Build command 留空，输出目录填根目录 `/`）。

这样部署之后，手机/平板/任何设备打开这个网址都能用，且和「云端定时扫描」功能（见下文）用的是同一个仓库，管理起来最方便。

---

## 四、首次使用步骤

1. 打开网页后，先进入 **「设置」** 页：
   - 填入 Alpaca API Key ID / Secret，点「保存」，再点「测试连接」确认成功。
   - （可选）填入 Finnhub Key。
   - （可选）填入 Webhook 地址、GitHub 云端仓库地址。
2. 进入 **「股票池」** 页：点击某个种子池卡片上的「载入」按钮（建议第一次先试 **ETF Universe** 或 **Industry Universe**，只有几十只，几分钟内能跑完；Core Universe 有500+只，受免费数据源限流影响，可能需要十几分钟甚至更久）。
3. 进入 **「扫描」** 页：点击「开始扫描」。日志区会实时显示进度，完成后结果表按「综合评分」从高到低排列。点击股票代码或「详情」按钮，可以看到：
   - 三频共振（周线/日线/短周期）逐项通过情况
   - Minervini趋势模板 8 条件逐项通过情况
   - Weinstein 阶段判断
   - CANSLIM 各字母维度（含"数据不可用"的诚实标注）
   - 综合评分的分层权重明细（市场层/行业层/三频共振层/机构多因子层/质量层各自贡献了多少分）
4. 进入 **「派生池」** 页：点击「生成派生池」，从刚才的扫描结果里自动筛出 Momentum / Quality / High RS / New Highs / CANSLIM候选 / Minervini候选 / 机构买入代理池 这几个动态池子。

---

## 五、如何进行历史特定日期回溯（核心功能）

这是最初需求里明确要求的功能，操作方式：

### 单只股票回溯

1. 进入 **「历史回溯」** 页最上方的卡片。
2. 「股票代码」填入你想查的代码（如 `AAPL`）。
3. 「历史日期」选择任意过去的日期（不能选未来）。
4. 点击「▶ 回溯分析」。

系统会：
- 把该股票的日线/周线/短周期（小时线或替代）数据全部截断到这个日期为止，重新计算所有均线/MACD/RSI/52周高低点等。
- 如果这天是周末/节假日，自动使用之前最近的一个交易日，并在结果里明确提示「已自动使用最近交易日 XXXX-XX-XX」。
- 输出当天的三频共振状态、Minervini/Weinstein/CANSLIM 结果、综合评分明细。
- **明确标注**：基本面/机构持仓相关字段（Quality层、CANSLIM的C/A/I子项）用的是当前最新快照，不是那天的真实时点数据（这是免费数据源的普遍限制，本系统选择诚实标注而不是编造）。
- 单只查询时 RS 百分位没有统计意义（样本只有1个），会提示你用"批量回溯"。

### 批量历史回溯

1. 先在「股票池」页载入一批股票（或用自定义列表）。
2. 到「历史回溯」页下方「批量历史回溯」卡片，选好日期，点击「▶ 批量回溯」。
3. 这样算出来的 RS 百分位排名，是"那一天这批股票里谁更强"，比单只查询更有参考价值。

---

## 六、持仓与风控工作台

1. 「持仓风控」页点击「+ 添加持仓」，依次输入代码/股数/成本价。
2. 先在「扫描」页对一个包含你持仓代码的股票池跑一次扫描（或用观察池/自定义列表把持仓代码也加进去扫）。
3. 回到「持仓风控」页点击「▶ 复核全部持仓」，会给出"继续持有/加仓/减仓/卖出"建议及具体触发理由。
4. 「仓位建议工作台」区域：填好账户资金、单笔风险%、单仓上限%、止损模式，点击「生成建议仓位」，会按最近一次扫描结果里综合评分≥60且从高到低的顺序分配资金，算出建议股数/止损价/止盈价，资金不够时明确标注而不是硬算。

---

## 七、云端定时扫描（可选，进阶）

不想每天手动开网页扫描的话，可以用 GitHub Actions 免费额度做定时扫描：

1. 把项目 push 到你自己的 GitHub 仓库。
2. 仓库 **Settings -> Secrets and variables -> Actions**，添加：
   - `ALPACA_KEY_ID`、`ALPACA_SECRET`（必需）
   - `FINNHUB_KEY`（可选）
   - `TG_BOT_TOKEN`、`TG_CHAT_ID` / `DISCORD_WEBHOOK` / `FEISHU_WEBHOOK`（可选，任意配置一个即可收到推送）
3. `.github/workflows/daily-scan.yml` 默认在每个交易日美东时间16:30自动运行一次（夏令时需要自己微调cron里的UTC时间），也可以在仓库的 Actions 页手动点「Run workflow」立即测试。
4. 运行结果会自动 commit 到 `cloud/results/` 目录。
5. 回到网页「设置」页，「云端同步」处填入 `https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main`，保存后去「云端结果」页点击「加载云端记录」即可看到历史扫描记录，不需要一直开着浏览器。

---

## 八、如何扩展/替换指标或信号规则（写给未来的你）

- **新增一个技术指标**：只需要在 `js/core/indicators.js` 里新增一个纯函数，输入输出跟现有的保持同样的数组约定即可，不需要改任何其他文件。
- **调整三频共振的判断条件**：改 `js/signals/resonance.js` 里的 `DEFAULT_RESONANCE_CONFIG` 或对应的 `checkWeekly/checkDaily/checkShort` 函数。
- **调整机构多因子的判断标准**（比如 Minervini 条件的具体数字）：改 `js/signals/institutional.js`。
- **调整评分权重**：改 `js/signals/compositeScore.js` 里的 `LAYER_WEIGHTS`。
- **新增一个股票池**：在 `js/core/universeEngine.js` 的 `PoolRegistry` 里加一条注册信息，再在 `getSeedSymbols`（种子池）或 `deriveDynamicPools`（派生池）里加对应的取数据/筛选逻辑。

---

## 九、V2 新增功能使用指南（Universe Management Platform）

V2 在不删除、不改变任何原有功能的前提下，新增了一整套"股票池管理"能力。所有新增功能都通过左侧导航新增的 **构建器 / 统计 / 信号跟踪** 三个页面，以及 **股票池 / 持仓风控 / 设置** 三个原有页面里新增的卡片来使用。

### 9.1 本地数据库（浏览器内嵌 SQLite）

- 首次打开网页时会在后台自动初始化（不阻塞其它功能），实际存储引擎是编译成 WebAssembly 的真实 SQLite（sql.js），数据以单个二进制块的形式保存在浏览器的 IndexedDB 里。
- **数据只保存在当前浏览器/当前设备上**，换电脑或换浏览器不会自动同步（这是"浏览器内嵌数据库"方案的固有特性，如需跨设备可用「设置」页的「导出数据库」功能手动搬运）。
- 「设置」页新增「本地数据库 Local Database (SQLite)」卡片：
  - 「查看状态」：显示数据库是否就绪、各表的行数。
  - 「导出数据库」：把整个数据库导出成 `.sqlite` 文件下载，可用任何 SQLite 工具（如 DB Browser for SQLite）打开查看，也可以当备份。
  - 「重置数据库」：清空所有本地数据库内容（Master Universe/已保存查询/快照/信号历史等），**不会影响**股票池、持仓、设置这些仍然存在 localStorage 里的原有数据。

### 9.2 Master Universe 全市场股票库（第2/3阶段）

- 「设置」页新增「Master Universe 同步」卡片，「立即全量同步」按钮调用 Alpaca `/v2/assets` 接口，把当前可交易的美股（数量通常上万只）的代码/公司名/交易所/资产类型写入本地数据库，作为 **Full Tradable Universe** 的真实底表。
- 这一步拿到的只是基础字段（市值/行业/均量等字段是空的），**这些字段会随着你实际跑扫描而逐步补全**——每次扫描或历史回溯完成后，系统会自动把已经算出来的价格/板块/RS百分位/质量分/综合分写回对应股票的记录，不会覆盖已有的更早数据（用 `COALESCE` 只补空值）。
- 「查看覆盖率」按钮会诚实显示每个字段目前"有多少只股票已知/占比多少"，不会假装数据比实际更全。
- 是否为 ETF 目前是用股票名称里是否含 "ETF/Trust/Fund" 等关键词做启发式判断，**不是官方分类**，数据来源字段会标注为 `alpaca_assets(heuristic_flags)`，供你自行判断可信度。

### 9.3 Dynamic Universe Builder 动态选股构建器（第1阶段）— 「构建器」页

1. 点击「+ 添加条件」，每行选择一个字段（交易所/市值/价格/板块/行业/国家/ETF/ADR/REIT/RS百分位/质量分/动量分/成长分/综合分/上市天数等共19个字段），再选运算符（等于/大于/小于/介于/包含于列表等），填入值。
2. 可以添加多个条件，条件之间支持"全部满足(AND)"或"任一满足(OR)"。
3. 点击「▶ 运行查询」，结果会从本地 Master Universe 表里查出来（所以查询结果的完整度取决于 9.2 提到的字段覆盖率——刚同步完还没怎么扫描过的话，市值/行业这些字段可能大多是空的，此时建议先用 exchange/asset_type 这类基础字段筛选）。
4. 查询结果页面有「➡ 载入到当前扫描池」按钮，一键把结果作为下次扫描的股票池。
5. 可以给条件组合命名保存（「保存查询」），下次直接在「已保存查询」列表里点「运行」重新执行，不用重新拼条件；也可以删除不需要的保存项。
6. 所有条件字段名都经过白名单校验（`FIELD_DEFS`），值全部走参数化绑定，不会有 SQL 注入风险。

### 9.4 股票池集合运算（第5阶段）— 「股票池」页新增卡片

「股票池运算 Universe Operations」卡片，在"当前扫描池"的基础上，跟你在第二个输入框里填的另一批代码做运算：

- **并集/交集/差集/去重**：点击后直接把运算结果写回"当前扫描池"。
- **导出**：把当前扫描池导出成 JSON 文件下载。
- **导入**：选择之前导出的 JSON 文件，恢复成当前扫描池。
- **快照**：给当前扫描池的股票列表存一个带名字的快照，之后可以在下方的快照列表里「载入」（恢复成当前池）、「克隆」（复制一份新快照）或「删除」。快照和已保存的 Builder 查询、Master Universe 数据一样，都存在本地 SQLite 数据库里。

### 9.5 Universe Statistics 股票池统计（第4阶段）— 「统计」页

- 「基于本次扫描结果统计」：对最近一次扫描/历史回溯的结果做统计——多空信号数量分布、板块分布、市值区间分布、综合分/RS分区间分布，每项都用条形图直观展示。
- 「基于 Master Universe 统计」：对本地数据库里 Master Universe 全表做统计（交易所/国家分布等），反映的是"全市场底表"的构成，和上面"基于扫描结果"是两个不同的统计口径，互相不冲突。

### 9.6 Portfolio Risk Analytics 组合风险分析（第7阶段）— 「持仓风控」页新增卡片

在「持仓风控」页原有功能基础上新增「组合风险分析」卡片，需要先有持仓、并且这些持仓代码最近扫描过（用于取当前价/止损价/板块/ATR等数据），点击「▶ 运行风险分析」会计算：

- **Open Risk / Portfolio Heat**：每笔持仓距离止损的风险占比，以及组合总风险敞口。
- **Sector / Theme Exposure**：按板块、按题材（AI/半导体/云计算等13个成长题材分组，`GROWTH_THEMES`）汇总持仓集中度，超过你设定的阈值会标红提示。
- **相关性矩阵**：拉取各持仓最近的日线收盘价，计算两两相关系数，找出高相关（同涨同跌）的持仓对，提示"这两只本质上是同一个风险敞口"。
- **Kelly仓位建议 / 波动率仓位 / 风险平价权重**：Kelly仓位需要 Signal Tracking（见9.7）积累出真实胜率/盈亏比数据才有意义，样本不足时会明确提示"样本不足，暂不建议采用"而不是硬凑一个数字；风险平价用的是简化版"波动率倒数加权"，**不是**严格意义上迭代求解的等风险贡献优化，代码注释里有明确说明。
- **风险预算检查**：对照你设定的单仓/板块/题材风险上限，列出超限项。

### 9.7 Signal Tracking 信号表现看板（第9阶段）— 「信号跟踪」页

- 每次扫描或历史回溯完成后，系统会**自动**把当时的综合分/RS百分位/质量分等写入信号历史表，这一步不需要手动操作，失败也不会影响本次扫描本身（详见9.8）。
- 「查看待复核数量」：显示目前信号历史累计条数、已复核出结果的条数。
- 「▶ 复核到期信号」：对所有"信号发出后已经过了足够多真实交易日"的记录（5/10/20/60/120个交易日，用真实交易日而不是日历天数判断，自动跳过周末节假日），去拉取这段时间的真实价格，算出前瞻收益率/期间最大涨幅/最大回撤/是否跑赢SPY，写回数据库。这一步会产生较多网络请求，股票数量多时会需要一些时间，有进度提示。
- 复核完成后，页面会渲染 **Signal Performance Dashboard**：按持有期（5/10/20/60/120日）汇总平均前瞻收益率、平均最大涨幅/回撤、跑赢SPY胜率、样本数——用来验证"综合评分高的股票，后续表现是不是真的更好"，样本数会随着你持续使用逐渐增多，样本太少时的结论仅供参考。

### 9.8 关于"新功能失败不影响原有扫描"的设计

Master Universe 反哺写入、Signal Tracking 自动记录这两步都包在扫描引擎/历史回溯引擎里独立的 try/catch 中：即使浏览器不支持 IndexedDB、数据库初始化失败、或者某条记录写入出错，只会在控制台打印一条警告，**扫描本身的信号计算和界面展示完全不受影响**——这是延续本项目一贯的"优雅降级"原则，新功能不能反过来拖累或搞坏已经在用的核心功能。

---

## 十、数据局限性说明（诚实清单）

| 项目 | 局限 |
|---|---|
| 小时线数据 | 只有配置 Alpaca Key 才有；免费Yahoo接口只有约60天历史小时线；两者都拿不到时自动降级为"短期日线替代"，界面会标注 |
| 基本面/质量评分 | 依赖可选的 Finnhub Key，免费额度有限；历史回溯时只能用最新快照，非时点数据 |
| Institutional Buying 机构买入池 | 免费数据源没有真实13F/机构持仓变化数据，用"放量+资金流向上"做代理指标，不代表真实机构调仓 |
| RS 相对强度百分位 | 相对"本次扫描样本"排名，不是 IBD/MarketSmith 那种全市场 RS Rating |
| S&P 500 成分股列表 | 优先实时拉取公开数据集，失败时用内置静态兜底列表（可能非最新） |
| Earnings Watch 财报日历 | 依赖 Finnhub 免费额度，覆盖范围和及时性有限 |
| Growth Universe 候选池规模 | 手工分类整理，去重后约226只，覆盖AI/软件/网络安全/金融科技/生物科技/新能源/太空/量子计算等成长赛道，但未达到"对标Russell 1000 Growth约500~800只"的规模——受限于免费工具无法可靠整表抓取指数完整成分股，如需对齐官方成分股建议接入付费数据商(Polygon/FactSet等)的指数成分股接口 |
| Industry Leaders 覆盖度 | 56个细分行业、去重后约258只龙头股，比初版扩大约5倍，但仍是人工整理的代表性名单，不是详尽的GICS全行业覆盖 |
| 本地数据库（V2） | 数据存在浏览器 IndexedDB 里，**只属于当前浏览器/当前设备**，清除浏览器数据会连同数据库一并清空；跨设备需手动「导出/导入」，不是自动云同步 |
| Master Universe 字段覆盖率（V2） | 刚做完全量同步时，除 symbol/company/exchange/asset_type 外的字段（市值/行业/RS/评分等）大多是空的，需要靠实际扫描逐步"喂"出数据，「设置」页有诚实的覆盖率百分比可查 |
| ETF/ADR/REIT 自动分类（V2） | 目前用股票名称关键词做启发式判断（如名字含"ETF/Trust/Fund"判定为ETF），不是官方分类字段，边界情况可能误判，数据来源标注为 `heuristic_flags` 供甄别 |
| Risk Parity 风险平价（V2） | 用的是简化版"波动率倒数加权"近似，不是严格迭代求解的等风险贡献优化，代码注释中已明确标注 |
| Kelly 仓位建议（V2） | 依赖 Signal Tracking 积累的历史胜率/盈亏比样本，新数据库或样本量不足时会明确提示"样本不足"而不是给出误导性数字 |
| GROWTH_THEMES 题材分组（V2） | 和 sectorMap.js 一样是人工整理的"首次命中优先"映射表，不在列表里的股票题材归属会返回空而不是瞎猜 |

以上所有局限在界面上都会有对应的文字提示，不会有"看似正常实则数据缺失/过期"的静默错误。

---

## 十一、测试

项目自带一套零依赖的 Node.js 单元测试（`tests/run.mjs`，纯 `node tests/run.mjs` 即可运行，不需要安装任何测试框架），覆盖所有"纯计算/纯逻辑"模块——即不需要连网络、不需要浏览器环境就能验证正确性的部分：指标计算、时间周期转换、三频共振判断、机构多因子（Minervini/Weinstein/CANSLIM）、评分器、Universe Builder 的 WHERE 子句拼装（`buildWhereClause`）、Universe Ops 的并交差集运算、Universe Statistics 的分布统计、Risk Analytics 的 Beta/相关性/Kelly/风险平价计算、Signal Tracking 的前瞻收益计算、SQLite 表结构定义、Growth/Momentum 派生评分、GROWTH_THEMES 题材映射等，**目前共 77 项测试，全部通过**。

```bash
node tests/run.mjs
```

需要连数据库/网络的"编排层"函数（如 `UniverseBuilder.execute`、`MasterUniverseSync.syncTradableAssets`、`SignalTracking.reviewPendingSignals` 等实际读写 SQLite 或发起真实HTTP请求的部分）不适合用零依赖的Node单元测试覆盖，这部分改用 Playwright 端到端测试在真实 Chromium 浏览器里验证（数据库初始化、Master Universe 同步、Builder 查询与保存、股票池并集与快照、真实扫描、统计渲染、信号自动记录、组合风险分析渲染等全链路均已验证通过），不作为项目交付物的一部分，仅用于本次开发过程中的正确性验证。
