import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { S } from "../../lib/strings";
import * as api from "../../lib/tauri";
import type { TokenGroup, TokenStatistics, TokenTotals } from "../../lib/types";

export function tokenCount(totals: TokenTotals): number {
  return totals.input_tokens + totals.output_tokens;
}

export function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "local":
      return S.settings.statistics.providers.local;
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "mistral":
      return "Mistral";
    case "remote":
      return S.settings.statistics.providers.remote;
    default:
      return S.settings.statistics.providers.other;
  }
}

function UsageNumbers({ totals }: { totals: TokenTotals }) {
  return (
    <dl className="grid grid-cols-3 gap-2">
      <div>
        <dt className="text-[9px] uppercase tracking-wide text-text-muted">
          {S.settings.statistics.input}
        </dt>
        <dd className="mt-0.5 font-mono text-[12px] text-text-primary">
          {formatTokenCount(totals.input_tokens)}
        </dd>
      </div>
      <div>
        <dt className="text-[9px] uppercase tracking-wide text-text-muted">
          {S.settings.statistics.output}
        </dt>
        <dd className="mt-0.5 font-mono text-[12px] text-text-primary">
          {formatTokenCount(totals.output_tokens)}
        </dd>
      </div>
      <div>
        <dt className="text-[9px] uppercase tracking-wide text-text-muted">
          {S.settings.statistics.calls}
        </dt>
        <dd className="mt-0.5 font-mono text-[12px] text-text-primary">
          {formatTokenCount(totals.model_calls)}
        </dd>
      </div>
    </dl>
  );
}

function LocationCard({
  label,
  hint,
  totals,
  overall,
}: {
  label: string;
  hint: string;
  totals: TokenTotals;
  overall: number;
}) {
  const tokens = tokenCount(totals);
  const percent = overall > 0 ? (tokens / overall) * 100 : 0;
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[12px] font-medium text-text-primary">{label}</p>
          <p className="mt-0.5 text-[9px] leading-relaxed text-text-muted">{hint}</p>
        </div>
        <span className="font-mono text-[10px] text-text-muted">{percent.toFixed(1)}%</span>
      </div>
      <p className="mt-3 font-mono text-[18px] font-medium text-text-primary">
        {formatTokenCount(tokens)}
      </p>
      <p className="text-[9px] uppercase tracking-wide text-text-muted">
        {S.settings.statistics.tokens}
      </p>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-bg-elevated">
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-3 border-t border-border-subtle pt-2">
        <UsageNumbers totals={totals} />
      </div>
    </div>
  );
}

function BreakdownRow({ group, maxTokens }: { group: TokenGroup; maxTokens: number }) {
  const tokens = tokenCount(group);
  const width = maxTokens > 0 ? (tokens / maxTokens) * 100 : 0;
  return (
    <div className="space-y-1.5 py-2 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-text-primary">{group.label}</p>
          <p className="text-[9px] text-text-muted">
            {providerLabel(group.provider)} · {formatTokenCount(group.model_calls)} {S.settings.statistics.calls.toLowerCase()}
          </p>
        </div>
        <div className="shrink-0 text-end">
          <p className="font-mono text-[11px] text-text-primary">{formatTokenCount(tokens)}</p>
          <p className="text-[9px] text-text-muted">
            {formatTokenCount(group.input_tokens)} {S.settings.statistics.inShort} / {formatTokenCount(group.output_tokens)} {S.settings.statistics.outShort}
          </p>
        </div>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-bg-elevated">
        <div className="h-full rounded-full bg-accent" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function Breakdown({ title, groups }: { title: string; groups: TokenGroup[] }) {
  if (groups.length === 0) return null;
  const maxTokens = Math.max(...groups.map(tokenCount), 1);
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
        {title}
      </h3>
      <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle bg-bg-card p-4">
        {groups.map((group) => (
          <BreakdownRow key={`${group.provider}:${group.id}`} group={group} maxTokens={maxTokens} />
        ))}
      </div>
    </section>
  );
}

export function StatisticsSection() {
  const [statistics, setStatistics] = useState<TokenStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatistics(await api.tokenStatistics());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const total = statistics ? tokenCount(statistics.total) : 0;
  const trackingSince = statistics?.tracking_since
    ? new Date(statistics.tracking_since).toLocaleDateString()
    : null;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              {S.settings.statistics.title}
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
              {S.settings.statistics.intro}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={S.settings.statistics.refresh}
            className="rounded-md border border-border-subtle p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        </div>

        {error && (
          <p className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-[11px] text-error">
            {S.settings.statistics.error}: {error}
          </p>
        )}

        {!error && !statistics && loading && (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-border-subtle bg-bg-card py-8 text-[11px] text-text-muted">
            <Loader2 size={14} className="animate-spin" />
            {S.settings.statistics.loading}
          </div>
        )}

        {statistics && (
          <>
            <div className="rounded-lg border border-accent/25 bg-accent/5 p-4 sm:p-5">
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.75fr)] sm:items-end">
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-widest text-text-muted">
                    {S.settings.statistics.allTime}
                  </p>
                  <p className="mt-1 font-mono text-[26px] font-medium tracking-tight text-text-primary">
                    {formatTokenCount(total)}
                  </p>
                  <p className="text-[10px] text-text-muted">{S.settings.statistics.tokens}</p>
                </div>
                <div className="border-t border-accent/15 pt-3 sm:border-s sm:border-t-0 sm:ps-5 sm:pt-0">
                  <UsageNumbers totals={statistics.total} />
                </div>
              </div>
            </div>

            {total === 0 ? (
              <p className="rounded-lg border border-border-subtle bg-bg-card px-3 py-6 text-center text-[11px] leading-relaxed text-text-muted">
                {S.settings.statistics.empty}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <LocationCard
                  label={S.settings.statistics.local}
                  hint={S.settings.statistics.localHint}
                  totals={statistics.local}
                  overall={total}
                />
                <LocationCard
                  label={S.settings.statistics.cloud}
                  hint={S.settings.statistics.cloudHint}
                  totals={statistics.cloud}
                  overall={total}
                />
              </div>
            )}
          </>
        )}
      </section>

      {statistics && total > 0 && (
        <>
          <Breakdown title={S.settings.statistics.byProvider} groups={statistics.by_provider} />
          <Breakdown title={S.settings.statistics.byModel} groups={statistics.by_model} />
        </>
      )}

      {statistics && (
        <p className="text-[9px] leading-relaxed text-text-muted">
          {S.settings.statistics.note}
          {trackingSince ? ` ${S.settings.statistics.since} ${trackingSince}.` : ""}
        </p>
      )}
    </div>
  );
}
