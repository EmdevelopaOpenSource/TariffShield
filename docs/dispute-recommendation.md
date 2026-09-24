# Dispute Resolution Recommendation Logic (#1008)

The surety admin remains the decision-maker for `resolve_dispute`; the
recommendation produced by
`apps/api/src/services/dispute-recommendation.ts` is **advisory only**
(`advisoryOnly: true`) and never resolves a dispute by itself. This document
is the audit reference for how a suggestion is computed.

## Inputs

| Input | Source |
| --- | --- |
| `collateralBalance`, `requiredCollateral`, `preDisputeRequired` | On-chain account (`getAccount`) |
| Open dispute `old_required` / `new_required` | `collateral_disputes` (latest `status = 'open'` row, when present) |
| Collateral requirement history | On-chain `get_collateral_history` (last 12 entries) |
| Latest oracle change | `oracle_price_feed.pct_change` |
| Past dispute outcomes | `collateral_disputes` where status is `resolved_*` |
| Payment discipline | `contract_events` deposits (`deposit`, `deposit_collateral`, `deposit_reserve`, `auto_top_up`) in the last 90 days |

On-chain reads are best-effort: if Soroban RPC is unreachable the engine still
returns a recommendation built from database inputs with
`chainDataAvailable: false` and confidence capped at `low`.

## Factors and weights

Each factor contributes a signed weight: positive leans **accept** (keep the
new required collateral), negative leans **reject** (revert to the
pre-dispute requirement).

| Factor | Weight | Rule |
| --- | --- | --- |
| Collateral coverage (`balance / required`) | `+3` / `0` / `-3` | `≥ 1.0` → accept; `≥ 0.8` → neutral; otherwise → reject |
| Requirement change magnitude | `+2` / `0` / `-2` | decrease or `< +50%` → accept; `≥ +50%` → reject; unknown → neutral |
| History stability (mean abs. % move across history) | `+1` / `0` / `-1` | `≤ 10%` → accept; `≤ 50%` → neutral; else → reject; `< 3` entries → neutral |
| Payment discipline (90d deposits) | `+2` / `0` / `-2` | deposits `> 0` → accept; no deposits **and** shortfall → reject; no deposits but covered → neutral |
| Past dispute outcomes | `+1` / `0` / `-1` | more upheld (accepted) than importer-favourable (rejected) → accept; more importer-favourable → reject; none → neutral |

## Score → suggestion and confidence

- `score = Σ factor weights`
- `suggestion = score ≥ 0 ? 'accept' : 'reject'`
- Confidence: `|score| ≥ 5` → `high`; `|score| ≥ 2` → `medium`; otherwise
  `low`. Any recommendation produced without on-chain data is forced to `low`.

## Endpoints

- `GET /admin/disputes/:importerId/recommendation` — returns the suggestion,
  score, confidence, per-factor breakdown, inputs and rationale.
- `POST /admin/disputes/:disputeId/resolve` — the explicit admin decision;
  calls on-chain `resolve_dispute`, updates `collateral_disputes`, writes an
  audit-log entry. Recommendations are never invoked from this path.

## Change management

Any change to factors, weights or thresholds **must** be reflected in this
document and in the `RecommendationFactor` table in
`apps/api/src/services/dispute-recommendation.ts` in the same PR, so the
audit trail of past recommendations stays reproducible.
