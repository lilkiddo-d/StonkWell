"use client";

import { formatUnits } from "viem";
import { useReadContracts } from "wagmi";
import { drawdownRetireAbi, wellAbi, wellTokenAbi } from "@/generated/abis";
import { useDeployment } from "@/lib/deployment";
import { fmtUsdg } from "@/lib/format";
import { Stat } from "./ui";

export function HomeStats() {
  const { deployment } = useDeployment();
  const wells = deployment ? Object.values(deployment.wells) : [];
  const token = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment) },
    contracts: [
      { address: deployment?.drawdownRetire, abi: drawdownRetireAbi, functionName: "totalRetired" },
      { address: deployment?.wellToken, abi: wellTokenAbi, functionName: "totalSupply" },
    ],
  });
  const held = useReadContracts({
    allowFailure: true,
    query: { enabled: wells.length > 0 },
    contracts: wells.map((w) => ({ address: w.well, abi: wellAbi, functionName: "totalAssets" }) as const),
  });
  const totalHeld = held.data ? held.data.reduce((sum, r) => sum + (r.status === "success" ? r.result : 0n), 0n) : undefined;
  const retired = token.data?.[0]?.result;
  const supply = token.data?.[1]?.result;
  const n = (v?: bigint) => (v === undefined ? "…" : Number(formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 }));

  return (
    <section className="stats-row">
      <Stat label="Held Value" value={deployment ? fmtUsdg(totalHeld, 0) : "—"} hint="Across all Wells" />
      <Stat label="Wells" value={deployment ? String(wells.length) : "—"} />
      <Stat label="$WELL retired" value={deployment ? n(retired) : "—"} />
      <Stat label="$WELL supply" value={deployment ? n(supply) : "—"} />
    </section>
  );
}
