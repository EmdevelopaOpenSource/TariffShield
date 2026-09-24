'use client';

// #1008 — surety admin dispute resolution with advisory recommendations.
//
// Lists open collateral disputes and, per dispute, fetches the recommendation
// from GET /admin/disputes/:importerId/recommendation. The suggestion is
// displayed alongside the explicit resolve action (accept keeps the new
// required collateral, reject reverts to the pre-dispute value) — nothing is
// ever auto-resolved.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Nav } from '@/components/Nav';
import { ErrorBanner } from '@/components/ErrorBanner';
import {
  api,
  stroopsToXlm,
  type CollateralDispute,
  type DisputeRecommendation,
} from '@/lib/api';
import { getUser, isAuthenticated } from '@/lib/auth';
import { formatApiError, type FormattedError } from '@/lib/error-formatter';

export default function SuretyDisputesPage() {
  const router = useRouter();
  const [disputes, setDisputes] = useState<CollateralDispute[] | null>(null);
  const [error, setError] = useState<FormattedError | string | null>(null);
  const [recommendations, setRecommendations] = useState<
    Record<string, DisputeRecommendation | 'loading'>
  >({});
  const [busy, setBusy] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace('/login');
      return;
    }
    const user = getUser();
    if (user?.role !== 'surety_admin') {
      router.replace('/app');
      return;
    }
    refresh();
  }, [router]);

  async function refresh() {
    try {
      const r = await api.listOpenDisputes();
      setDisputes(r.disputes);
    } catch (e) {
      setError(formatApiError(e));
      setDisputes([]);
    }
  }

  async function loadRecommendation(dispute: CollateralDispute) {
    setRecommendations((prev) => ({ ...prev, [dispute.id]: 'loading' }));
    try {
      const r = await api.getDisputeRecommendation(dispute.importer_id);
      setRecommendations((prev) => ({ ...prev, [dispute.id]: r.recommendation }));
    } catch (e) {
      setError(formatApiError(e));
      setRecommendations((prev) => {
        const next = { ...prev };
        delete next[dispute.id];
        return next;
      });
    }
  }

  async function resolve(dispute: CollateralDispute, accept: boolean) {
    setBusy(`${dispute.id}:${accept ? 'accept' : 'reject'}`);
    setError(null);
    setSuccessMessage(null);
    try {
      await api.resolveDispute(dispute.id, accept);
      setSuccessMessage(
        accept
          ? `${dispute.importer_legal_name ?? 'Dispute'}: new required collateral upheld on-chain.`
          : `${dispute.importer_legal_name ?? 'Dispute'}: requirement reverted to the pre-dispute value on-chain.`
      );
      await refresh();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Nav />
      <main className="max-w-4xl mx-auto px-6 py-10">
        <Link
          href="/surety"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-card text-xs font-medium text-muted hover:text-accent hover:border-accent/40 transition-colors"
        >
          ← Back to portfolio
        </Link>

        <div className="mt-4">
          <h1 className="text-2xl font-semibold">Collateral disputes</h1>
          <p className="mt-1 text-sm text-muted">
            Open disputes with an advisory accept/reject recommendation. Every resolution is an
            explicit decision executed on-chain — recommendations never auto-resolve.
          </p>
        </div>

        {successMessage ? (
          <div className="mt-4 rounded border border-success bg-success/10 px-3 py-2 text-sm text-success">
            {successMessage}
          </div>
        ) : null}
        <ErrorBanner error={error} className="mt-4" />

        {disputes === null ? (
          <p className="mt-6 text-sm text-muted">Loading…</p>
        ) : disputes.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-border p-10 text-center">
            <p className="text-sm text-muted">No open disputes.</p>
          </div>
        ) : (
          <ul className="mt-6 space-y-4">
            {disputes.map((d) => {
              const rec = recommendations[d.id];
              const busyKey = busy === `${d.id}:accept` || busy === `${d.id}:reject` ? busy : null;
              return (
                <li key={d.id} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{d.importer_legal_name ?? d.importer_id}</p>
                      <p className="mt-1 text-xs text-muted">
                        Raised {new Date(d.raised_at).toLocaleString()} ·{' '}
                        <span className="font-mono">
                          {stroopsToXlm(d.old_required)} → {stroopsToXlm(d.new_required)} XLM
                        </span>{' '}
                        required
                      </p>
                      {d.raise_tx_hash ? (
                        <p className="text-xs font-mono text-muted">{d.raise_tx_hash.slice(0, 12)}…</p>
                      ) : null}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => loadRecommendation(d)}
                        disabled={rec === 'loading'}
                        className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/20 disabled:opacity-50"
                      >
                        {rec === 'loading' ? 'Analyzing…' : 'Show recommendation'}
                      </button>
                      <button
                        onClick={() => resolve(d, true)}
                        disabled={busyKey !== null}
                        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
                      >
                        {busyKey === `${d.id}:accept` ? 'Resolving…' : 'Accept (keep new)'}
                      </button>
                      <button
                        onClick={() => resolve(d, false)}
                        disabled={busyKey !== null}
                        className="rounded-md border border-danger text-danger px-3 py-1.5 text-xs hover:bg-danger/10 disabled:opacity-50"
                      >
                        {busyKey === `${d.id}:reject` ? 'Resolving…' : 'Reject (revert)'}
                      </button>
                    </div>
                  </div>

                  {rec && rec !== 'loading' ? (
                    <div className="mt-4 rounded-md border border-border bg-background p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                            rec.suggestion === 'accept'
                              ? 'border-success/40 bg-success/10 text-success'
                              : 'border-warning/40 bg-warning/10 text-warning'
                          }`}
                        >
                          Suggested: {rec.suggestion === 'accept' ? 'Accept' : 'Reject'}
                        </span>
                        <span className="text-xs text-muted">
                          confidence {rec.confidence} · score {rec.score}
                        </span>
                        <span className="text-xs text-muted">advisory only</span>
                      </div>
                      <p className="mt-2 text-xs text-muted">{rec.rationale}</p>
                      <ul className="mt-3 space-y-1.5">
                        {rec.factors.map((f) => (
                          <li key={f.key} className="flex items-start gap-2 text-xs">
                            <span
                              className={
                                f.direction === 'accept'
                                  ? 'text-success'
                                  : f.direction === 'reject'
                                    ? 'text-warning'
                                    : 'text-muted'
                              }
                            >
                              {f.direction === 'accept' ? '▲' : f.direction === 'reject' ? '▼' : '•'}
                            </span>
                            <span className="text-muted">
                              <span className="font-medium text-foreground">{f.label}:</span>{' '}
                              {f.detail}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {!rec.inputs.chainDataAvailable ? (
                        <p className="mt-2 text-xs text-warning">
                          On-chain data was unavailable — confidence capped at low.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-6 text-xs text-muted">
          Recommendation logic:{' '}
          <Link href="https://github.com/vjuliaife/TariffShield/blob/main/docs/dispute-recommendation.md" className="text-accent hover:underline">
            docs/dispute-recommendation.md
          </Link>
        </p>
      </main>
    </>
  );
}
