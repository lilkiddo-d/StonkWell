import Link from "next/link";
import { Fragment } from "react";
import { BorrowTeaser } from "@/components/BorrowTeaser";
import { FeeSplit } from "@/components/FeeSplit";
import { HomeStats } from "@/components/HomeStats";
import { Ripple } from "@/components/Ripple";
import { WellBoard } from "@/components/WellBoard";
import { catalog } from "@/generated/catalog";

const FLOW = [
  {
    k: "01 · SINK",
    title: "You deposit USDG",
    body: "You get Well shares that track your slice of everything the Well holds. New deposits wait for the next rebalance, then go to work.",
  },
  {
    k: "02 · WORK",
    title: "The Well provides liquidity",
    body: "A keeper places a tight price range around the Chainlink price and moves it as the stock moves. Every trade through the range pays a fee.",
  },
  {
    k: "03 · EARN",
    title: "Fees split 70 / 30",
    body: "70% compounds into the Well, so each share is worth more. 30% buys $WELL on the market and burns it. Both numbers are limits in the code.",
  },
];

export default function Home() {
  return (
    <div className="page">
      <section className="hero">
        <Ripple />
        <div>
          <div className="eyebrow">Robinhood Chain · Uniswap v4</div>
          <h1>
            Stocks trade all night.
            <br />
            <span className="accent">Your USDG earns the fees.</span>
          </h1>
          <p className="lead">
            Deposit USDG into a Well. It provides liquidity for one tokenized stock, collects a fee on every trade, and pays
            70% of it back to you. Withdraw any time, market open or closed.
          </p>
          <div className="hero-cta">
            <Link href="/wells" className="btn btn-primary">Sink USDG</Link>
            <Link href="/docs" className="btn btn-ghost">How a Well works</Link>
          </div>
          <div className="hero-note">
            {catalog.launchWells.length} Wells · ${catalog.heldValueCapUsdg.toLocaleString()} cap each · 70 / 30 fee split enforced in code
          </div>
        </div>
        <WellBoard />
      </section>

      <HomeStats />

      <section className="section">
        <div className="section-head">
          <div>
            <h2>What a Well does with your USDG</h2>
            <p>One Well per stock. Each is its own contract with its own cap, so trouble in one never spills into another.</p>
          </div>
        </div>
        <div className="flow">
          {FLOW.map((s, i) => (
            <Fragment key={s.k}>
              {i > 0 && <div className="flow-arrow" aria-hidden>→</div>}
              <div className="card">
                <span className="flow-k">{s.k}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </Fragment>
          ))}
        </div>
      </section>

      <section className="section">
        <FeeSplit />
      </section>

      <BorrowTeaser />
    </div>
  );
}
