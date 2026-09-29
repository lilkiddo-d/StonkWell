"use client";

import Link from "next/link";
import { useReadContracts } from "wagmi";
import { borrowDeskAbi } from "@/generated/abis";
import { useDeployment } from "@/lib/deployment";
import { fmtBps, fmtUsdg, fmtWadPct } from "@/lib/format";
import { Stat } from "./ui";

export function BorrowTeaser() {
  const { deployment, chainId } = useDeployment();
  const [ticker, desk] = deployment ? (Object.entries(deployment.creditLines)[0] ?? []) : [];
  const d = { address: desk, abi: borrowDeskAbi, chainId } as const;
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(desk) },
    contracts: [
      { ...d, functionName: "borrowRatePerYear" },
      { ...d, functionName: "supplyRatePerYear" },
      { ...d, functionName: "risk" },
      { ...d, functionName: "borrowCap" },
      { ...d, functionName: "totalDebt" },
      { ...d, functionName: "cash" },
    ],
  });
  const g = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const risk = g<readonly number[]>(2);
  const cap = g<bigint>(3);
  const debt = g<bigint>(4);
  const cash = g<bigint>(5);
  const underCap = cap !== undefined && debt !== undefined ? (cap > debt ? cap - debt : 0n) : undefined;
  const room = underCap !== undefined && cash !== undefined ? (underCap < cash ? underCap : cash) : undefined;

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Borrow against your shares</h2>
          <p>Pledge Well shares on the Borrow Desk and draw USDG. Collateral is valued at the Chainlink price, never the pool price.</p>
        </div>
        <Link href="/borrow" className="btn">Open Borrow Desk</Link>
      </div>
      <div className="strip">
        <Stat label={ticker ? `${ticker} Credit Line` : "Credit Lines"} value={desk ? fmtWadPct(g<bigint>(0)) : "—"} hint="borrow rate, variable" />
        <Stat label="Max LTV" value={risk ? fmtBps(risk[0]) : "—"} hint={risk ? `liquidation at ${fmtBps(risk[1])}` : "set per market"} />
        <Stat label="Available to borrow" value={desk ? fmtUsdg(room, 0) : "—"} hint={cap !== undefined ? `of ${fmtUsdg(cap, 0)} cap` : "capped per market"} />
        <Stat label="Lend rate" value={desk ? fmtWadPct(g<bigint>(1)) : "—"} hint="variable, per year" />
      </div>
    </section>
  );
}
