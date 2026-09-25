import { WellList } from "@/components/WellList";

export default function WellsPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Wells</h1>
          <p className="muted">
            One Well per Equity Token / USDG pair. Each has its own Held Value cap, range and risk limits, so trouble in
            one Well does not spill into another.
          </p>
        </div>
      </div>
      <WellList />
    </div>
  );
}
