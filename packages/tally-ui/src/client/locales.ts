/** Locale namespace of every dsh-tally-ui string. */
export const NS = 'tally'

/** Simplified-Chinese strings. */
export const zh = {
  'status.ready': '记账服务已连接',
  'status.unavailable': '记账服务不可用',
} as const

/** English strings; the key set must equal the Chinese one. */
export const en: Record<keyof typeof zh, string> = {
  'status.ready': 'Usage tracking connected',
  'status.unavailable': 'Usage tracking unavailable',
}

export type TallyLocaleKey = keyof typeof zh
