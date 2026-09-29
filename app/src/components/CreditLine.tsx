"use client";

import { useState } from "react";
import { erc20Abi, formatUnits, maxUint256, type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { borrowDeskAbi, wellAbi } from "@/generated/abis";
import { explorerAddress } from "@/lib/chains";
import { useDeployment } from "@/lib/deployment";
import { fmtAmount, fmtBps, fmtHealth, fmtUsdg, fmtWadPct, safeParse, USDG_DECIMALS, WELL_SHARE_DECIMALS } from "@/lib/format";
import { TxStatus, useTx } from "./Tx";
import { AmountInput, Pill, Stat, Tabs } from "./ui";

const TABS = ["Lend", "Withdraw", "Pledge", "Borrow", "Repay", "Release"] as const;
type Tab = (typeof TABS)[number];

export function CreditLine({ ticker, desk, well, usdg }: { ticker: string; desk: Address; well: Address; usdg: Address }) {
  const { address } = useAccount();
  const { chainId } = useDeployment();
  const d = { address: desk, abi: borrowDeskAbi, chainId } as const;
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: [
      { ...d, functionName: "totalAssets" },
      { ...d, functionName: "totalDebt" },
      { ...d, functionName: "cash" },
      { ...d, functionName: "utilization" },
      { ...d, functionName: "borrowRatePerYear" },
      { ...d, functionName: "supplyRatePerYear" },
      { ...d, functionName: "risk" },
      { ...d, functionName: "supplyCap" },
      { ...d, functionName: "borrowCap" },
      { ...d, functionName: "paused" },
      { ...d, functionName: "totalCollateralShares" },
      { address: well, abi: wellAbi, chainId, functionName: "totalSupply" },
    ],
  });
  const acctQ = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(address) },
    contracts: [
      { ...d, functionName: "maxWithdraw", args: [address!] },
      { ...d, functionName: "accounts", args: [address!] },
      { ...d, functionName: "debtOf", args: [address!] },
      { ...d, functionName: "collateralValue", args: [address!] },
      { ...d, functionName: "borrowable", args: [address!] },
      { ...d, functionName: "healthFactor", args: [address!] },
      { address: well, abi: wellAbi, chainId, functionName: "balanceOf", args: [address!] },
      { address: usdg, abi: erc20Abi, chainId, functionName: "balanceOf", args: [address!] },
      { ...d, functionName: "maxDeposit", args: [address!] },
    ],
  });
  const g = <T,>(src: readonly { status: string; result?: unknown }[] | undefined, i: number) =>
    src?.[i]?.status === "success" ? (src[i].result as T) : undefined;
  const risk = g<readonly [number, number, number, number, number, number]>(data, 6);
  const paused = g<boolean>(data, 9);
  const a = acctQ.data;
  const lent = g<bigint>(a, 0);
  const pledged = g<readonly [bigint, bigint]>(a, 1)?.[0];
  const debt = g<bigint>(a, 2);
  const collateral = g<bigint>(a, 3);
  const borrowable = g<bigint>(a, 4);
  const health = g<bigint>(a, 5);
  const wellShares = g<bigint>(a, 6);
  const usdgBal = g<bigint>(a, 7);
  const maxDeposit = g<bigint>(a, 8);
  const totalPledged = g<bigint>(data, 10);
  const wellSupply = g<bigint>(data, 11);
  // pledge() caps all pledged shares at maxCollateralShareBps of the Well's supply.
  const pledgeRoom =
    risk && totalPledged !== undefined && wellSupply !== undefined
      ? (() => { const cap = (wellSupply * BigInt(risk[4])) / 10_000n; return cap > totalPledged ? cap - totalPledged : 0n; })()
      : undefined;
  const min = (x: bigint | undefined, y: bigint | undefined) => (x === undefined || y === undefined ? undefined : x < y ? x : y);

  const [tab, setTab] = useState<Tab>("Lend");
  const [amount, setAmount] = useState("");
  const tx = useTx();
  const isShares = tab === "Pledge" || tab === "Release";
  const decimals = isShares ? WELL_SHARE_DECIMALS : USDG_DECIMALS;
  const parsed = safeParse(amount, decimals);
  const limit: bigint | undefined = {
    Lend: min(usdgBal, maxDeposit),
    Withdraw: lent,
    Pledge: min(wellShares, pledgeRoom),
    Borrow: borrowable,
    Repay: min(debt, usdgBal),
    Release: pledged,
  }[tab];

  async function submit() {
    if (!parsed || !address) return;
    const me = address;
    const w = tx.writeContractAsync;
    const actions: Record<Tab, () => Promise<void>> = {
      Lend: () => tx.run("Lending", async ({ ensureAllowance }) => {
        await ensureAllowance(usdg, desk, parsed);
        return w({ ...d, functionName: "deposit", args: [parsed, me] });
      }),
      Withdraw: () => tx.run("Withdrawing", () => w({ ...d, functionName: "withdraw", args: [parsed, me, me] })),
      Pledge: () => tx.run("Pledging", async ({ ensureAllowance }) => {
        await ensureAllowance(well, desk, parsed);
        return w({ ...d, functionName: "pledge", args: [parsed] });
      }),
      Borrow: () => tx.run("Borrowing", () => w({ ...d, functionName: "borrow", args: [parsed, me] })),
      Repay: () => tx.run("Repaying", async ({ ensureAllowance }) => {
        // Interest accrues until the tx lands, so repaying the displayed debt would leave dust that blocks
        // Release. Repaying in full sends maxUint256 (the desk caps it at debtOf) with a small allowance buffer.
        const full = debt !== undefined && parsed >= debt;
        await ensureAllowance(usdg, desk, full ? parsed + parsed / 1000n + 1n : parsed);
        return w({ ...d, functionName: "repay", args: [full ? maxUint256 : parsed, me] });
      }),
      Release: () => tx.run("Releasing", () => w({ ...d, functionName: "release", args: [parsed, me] })),
    };
    await actions[tab]();
    setAmount("");
  }

  const blocked = !address
    ? "Connect a wallet"
    : paused && (tab === "Lend" || tab === "Pledge" || tab === "Borrow")
      ? "Credit Line paused"
      : parsed !== null && limit !== undefined && parsed > limit
        ? "Amount exceeds available"
        : null;

  // Health after the typed amount, for the actions that change debt or collateral.
  const liq = risk ? BigInt(risk[1]) : undefined;
  const healthOf = (c: bigint, dbt: bigint) => (dbt === 0n ? INFINITE : (c * liq! * 10n ** 18n) / (10_000n * dbt));
  const nextHealth =
    parsed === null || liq === undefined || collateral === undefined || debt === undefined
      ? undefined
      : tab === "Borrow"
        ? healthOf(collateral, debt + parsed)
        : tab === "Repay"
          ? healthOf(collateral, debt > parsed ? debt - parsed : 0n)
          : (tab === "Pledge" || tab === "Release") && pledged
            ? healthOf(tab === "Pledge" ? collateral + (collateral * parsed) / pledged : parsed >= pledged ? 0n : collateral - (collateral * parsed) / pledged, debt)
            : undefined;

  return (
    <div className="stack">
      <div className="card">
        <div className="well-card-head">
          <div>
            <h2>{ticker} Credit Line</h2>
            <p className="small" style={{ margin: "0.3rem 0 0" }}>
              Lend USDG to earn interest, or pledge w{ticker} and borrow USDG against it.{" "}
              <a href={explorerAddress(desk)} target="_blank" rel="noreferrer">Contract ↗</a>
            </p>
          </div>
          {paused ? <Pill tone="warn">Paused</Pill> : <Pill tone="ok">Open</Pill>}
        </div>
        <div className="strip" style={{ marginTop: "1.1rem" }}>
          <Stat label="Supplied" value={fmtUsdg(g<bigint>(data, 0), 0)} hint={`of ${fmtUsdg(g<bigint>(data, 7), 0)} cap`} />
          <Stat label="Borrowed" value={fmtUsdg(g<bigint>(data, 1), 0)} hint={`of ${fmtUsdg(g<bigint>(data, 8), 0)} cap · ${fmtWadPct(g<bigint>(data, 3), 0)} used`} />
          <Stat label="Borrow rate" value={fmtWadPct(g<bigint>(data, 4))} hint="variable, per year" />
          <Stat label="Lend rate" value={fmtWadPct(g<bigint>(data, 5))} hint="variable, per year" />
        </div>
        <p className="small dim" style={{ marginBottom: 0 }}>
          {risk ? `Max LTV ${fmtBps(risk[0])} · liquidation at ${fmtBps(risk[1])} · liquidation bonus ${fmtBps(risk[2])}` : "…"}
        </p>
      </div>
      <div className="grid-2">
        <div className="card">
          <h3>Your Credit Line</h3>
          <div className="kv"><span>Lent</span><span>{fmtUsdg(lent)}</span></div>
          <div className="kv"><span>Pledged</span><span>{fmtAmount(pledged, WELL_SHARE_DECIMALS, 2)} w{ticker} ({fmtUsdg(collateral)})</span></div>
          <div className="kv"><span>Debt</span><span>{fmtUsdg(debt)}</span></div>
          <div className="kv"><span>Can still borrow</span><span>{fmtUsdg(borrowable)}</span></div>
          <div style={{ marginTop: "1rem" }}>
            <div className="label">
              Health · <span className={health !== undefined && health < 11n * 10n ** 17n ? "danger" : undefined}>{fmtHealth(health)}</span>
            </div>
            <div className="health-track">
              {health !== undefined && <span className="health-dot" style={{ left: gaugePos(health) }} />}
              {nextHealth !== undefined && nextHealth !== health && <span className="health-dot next" style={{ left: gaugePos(nextHealth) }} />}
            </div>
            <p className="small dim" style={{ margin: 0 }}>
              Below 1.00, anyone can repay part of your debt and take pledged shares at a discount. Prices pause outside
              market hours and can gap at the open.
            </p>
          </div>
        </div>
        <div className="card">
          <Tabs tabs={TABS} active={tab} onChange={(t) => { setTab(t); setAmount(""); }} />
          <AmountInput
            value={amount}
            onChange={setAmount}
            symbol={isShares ? `w${ticker}` : "USDG"}
            max={limit !== undefined ? fmtAmount(limit, decimals, 2) : undefined}
            onMax={limit !== undefined ? () => setAmount(formatUnits(limit, decimals)) : undefined}
          />
          {nextHealth !== undefined && (
            <div className="kv">
              <span>Health after</span>
              <span className={nextHealth < 11n * 10n ** 17n ? "danger" : undefined}>{fmtHealth(health)} → {fmtHealth(nextHealth)}</span>
            </div>
          )}
          <button className="btn btn-primary wide" disabled={!parsed || tx.busy || Boolean(blocked)} onClick={submit}>
            {tx.busy ? tx.message : blocked ?? tab}
          </button>
          <TxStatus message={tx.busy ? undefined : tx.message} error={tx.error} />
        </div>
      </div>
    </div>
  );
}

const INFINITE = 2n ** 255n;

/// Health on a log scale: 0.70 at the left edge, 1.00 around a quarter of the way, 3.00 and above at the right.
function gaugePos(h: bigint) {
  const v = Number(formatUnits(h > 10n ** 21n ? 10n ** 21n : h, 18));
  const p = Math.log(Math.max(v, 0.7) / 0.7) / Math.log(3 / 0.7);
  return `${(Math.min(1, Math.max(0, p)) * 100).toFixed(1)}%`;
}
