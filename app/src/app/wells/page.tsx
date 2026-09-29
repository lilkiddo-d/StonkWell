import { MarketChip } from "@/components/MarketChip";
import { WellList } from "@/components/WellList";

export default function WellsPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Wells</h1>
          <p className="muted">
            One per tokenized stock. Each has its own cap, range and risk limits. Deposits open while NYSE is open and
            Chainlink prices are fresh; withdrawals are open at any time.
          </p>
        </div>
        <MarketChip />
      </div>
      <WellList />
    </div>
  );
}
