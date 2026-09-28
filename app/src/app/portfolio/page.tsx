import { WellTokenDetails } from "@/components/WellTokenDetails";
import { YourHoldings } from "@/components/YourHoldings";

export default function PortfolioPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Portfolio</h1>
          <p className="muted">$WELL token details and everything your connected wallet holds across Stonkwell.</p>
        </div>
      </div>
      <div className="grid-2">
        <YourHoldings />
        <WellTokenDetails />
      </div>
    </div>
  );
}
