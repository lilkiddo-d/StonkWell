"use client";

import Link from "next/link";
import type { Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { basketProgramAbi, borrowDeskAbi, wellAbi, wellTokenAbi } from "@/generated/abis";
import { useWellToken } from "@/hooks/useProtocol";
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

  const { token: wellAddress, pending: wellPending } = useWellToken();
  const t = { address: wellAddress, abi: wellTokenAbi, chainId } as const;
  const token = useReadContracts({
    allowFailure: true,
    query: { enabled: enabled && Boolean(wellAddress) },
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
    <div className="stack">
      {unreachable && (
        <p className="tx-status error" style={{ margin: 0 }}>Couldn&apos;t read your positions from the network. Check your connection or RPC and try again.</p>
      )}
      <div className="strip three">
        <Stat label="Net position" value={fmtUsdg(netValue)} hint={loaded && !priced ? "unavailable while prices are stale" : "Wells + lent − debt"} />
        <Stat label="Credit Line debt" value={fmtUsdg(totalDebt)} hint={totalDebt ? "repay any time" : "no open debt"} />
        <Stat label="$WELL balance" value={wellPending ? "—" : fmtAmount(wellBalance, wellDecimals, 2)} hint={wellPending ? "launching soon on Pons" : supplyPct} />
      </div>

      <div className="card">
        <h3>Wells</h3>
        {loadingLists || unreachable ? (
          <p className="small">{unreachable ? "Unavailable" : "Loading…"}</p>
        ) : heldWells.length === 0 && !basketShares ? (
          <p className="small">No Well shares yet. <Link href="/wells">Browse Wells</Link></p>
        ) : null}
        {heldWells.map((w) => {
          // Shares start at 1 USDG each, so value per share above 1.00 is the Well's growth since launch.
          const perShare = w.value !== undefined && w.shares ? Number((w.value * 10n ** 12n * 10_000n) / w.shares) / 10_000 / 1e6 : undefined;
          const growth = perShare !== undefined ? (perShare - 1) * 100 : undefined;
          return (
            <Link key={w.ticker} href={`/wells/${w.ticker}`} className="holding">
              <span className="holding-ic">{w.ticker}</span>
              <span>
                <b>{fmtAmount(w.shares, WELL_SHARE_DECIMALS, 2)} w{w.ticker}</b>
                <span className="small muted" style={{ display: "block" }}>{w.ticker} Well</span>
              </span>
              <span className="holding-v">
                {fmtUsdg(w.value)}
                {growth !== undefined && (
                  <span className={growth >= 0 ? "holding-d good" : "holding-d danger"} style={{ display: "block" }}>
                    {growth >= 0 ? "+" : ""}{growth.toFixed(2)}% per share
                  </span>
                )}
              </span>
            </Link>
          );
        })}
        {basketShares ? (
          <Link href="/programs" className="holding">
            <span className="holding-ic">BSKT</span>
            <span><b>Basket Program</b></span>
            <span className="holding-v">{fmtUsdg(basketValue)}</span>
          </Link>
        ) : null}

        <h3 style={{ marginTop: "1.4rem" }}>Credit Lines</h3>
        {!desksQ.data || unreachable ? (
          <p className="small">{unreachable ? "Unavailable" : "Loading…"}</p>
        ) : activeDesks.length === 0 ? (
          <p className="small">No Credit Line positions. <Link href="/borrow">Borrow Desk</Link></p>
        ) : null}
        {activeDesks.map((d) => (
          <Link key={d.ticker} href="/borrow" className="holding">
            <span className="holding-ic">{d.ticker}</span>
            <span>
              <b>{d.ticker} Credit Line</b>
              <span className="small muted" style={{ display: "block" }}>
                lent {fmtUsdg(d.lent)} · pledged {fmtUsdg(d.collateral)}
              </span>
            </span>
            <span className="holding-v">
              {fmtUsdg(d.debt)}
              <span className="holding-d dim" style={{ display: "block" }}>debt</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
