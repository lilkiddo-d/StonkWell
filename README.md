# STONKWELL

Managed, oracle-guarded liquidity for Equity Tokens on Robinhood Chain. You sink USDG into a **Well**, and the Well runs concentrated Equity Token / USDG liquidity on Uniswap v4. 70% of fees compound for Well holders; the other 30% is spent on **drawdown and retire** of $WELL. Well shares can back **Credit Lines** on the Borrow Desk.

- [`docs/OVERVIEW.md`](docs/OVERVIEW.md): full project write-up (what it is, how it works, economics, safety, status, roadmap)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): one-page, contract-by-contract mapping from TickerSpring to Stonkwell
- [`docs/RISK_REVIEW.md`](docs/RISK_REVIEW.md): oracle staleness, guardian permissions, collateral valuation, and other findings
- [`docs/LAUNCH.md`](docs/LAUNCH.md): launch-day steps (`launch.ps1`, preflight, timelock handoff)

## Layout

```
contracts/   Hardhat project (Solidity 0.8.26, OpenZeppelin 5.1, Uniswap v4 MIT files only)
  src/                 Well, WellOracle, FeeRouter, DrawdownRetire, WellToken, WellRegistry, BorrowDesk
  src/v4/              WellPositionV4 (PositionManager + Permit2), V4SwapAdapter (PoolManager unlock swaps)
  src/programs/        BasketProgram
  test/unit/           33 unit tests on mocks
  test/fork/           5 tests against the live META/USDG v4 pool on a Robinhood Chain fork
  scripts/deploy.js    Deploys everything (mocks locally, real addresses on chain 4663)
  scripts/probe-pools.js  Reads live v4 pools versus Chainlink and writes config/robinhood.pools.json
  config/              Chain addresses (USDG, 18 Equity Tokens, Chainlink feeds, Uniswap v4) and launch parameters
app/         Next.js 14 + wagmi/viem interface: Home, Wells, Well detail, Borrow Desk, Programs, Docs
research/    Raw TickerSpring on-chain data used for the review
```

## Contracts

```bash
cd contracts
npm install
npm test                                  # unit tests
$env:FORK="1"; npx hardhat test           # mainnet-fork tests (PowerShell; use FORK=1 on bash)
npm run export-abis                       # refresh app/src/generated
```

The fork tests use `https://rpc.mainnet.chain.robinhood.com` by default. Set `ROBINHOOD_RPC_URL` for a private endpoint, and `FORK_BLOCK` to pin a block.

### Deploying

**Local demo** (mock tokens and feeds, seeded with deposits):
```bash
npx hardhat node                                   # terminal 1
npx hardhat run scripts/deploy.js --network localhost
npm run export-abis
```

**Dry run of the real deployment on a fork:**
```bash
$env:FORK="1"; $env:DEPLOY_LIVE="1"; npx hardhat run scripts/deploy.js
```

**Robinhood Chain** (after the audit):
```bash
# set in the shell environment
DEPLOYER_PRIVATE_KEY=...
ADMIN_MULTISIG=0x...      # proposer/executor of the 48h timelock
GUARDIAN_MULTISIG=0x...   # must differ from admin
KEEPER_ADDRESS=0x...
TREASURY_MULTISIG=0x...   # receives the fixed $WELL supply
WELL_TOKEN_ADDRESS=0x...  # optional: use an already-deployed $WELL (18 decimals, must support burn(uint256))
npm run deploy:robinhood
npm run export-abis
```

After deploying, schedule `acceptOwnership()` through the timelock for the contracts the script lists: the oracle, the registry and the swap adapter. Then create and register a $WELL/USDG pool so drawdowns can run.

## App

```bash
cd app
npm install
npm run dev                                   # Robinhood Chain only
$env:NEXT_PUBLIC_ENABLE_LOCAL="1"; npm run dev  # also shows the local Hardhat deployment
npm run build
```

The app reads addresses from `app/src/generated/deployments.ts`. Before a deployment is exported, it shows "not live yet" states. Set `NEXT_PUBLIC_ROBINHOOD_RPC_URL` to use a private RPC. The "Trade $WELL on Pons" button links to the token's Pons page automatically; `NEXT_PUBLIC_WELL_TRADE_URL` overrides it.

## Launch parameters (`contracts/config/robinhood.json`)

- **Wells:** TSLA, NVDA, AAPL, PLTR and META, each with a $25,000 Held Value cap and a 30% protocol share.
- **META Credit Line:** 40% LTV, 55% liquidation threshold, 6% bonus, 50% close factor, 30% concentration cap, 10% reserve factor.
- **Basket Program:** deployed closed (cap 0).
- **Timelock:** 48 hours. The FeeRouter destination change has its own 48-hour delay.

## License

MIT. Stonkwell is original code. TickerSpring's MIT-licensed contracts were read as a design reference only, and no code was copied. The only Uniswap v4-core files used are MIT-licensed; no BUSL files are included.
