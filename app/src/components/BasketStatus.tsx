"use client";

import { useReadContracts } from "wagmi";
import { basketProgramAbi } from "@/generated/abis";
import { explorerAddress } from "@/lib/chains";
import { useDeployment } from "@/lib/deployment";
import { fmtBps, fmtUsdg } from "@/lib/format";
import { Pill, Stat } from "./ui";

export function BasketStatus() {
  const { deployment } = useDeployment();
  const b = { address: deployment?.basketProgram, abi: basketProgramAbi } as const;
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment) },
    contracts: [
      { ...b, functionName: "totalAssets" },
      { ...b, functionName: "heldValueCap" },
      { ...b, functionName: "wells" },
      { ...b, functionName: "maxAllocationBps" },
    ],
  });
  const r = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const cap = r<bigint>(1);
  const wells = r<readonly unknown[]>(2);
  const open = cap !== undefined && cap > 0n;

  return (
    <div className="card">
      <div className="well-card-head">
        <div>
          <h2>Basket Program</h2>
          <p className="muted small">
            One deposit spread across several Wells by a keeper, capped at a maximum share per Well. Exit in USDG from
            the idle balance, or in kind as USDG plus Well shares.
          </p>
        </div>
        {!deployment ? <Pill tone="muted">Not deployed</Pill> : open ? <Pill tone="ok">Open</Pill> : <Pill tone="muted">Closed</Pill>}
      </div>
      {deployment && (
        <div className="stats-grid">
          <Stat label="Held Value" value={fmtUsdg(r<bigint>(0), 0)} />
          <Stat label="Cap" value={open ? fmtUsdg(cap, 0) : "Closed"} />
          <Stat label="Wells" value={wells ? String(wells.length) : "…"} />
          <Stat label="Max per Well" value={fmtBps(r<number>(3))} />
        </div>
      )}
      {deployment && (
        <a className="small" href={explorerAddress(deployment.basketProgram)} target="_blank" rel="noreferrer">
          Contract ↗
        </a>
      )}
    </div>
  );
}
