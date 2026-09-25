import { notFound } from "next/navigation";
import { WellDetail } from "@/components/WellDetail";
import { catalog } from "@/generated/catalog";

export function generateStaticParams() {
  return Object.keys(catalog.equityTokens).map((ticker) => ({ ticker }));
}

export default function WellPage({ params }: { params: { ticker: string } }) {
  const ticker = params.ticker.toUpperCase();
  if (!(ticker in catalog.equityTokens)) notFound();
  return <WellDetail ticker={ticker} />;
}
