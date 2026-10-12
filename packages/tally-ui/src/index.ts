/**
 * Host half of dsh-tally-ui. It names the Loader entry and declares the element switches the
 * settings page edits: everything else happens in the browser bundle (`dsh-tally-ui/client`),
 * which talks to `dsh-tally` through the `tally` Remote namespace.
 */
import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-tally-ui'

/** The UI elements that can be switched off. The settings section itself always stays on. */
export interface Elements {
  composerDock: boolean
  turnTail: boolean
  headerUtilities: boolean
  sidebarTab: boolean
  budgetToast: boolean
}

export interface Config {
  /** Volatile: switching an element takes effect without remounting the plugin. */
  elements: { [K in keyof Elements]: Volatile<Elements[K]> }
}

/** Raw config as written in the entry (before volatile fields become references). */
export interface ConfigInput {
  elements?: Partial<Elements>
}

const element = (description: string) => Schema.boolean().default(true).volatile().description(description)

export const Config: Schema<ConfigInput, Config> = Schema.object({
  elements: Schema.object({
    composerDock: element('在输入框下方显示费用条'),
    turnTail: element('在每轮回复末尾显示这一轮的费用'),
    headerUtilities: element('在会话头部显示会话累计费用'),
    sidebarTab: element('在右侧栏显示用量看板'),
    budgetToast: element('预算达到提醒线时弹出提示'),
  }).default({}).description('界面元素开关'),
})

export function apply(): void {}
