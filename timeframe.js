/**
 * ============================================================================
 * 个股 → 板块ETF 映射表 (Symbol → Sector ETF Map) —— 2026-07 新增
 * ----------------------------------------------------------------------------
 * 背景：之前 compositeScore.js 的"行业层"从来没有真正用过任何一只股票的
 * 真实行业归属——不管开没开"启用行业轮动评分"，行业层要么是硬编码的中性50分，
 * 要么恒定是null，从未真正把 MarketContext.getSectorRotation() 算出来的
 * 11个板块ETF排名跟"某只股票具体属于哪个板块"对应起来。本文件就是补上
 * 这个缺失的环节：给个股一个板块ETF标签，才能查它在板块轮动排名里的百分位。
 *
 * 做法：复用 symbolLists.js 里已经维护的 INDUSTRY_LEADERS(56个细分行业)，
 * 手工给每个细分行业分配一个最贴近的 SECTOR_ETFS(11个大类)标签，
 * 再反推出 "股票代码 -> 板块ETF" 的映射表。
 *
 * 明确的局限性(如实说明，不假装精确)：
 *  1. 这是简化的近似映射，不是严格的GICS官方分类。个别边界案例(比如"消费-零售"
 *     里混了必需消费的WMT/COST和可选消费的TGT/TJX)按类别里的多数从属做了取舍。
 *  2. 只覆盖 INDUSTRY_LEADERS 里出现过的~260只股票。不在这个表里的股票
 *     (比如Core池里很多S&P500成分股并未进入行业龙头名单)查不到板块，
 *     getSectorForSymbol 会返回 null——调用方(compositeScore/riskWorkbench)
 *     必须把"查不到"当成"数据不可用"处理，不能瞎猜一个板块或者补一个中性分。
 *  3. 同一只股票可能在 INDUSTRY_LEADERS 里出现在多个细分行业下(比如NVDA
 *     同时属于"AI"和"半导体设计")，这里取它第一次出现的那个分类，结果是
 *     确定性的(每次运行都一样)，但本质上是"选了其中一种合理归类"，不代表
 *     该公司只属于这一个行业。
 *  4. 如果未来想要更精确的行业分类，建议接入付费数据商(如FMP/Polygon)的
 *     GICS sector/industry字段替换这个手工表，其余调用方代码不用改。
 * ============================================================================
 */
'use strict';
import { INDUSTRY_LEADERS } from './symbolLists.js';

// 56个细分行业 -> 11个SPDR板块ETF(见 symbolLists.js 的 SECTOR_ETFS) 的简化对应表
export const CATEGORY_TO_SECTOR_ETF = {
  'AI / 人工智能': 'XLK',
  'AI基础设施/数据中心 Data Center': 'XLK',
  '软件 Software/SaaS': 'XLK',
  '网络安全 Cybersecurity': 'XLK',
  '云计算基础设施 Cloud Infra': 'XLK',
  '数据分析/云软件 Data & Analytics': 'XLK',
  '半导体设计 Semiconductor Design': 'XLK',
  '半导体设备 Semiconductor Equip': 'XLK',
  '网络硬件 Networking': 'XLK',
  '货币中心银行 Money Center Banks': 'XLF',
  '区域银行 Regional Banks': 'XLF',
  '资产管理 Asset Management': 'XLF',
  '保险-财产险 P&C Insurance': 'XLF',
  '保险-人寿/健康 Life & Health': 'XLF',
  '支付/信用卡网络 Payments': 'XLK',
  '交易所/金融数据 Exchanges & Data': 'XLF',
  '医疗-制药大厂 Big Pharma': 'XLV',
  '医疗-生物科技 Biotech': 'XLV',
  '医疗-基因编辑/罕见病 Gene Editing': 'XLV',
  '医疗设备 MedTech': 'XLV',
  '医疗保险 Health Insurers': 'XLV',
  '诊断/生命科学工具 Diagnostics': 'XLV',
  '消费-电商 E-commerce': 'XLY',
  '消费-社交媒体/数字广告 Social Ads': 'XLC',
  '消费-流媒体/娱乐 Streaming': 'XLC',
  '消费-游戏 Gaming': 'XLC',
  '消费-餐饮 Restaurants': 'XLY',
  '消费-零售 Retail': 'XLY',
  '消费-服饰/奢侈品 Apparel & Luxury': 'XLY',
  '消费-美妆个护 Beauty & Personal': 'XLP',
  '航空 Airlines': 'XLI',
  '铁路/物流 Rail & Logistics': 'XLI',
  '汽车制造 Automakers': 'XLY',
  '汽车零部件 Auto Parts': 'XLY',
  '工业自动化/机器人 Industrial Auto': 'XLI',
  '农业机械 Agri Equipment': 'XLI',
  '化工 Chemicals': 'XLB',
  '金属/矿业 Metals & Mining': 'XLB',
  '石油天然气-开采 Oil & Gas E&P': 'XLE',
  '油田服务 Oilfield Services': 'XLE',
  '公用事业-电力 Electric Utilities': 'XLU',
  '公用事业-水务 Water Utilities': 'XLU',
  '电信 Telecom': 'XLC',
  '传媒娱乐 Media': 'XLC',
  '酒店/博彩 Hotels & Gaming': 'XLY',
  '旅游预订 Online Travel': 'XLY',
  'REIT-住宅 Residential REIT': 'XLRE',
  'REIT-工业/数据中心 Industrial REIT': 'XLRE',
  '住宅建筑 Homebuilders': 'XLY',
  '太阳能/新能源 Solar & Clean Energy': 'XLU',
  '电池/储能 Battery & Storage': 'XLI',
  '核能/电力需求 Nuclear & Power': 'XLU',
  '太空/卫星 Space & Satellite': 'XLI',
  '国防军工 Defense': 'XLI',
  '量子计算 Quantum Computing': 'XLK',
  '金融科技/新兴支付 Fintech': 'XLK',
};

// 由 INDUSTRY_LEADERS 反推出 "股票代码 -> 板块ETF" 的映射（模块加载时算一次，之后是纯查表）
function buildSymbolSectorMap() {
  const map = {};
  for (const [category, symbols] of Object.entries(INDUSTRY_LEADERS)) {
    const etf = CATEGORY_TO_SECTOR_ETF[category];
    if (!etf) continue; // 理论上不会发生：如果发生说明两个文件的分类名不一致，属于需要修的bug
    for (const sym of symbols) {
      if (!(sym in map)) map[sym] = etf; // 多个行业出现同一代码时，取第一次出现的分类
    }
  }
  return map;
}

export const SYMBOL_TO_SECTOR_ETF = buildSymbolSectorMap();

/** 查询某只股票所属的板块ETF代码，查不到返回 null（明确表示"未知"，不是"中性"） */
export function getSectorForSymbol(sym) {
  return SYMBOL_TO_SECTOR_ETF[sym] || null;
}
