import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TallyStatusView } from 'dsh-tally-api'
import type { TallyBalance } from '../balance-service.js'
import type { TallyPricingService } from '../pricing-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tallyRemote: TallyRemote
  }
}

/**
 * `ctx.tallyRemote`: the `tally` Remote namespace, callable from the browser through the dsh
 * API Gateway. Methods only read and delegate to the other tally services.
 *
 * Parameter names matter: the Gateway's source-mode fallback reads them from the compiled
 * function, so a method takes no parameters or a single `request` object.
 */
export class TallyRemote extends TypertRemoteService {
  static inject = ['tallyUsage', 'tallyPricing', 'tallyBalance', 'tallyBudget']

  constructor(ctx: Context) {
    super(ctx, 'tallyRemote', { namespace: 'tally' })
  }

  @Remote
  async status(): Promise<TallyStatusView> {
    // Inside dsh-tally these services are always this package's own implementations.
    const pricing = this.ctx.tallyPricing as TallyPricingService
    const balance = this.ctx.tallyBalance as TallyBalance
    return {
      usage: this.ctx.tallyUsage.status(),
      catalogVersion: pricing.catalogVersion(),
      pricingErrors: pricing.configErrors.map(e => e.message),
      budgetErrors: this.ctx.tallyBudget.status().errors,
      balanceRoutes: balance.routes(),
    }
  }
}
