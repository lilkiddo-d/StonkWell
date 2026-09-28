"use client";

import { useState } from "react";
import { useAccount, useReadContracts, useWatchAsset } from "wagmi";
import { drawdownRetireAbi, wellTokenAbi } from "@/generated/abis";
import { explorerAddress } from "@/lib/chains";
import { useDeployment } from "@/lib/deployment";
import { fmtAmount, shortAddress } from "@/lib/format";
import { Pill, Stat } from "./ui";

// $WELL trades on the Pons launchpad, whose token pages are /launchpad/<address>. NEXT_PUBLIC_WELL_TRADE_URL overrides.
const tradeUrl = (token: string) => process.env.NEXT_PUBLIC_WELL_TRADE_URL || `https://www.ponsfamily.com/launchpad/${token}`;

export function WellTokenDetails() {
  const { deployment, chainId } = useDeployment();
  const { isConnected } = useAccount();
  const { watchAsset, isPending } = useWatchAsset();
  const [copied, setCopied] = useState(false);
  const t = { address: deployment?.wellToken, abi: wellTokenAbi, chainId } as const;
  const { data, isError } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment) },
    contracts: [
      { ...t, functionName: "name" },
      { ...t, functionName: "symbol" },
      { ...t, functionName: "decimals" },
      { ...t, functionName: "totalSupply" },
      { address: deployment?.drawdownRetire, abi: drawdownRetireAbi, chainId, functionName: "totalRetired" },
    ],
  });
  const unreachable = isError || (data !== undefined && data.every((x) => x.status !== "success"));
  const r = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const name = r<string>(0);
  const symbol = r<string>(1);
  const decimals = r<number>(2);
  const supply = r<bigint>(3);
  const retired = r<bigint>(4);
  const d = decimals ?? 18;
  const original = supply !== undefined && retired !== undefined ? supply + retired : undefined;
  const retiredPct = original && retired !== undefined ? (Number((retired * 1_000_000n) / original) / 10_000).toFixed(2) : undefined;

  async function copy() {
    if (!deployment) return;
    await navigator.clipboard.writeText(deployment.wellToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="card">
      <div className="well-card-head">
        <div>
          <h2>$WELL token</h2>
          <p className="muted small">
            Fixed supply. It only shrinks, as the Drawdown and Retire contract buys $WELL with the protocol&apos;s 30% fee
            share and burns it.
          </p>
        </div>
        {deployment ? <Pill tone="ok">Live</Pill> : <Pill tone="muted">Not deployed</Pill>}
      </div>
      {deployment && (
        <>
          {unreachable && <p className="tx-status error">Couldn&apos;t read the token from the network.</p>}
          <div className="stats-grid">
            <Stat label="Name" value={name ?? "…"} hint={symbol ? `Symbol ${symbol}` : undefined} />
            <Stat label="Total supply" value={fmtAmount(supply, d, 0)} />
            <Stat label="Retired" value={fmtAmount(retired, d, 0)} hint={retiredPct ? `${retiredPct}% of supply retired by Drawdown` : undefined} />
          </div>
          <div className="kv">
            <span>Contract</span>
            <span>
              <a href={explorerAddress(deployment.wellToken)} target="_blank" rel="noreferrer">
                {shortAddress(deployment.wellToken)} ↗
              </a>
            </span>
          </div>
          <div className="kv">
            <span>Decimals</span>
            <span>{decimals ?? "…"}</span>
          </div>
          <div className="hero-cta">
            <a className="btn btn-primary" href={tradeUrl(deployment.wellToken)} target="_blank" rel="noreferrer">Trade $WELL on Pons ↗</a>
            <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy address"}</button>
            {isConnected && (
              <button
                className="btn"
                disabled={!symbol || isPending}
                onClick={() => watchAsset({ type: "ERC20", options: { address: deployment.wellToken, symbol: symbol!, decimals: d } })}
              >
                Add $WELL to wallet
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
