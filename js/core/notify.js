/**
 * ============================================================================
 * Webhook 通知模块 (Notify) —— Telegram / Discord / 飞书
 * ----------------------------------------------------------------------------
 * 所有 Webhook 地址/Token 只保存在浏览器 localStorage。
 * 三个渠道的请求格式不同，这里统一封装成"传一段文本进来，自动适配格式"，
 * 上层(UI/扫描完成回调)不需要关心每个平台的 API 细节。
 * 注意：浏览器直接调用 Telegram Bot API / Discord Webhook 一般允许跨域，
 * 飞书自定义机器人 Webhook 同样支持浏览器直接 POST；如果你的浏览器/网络
 * 环境屏蔽了直接调用，可以考虑自己加一个简单的转发后端。
 * ============================================================================
 */
'use strict';

const LS_PREFIX = 'va_notify_';

export const Notify = {
  getConfig() {
    return {
      telegramToken: localStorage.getItem(LS_PREFIX + 'tg_token') || '',
      telegramChatId: localStorage.getItem(LS_PREFIX + 'tg_chat') || '',
      discordWebhook: localStorage.getItem(LS_PREFIX + 'discord_url') || '',
      feishuWebhook: localStorage.getItem(LS_PREFIX + 'feishu_url') || '',
    };
  },
  saveConfig(cfg) {
    localStorage.setItem(LS_PREFIX + 'tg_token', cfg.telegramToken || '');
    localStorage.setItem(LS_PREFIX + 'tg_chat', cfg.telegramChatId || '');
    localStorage.setItem(LS_PREFIX + 'discord_url', cfg.discordWebhook || '');
    localStorage.setItem(LS_PREFIX + 'feishu_url', cfg.feishuWebhook || '');
  },

  async sendAll(message) {
    const cfg = this.getConfig();
    const results = {};
    if (cfg.telegramToken && cfg.telegramChatId) {
      results.telegram = await this._sendTelegram(cfg.telegramToken, cfg.telegramChatId, message).catch(e => ({ ok: false, error: e.message }));
    }
    if (cfg.discordWebhook) {
      results.discord = await this._sendDiscord(cfg.discordWebhook, message).catch(e => ({ ok: false, error: e.message }));
    }
    if (cfg.feishuWebhook) {
      results.feishu = await this._sendFeishu(cfg.feishuWebhook, message).catch(e => ({ ok: false, error: e.message }));
    }
    return results;
  },

  async _sendTelegram(token, chatId, text) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    if (!resp.ok) throw new Error(`Telegram ${resp.status}`);
    return { ok: true };
  },

  async _sendDiscord(webhookUrl, content) {
    const resp = await fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
    });
    if (!resp.ok) throw new Error(`Discord ${resp.status}`);
    return { ok: true };
  },

  async _sendFeishu(webhookUrl, text) {
    const resp = await fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
    });
    if (!resp.ok) throw new Error(`飞书 ${resp.status}`);
    const data = await resp.json();
    if (data.code && data.code !== 0) throw new Error(`飞书返回错误: ${data.msg || data.code}`);
    return { ok: true };
  },

  /** 把一批扫描结果格式化成推送文本 */
  formatScanSummary(scanResult, topN = 10) {
    const passed = scanResult.results.filter(r => !r.isError && r.composite && r.composite.score != null)
      .sort((a, b) => b.composite.score - a.composite.score).slice(0, topN);
    const lines = [
      `📊 VectorAlpha 扫描完成 ${scanResult.isHistorical ? `(历史回溯 @ ${scanResult.asOfDate})` : ''}`,
      `样本数: ${scanResult.results.length}  |  ${new Date().toLocaleString('zh-CN')}`,
      '',
      ...passed.map(r => `${r.sym}  综合评分:${r.composite.score}  三频通过:${r.resonance?.passCount ?? '-'}/3  $${r.price?.toFixed(2) ?? '-'}`),
    ];
    return lines.join('\n');
  },
};
