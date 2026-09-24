export const YIELD_FORECAST_HORIZONS = [30, 90, 365] as const;

export interface YieldForecastInput { currentBalanceStroops: string; annualYieldBps: number; horizons?: readonly number[]; }
export interface YieldForecastPoint { days: number; projectedBalanceStroops: string; projectedYieldStroops: string; label: string; }

export function calculateYieldForecasts({ currentBalanceStroops, annualYieldBps, horizons = YIELD_FORECAST_HORIZONS }: YieldForecastInput): YieldForecastPoint[] {
  const balance = BigInt(currentBalanceStroops || '0');
  const safeBps = Math.max(0, Math.min(annualYieldBps, 10000));
  return horizons.map((days) => {
    const projectedYield = (balance * BigInt(safeBps) * BigInt(days)) / (10000n * 365n);
    return { days, projectedBalanceStroops: (balance + projectedYield).toString(), projectedYieldStroops: projectedYield.toString(), label: `${days} day${days === 1 ? '' : 's'}` };
  });
}