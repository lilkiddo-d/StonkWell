import type { Metadata } from "next";
import { Bricolage_Grotesque, JetBrains_Mono, Manrope } from "next/font/google";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Providers } from "@/components/Providers";
import "./globals.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Manrope({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Stonkwell: earn the fees on tokenized stock trading",
  description:
    "Deposit USDG into a Well. Stonkwell provides liquidity for tokenized stocks on Robinhood Chain, pays 70% of trading fees to depositors, and burns $WELL with the rest.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <Header />
          <main>{children}</main>
          <footer className="footer">
            <span>Stonkwell. Independent software, not affiliated with Robinhood, Uniswap or any issuer.</span>
            <span className="num">Robinhood Chain · Uniswap v4 · Chainlink</span>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
