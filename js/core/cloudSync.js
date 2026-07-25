/**
 * ============================================================================
 * 云端同步模块 (Cloud Sync) —— 前端读取 GitHub Actions 定时扫描的结果
 * ----------------------------------------------------------------------------
 * 不需要你自己搭后端：GitHub Actions 每天跑一次 cloud/scan.mjs，
 * 结果以 JSON 文件形式 commit 回仓库的 cloud/results/ 目录，
 * 前端只需要用 GitHub raw 内容 URL 直接 fetch 这些 JSON 文件即可。
 * 仓库地址保存在 localStorage，格式如 https://raw.githubusercontent.com/<user>/<repo>/<branch>
 * ============================================================================
 */
'use strict';

const LS_KEY = 'va_cloud_raw_base';

export const CloudSync = {
  getBaseUrl() { return localStorage.getItem(LS_KEY) || ''; },
  saveBaseUrl(url) { localStorage.setItem(LS_KEY, (url || '').replace(/\/$/, '')); },

  async getHistory() {
    const base = this.getBaseUrl();
    if (!base) throw new Error('尚未配置云端仓库地址（设置页 -> 云端同步）');
    const resp = await fetch(`${base}/cloud/results/history.json?t=${Date.now()}`);
    if (!resp.ok) throw new Error(`获取云端记录失败 HTTP ${resp.status}（GitHub Actions可能还没跑过，或仓库地址不对）`);
    return resp.json();
  },

  async getLatestDetail() {
    const base = this.getBaseUrl();
    if (!base) throw new Error('尚未配置云端仓库地址');
    const resp = await fetch(`${base}/cloud/results/latest-full.json?t=${Date.now()}`);
    if (!resp.ok) throw new Error(`获取云端明细失败 HTTP ${resp.status}`);
    return resp.json();
  },
};
