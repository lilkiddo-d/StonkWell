"use client";

import { useState } from "react";
import { erc20Abi, formatUnits, type Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { borrowDeskAbi, wellAbi } from "@/generated/abis";
import { explorerAddress } from "@/lib/chains";
import { fmtAmount, fmtBps, fmtHealth, fmtUsdg, fmtWadPct, safeParse, USDG_DECIMALS, WELL_SHARE_DECIMALS } from "@/lib/format";
import { TxStatus, useTx } from "./Tx";
import { AmountInput, Pill, Stat, Tabs } from "./ui";

const TABS = ["Lend", "Withdraw", "Pledge", "Borrow", "Repay", "Release"] as const;
type Tab = (typeof TABS)[number];

export function CreditLine({ ticker, desk, well, usdg }: { ticker: string; desk: Address; well: Address; usdg: Address }) {
  const { address } = useAccount();
  const d = { address: desk, abi: borrowDeskAbi } as const;
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
      { address: well, abi: wellAbi, functionName: "balanceOf", args: [address!] },
      { address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [address!] },
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

  const [tab, setTab] = useState<Tab>("Lend");
  const [amount, setAmount] = useState("");
  const tx = useTx();
  const isShares = tab === "Pledge" || tab === "Release";
  const decimals = isShares ? WELL_SHARE_DECIMALS : USDG_DECIMALS;
  const parsed = safeParse(amount, decimals);
  const limit: bigint | undefined = {
    Lend: usdgBal,
    Withdraw: lent,
    Pledge: wellShares,
    Borrow: borrowable,
    Repay: debt !== undefined && usdgBal !== undefined ? (debt < usdgBal ? debt : usdgBal) : undefined,
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
        await ensureAllowance(usdg, desk, parsed);
        return w({ ...d, functionName: "repay", args: [parsed, me] });
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

  return (
    <div className="card credit-line">
      <div className="page-head">
        <div>
          <h2>{ticker} Credit Line</h2>
          <p className="muted small">
            Lend USDG to earn interest, or pledge {ticker} Well shares and borrow USDG against them.{" "}
            <a href={explorerAddress(desk)} target="_blank" rel="noreferrer">Contract ↗</a>
          </p>
        </div>
        {paused ? <Pill tone="warn">Paused</Pill> : <Pill tone="ok">Open</Pill>}
      </div>
      <div className="stats-grid">
        <Stat label="Supplied" value={fmtUsdg(g<bigint>(data, 0), 0)} hint={`Cap ${fmtUsdg(g<bigint>(data, 7), 0)}`} />
        <Stat label="Borrowed" value={fmtUsdg(g<bigint>(data, 1), 0)} hint={`Cap ${fmtUsdg(g<bigint>(data, 8), 0)}`} />
        <Stat label="Utilization" value={fmtWadPct(g<bigint>(data, 3))} />
        <Stat label="Lend rate" value={fmtWadPct(g<bigint>(data, 5))} hint="Variable, per year" />
        <Stat label="Borrow rate" value={fmtWadPct(g<bigint>(data, 4))} hint="Variable, per year" />
        <Stat label="Max LTV / liquidation" value={risk ? `${fmtBps(risk[0])} / ${fmtBps(risk[1])}` : "…"} hint={risk ? `Liquidation bonus ${fmtBps(risk[2])}` : undefined} />
      </div>
      <div className="grid-2 tight">
        <div>
          <h3>Your Credit Line</h3>
          <div className="kv"><span>Lent</span><span>{fmtUsdg(lent)}</span></div>
          <div className="kv"><span>Pledged</span><span>{fmtAmount(pledged, WELL_SHARE_DECIMALS, 2)} w{ticker} ({fmtUsdg(collateral)})</span></div>
          <div className="kv"><span>Debt</span><span>{fmtUsdg(debt)}</span></div>
          <div className="kv"><span>Can borrow</span><span>{fmtUsdg(borrowable)}</span></div>
          <div className="kv"><span>Health</span><span className={health !== undefined && health < 11n * 10n ** 17n ? "danger" : undefined}>{fmtHealth(health)}</span></div>
          <p className="muted small">
            Collateral is valued at the Chainlink price, never the pool price. Below health 1.00 anyone may repay part of
            your debt and take pledged shares at a discount.
          </p>
        </div>
        <div>
          <Tabs tabs={TABS} active={tab} onChange={(t) => { setTab(t); setAmount(""); }} />
          <AmountInput
            value={amount}
            onChange={setAmount}
            symbol={isShares ? `w${ticker}` : "USDG"}
            max={limit !== undefined ? fmtAmount(limit, decimals, 2) : undefined}
            onMax={limit !== undefined ? () => setAmount(formatUnits(limit, decimals)) : undefined}
          />
          <button className="btn btn-primary wide" disabled={!parsed || tx.busy || Boolean(blocked)} onClick={submit}>
            {tx.busy ? tx.message : blocked ?? tab}
          </button>
          <TxStatus message={tx.busy ? undefined : tx.message} error={tx.error} />
        </div>
      </div>
    </div>
  );
}
