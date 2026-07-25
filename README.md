# VectorAlpha 网络版美股选股器

基于 **Universe Engine（股票池引擎）** 架构的机构级美股选股系统，纯前端网页应用（也可选配 GitHub Actions 做云端定时扫描），核心特色：

- 16 类股票池统一管理（Core / ETF / Sector / Industry / Growth / Quality / Momentum / Watchlist / Portfolio / Earnings Watch / High RS / New Highs / Institutional Buying / CANSLIM Candidates / Minervini Candidates / Custom）
- 双信号框架分层组合：**三频共振**（周线/日线/短周期择时）+ **机构多因子**（Minervini趋势模板 / Weinstein阶段分析 / CANSLIM / RS相对强度）
- **历史特定日期回溯**：输入任意历史日期，还原当天真实的多周期信号状态，而不是给最新数据贴个日期标签
- 持仓/风控工作台、Webhook推送（Telegram/Discord/飞书）、GitHub Actions云端定时扫描
- 模块化设计：数据层/指标层/时间周期层/Universe引擎/信号引擎/UI 完全解耦，方便替换或新增指标

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
│  │  ├─ indicators.js          指标计算（SMA/EMA/RSI/MACD/ADX/ATR/OBV/CMF/布林带…）
│  │  ├─ timeframe.js           时间周期转换（日→周/月聚合、asOfDate截断）
│  │  ├─ universeEngine.js      Universe Engine（16类股票池注册表）
│  │  ├─ analysisPipeline.js    单只股票分析流水线（数据+指标+信号+评分）
│  │  ├─ scanEngine.js          实时扫描引擎
│  │  ├─ historyEngine.js       历史回溯引擎（核心功能）
│  │  ├─ riskWorkbench.js       持仓/风控工作台
│  │  ├─ notify.js              Webhook 通知
│  │  └─ cloudSync.js           云端结果读取
│  ├─ signals/                 信号引擎
│  │  ├─ resonance.js           三频共振框架
│  │  ├─ institutional.js       机构多因子框架（Minervini/Weinstein/CANSLIM/RS）
│  │  ├─ marketContext.js       市场环境（Market Regime + Sector Rotation）
│  │  ├─ qualityScore.js        质量评分
│  │  └─ compositeScore.js      分层组合评分器
│  └─ ui/
│     ├─ app.js                 界面控制器
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

## 九、数据局限性说明（诚实清单）

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

以上所有局限在界面上都会有对应的文字提示，不会有"看似正常实则数据缺失/过期"的静默错误。
