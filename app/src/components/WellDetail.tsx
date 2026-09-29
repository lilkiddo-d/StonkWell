"use client";

import Link from "next/link";
import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { useLastRebalance, usePositionRange, tickToPrice } from "@/hooks/useProtocol";
import { useWellAccount, useWellStats, useYieldRate } from "@/hooks/useWell";
import { wellAbi, wellOracleAbi, wellPositionV4Abi } from "@/generated/abis";
import { catalog } from "@/generated/catalog";
import { explorerAddress } from "@/lib/chains";
import { useDeployment } from "@/lib/deployment";
import { fmtAmount, fmtBps, fmtUsdg, safeParse, USDG_DECIMALS, WELL_SHARE_DECIMALS } from "@/lib/format";
import { TxStatus, useTx } from "./Tx";
import { AmountInput, NotDeployed, Pill, Stat, Tabs } from "./ui";

const TABS = ["Sink", "Withdraw", "Redeem in kind"] as const;
const ONE_EQUITY = 10n ** 18n;

export function WellDetail({ ticker }: { ticker: string }) {
  const { deployment } = useDeployment();
  const entry = deployment?.wells[ticker];
  const meta = catalog.equityTokens[ticker as keyof typeof catalog.equityTokens];
  const well = entry?.well;
  const s = useWellStats(well);
  const y = useYieldRate(well, s.heldValue, s.equityToken, s.oracle);
  // Shares start at exactly 1 USDG each, so share value above 1.00 is the Well's return since launch.
  const growth = s.sharePrice !== undefined ? (Number(formatUnits(s.sharePrice, USDG_DECIMALS)) - 1) * 100 : undefined;

  return (
    <div className="page">
      <Link href="/wells" className="back" style={{ paddingTop: "1rem" }}>← All Wells</Link>
      <div className="page-head" style={{ paddingTop: 0 }}>
        <div>
          <div className="eyebrow">{meta?.name ?? ticker} Equity Token / USDG</div>
          <h1>{ticker} Well</h1>
        </div>
        {well &&
          (s.paused ? (
            <Pill tone="warn">Sinking paused</Pill>
          ) : s.priceFresh === false ? (
            <Pill tone="warn">Market closed · exits in kind only</Pill>
          ) : (
            <Pill tone="ok">Open · price fresh</Pill>
          ))}
      </div>

      {!deployment || !well || !entry ? (
        <NotDeployed what={`The ${ticker} Well and other Wells`} />
      ) : (
        <div className="grid-2">
          <div className="stack">
            <div className="strip">
              <Stat label="Held value" value={fmtUsdg(s.heldValue, 0)} hint={`of ${fmtUsdg(s.cap, 0)} cap`} />
              <Stat label="Yield rate" value={y.data != null ? `${(y.data * 100).toFixed(1)}%` : "—"} hint="recent fees, annualized" />
              <Stat
                label="Share value"
                value={s.sharePrice !== undefined ? `$${Number(formatUnits(s.sharePrice, USDG_DECIMALS)).toFixed(4)}` : "…"}
                hint={growth !== undefined ? `${growth >= 0 ? "+" : ""}${growth.toFixed(2)}% since launch` : `per w${ticker}`}
              />
              <Stat label="Protocol share" value={fmtBps(s.protocolShareBps)} hint="buys and burns $WELL" />
            </div>
            <WorkingCard ticker={ticker} well={well} position={entry.position} equity={entry.equityToken} usdg={deployment.usdg} oracle={deployment.oracle} stats={s} />
          </div>
          <SinkPanel well={well} usdg={deployment.usdg} ticker={ticker} stats={s} />
        </div>
      )}
    </div>
  );
}

function WorkingCard({
  ticker, well, position, equity, usdg, oracle, stats,
}: { ticker: string; well: Address; position: Address; equity: Address; usdg: Address; oracle: Address; stats: ReturnType<typeof useWellStats> }) {
  const { chainId } = useDeployment();
  const range = usePositionRange(position);
  const last = useLastRebalance(well);
  const { data: prices } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: position, abi: wellPositionV4Abi, chainId, functionName: "spotUsdgValue", args: [ONE_EQUITY] },
      { address: oracle, abi: wellOracleAbi, chainId, functionName: "usdgValue", args: [equity, ONE_EQUITY] },
    ],
  });
  const spot = prices?.[0]?.status === "success" ? Number(formatUnits(prices[0].result as bigint, USDG_DECIMALS)) : undefined;
  const fair = prices?.[1]?.status === "success" ? Number(formatUnits(prices[1].result as bigint, USDG_DECIMALS)) : undefined;
  const drift = spot !== undefined && fair ? ((spot - fair) / fair) * 100 : undefined;

  return (
    <div className="card">
      <h3>Where the Well is working</h3>
      {range && range.liquidity > 0n ? (
        <RangeBar {...range} equityIsToken0={BigInt(equity) < BigInt(usdg)} />
      ) : (
        <p className="small">
          {range ? "No range placed yet. New deposits go to work at the next rebalance." : "The live range appears here once the Well trades on Uniswap v4."}
        </p>
      )}
      <p className="small" style={{ marginTop: "0.9rem" }}>
        The keeper keeps this band centred on the Chainlink price and moves it when {ticker} drifts toward an edge. Trades
        inside the band pay fees to the Well.
      </p>
      <div className="kv"><span>{ticker} held</span><span>{fmtAmount(stats.equityHeld, 18)}</span></div>
      <div className="kv"><span>USDG held</span><span>{fmtUsdg(stats.usdgHeld)}</span></div>
      {drift !== undefined && (
        <div className="kv"><span>Pool vs Chainlink</span><span>{`${drift >= 0 ? "+" : ""}${drift.toFixed(2)}%`}</span></div>
      )}
      <div className="kv"><span>Last rebalance</span><span>{fmtAgo(last.data)}</span></div>
      <div className="addresses">
        <a href={explorerAddress(well)} target="_blank" rel="noreferrer">Well contract ↗</a>
        <a href={explorerAddress(position)} target="_blank" rel="noreferrer">Position ↗</a>
        <a href={explorerAddress(equity)} target="_blank" rel="noreferrer">{ticker} token ↗</a>
      </div>
    </div>
  );
}

function RangeBar({ lower, upper, tick, equityIsToken0 }: { lower: number; upper: number; tick: number; equityIsToken0: boolean }) {
  // Prices in USDG per Equity Token. Tick prices are token1 per token0, so invert when USDG is token0.
  const toUsdg = (t: number) => (equityIsToken0 ? tickToPrice(t, 18, 6) : 1 / tickToPrice(t, 6, 18));
  const a = toUsdg(lower);
  const b = toUsdg(upper);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const now = toUsdg(tick);
  const pad = (hi - lo) * 0.6;
  const min = Math.min(lo - pad, now);
  const max = Math.max(hi + pad, now);
  const pos = (p: number) => `${(((p - min) / (max - min)) * 100).toFixed(2)}%`;
  const inRange = now >= lo && now <= hi;
  const money = (p: number) => `$${p.toLocaleString(undefined, { maximumFractionDigits: p >= 100 ? 0 : 2 })}`;

  return (
    <div className="range">
      <div className="label">{inRange ? "Active range on Uniswap v4" : "Price is outside the range: rebalance due"}</div>
      <div className="range-bar">
        <div className="range-band" style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})` }} />
        <div className={inRange ? "range-mark" : "range-mark out"} style={{ left: pos(now) }} />
        <span className="range-tag" style={{ left: pos(lo) }}>{money(lo)}</span>
        <span className="range-tag now" style={{ left: pos(now) }}>{money(now)}</span>
        <span className="range-tag" style={{ left: pos(hi) }}>{money(hi)}</span>
      </div>
    </div>
  );
}

function fmtAgo(ts: number | null | undefined) {
  if (ts === undefined) return "…";
  if (ts === null) return "over 12h ago";
  const mins = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function SinkPanel({ well, usdg, ticker, stats }: { well: Address; usdg: Address; ticker: string; stats: ReturnType<typeof useWellStats> }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Sink");
  const [amount, setAmount] = useState("");
  const acct = useWellAccount(well, usdg);
  const tx = useTx();
  const { chainId } = useDeployment();

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
        return tx.writeContractAsync({ address: well, abi: wellAbi, chainId, functionName: "deposit", args: [parsed, me] });
      });
    } else if (tab === "Withdraw") {
      const all = acct.maxWithdraw !== undefined && parsed === acct.maxWithdraw && acct.shares !== undefined;
      await tx.run("Withdrawing", async () =>
        all
          ? tx.writeContractAsync({ address: well, abi: wellAbi, chainId, functionName: "redeem", args: [acct.shares!, me, me] })
          : tx.writeContractAsync({ address: well, abi: wellAbi, chainId, functionName: "withdraw", args: [parsed, me, me] })
      );
    } else {
      const supply = stats.totalSupply ?? 0n;
      const minEquity = supply && stats.equityHeld ? (stats.equityHeld * parsed * 98n) / (supply * 100n) : 0n;
      const minUsdg = supply && stats.usdgHeld ? (stats.usdgHeld * parsed * 98n) / (supply * 100n) : 0n;
      await tx.run("Redeeming in kind", async () =>
        tx.writeContractAsync({ address: well, abi: wellAbi, chainId, functionName: "redeemInKind", args: [parsed, me, me, minEquity, minUsdg] })
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
      <p className="small" style={{ margin: 0 }}>
        {tab === "Sink" && `Deposit USDG. You receive w${ticker} shares that track your slice of the Well.`}
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
      <div className="kv"><span>Your shares</span><span>{fmtAmount(acct.shares, WELL_SHARE_DECIMALS, 2)} w{ticker}</span></div>
      <div className="kv"><span>Your position</span><span>{fmtUsdg(acct.maxWithdraw)}</span></div>
      <div className="kv"><span>Wallet USDG</span><span>{fmtUsdg(acct.usdgBalance)}</span></div>
      <button className="btn btn-primary wide" disabled={!parsed || tx.busy || Boolean(disabledReason)} onClick={submit}>
        {tx.busy ? tx.message : disabledReason ?? (tab === "Sink" ? `Sink into the ${ticker} Well` : tab)}
      </button>
      <TxStatus message={tx.busy ? undefined : tx.message} error={tx.error} />
      {tab === "Sink" && <p className="small dim" style={{ marginBottom: 0 }}>Withdraw in USDG any time. Redeem in kind works even when markets are closed.</p>}
    </div>
  );
}

function min(a?: bigint, b?: bigint) {
  if (a === undefined || b === undefined) return undefined;
  return a < b ? a : b;
}
