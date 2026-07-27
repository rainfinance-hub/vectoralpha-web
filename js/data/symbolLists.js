/**
 * ============================================================================
 * 静态/半静态代码列表 (Symbol Lists)
 * ----------------------------------------------------------------------------
 * 说明：
 *  - 这些列表用于 Universe Engine 里"成分股类"股票池的兜底/初始数据。
 *  - 指数成分股每年会有调整，本文件内的静态列表整理自公开资料，可能与最新
 *    真实成分股存在少量出入。S&P 500 优先从公开数据集实时拉取，失败时才
 *    使用本文件的静态兜底列表，并在 UI 上明确提示"使用兜底列表，可能非最新"。
 *  - 想要更新/替换列表，只需要改这一个文件，不影响 Universe Engine 的逻辑。
 * ============================================================================
 */
'use strict';

export const DOW30 = [
  'AAPL','AMGN','AMZN','AXP','BA','CAT','CRM','CSCO','CVX','DIS',
  'GS','HD','HON','IBM','JNJ','JPM','KO','MCD','MMM','MRK',
  'MSFT','NKE','NVDA','PG','SHW','TRV','UNH','V','VZ','WMT',
];

export const NASDAQ100 = [...new Set([
  'AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','AVGO','TSLA','COST',
  'NFLX','AMD','PEP','ADBE','CSCO','TMUS','LIN','INTU','QCOM','TXN',
  'CMCSA','AMGN','HON','INTC','AMAT','BKNG','ISRG','VRTX','PANW','ADP',
  'SBUX','MU','LRCX','GILD','MDLZ','REGN','ADI','PYPL','KLAC','SNPS',
  'CDNS','MELI','CRWD','MAR','CTAS','ORLY','PDD','ABNB','MRVL','CSX',
  'WDAY','ROP','NXPI','FTNT','DXCM','PCAR','MNST','PAYX','ODFL','AEP',
  'ROST','KDP','FAST','EA','CHTR','BKR','CTSH','VRSK','EXC','XEL',
  'CPRT','KHC','GEHC','DDOG','TTD','ANSS','ON','CSGP','FANG','ZS',
  'BIIB','WBD','TEAM','DASH','ILMN','MRNA','LULU','GFS','SMCI',
  'CDW','MDB','WBA','ENPH','SIRI','ALGN','JD','LCID','RIVN',
])];

// SPDR 板块 ETF —— Sector Universe 的核心
export const SECTOR_ETFS = [
  { sym: 'XLK', name: '科技 Technology' },
  { sym: 'XLF', name: '金融 Financials' },
  { sym: 'XLV', name: '医疗 Healthcare' },
  { sym: 'XLY', name: '可选消费 Cons. Discretionary' },
  { sym: 'XLP', name: '必需消费 Cons. Staples' },
  { sym: 'XLE', name: '能源 Energy' },
  { sym: 'XLI', name: '工业 Industrials' },
  { sym: 'XLB', name: '材料 Materials' },
  { sym: 'XLU', name: '公用事业 Utilities' },
  { sym: 'XLRE', name: '房地产 Real Estate' },
  { sym: 'XLC', name: '通信服务 Comm. Services' },
];

// ETF Universe：宽基 + 板块 + 主题，用于 Sector Rotation / 资金流向观察
export const ETF_UNIVERSE = [
  'SPY','QQQ','IWM','DIA','SMH','SOXX','IGV','ARKK',
  'XLF','XLK','XLE','XLI','XLY','XLV','XLP','XLU','XLB','XLRE','XLC',
  'XBI','VNQ','TLT','IEF','GLD','SLV','USO','UUP',
];

// Industry Leaders：每个细分行业保留 3-5 家龙头，用于 Industry Universe。
// 2026-07 扩容：从最初10个大类(45只)扩展到55个细分行业，覆盖更精细的GICS子行业。
// 部分小众/新兴行业(太空卫星、量子计算)的代码经过网络检索核实，避免使用已退市/改代码的公司
// (例如 Block Inc 已从 SQ 改为 XYZ，Paramount 与 Skydance 合并后新代码为 PSKY)。
// 行业之间允许代码重复出现(如 NVDA 同时属于AI和半导体设计)，这是正常的，不是bug。
export const INDUSTRY_LEADERS = {
  'AI / 人工智能':                  ['NVDA','AMD','AVGO','PLTR','SMCI'],
  'AI基础设施/数据中心 Data Center': ['VRT','ETN','EQIX','DLR','MOD'],
  '软件 Software/SaaS':             ['MSFT','CRM','NOW','WDAY','ADBE'],
  '网络安全 Cybersecurity':          ['CRWD','PANW','ZS','FTNT','S'],
  '云计算基础设施 Cloud Infra':      ['AMZN','GOOGL','MSFT','NET','DDOG'],
  '数据分析/云软件 Data & Analytics': ['SNOW','PLTR','MDB','ESTC','CFLT'],
  '半导体设计 Semiconductor Design': ['NVDA','AMD','AVGO','QCOM','MRVL'],
  '半导体设备 Semiconductor Equip':  ['ASML','AMAT','LRCX','KLAC','TER'],
  '网络硬件 Networking':             ['CSCO','ANET','JNPR','CIEN','NOK'],
  '货币中心银行 Money Center Banks': ['JPM','BAC','C','WFC','GS'],
  '区域银行 Regional Banks':         ['PNC','USB','TFC','RF','FITB'],
  '资产管理 Asset Management':       ['BLK','BX','KKR','APO','TROW'],
  '保险-财产险 P&C Insurance':       ['PGR','TRV','ALL','CB','AIG'],
  '保险-人寿/健康 Life & Health':    ['MET','PRU','UNH','ELV','CI'],
  '支付/信用卡网络 Payments':        ['V','MA','PYPL','FI','GPN'],
  '交易所/金融数据 Exchanges & Data': ['ICE','CME','NDAQ','CBOE','MSCI'],
  '医疗-制药大厂 Big Pharma':        ['LLY','NVO','JNJ','MRK','PFE'],
  '医疗-生物科技 Biotech':           ['VRTX','REGN','AMGN','GILD','BIIB'],
  '医疗-基因编辑/罕见病 Gene Editing': ['CRSP','NTLA','BEAM','RARE','SRPT'],
  '医疗设备 MedTech':                ['ISRG','MDT','SYK','BSX','EW'],
  '医疗保险 Health Insurers':        ['UNH','ELV','CI','HUM','CVS'],
  '诊断/生命科学工具 Diagnostics':   ['TMO','DHR','A','ILMN','IQV'],
  '消费-电商 E-commerce':            ['AMZN','MELI','JD','PDD','ETSY'],
  '消费-社交媒体/数字广告 Social Ads': ['META','GOOGL','PINS','SNAP','RDDT'],
  '消费-流媒体/娱乐 Streaming':      ['NFLX','DIS','WBD','SPOT','LYV'],
  '消费-游戏 Gaming':                ['EA','TTWO','RBLX','U','NTES'],
  '消费-餐饮 Restaurants':           ['MCD','SBUX','CMG','YUM','DPZ'],
  '消费-零售 Retail':                ['WMT','COST','TGT','TJX','ROST'],
  '消费-服饰/奢侈品 Apparel & Luxury': ['NKE','LULU','TPR','RL','DECK'],
  '消费-美妆个护 Beauty & Personal': ['EL','PG','COTY','ELF','KVUE'],
  '航空 Airlines':                   ['DAL','UAL','LUV','AAL','ALK'],
  '铁路/物流 Rail & Logistics':      ['UNP','CSX','NSC','UPS','FDX'],
  '汽车制造 Automakers':             ['TSLA','GM','F','TM','RIVN'],
  '汽车零部件 Auto Parts':           ['APTV','BWA','LEA','ALV','GT'],
  '工业自动化/机器人 Industrial Auto': ['ROK','HON','EMR','PH','ETN'],
  '农业机械 Agri Equipment':         ['DE','AGCO','CNHI','CAT','TTC'],
  '化工 Chemicals':                  ['LIN','APD','SHW','ECL','DD'],
  '金属/矿业 Metals & Mining':       ['FCX','NEM','NUE','STLD','AA'],
  '石油天然气-开采 Oil & Gas E&P':   ['XOM','CVX','COP','EOG','OXY'],
  '油田服务 Oilfield Services':      ['SLB','HAL','BKR','FTI','NOV'],
  '公用事业-电力 Electric Utilities': ['NEE','DUK','SO','D','AEP'],
  '公用事业-水务 Water Utilities':   ['AWK','WTRG','CWT'],
  '电信 Telecom':                    ['VZ','T','TMUS','CHTR','CMCSA'],
  '传媒娱乐 Media':                  ['DIS','WBD','PSKY','FOXA','LYV'],
  '酒店/博彩 Hotels & Gaming':       ['MAR','HLT','MGM','LVS','WYNN'],
  '旅游预订 Online Travel':          ['BKNG','EXPE','ABNB','TRIP','TCOM'],
  'REIT-住宅 Residential REIT':      ['AVB','EQR','ESS','MAA','INVH'],
  'REIT-工业/数据中心 Industrial REIT': ['PLD','EQIX','DLR','AMT','CCI'],
  '住宅建筑 Homebuilders':           ['DHI','LEN','PHM','NVR','TOL'],
  '太阳能/新能源 Solar & Clean Energy': ['FSLR','ENPH','SEDG','RUN','NEE'],
  '电池/储能 Battery & Storage':     ['TSLA','ALB','PLUG','BE','FLNC'],
  '核能/电力需求 Nuclear & Power':   ['GEV','VST','TLN','NRG','CEG'],
  '太空/卫星 Space & Satellite':     ['RKLB','ASTS','LUNR','IRDM','LMT'],
  '国防军工 Defense':                ['LMT','RTX','NOC','GD','LHX'],
  '量子计算 Quantum Computing':      ['IONQ','RGTI','QBTS','IBM','ARQQ'],
  '金融科技/新兴支付 Fintech':       ['XYZ','PYPL','AFRM','SOFI','COIN'],
};

// Growth Universe 候选池（成长股/未来龙头，作为动态筛选前的种子池，
// 实际"是否入选"由 Universe Engine 的成长性筛选逻辑二次确认，这里只是候选范围）。
// 2026-07 扩容说明：原本只有30只示例代码。用户要求扩到 500~800 只，
// 但受限于可用工具（无法可靠地整表抓取 Russell 1000 Growth 这类指数的完整成分股——
// 直接抓取会被拦截，WebFetch对大表格又会截断/摘要成几十条），改为手工分类整理，
// 去重后约 226 只覆盖各成长赛道的候选股——比初版扩大了约7.5倍，但仍未达到
// 500~800的目标规模。这是"能做到多少就诚实说多少"，没有为了凑数字硬塞不确定的代码。
// 已覆盖：AI/半导体/软件SaaS/网络安全/金融科技/消费互联网/社交媒体/生物科技/
// 消费品牌/新能源车/核能电力/太空国防量子计算/工业/医疗健康等主流成长赛道。
// 如果需要真正对齐 Russell 1000 Growth 等指数的完整官方成分股（通常450~800只），
// 建议接入付费数据商(如 Polygon/FactSet 的指数成分股接口)按官方名单定期同步，
// 而不是长期维护这份手工列表。
const GROWTH_AI_SEMIS = ['NVDA','AMD','AVGO','PLTR','SMCI','MRVL','ARM','ALAB','CRDO','ANET','VRT','MOD','ETN','MU','QCOM','ON','MPWR','TER','LRCX','AMAT'];
const GROWTH_SOFTWARE = ['MSFT','CRM','NOW','WDAY','SNOW','DDOG','NET','MDB','ESTC','CFLT','GTLB','FROG','PATH','BILL','HUBS','ZM','OKTA','DOCU','TWLO','PAYC','PCTY','VEEV','TEAM','MNDY','ASAN','ADBE','INTU','SHOP','TTD','APP','U','RBLX'];
const GROWTH_CYBER = ['CRWD','PANW','ZS','FTNT','S','CYBR','QLYS','TENB'];
const GROWTH_FINTECH = ['V','MA','PYPL','FI','GPN','XYZ','SOFI','AFRM','UPST','COIN','HOOD','MSTR','MARA','RIOT','CLSK'];
const GROWTH_INTERNET = ['AMZN','MELI','JD','PDD','ETSY','BABA','BIDU','W','CHWY','CPNG','SE','GRAB','DASH','UBER','ABNB','LYFT'];
const GROWTH_MEDIA_SOCIAL = ['META','GOOGL','GOOG','PINS','SNAP','RDDT','NFLX','DIS','SPOT','EA','TTWO','NTES','WBD','LYV'];
const GROWTH_BIOTECH = ['VRTX','REGN','LLY','NVO','ARGX','ALNY','NBIX','EXAS','DXCM','PODD','INSP','CRSP','NTLA','BEAM','RARE','SRPT','MRNA','BNTX','ISRG'];
const GROWTH_CONSUMER_BRANDS = ['CELH','ELF','BROS','CAVA','SG','WING','SHAK','PLNT','LULU','ONON','DECK','CROX','BIRK','DUOL','OLLI','FIVE','ULTA','DKNG','CVNA'];
const GROWTH_EV_CLEAN = ['TSLA','RIVN','LCID','NIO','LI','XPEV','ENPH','SEDG','FSLR','RUN','PLUG','BE','FLNC','ALB','CEG'];
const GROWTH_NUCLEAR_POWER = ['GEV','VST','TLN','NRG','OKLO','SMR','LEU','CCJ'];
const GROWTH_SPACE_DEFENSE_QUANTUM = ['RKLB','ASTS','LUNR','IRDM','LMT','NOC','IONQ','RGTI','QBTS','ARQQ','KTOS','AXON'];
const GROWTH_INDUSTRIAL_MISC = ['CAT','DE','HON','GE','TDG','HEI','ROK','AXON'];
const GROWTH_HEALTHCARE_MISC = ['TDOC','HIMS','OSCR','GH','NVCR','TMDX','PEN','VEEV','DOCS','HQY','GDRX'];
const GROWTH_SEMIS_EXTRA = ['SWKS','QRVO','ENTG','COHR','LSCC','MCHP','ADI','TXN'];
const GROWTH_BIOTECH_EXTRA = ['ARWR','IONS','VKTX','RXRX','TWST','NBIX'];
const GROWTH_SPACE_EXTRA = ['RDW','SATS','VSAT','GSAT','TSAT','SPIR'];
const GROWTH_URANIUM_EXTRA = ['UUUU','UEC','DNN','CCJ'];
const GROWTH_TRAVEL_RETAIL_EXTRA = ['BKNG','EXPE','TCOM','BOOT','YETI','FIVE'];
const GROWTH_SOFTWARE_EXTRA = ['DBX','ZI','NICE','DOCN'];
// 注：Splunk(SPLK)已于2024年被思科收购并退市，Discover Financial(DFS)已于2025年被Capital One收购并退市，
// 均不再纳入候选列表——这是核实后主动排除，不是遗漏。

export const GROWTH_SEEDS = [...new Set([
  ...GROWTH_AI_SEMIS, ...GROWTH_SOFTWARE, ...GROWTH_CYBER, ...GROWTH_FINTECH,
  ...GROWTH_INTERNET, ...GROWTH_MEDIA_SOCIAL, ...GROWTH_BIOTECH, ...GROWTH_CONSUMER_BRANDS,
  ...GROWTH_EV_CLEAN, ...GROWTH_NUCLEAR_POWER, ...GROWTH_SPACE_DEFENSE_QUANTUM,
  ...GROWTH_INDUSTRIAL_MISC, ...GROWTH_HEALTHCARE_MISC, ...GROWTH_SEMIS_EXTRA,
  ...GROWTH_BIOTECH_EXTRA, ...GROWTH_SPACE_EXTRA, ...GROWTH_URANIUM_EXTRA,
  ...GROWTH_TRAVEL_RETAIL_EXTRA, ...GROWTH_SOFTWARE_EXTRA,
])];

// ----------------------------------------------------------------------------
// 主题分类 (Growth Themes) —— V2 第七阶段(Portfolio Risk / Theme Exposure)新增
// 复用上面已经手工整理好的成长赛道分组，给每个分组一个主题名字，供
// riskAnalytics.js 计算"主题集中度(Theme Exposure)"用——比如同时持有
// NVDA+AMD+SMCI 单看都是不同代码，但都属于"AI/半导体"主题，组合实际
// 集中度比看起来更高。和 sectorMap.js 的板块映射是同一种"如实标注局限性"
// 的做法：同一只股票可能出现在多个主题分组里，取第一次出现的分类。
// ----------------------------------------------------------------------------
export const GROWTH_THEMES = {
  'AI/半导体 AI & Semiconductors': GROWTH_AI_SEMIS,
  '软件/SaaS Software & SaaS': GROWTH_SOFTWARE,
  '网络安全 Cybersecurity': GROWTH_CYBER,
  '金融科技 Fintech': GROWTH_FINTECH,
  '互联网/电商 Internet & E-commerce': GROWTH_INTERNET,
  '媒体/社交 Media & Social': GROWTH_MEDIA_SOCIAL,
  '生物科技 Biotech': [...GROWTH_BIOTECH, ...GROWTH_BIOTECH_EXTRA],
  '消费品牌 Consumer Brands': GROWTH_CONSUMER_BRANDS,
  '新能源车/清洁能源 EV & Clean Energy': GROWTH_EV_CLEAN,
  '核能/电力 Nuclear & Power': [...GROWTH_NUCLEAR_POWER, ...GROWTH_URANIUM_EXTRA],
  '太空/国防/量子计算 Space/Defense/Quantum': [...GROWTH_SPACE_DEFENSE_QUANTUM, ...GROWTH_SPACE_EXTRA],
  '工业 Industrial': GROWTH_INDUSTRIAL_MISC,
  '医疗健康 Healthcare Misc': GROWTH_HEALTHCARE_MISC,
};

function buildSymbolThemeMap() {
  const map = {};
  for (const [theme, symbols] of Object.entries(GROWTH_THEMES)) {
    for (const sym of symbols) if (!(sym in map)) map[sym] = theme; // 多主题重复出现时取第一次
  }
  return map;
}
const SYMBOL_TO_THEME = buildSymbolThemeMap();

/** 查询某只股票所属的主题分类，查不到返回 null（不在成长赛道分组里的股票，比如传统价值股，本来就没有主题标签） */
export function getThemeForSymbol(sym) {
  return SYMBOL_TO_THEME[sym] || null;
}

/**
 * 获取 S&P 500 成分股：优先从公开 GitHub 数据集实时拉取，失败则用静态兜底列表。
 * 返回 { symbols, source: 'live'|'static-fallback' }
 */
export async function fetchSP500() {
  try {
    const resp = await fetch('https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const lines = text.trim().split('\n').slice(1);
    const symbols = lines.map(l => l.split(',')[0].trim().replace(/\./g, '-')).filter(Boolean);
    if (symbols.length < 400) throw new Error('返回数量异常，判定为无效数据');
    return { symbols, source: 'live' };
  } catch (e) {
    console.warn('[symbolLists] S&P500 实时拉取失败，使用静态兜底列表:', e.message);
    return { symbols: SP500_STATIC_FALLBACK, source: 'static-fallback' };
  }
}

// S&P 500 静态兜底列表（精简版，覆盖各板块权重股，实时拉取失败时使用）
export const SP500_STATIC_FALLBACK = [
  ...new Set([...DOW30, ...NASDAQ100,
    'BRK-B','UNH','XOM','JPM','V','PG','MA','HD','CVX','MRK','ABBV','PEP','KO','BAC','PFE',
    'TMO','COST','DIS','ABT','WFC','CRM','ACN','MCD','LIN','DHR','TXN','VZ','NEE','PM',
    'RTX','UPS','SPGI','LOW','INTU','AMGN','UNP','IBM','CAT','GE','ELV','NOW','BA','AMD',
    'PLD','SYK','DE','BLK','GS','MDT','ADI','BKNG','LMT','MMC','AXP','GILD','SBUX','MDLZ',
    'C','TJX','ADP','VRTX','CI','SCHW','ZTS','PGR','SO','CB','MO','BSX','ETN','EOG',
    'DUK','APD','ITW','CL','FI','AON','SLB','NOC','WM','CSX','PNC','TGT','USB','FDX',
  ])
];
