"use client";

import Link from "next/link";
import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { useWellAccount, useWellStats, useYieldRate } from "@/hooks/useWell";
import { wellAbi } from "@/generated/abis";
import { catalog } from "@/generated/catalog";
import { explorerAddress } from "@/lib/chains";
import { useDeployment } from "@/lib/deployment";
import { fmtAmount, fmtBps, fmtUsdg, safeParse, USDG_DECIMALS, WELL_SHARE_DECIMALS } from "@/lib/format";
import { TxStatus, useTx } from "./Tx";
import { AmountInput, NotDeployed, Pill, Stat, Tabs } from "./ui";

const TABS = ["Sink", "Withdraw", "Redeem in kind"] as const;

export function WellDetail({ ticker }: { ticker: string }) {
  const { deployment } = useDeployment();
  const entry = deployment?.wells[ticker];
  const meta = catalog.equityTokens[ticker as keyof typeof catalog.equityTokens];
  const well = entry?.well;
  const s = useWellStats(well);
  const y = useYieldRate(well, s.heldValue, s.equityToken, s.oracle);

  return (
    <div className="page">
      <Link href="/wells" className="back">← All Wells</Link>
      <div className="page-head">
        <div>
          <h1>{ticker} Well</h1>
          <p className="muted">
            Sink USDG and the Well runs concentrated {meta?.name ?? ticker} Equity Token / USDG liquidity on Uniswap v4,
            compounding 70% of swap fees back into the Well.
          </p>
        </div>
        {well && (s.paused ? <Pill tone="warn">Sinking paused</Pill> : s.priceFresh === false ? <Pill tone="warn">Market closed: exits in kind only</Pill> : <Pill tone="ok">Open</Pill>)}
      </div>

      {!deployment || !well ? (
        <NotDeployed what={`The ${ticker} Well and other Wells`} />
      ) : (
        <div className="grid-2">
          <div className="card">
            <div className="stats-grid">
              <Stat label="Held Value" value={fmtUsdg(s.heldValue)} hint={`Cap ${fmtUsdg(s.cap, 0)}`} />
              <Stat label="Yield Rate" value={y.data != null ? `${(y.data * 100).toFixed(2)}%` : "—"} hint="Trailing, annualized. Not a forecast." />
              <Stat label="Share value" value={s.sharePrice !== undefined ? `$${Number(formatUnits(s.sharePrice, USDG_DECIMALS)).toFixed(6)}` : "…"} hint={`w${ticker} per share`} />
              <Stat label="Protocol share" value={fmtBps(s.protocolShareBps)} hint="Routed to drawdown and retire of $WELL" />
              <Stat label={`${ticker} held`} value={fmtAmount(s.equityHeld, 18)} />
              <Stat label="USDG held" value={fmtUsdg(s.usdgHeld)} />
            </div>
            <div className="addresses">
              <a href={explorerAddress(well)} target="_blank" rel="noreferrer">Well contract ↗</a>
              <a href={explorerAddress(entry.position)} target="_blank" rel="noreferrer">Position contract ↗</a>
              <a href={explorerAddress(entry.equityToken)} target="_blank" rel="noreferrer">{ticker} Equity Token ↗</a>
            </div>
          </div>
          <SinkPanel well={well} usdg={deployment.usdg} ticker={ticker} stats={s} />
        </div>
      )}
    </div>
  );
}

function SinkPanel({ well, usdg, ticker, stats }: { well: Address; usdg: Address; ticker: string; stats: ReturnType<typeof useWellStats> }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Sink");
  const [amount, setAmount] = useState("");
  const acct = useWellAccount(well, usdg);
  const tx = useTx();

  const isShares = tab === "Redeem in kind";
  const parsed = safeParse(amount, isShares ? WELL_SHARE_DECIMALS : USDG_DECIMALS);
  const limit = tab === "Sink" ? min(acct.maxDeposit, acct.usdgBalance) : tab === "Withdraw" ? acct.maxWithdraw : acct.shares;
  const over = parsed !== null && limit !== undefined && parsed > limit;

  async function submit() {
    if (!parsed || !acct.address) return;
    const me = acct.address;
    if (tab === "Sink") {
      await tx.run("Sinking", async ({ ensureAllowance }) => {
        await ensureAllowance(usdg, well, parsed);
        return tx.writeContractAsync({ address: well, abi: wellAbi, functionName: "deposit", args: [parsed, me] });
      });
    } else if (tab === "Withdraw") {
      const all = acct.maxWithdraw !== undefined && parsed === acct.maxWithdraw && acct.shares !== undefined;
      await tx.run("Withdrawing", async () =>
        all
          ? tx.writeContractAsync({ address: well, abi: wellAbi, functionName: "redeem", args: [acct.shares!, me, me] })
          : tx.writeContractAsync({ address: well, abi: wellAbi, functionName: "withdraw", args: [parsed, me, me] })
      );
    } else {
      const supply = stats.totalSupply ?? 0n;
      const minEquity = supply && stats.equityHeld ? (stats.equityHeld * parsed * 98n) / (supply * 100n) : 0n;
      const minUsdg = supply && stats.usdgHeld ? (stats.usdgHeld * parsed * 98n) / (supply * 100n) : 0n;
      await tx.run("Redeeming in kind", async () =>
        tx.writeContractAsync({ address: well, abi: wellAbi, functionName: "redeemInKind", args: [parsed, me, me, minEquity, minUsdg] })
      );
    }
    setAmount("");
  }

  const disabledReason = !acct.address
    ? "Connect a wallet"
    : tab === "Sink" && stats.paused
      ? "Sinking is paused"
      : tab !== "Redeem in kind" && stats.priceFresh === false
        ? "Price feed closed: use Redeem in kind"
        : over
          ? "Amount exceeds available"
          : null;

  return (
    <div className="card">
      <Tabs tabs={TABS} active={tab} onChange={(t) => { setTab(t); setAmount(""); }} />
      <p className="muted small">
        {tab === "Sink" && "Sink USDG into the Well. You receive Well shares that track your portion of Held Value."}
        {tab === "Withdraw" && "Exit to USDG. The Well sells Equity Token as needed within its swap-loss limit (1% by default). You pay that cost, not the holders who stay."}
        {tab === "Redeem in kind" && `Always available, even when markets are closed or sinking is paused. You receive your share of ${ticker} Equity Token and USDG directly.`}
      </p>
      <AmountInput
        value={amount}
        onChange={setAmount}
        symbol={isShares ? `w${ticker}` : "USDG"}
        max={limit !== undefined ? fmtAmount(limit, isShares ? WELL_SHARE_DECIMALS : USDG_DECIMALS, 2) : undefined}
        onMax={limit !== undefined ? () => setAmount(formatUnits(limit, isShares ? WELL_SHARE_DECIMALS : USDG_DECIMALS)) : undefined}
      />
      <div className="kv">
        <span>Your shares</span>
        <span>{fmtAmount(acct.shares, WELL_SHARE_DECIMALS, 2)} w{ticker}</span>
      </div>
      <div className="kv">
        <span>Your position</span>
        <span>{fmtUsdg(acct.maxWithdraw)}</span>
      </div>
      <div className="kv">
        <span>Wallet USDG</span>
        <span>{fmtUsdg(acct.usdgBalance)}</span>
      </div>
      <button className="btn btn-primary wide" disabled={!parsed || tx.busy || Boolean(disabledReason)} onClick={submit}>
        {tx.busy ? tx.message : disabledReason ?? (tab === "Sink" ? `Sink into the ${ticker} Well` : tab)}
      </button>
      <TxStatus message={tx.busy ? undefined : tx.message} error={tx.error} />
    </div>
  );
}

function min(a?: bigint, b?: bigint) {
  if (a === undefined || b === undefined) return undefined;
  return a < b ? a : b;
}
