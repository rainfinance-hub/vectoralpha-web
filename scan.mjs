# ============================================================================
# 云端定时扫描工作流 (Daily Cloud Scan)
# ----------------------------------------------------------------------------
# 使用方法：
#   1. 把整个项目 push 到你自己的 GitHub 仓库。
#   2. 在仓库 Settings -> Secrets and variables -> Actions 里添加以下 Secrets：
#        ALPACA_KEY_ID, ALPACA_SECRET   （必需，用于取行情数据）
#        FINNHUB_KEY                    （可选，用于基本面/质量评分）
#        TG_BOT_TOKEN, TG_CHAT_ID       （可选，Telegram推送）
#        DISCORD_WEBHOOK                （可选，Discord推送）
#        FEISHU_WEBHOOK                 （可选，飞书推送）
#   3. 默认每个交易日美东时间 16:30（收盘后半小时）运行一次，可自行调整 cron。
#   4. 运行结果会自动 commit 回 cloud/results/ 目录，前端"云端结果"页
#      通过 GitHub raw 内容直接读取，不需要额外的服务器。
# ============================================================================
name: Daily Cloud Scan

on:
  schedule:
    - cron: '30 20 * * 1-5'   # UTC 20:30 = 美东标准时间 16:30（夏令时请自行调整为 19:30 UTC）
  workflow_dispatch:          # 支持手动触发，方便测试
    inputs:
      pool:
        description: '要扫描的 Universe 池子 id（见 js/core/universeEngine.js 的 PoolRegistry）'
        default: 'core'
      limit:
        description: '本次扫描的最大股票数量'
        default: '600'

jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: 运行云端扫描
        env:
          ALPACA_KEY_ID: ${{ secrets.ALPACA_KEY_ID }}
          ALPACA_SECRET: ${{ secrets.ALPACA_SECRET }}
          FINNHUB_KEY: ${{ secrets.FINNHUB_KEY }}
          TG_BOT_TOKEN: ${{ secrets.TG_BOT_TOKEN }}
          TG_CHAT_ID: ${{ secrets.TG_CHAT_ID }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
          FEISHU_WEBHOOK: ${{ secrets.FEISHU_WEBHOOK }}
          NOTIFY_ON_SIGNAL: 'true'
          SCAN_POOL: ${{ github.event.inputs.pool || 'core' }}
          SCAN_LIMIT: ${{ github.event.inputs.limit || '600' }}
        run: node cloud/scan.mjs

      - name: 提交扫描结果
        run: |
          git config user.name "vectoralpha-bot"
          git config user.email "actions@users.noreply.github.com"
          git add cloud/results/
          git diff --cached --quiet || git commit -m "chore: 云端扫描结果 $(date -u +%Y-%m-%d)"
          git push
