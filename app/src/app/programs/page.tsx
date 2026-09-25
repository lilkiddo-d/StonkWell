import { BasketStatus } from "@/components/BasketStatus";

const PLANNED = [
  {
    name: "Loop Program",
    body: "Sinks USDG into a Well, pledges the shares on the matching Credit Line, borrows and sinks again, up to a governance-set target LTV well below liquidation. It unwinds automatically when health drops or the price feed closes.",
  },
  {
    name: "Steady Range Program",
    body: "Holds a wider, slower-moving range for holders who want less re-ranging and fewer swap costs, and accept a lower Yield Rate in return.",
  },
  {
    name: "Market-Hours Program",
    body: "Pulls liquidity into USDG ahead of weekend and holiday closures, when Chainlink feeds pause, and redeploys once feeds are live again.",
  },
];

export default function ProgramsPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Programs</h1>
          <p className="muted">
            Programs are managed allocations built from Wells and Credit Lines. Each opens only after its contracts are
            reviewed and governance raises its cap above zero.
          </p>
        </div>
      </div>
      <BasketStatus />
      <h2 className="section-title">Planned</h2>
      <div className="well-grid">
        {PLANNED.map((p) => (
          <div key={p.name} className="card">
            <div className="well-card-head">
              <h3>{p.name}</h3>
              <span className="pill pill-muted">Planned</span>
            </div>
            <p className="muted small">{p.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
