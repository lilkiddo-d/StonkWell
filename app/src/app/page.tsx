import Link from "next/link";
import { HeroWell } from "@/components/HeroWell";
import { HomeStats } from "@/components/HomeStats";

const STEPS = [
  {
    title: "Sink USDG",
    body: "Pick a Well, one per Equity Token, and sink USDG. You receive Well shares that track your portion of Held Value.",
  },
  {
    title: "The Well works the range",
    body: "A keeper runs concentrated liquidity on Uniswap v4 around the Chainlink price and re-ranges when needed. Rebalances are blocked if the oracle is stale or the pool drifts from it.",
  },
  {
    title: "Fees compound",
    body: "70% of swap fees are reinvested for Well holders. 30% flows to the fee router and is spent drawing down and retiring $WELL.",
  },
  {
    title: "Borrow against it",
    body: "Pledge Well shares on the Borrow Desk and open a Credit Line in USDG, priced by oracle and capped per market.",
  },
];

export default function Home() {
  return (
    <div className="page">
      <section className="hero">
        <div className="hero-glow" aria-hidden />
        <HeroWell />
        <div className="hero-content">
        <h1>
          Sink into a Well.
          <br />
          <span className="accent">Let the fees pool up.</span>
        </h1>
        <p className="lead">
          Stonkwell runs managed, oracle-guarded liquidity for Equity Tokens on Robinhood Chain. Sink USDG, earn swap
          fees from the Equity Token / USDG market, and exit in USDG or in kind at any time.
        </p>
        <div className="hero-cta">
          <Link href="/wells" className="btn btn-primary">Browse Wells</Link>
          <Link href="/docs" className="btn">How it works</Link>
        </div>
        </div>
      </section>

      <HomeStats />

      <section className="steps">
        {STEPS.map((s, i) => (
          <div key={s.title} className="card step">
            <div className="step-num">{i + 1}</div>
            <h3>{s.title}</h3>
            <p className="muted">{s.body}</p>
          </div>
        ))}
      </section>

      <section className="card split">
        <div>
          <h2>Where the 30% goes</h2>
          <p className="muted">
            All of the protocol share goes to one place: the Drawdown and Retire contract. It swaps what it receives into
            $WELL through owner-registered pools under per-run limits and burns it. It has no withdrawal function, and
            redirecting the fee router takes a public 48-hour delay.
          </p>
        </div>
        <div className="split-figure">
          <div className="bar"><div className="bar-depositors" style={{ width: "70%" }}>70% Well holders</div><div className="bar-protocol" style={{ width: "30%" }}>30% retire</div></div>
        </div>
      </section>
    </div>
  );
}
