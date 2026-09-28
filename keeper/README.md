# Stonkwell keeper

A small Node.js bot (ethers v6, CommonJS) that performs the protocol's routine keeper duties on a loop:

| # | Duty | Contract call | Who may call |
|---|------|---------------|--------------|
| 1 | Keep each Well's range around the Chainlink price | `Well.rebalance(tickLower, tickUpper, sellUsdg, swapAmount, route)` | `KEEPER_ROLE` |
| 2 | Collect swap fees | `Well.harvest()` | anyone |
| 3 | Claim Credit Line reserves | `BorrowDesk.claimReserves()` | anyone |
| 4 | Forward the protocol share | `FeeRouter.routeMany(tokens)` | anyone |
| 5 | Buy and burn $WELL | `DrawdownRetire.drawdown(tokenIn, amountIn, minWellOut, route)` | `KEEPER_ROLE` |

Every call is simulated first (`staticCall` from the keeper address). A reverting simulation is logged and skipped, so one failing Well or token never stops the rest of the cycle.

It does **not** liquidate borrowers, and it does **not** run BasketProgram `allocate`/`deallocate` (see [Not automated](#not-automated)).

## Setup

```bash
cd contracts && npm install && npx hardhat compile     # the keeper reads ABIs from contracts/artifacts
cd ../keeper && npm install
```

**ABIs** come from `contracts/artifacts` (the Hardhat build output). That keeps the keeper in lockstep with the Solidity source and covers `WellPositionV4` and `V4SwapAdapter`, which `app/src/generated/abis.ts` does not export. Re-run `npx hardhat compile` after contract changes. Point `KEEPER_ARTIFACTS_DIR` elsewhere if you ship the keeper without the contracts folder (copy `contracts/artifacts` next to it).

**Addresses** come from `contracts/deployments/<KEEPER_NETWORK>.json`, written by `contracts/scripts/deploy.js`. The keeper checks that the RPC's chainId matches the file.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_PRIVATE_KEY` | none | Keeper wallet key (hex, with or without `0x`). Only read from the environment, never logged. Required when `DRY_RUN=0`. |
| `DRY_RUN` | dry run | **Only `DRY_RUN=0` sends transactions.** Anything else simulates every call and logs what it would send. |
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | JSON-RPC endpoint. |
| `KEEPER_NETWORK` | `robinhood` | Picks `contracts/deployments/<name>.json`. |
| `KEEPER_ADDRESS` | `roles.keeper` from the deployment | Address to simulate from in a dry run without a key. |
| `KEEPER_CONFIG` | none | JSON file deep-merged over `config.json`. |
| `LOOP_INTERVAL_SECONDS` | `loopIntervalSeconds` in config | Seconds between cycles. |
| `LOG_JSON` | off | `1` prints one JSON object per line instead of text. |
| `LOG_LEVEL` | `info` | `debug` shows extra detail (e.g. harvest interval skips). |
| `KEEPER_DEPLOYMENTS_DIR`, `KEEPER_ARTIFACTS_DIR` | contracts folder | Override where deployments and ABIs are read from. |

## Running

```bash
# Dry run against mainnet (no key needed; simulates from roles.keeper)
node src/index.js --once

# Live, looping every loopIntervalSeconds
DRY_RUN=0 KEEPER_PRIVATE_KEY=0x... npm start
```

PowerShell: `$env:DRY_RUN="0"; $env:KEEPER_PRIVATE_KEY="0x..."; npm start`.

`--once` (or `KEEPER_ONCE=1`) runs one cycle and exits with status 0, which also suits cron or a systemd timer. `SIGINT`/`SIGTERM` stop the loop after the current step.

### As a background service

Keep the key in a root-only env file, not in the unit or the repo.

**systemd** (`/etc/systemd/system/stonkwell-keeper.service`):

```ini
[Unit]
Description=Stonkwell keeper
After=network-online.target

[Service]
WorkingDirectory=/opt/stonkwell/keeper
EnvironmentFile=/etc/stonkwell/keeper.env     # chmod 600: KEEPER_PRIVATE_KEY=..., DRY_RUN=0, RPC_URL=...
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=30
User=stonkwell

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now stonkwell-keeper && journalctl -u stonkwell-keeper -f`

**pm2**: `pm2 start src/index.js --name stonkwell-keeper` with the variables exported in that shell (or an ecosystem file outside the repo), then `pm2 save`.

## Configuration (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `loopIntervalSeconds` | 300 | Pause between cycles. |
| `txConfirmations`, `txTimeoutSeconds` | 1, 180 | How long to wait for each transaction. |
| `wells.only` | `[]` (all) | Restrict to these tickers. |
| `rebalance.halfWidthTicks` | 1200 | New range is about ±this many ticks (±12.7%) around the oracle price, snapped out to the pool's tick spacing. |
| `rebalance.edgeThresholdPct` | 15 | Rebalance when the pool tick is within this % of the range width from either edge, or outside it. |
| `rebalance.maxIdlePct` | 25 | Also rebalance when USDG/equity idle in the Well (e.g. new deposits, which are not placed automatically) exceeds this % of Held Value. `0` disables. |
| `rebalance.minIdleUsdg` | 10 | Ignore idle value below this. |
| `rebalance.minSwapUsdg` | 5 | Skip the pre-rebalance swap when smaller than this. |
| `rebalance.routes` | `{}` | Per ticker, a hop list written USDG → … → equity (reversed for equity sales). Empty = the adapter's registered direct pool. |
| `harvest.intervalSeconds` | 21600 | Minimum time between harvests of one Well. |
| `harvest.minFeesUsdg` | 0 | Wait until pending fees are worth at least this. |
| `feeRouter.enabled` | true | Route every non-zero fee token each cycle. |
| `drawdown.slippageBps` | 200 | `minWellOut = quote × (1 − slippage)`. |
| `drawdown.defaultRoute` | `["IN","USDG","ETH","WELL"]` | Hop list for every fee token (see below). |
| `drawdown.routes` | `{}` | Per-token override, keyed by ticker (`"META"`), `"USDG"` or token address. |
| `borrowDesk.claimReserves` | true | Call `claimReserves()` every `claimIntervalSeconds` (86400). |
| `borrowDesk.logUnhealthy` | false | Scan `Borrowed` events from `scanFromBlock` in `scanChunkBlocks` chunks and warn about accounts with health factor < 1. Set `scanFromBlock` to the BorrowDesk deploy block before enabling on mainnet. |

**Route hops** are addresses or names: `IN` (the token being sold), `USDG`, `ETH`/`NATIVE` (address(0), native ETH in Uniswap v4), `WELL`, or a Well ticker such as `META`. Consecutive duplicates collapse, so the default route is `USDG → ETH → WELL` for USDG and `META → USDG → ETH → WELL` for META. `"default"` or `[]` sends an empty route (`0x`), which makes the swap adapter use its registered direct pool (or two hops via USDG). A route is sent as `abi.encode(address[])`, the format `V4SwapAdapter.swap` decodes.

## What each duty does

### 1. Rebalance (per Well, needs `KEEPER_ROLE`)

Skipped (logged) when the Well is paused, the keeper lacks the role, or the position is a mock without v4 views. Otherwise:

1. `Well.priceFresh()` false → **log and skip**. This is normal outside US market hours and on weekends: the Chainlink equity feeds stop and `rebalance` would revert `Unpriced`.
2. Pool vs oracle: `WellPositionV4.spotUsdgValue(1 unit)` vs `WellOracle.usdgValue(1 unit)`. If the gap is above `Well.maxPoolDeviationBps` (default 2%), `rebalance` would revert `PoolDeviation`, so the keeper logs a warning and skips. It cannot fix this itself: the pool must be arbitraged back.
3. Trigger: no active range with value to place, pool tick outside the range or within `edgeThresholdPct` of an edge, or idle balance above `maxIdlePct`. If the oracle-centred range equals the current range, it skips rather than churning.
4. New range: centred on the oracle price's tick, ±`halfWidthTicks`, aligned to the pool's `tickSpacing`.
5. Swap size: the value split the new range needs at the pool price, from `Well.holdings()` valued by the oracle. `Well` enforces `maxSwapLossBps` (default 1%) against the oracle on that swap, so the keeper simulates the full swap, then 1/2, 1/4 and finally no swap, and sends the first size that passes.

`rebalance` harvests first, so the harvest timer resets.

### 2. Harvest (per Well)

There is no pending-fee view, so the keeper simulates `position.collectFees()` as the Well (an `eth_call` with `from = Well`), which returns exactly what `harvest()` would collect. It harvests when that is non-zero (and above `minFeesUsdg`), at most once per `intervalSeconds`. If the simulation fails it harvests unconditionally on the interval.

### 3. BorrowDesk reserves

`claimReserves()` accrues interest and sends reserves to the FeeRouter. A `ZeroAmount` revert just means nothing has built up; it is logged at info level.

### 4. FeeRouter

Checks the router's balance of USDG and every Well's Equity Token and calls `routeMany` with the non-zero ones. Runs after harvests and reserve claims so the same cycle forwards them.

### 5. Drawdown and retire (needs `KEEPER_ROLE`)

- Skips while `halted()`, and while `block.timestamp < lastDrawdown + minInterval`. **`lastDrawdown` is shared by every input token**, so only one drawdown can happen per `minInterval` (1 hour at launch) in total.
- Candidates: every fee token DrawdownRetire holds with a non-zero `maxInputPerRun`, sized `min(balance, maxInputPerRun)`, largest oracle value first. A held token with no input limit is logged as a governance to-do.
- Quote: `drawdown.staticCall(token, amount, 1, route)` from the keeper returns the $WELL the real swap delivers; `minWellOut = quote × (1 − slippageBps)`. The keeper then sends `drawdown(token, amount, minWellOut, route)`. If a token's quote reverts it logs the reason and tries the next one.

> **$WELL on Pons: drawdowns will fail until the swap adapter changes.** $WELL is planned to trade in a Uniswap v4 pool paired with **native ETH** that uses the **Pons launchpad hook**. The current `V4SwapAdapter` only registers hookless pools and has no native-ETH hop, so the default route `… → ETH → WELL` reverts (`InvalidRoute()` from the adapter) in the quote. The keeper logs `quote failed, skipping this token` with a hint on each cycle and carries on with its other duties; nothing is sent. Once the adapter supports hooked pools and native ETH hops, the configured route works without keeper changes. Until then, the only way to run drawdowns is a hookless $WELL pool the adapter can register (e.g. $WELL/USDG) with `drawdown.defaultRoute` set to `"default"` or `["IN","USDG","WELL"]`.

## Not automated

- **Liquidations.** v1 only reports unhealthy accounts (`borrowDesk.logUnhealthy`). Liquidating needs USDG inventory and a plan for the seized Well shares; do it manually (`BorrowDesk.liquidate`) or build it later.
- **BasketProgram `allocate` / `deallocate`.** TODO: how much of the Basket goes into which Well is a governance decision, not a routine duty. Add a duty here once there is a policy (target weights, rebalance bands) to encode.
- **Timelock/governance actions** (input limits, risk limits, unpausing). The keeper warns when it sees one is needed (e.g. `maxInputPerRun` is 0 for a held token).

## Testing

```bash
npm test          # offline unit tests: tick math, rebalance planning, routes, revert decoding
```

End-to-end against a local Hardhat node with the mock demo deploy (uses port 8547 so it does not clash with a node on 8545):

```bash
cd contracts
npx hardhat node --port 8547                                   # separate terminal
npx hardhat run scripts/deploy.js --network keeper             # writes deployments/keeper.json
cd ../keeper
npm run smoke
```

`npm run smoke` accrues fees on the mock positions, gives the mock swap venue $WELL, opens a borrow so reserves build, then runs the keeper with `DRY_RUN=1` (asserts nothing changed) and `DRY_RUN=0` (asserts every Well harvested, reserves claimed, FeeRouter emptied, $WELL retired, exactly one drawdown per interval, the key never printed), plus a rate-limit rerun, a next-interval drawdown and an unhealthy-account report. It refuses to run on anything but chainId 31337 and uses Hardhat's public dev account #3 (the local keeper). Delete `contracts/deployments/keeper.json` afterwards if you do not want it around.

The local demo uses `MockPosition`, which has no Uniswap v4 views, so rebalancing is covered by the unit tests only. Try it on a mainnet fork or testnet deployment in `DRY_RUN` before going live.

## Safety notes

- Default is dry run. Nothing is sent unless `DRY_RUN=0` is set explicitly.
- The keeper key only holds `KEEPER_ROLE` (rebalance, drawdown) plus gas money. Keep little ETH on it. On-chain limits bound what a compromised keeper can do: registered pools only, `maxSwapLossBps` on rebalances, `maxInputPerRun` and `minInterval` on drawdowns, and the guardian can pause Wells and halt drawdowns.
- The key is read only from `KEEPER_PRIVATE_KEY` and never logged. The RPC URL's credentials (`https://user:pass@...`) are masked in the startup log, but prefer a URL without secrets in it.
- `minWellOut` comes from a simulation in the same block the transaction is built in, so it protects against the price moving before inclusion, not against a pool that is already manipulated. `maxInputPerRun` is the real bound on drawdown losses; keep it small relative to the $WELL pool's depth.
- Stale prices on weekends are expected and logged at info level; persistent `PoolDeviation` or quote failures during market hours are worth an alert.
- Nonces are managed locally (ethers `NonceManager`) and resynced after any failed send. Run only one live keeper per key.
