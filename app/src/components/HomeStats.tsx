"use client";

import { formatUnits } from "viem";
import { useReadContracts } from "wagmi";
import { catalog } from "@/generated/catalog";
import { drawdownRetireAbi, wellAbi } from "@/generated/abis";
import { useBurnQueue } from "@/hooks/useProtocol";
import { useDeployment } from "@/lib/deployment";
import { fmtUsdg } from "@/lib/format";
import { Stat } from "./ui";

export function HomeStats() {
  const { deployment, chainId } = useDeployment();
  const wells = deployment ? Object.values(deployment.wells) : [];
  const retiredQ = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment) },
    contracts: [{ address: deployment?.drawdownRetire, abi: drawdownRetireAbi, chainId, functionName: "totalRetired" }],
  });
  const held = useReadContracts({
    allowFailure: true,
    query: { enabled: wells.length > 0 },
    contracts: wells.map((w) => ({ address: w.well, abi: wellAbi, chainId, functionName: "totalAssets" }) as const),
  });
  const queue = useBurnQueue();
  const totalHeld = held.data ? held.data.reduce((sum, r) => sum + (r.status === "success" ? (r.result as bigint) : 0n), 0n) : undefined;
  const retired = retiredQ.data?.[0]?.status === "success" ? (retiredQ.data[0].result as bigint) : undefined;
  const cap = `$${catalog.heldValueCapUsdg.toLocaleString()} cap each`;
  const count = wells.length || catalog.launchWells.length;

  return (
    <section className="strip">
      <Stat label="Total held value" value={deployment ? fmtUsdg(totalHeld, 0) : "—"} hint={`across ${count} Wells`} />
      <Stat label="Wells" value={String(count)} hint={deployment ? cap : `launching · ${cap}`} />
      <Stat label="Waiting to burn" value={deployment ? fmtUsdg(queue.usdg, 2) : "—"} hint="protocol fees for $WELL" />
      <Stat
        label="$WELL retired"
        value={
          <span style={{ color: "var(--ember)" }}>
            {retired === undefined ? (deployment ? "…" : "—") : Number(formatUnits(retired, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        }
        hint="bought and burned"
      />
    </section>
  );
}
