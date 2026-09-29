"use client";

import Link from "next/link";
import type { Address } from "viem";
import { useWellStats, useYieldRate } from "@/hooks/useWell";
import { fmtUsdg } from "@/lib/format";
import { Pill } from "./ui";

export function WellCard({ ticker, name, well, soon }: { ticker: string; name: string; well?: Address; soon?: boolean }) {
  const s = useWellStats(well);
  const y = useYieldRate(well, s.heldValue, s.equityToken, s.oracle);
  const fill = s.heldValue !== undefined && s.cap ? Number((s.heldValue * 10_000n) / s.cap) / 100 : 0;

  if (soon) {
    return (
      <div className="card well-card soon">
        <div className="well-card-head">
          <div>
            <div className="ticker">{ticker}</div>
            <div className="muted small">{name} / USDG</div>
          </div>
          <Pill tone="muted">Soon</Pill>
        </div>
      </div>
    );
  }

  return (
    <Link href={`/wells/${ticker}`} className="card well-card">
      <div className="well-card-head">
        <div>
          <div className="ticker">{ticker}</div>
          <div className="muted small">{name} / USDG</div>
        </div>
        {!well ? (
          <Pill tone="muted">Launching</Pill>
        ) : s.paused ? (
          <Pill tone="warn">Paused</Pill>
        ) : s.priceFresh === false ? (
          <Pill tone="warn">Market closed</Pill>
        ) : (
          <Pill tone="ok">Open</Pill>
        )}
      </div>
      <div className="well-card-stats">
        <div>
          <div className="label">Held value</div>
          <div className="stat-value small">{well ? fmtUsdg(s.heldValue, 0) : "—"}</div>
        </div>
        <div>
          <div className="label">Yield rate</div>
          <div className="stat-value small">{y.data != null ? `${(y.data * 100).toFixed(2)}%` : "—"}</div>
        </div>
      </div>
      {well && (
        <div>
          <div className="capbar" title={`${fill.toFixed(1)}% of cap`}>
            <div style={{ width: `${Math.min(fill, 100)}%` }} />
          </div>
          <div className="cap-note">
            {fill.toFixed(0)}% of {fmtUsdg(s.cap, 0)} cap
          </div>
        </div>
      )}
    </Link>
  );
}
