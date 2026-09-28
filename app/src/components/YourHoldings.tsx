"use client";

import Link from "next/link";
import type { Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { basketProgramAbi, borrowDeskAbi, wellAbi, wellTokenAbi } from "@/generated/abis";
import { useDeployment } from "@/lib/deployment";
import { fmtAmount, fmtUsdg, WELL_SHARE_DECIMALS } from "@/lib/format";
import { ConnectButton } from "./ConnectButton";
import { Stat } from "./ui";

type Result = { status: string; result?: unknown };
const get = <T,>(src: readonly Result[] | undefined, i: number) =>
  src?.[i]?.status === "success" ? (src[i].result as T) : undefined;

export function YourHoldings() {
  const { deployment, chainId } = useDeployment();
  const { address } = useAccount();
  const wells = deployment ? Object.entries(deployment.wells) : [];
  const desks = deployment ? (Object.entries(deployment.creditLines) as [string, Address][]) : [];
  const enabled = Boolean(deployment && address);
  const me = address!;

  const t = { address: deployment?.wellToken, abi: wellTokenAbi, chainId } as const;
  const token = useReadContracts({
    allowFailure: true,
    query: { enabled },
    contracts: [
      { ...t, functionName: "balanceOf", args: [me] },
      { ...t, functionName: "totalSupply" },
      { ...t, functionName: "decimals" },
    ],
  });
  const wellBalance = get<bigint>(token.data, 0);
  const wellSupply = get<bigint>(token.data, 1);
  const wellDecimals = get<number>(token.data, 2) ?? 18;

  const shares = useReadContracts({
    allowFailure: true,
    query: { enabled },
    contracts: wells.map(([, w]) => ({ address: w.well, abi: wellAbi, chainId, functionName: "balanceOf", args: [me] }) as const),
  });
  const wellShares = wells.map((_, i) => get<bigint>(shares.data, i));
  const wellValuesQ = useReadContracts({
    allowFailure: true,
    query: { enabled: enabled && Boolean(shares.data) },
    contracts: wells.map(([, w], i) => ({ address: w.well, abi: wellAbi, chainId, functionName: "convertToAssets", args: [wellShares[i] ?? 0n] }) as const),
  });
  const wellValues = wells.map((_, i) => get<bigint>(wellValuesQ.data, i));

  const bp = { address: deployment?.basketProgram, abi: basketProgramAbi, chainId } as const;
  const basketSharesQ = useReadContracts({
    allowFailure: true,
    query: { enabled },
    contracts: [{ ...bp, functionName: "balanceOf", args: [me] }],
  });
  const basketShares = get<bigint>(basketSharesQ.data, 0);
  const basketValueQ = useReadContracts({
    allowFailure: true,
    query: { enabled: enabled && basketShares !== undefined },
    contracts: [{ ...bp, functionName: "convertToAssets", args: [basketShares ?? 0n] }],
  });
  const basketValue = get<bigint>(basketValueQ.data, 0);

  // Lender shares are valued with convertToAssets, not maxWithdraw, which is capped by the desk's free cash.
  const deskSharesQ = useReadContracts({
    allowFailure: true,
    query: { enabled },
    contracts: desks.map(([, desk]) => ({ address: desk, abi: borrowDeskAbi, chainId, functionName: "balanceOf", args: [me] }) as const),
  });
  const deskShares = desks.map((_, i) => get<bigint>(deskSharesQ.data, i));
  const desksQ = useReadContracts({
    allowFailure: true,
    query: { enabled: enabled && Boolean(deskSharesQ.data) },
    contracts: desks.flatMap(([, desk], i) => [
      { address: desk, abi: borrowDeskAbi, chainId, functionName: "convertToAssets", args: [deskShares[i] ?? 0n] } as const,
      { address: desk, abi: borrowDeskAbi, chainId, functionName: "collateralValue", args: [me] } as const,
      { address: desk, abi: borrowDeskAbi, chainId, functionName: "debtOf", args: [me] } as const,
    ]),
  });
  const deskRows = desks.map(([ticker], i) => ({
    ticker,
    lent: get<bigint>(desksQ.data, i * 3),
    collateral: get<bigint>(desksQ.data, i * 3 + 1),
    debt: get<bigint>(desksQ.data, i * 3 + 2),
  }));

  const sum = (xs: (bigint | undefined)[]) => xs.reduce<bigint>((s, x) => s + (x ?? 0n), 0n);
  const totalDebt = desksQ.data ? sum(deskRows.map((d) => d.debt)) : undefined;
  // Distinguish "you hold nothing" from "couldn't read the chain", so an unreachable RPC never shows as empty.
  const queries = [token, shares, basketSharesQ, deskSharesQ];
  const unreachable = queries.some((q) => q.isError || (q.data !== undefined && q.data.length > 0 && q.data.every((x) => x.status !== "success")));
  const loadingLists = !shares.data || !deskSharesQ.data;
  const loaded = wellValuesQ.data && basketValueQ.data && desksQ.data;
  // Well and collateral valuations revert while the oracle price is stale (market closed); don't count those as zero.
  const failed = (q: readonly Result[] | undefined) => q?.some((x) => x.status !== "success") ?? false;
  const priced = !failed(wellValuesQ.data) && !failed(basketValueQ.data) && !failed(desksQ.data);
  const netValue = loaded && priced
    ? sum([...wellValues, basketValue, ...deskRows.map((d) => d.lent), ...deskRows.map((d) => d.collateral)]) - (totalDebt ?? 0n)
    : undefined;
  const supplyPct =
    wellBalance !== undefined && wellSupply ? `${(Number((wellBalance * 1_000_000n) / wellSupply) / 10_000).toFixed(4)}% of supply` : undefined;

  if (!deployment) return null;
  if (!address) {
    return (
      <div className="card notice">
        <h3>Your holdings</h3>
        <p className="muted">Connect a wallet to see your $WELL balance, Well shares and Credit Line positions.</p>
        <ConnectButton />
      </div>
    );
  }

  const heldWells = wells.map(([ticker], i) => ({ ticker, shares: wellShares[i], value: wellValues[i] })).filter((w) => w.shares);
  const activeDesks = deskRows.filter((d) => d.lent || d.collateral || d.debt);

  return (
    <div className="card">
      <h2>Your holdings</h2>
      {unreachable && (
        <p className="tx-status error">Couldn&apos;t read your positions from the network. Check your connection or RPC and try again.</p>
      )}
      <div className="stats-grid">
        <Stat label="$WELL balance" value={fmtAmount(wellBalance, wellDecimals, 2)} hint={supplyPct} />
        <Stat label="Net position value" value={fmtUsdg(netValue)} hint={loaded && !priced ? "Unavailable while prices are stale (market closed)" : "Wells, Basket and Credit Lines, less debt"} />
        <Stat label="Credit Line debt" value={fmtUsdg(totalDebt)} />
      </div>

      <h3 className="section-title">Wells</h3>
      {loadingLists || unreachable ? (
        <p className="muted small">{unreachable ? "Unavailable" : "Loading…"}</p>
      ) : heldWells.length === 0 ? (
        <p className="muted small">No Well shares yet. <Link href="/wells">Browse Wells</Link></p>
      ) : null}
      {heldWells.map((w) => (
        <div key={w.ticker} className="kv">
          <span><Link href={`/wells/${w.ticker}`}>{w.ticker} Well</Link> · {fmtAmount(w.shares, WELL_SHARE_DECIMALS, 4)} w{w.ticker}</span>
          <span>{fmtUsdg(w.value)}</span>
        </div>
      ))}
      {basketShares ? (
        <div className="kv">
          <span><Link href="/programs">Basket Program</Link></span>
          <span>{fmtUsdg(basketValue)}</span>
        </div>
      ) : null}

      <h3 className="section-title">Credit Lines</h3>
      {!desksQ.data || unreachable ? (
        <p className="muted small">{unreachable ? "Unavailable" : "Loading…"}</p>
      ) : activeDesks.length === 0 ? (
        <p className="muted small">No Credit Line positions. <Link href="/borrow">Borrow Desk</Link></p>
      ) : null}
      {activeDesks.map((d) => (
        <div key={d.ticker}>
          <div className="kv"><span><Link href="/borrow">{d.ticker} Credit Line</Link> · lent</span><span>{fmtUsdg(d.lent)}</span></div>
          <div className="kv"><span>Pledged Well shares</span><span>{fmtUsdg(d.collateral)}</span></div>
          <div className="kv"><span>Debt</span><span>{fmtUsdg(d.debt)}</span></div>
        </div>
      ))}
    </div>
  );
}
