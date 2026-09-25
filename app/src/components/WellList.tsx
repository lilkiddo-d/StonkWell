"use client";

import { catalog } from "@/generated/catalog";
import { useDeployment } from "@/lib/deployment";
import { WellCard } from "./WellCard";

type Ticker = keyof typeof catalog.equityTokens;

export function WellList() {
  const { deployment } = useDeployment();
  const live = deployment ? Object.keys(deployment.wells) : [];
  const launch = catalog.launchWells.filter((t) => !live.includes(t));
  const upcoming = (Object.keys(catalog.equityTokens) as Ticker[]).filter((t) => !live.includes(t) && !launch.includes(t as never));

  return (
    <>
      {live.length > 0 && (
        <div className="well-grid">
          {live.map((t) => (
            <WellCard key={t} ticker={t} name={deployment!.wells[t].name} well={deployment!.wells[t].well} />
          ))}
        </div>
      )}
      {launch.length > 0 && (
        <>
          <h2 className="section-title">Launching first</h2>
          <div className="well-grid">
            {launch.map((t) => (
              <WellCard key={t} ticker={t} name={catalog.equityTokens[t as Ticker].name} />
            ))}
          </div>
        </>
      )}
      <h2 className="section-title">Later Wells</h2>
      <p className="muted small">
        Opened once the pool for the Equity Token has enough depth and tracks its Chainlink feed.
      </p>
      <div className="well-grid">
        {upcoming.map((t) => (
          <WellCard key={t} ticker={t} name={catalog.equityTokens[t].name} />
        ))}
      </div>
    </>
  );
}
