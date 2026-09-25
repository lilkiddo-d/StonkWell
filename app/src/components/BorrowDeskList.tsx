"use client";

import { useDeployment } from "@/lib/deployment";
import { CreditLine } from "./CreditLine";
import { NotDeployed } from "./ui";

export function BorrowDeskList() {
  const { deployment } = useDeployment();
  const lines = deployment ? Object.entries(deployment.creditLines) : [];
  if (!deployment || lines.length === 0) return <NotDeployed what="Credit Lines" />;
  return (
    <div className="stack">
      {lines.map(([ticker, desk]) => (
        <CreditLine key={ticker} ticker={ticker} desk={desk} well={deployment.wells[ticker].well} usdg={deployment.usdg} />
      ))}
    </div>
  );
}
