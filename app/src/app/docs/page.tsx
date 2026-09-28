import type { ReactNode } from "react";

const TOC = [
  ["overview", "Overview"],
  ["wells", "Wells"],
  ["fees", "Fees, drawdown and retire"],
  ["borrow", "Borrow Desk"],
  ["oracle", "Prices and market hours"],
  ["governance", "Governance and safety"],
  ["glossary", "Glossary"],
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="doc-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function DocsPage() {
  return (
    <div className="page docs">
      <aside className="toc">
        {TOC.map(([id, label]) => (
          <a key={id} href={`#${id}`}>{label}</a>
        ))}
      </aside>
      <article>
        <h1>Stonkwell docs</h1>

        <Section id="overview" title="Overview">
          <p>
            Stonkwell runs managed liquidity for Equity Tokens on Robinhood Chain. Each <strong>Well</strong> holds one
            Equity Token / USDG position on Uniswap v4. You sink USDG, the Well earns swap fees from traders, and 70% of
            those fees compound back into the Well. The other 30% is spent buying $WELL and burning it.
          </p>
          <p>
            Every contract is open source and verified. There are no off-chain valuations: Held Value, share prices and
            collateral values are all computed on-chain from Chainlink prices.
          </p>
        </Section>

        <Section id="wells" title="Wells">
          <ul>
            <li><strong>Sinking into a Well.</strong> Deposit USDG and receive Well shares (ERC-4626). Your shares are your portion of the Well&apos;s Held Value.</li>
            <li><strong>Ranges.</strong> A keeper places the Well&apos;s balances in a concentrated range around the Chainlink price and re-ranges when price moves. Rebalances revert if the price is stale or the pool has drifted more than 2% from the oracle.</li>
            <li><strong>USDG exits.</strong> <code>withdraw</code>/<code>redeem</code> pull your slice of the range and sell Equity Token for USDG. The swap must clear within 1% of the oracle price, and you pay that cost, not the holders who stay.</li>
            <li><strong>In-kind exits.</strong> <code>redeemInKind</code> returns your share of Equity Token and USDG with no swap and no price check. It works while paused, over weekends, and during oracle outages.</li>
            <li><strong>Caps.</strong> Each Well has a Held Value cap. Launch Wells open at $25,000 each and rise only through the timelock.</li>
          </ul>
        </Section>

        <Section id="fees" title="Fees, drawdown and retire">
          <p>
            Swap fees are collected on every sink, exit and rebalance, and whenever anyone calls <code>harvest</code>.
          </p>
          <ul>
            <li><strong>70%</strong> stays in the Well and raises the value of every share.</li>
            <li><strong>30%</strong> goes to the <code>FeeRouter</code>, which forwards all of it to <code>DrawdownRetire</code>. That contract swaps the fees into $WELL through registered pools, subject to per-run limits and a minimum interval, then burns the $WELL in the same transaction. It has no withdrawal function.</li>
            <li>Pointing the FeeRouter anywhere else requires a public 48-hour delay.</li>
          </ul>
        </Section>

        <Section id="borrow" title="Borrow Desk">
          <p>
            Each Credit Line is an isolated market for one Well. Lenders supply USDG and earn a variable rate. Borrowers
            pledge Well shares and borrow USDG against them.
          </p>
          <ul>
            <li>Collateral is valued at the Chainlink price. Pool prices never affect it.</li>
            <li>The META Credit Line launches with a 40% max LTV, a 55% liquidation threshold, a 6% liquidation bonus and a 50% close factor.</li>
            <li>A single Credit Line may hold at most 30% of a Well&apos;s shares as collateral.</li>
            <li>Borrowing and liquidation need a fresh price. Repaying is always possible.</li>
            <li>Rates follow a kinked curve: 2% base, rising to 8% at 80% utilization, then steeply above that.</li>
          </ul>
        </Section>

        <Section id="oracle" title="Prices and market hours">
          <p>
            Equity Token prices come from Chainlink feeds that follow US market hours: 24 hours a day, five days a week,
            with a 24-hour heartbeat. A price counts as fresh for up to 26 hours. Stonkwell also checks the USDG/USD feed
            and the Equity Token&apos;s corporate-action flag.
          </p>
          <p>
            When a price is not fresh, sinking, USDG exits, rebalances, borrowing and liquidations pause automatically.
            In-kind exits and repayments stay open.
          </p>
        </Section>

        <Section id="governance" title="Governance and safety">
          <ul>
            <li><strong>Admin</strong> is a 48-hour timelock controlled by a multisig. Only the admin can unpause, raise caps, or change fees, risk limits, feeds and pools.</li>
            <li><strong>Guardian</strong> is a separate multisig. It can pause, lower caps and halt drawdowns. It cannot unpause, raise limits or move funds.</li>
            <li><strong>Keeper</strong> rebalances and runs drawdowns within on-chain limits.</li>
            <li>No contract has a function that lets any role take user funds.</li>
          </ul>
        </Section>

        <Section id="glossary" title="Glossary">
          <dl className="glossary">
            <dt>Well</dt><dd>A managed Equity Token / USDG liquidity vault, for example the AMD Well.</dd>
            <dt>Equity Token</dt><dd>A tokenized debt security on Robinhood Chain that tracks a stock or ETF.</dd>
            <dt>Sinking into a Well</dt><dd>Depositing USDG into a Well.</dd>
            <dt>Held Value</dt><dd>The total USDG value of a Well&apos;s assets at the oracle price.</dd>
            <dt>Yield Rate</dt><dd>Recent fee income to Well holders, annualized. Historical, not a forecast.</dd>
            <dt>Credit Line / Borrow Desk</dt><dd>Isolated USDG lending markets backed by Well shares.</dd>
            <dt>Programs</dt><dd>Managed allocations built from Wells and Credit Lines.</dd>
            <dt>Drawdown and retire</dt><dd>Spending the protocol fee share on $WELL and burning it.</dd>
            <dt>$WELL</dt><dd>Stonkwell&apos;s fixed-supply token.</dd>
          </dl>
        </Section>
      </article>
    </div>
  );
}
