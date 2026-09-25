import Link from "next/link";

export function RiskBanner() {
  return (
    <div className="risk-banner">
      Equity Tokens are tokenized debt securities, not shares of the underlying company. Well shares are not
      principal-protected and are not available in restricted jurisdictions, including to US persons.{" "}
      <Link href="/docs#disclaimer">Read the disclaimer</Link>
    </div>
  );
}
