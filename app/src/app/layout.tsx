import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Providers } from "@/components/Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stonkwell: managed Equity Token liquidity on Robinhood Chain",
  description:
    "Sink USDG into a Well. Stonkwell runs concentrated Equity Token / USDG liquidity, compounds fees, and retires $WELL with the protocol share.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Header />
          <main>{children}</main>
          <footer className="footer">
            <span>Stonkwell. Independent software, not affiliated with Robinhood, Uniswap or any issuer.</span>
            <span>Not investment advice. Not available to US persons or in restricted jurisdictions.</span>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
