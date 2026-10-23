import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { createCollector } from './collector.js';
import { TOKEN_PASS_ALLOWANCE_USD, TOKEN_PASS_PERIOD_START_DAY } from './pass.js';

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const snapshotSchema = z.object({
  status: z.enum(['ok', 'disabled', 'unauthenticated', 'unavailable']),
  allowanceUsd: z.number().finite().positive(),
  spentUsd: z.number().finite().nonnegative().nullable(),
  usedPercent: z.number().finite().nullable(),
  rateUsdPerDay: z.number().finite().nonnegative().nullable(),
  projectedPercent: z.number().finite().nullable(),
  hitDay: daySchema.nullable(),
  periodStart: daySchema,
  periodEnd: daySchema,
  renewal: daySchema,
  daily: z.array(z.object({ day: daySchema, usd: z.number().finite().nonnegative() })),
  observedAt: z.number().int().nonnegative().nullable(),
});

export const rpcContract = defineRpcContract({
  getPace: {
    input: z.object({ refresh: z.boolean().optional().default(false) }).strict(),
    output: snapshotSchema,
  },
});

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    tokenpassEnabled: { type: 'boolean', label: 'Track Vercel Token Pass', default: true },
    tokenpassApiKey: {
      type: 'string',
      label: 'Vercel AI Gateway API key',
      secret: true,
      description: 'Create one at vercel.com → AI Gateway → API Keys. Any key on the team that owns the Token Pass works; the plugin only reads spend for the token-pass provider.',
    },
    tokenpassAllowanceUsd: {
      type: 'number',
      label: 'Token Pass credit per billing period (USD)',
      experimental_schema: z.number().finite().positive(),
      description: `Defaults to ${TOKEN_PASS_ALLOWANCE_USD}. Token Pass publishes no balance endpoint, so usage is this allowance minus measured spend.`,
    },
    tokenpassPeriodStartDay: {
      type: 'number',
      label: 'Renewal day of the month',
      experimental_schema: z.number().int().min(1).max(31),
      description: `Defaults to ${TOKEN_PASS_PERIOD_START_DAY}. The day your Token Pass renews — find it under Teams → Billing → next invoice in Vercel. No API exposes it, so it cannot be detected automatically. Day 31 is clamped inside short months.`,
    },
  });

  const collector = createCollector();
  settings.onChange(() => collector.invalidate());
  bb.onDispose(() => collector.dispose());

  const number = (values: Record<string, unknown>, key: string, fallback: number) => {
    const value = values[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };

  async function measure(refresh: boolean) {
    const values = await settings.get() as Record<string, unknown>;
    const key = typeof values['tokenpassApiKey'] === 'string' ? values['tokenpassApiKey'] as string : '';
    return collector.measure({
      enabled: values['tokenpassEnabled'] !== false,
      key,
      allowanceUsd: number(values, 'tokenpassAllowanceUsd', TOKEN_PASS_ALLOWANCE_USD),
      periodStartDay: number(values, 'tokenpassPeriodStartDay', TOKEN_PASS_PERIOD_START_DAY),
    }, refresh);
  }

  bb.rpc.register(rpcContract, {
    getPace: async ({ refresh }) => measure(refresh),
  });
}
