/** Locale namespace of every dsh-tally-ui string. */
export const NS = 'tally'

/** Simplified-Chinese strings. Placeholders are written `{name}`. */
export const zh = {
  'status.ready': '记账服务已连接',
  'status.unavailable': '记账服务不可用',

  'band.peak': '高峰价',
  'band.offpeak': '低谷价',
  'band.flat': '统一价',
  'band.countdown': '{band}，{time} 后切换',

  'money.unpriced': '未定价',
  'balance.stale': '已过期',
  'balance.notConfigured': '未配置账号',
  'balance.signedOut': '未登录',
  'balance.failed': '查询失败：{reason}',

  'dock.session': '本会话',
  'dock.today': '今日',
  'dock.balance': '余额',

  'turn.cost': '本轮费用',
  'turn.input': '输入',
  'turn.cacheRead': '缓存命中',
  'turn.output': '输出',
  'turn.hitRate': '命中率',
  'turn.requests': '请求数',
  'turn.priceVersion': '价格版本',
  'turn.source': '价格来源',

  'header.total': '本会话累计',
  'header.subagents': '含子智能体 {count} 个',

  'tab.title': '用量',
  'tab.range.today': '今天',
  'tab.range.7d': '近 7 天',
  'tab.range.30d': '近 30 天',
  'tab.range.month': '本月',
  'tab.byModel': '按模型',
  'tab.byWorkspace': '按工作区',
  'tab.bySession': '按会话',
  'tab.hitRateTrend': '缓存命中率趋势',
  'tab.savings': '低谷时段节省',
  'tab.export': '导出 CSV',
  'tab.unpriced': '{count} 次请求未定价',
  'tab.unknownWorkspace': '未知工作区',
  'tab.deleted': '已删除（{count}）',

  'settings.nav': '用量与费用',
  'settings.catalog': '价格目录',
  'settings.overrides': '价格覆盖',
  'settings.budgets': '预算',
  'settings.elements': '界面元素',
  'settings.rebuild': '重建账本',
  'settings.rebuildProgress': '正在重建：{done} / {total}',

  'alert.reached80': '预算“{budget}”已用 80%（{spent} / {limit}）',
  'alert.reached100': '预算“{budget}”已用尽（{spent} / {limit}）',

  disclaimer: '估算值，以账单为准',
} as const

/** English strings; the key set must equal the Chinese one. */
export const en: Record<keyof typeof zh, string> = {
  'status.ready': 'Usage tracking connected',
  'status.unavailable': 'Usage tracking unavailable',

  'band.peak': 'Peak price',
  'band.offpeak': 'Off-peak price',
  'band.flat': 'Flat price',
  'band.countdown': '{band}, changes in {time}',

  'money.unpriced': 'Unpriced',
  'balance.stale': 'Stale',
  'balance.notConfigured': 'Account not configured',
  'balance.signedOut': 'Signed out',
  'balance.failed': 'Lookup failed: {reason}',

  'dock.session': 'Session',
  'dock.today': 'Today',
  'dock.balance': 'Balance',

  'turn.cost': 'Turn cost',
  'turn.input': 'Input',
  'turn.cacheRead': 'Cache hit',
  'turn.output': 'Output',
  'turn.hitRate': 'Hit rate',
  'turn.requests': 'Requests',
  'turn.priceVersion': 'Price version',
  'turn.source': 'Price source',

  'header.total': 'Session total',
  'header.subagents': 'Includes {count} subagents',

  'tab.title': 'Usage',
  'tab.range.today': 'Today',
  'tab.range.7d': 'Last 7 days',
  'tab.range.30d': 'Last 30 days',
  'tab.range.month': 'This month',
  'tab.byModel': 'By model',
  'tab.byWorkspace': 'By workspace',
  'tab.bySession': 'By session',
  'tab.hitRateTrend': 'Cache hit rate trend',
  'tab.savings': 'Off-peak savings',
  'tab.export': 'Export CSV',
  'tab.unpriced': '{count} requests unpriced',
  'tab.unknownWorkspace': 'Unknown workspace',
  'tab.deleted': 'Deleted ({count})',

  'settings.nav': 'Usage and cost',
  'settings.catalog': 'Price catalog',
  'settings.overrides': 'Price overrides',
  'settings.budgets': 'Budgets',
  'settings.elements': 'Interface elements',
  'settings.rebuild': 'Rebuild ledger',
  'settings.rebuildProgress': 'Rebuilding: {done} / {total}',

  'alert.reached80': 'Budget "{budget}" is 80% used ({spent} / {limit})',
  'alert.reached100': 'Budget "{budget}" is used up ({spent} / {limit})',

  disclaimer: 'Estimate; the bill is authoritative',
}

export type TallyLocaleKey = keyof typeof zh
