# Launch day

Everything below was rehearsed on a copy of Robinhood Chain on 2026-09-28: preflight, the full live deploy with a Pons token as $WELL, and the timelock handoff (schedule, early execute rejected, execute after 48h, timelock owns everything).

## Before you start

| You need | Notes |
|---|---|
| **$WELL launched on Pons** | Copy its contract address. It must have 18 decimals and a working `burn()`; the preflight checks both (Pons tokens pass). |
| **Admin multisig** | A Safe (safe.global) on Robinhood Chain. Controls settings through the 48h timelock. |
| **Guardian multisig** | A *different* Safe, with different signers. Can pause in an emergency. |
| **Keeper wallet** | A normal wallet with a little ETH for gas. Runs the keeper bot. |
| **Treasury multisig** | Can be your team Safe. |
| **Deployer wallet** | A fresh wallet with **0.01 ETH** on Robinhood Chain. The full deploy costs about 0.001 ETH at today's gas price. Controls nothing once the handoff is done. |
| **Market hours** | Deploy while US markets are open. Chainlink stock prices stop updating when markets close; the deploy still works, but Wells stay closed to deposits until prices update. |

## 1. Fill in your addresses

Copy `launch.env.example` to `launch.env` in the repo root and fill in the five addresses. `launch.env` is gitignored. **Never put a private key in it.**

## 2. Rehearse (optional, free)

```powershell
.\launch.ps1 -Rehearsal
```

Runs every check and a full deploy on a local copy of the chain. Nothing is sent.

## 3. Deploy

```powershell
.\launch.ps1
```

It will:
1. Ask for the deployer private key with hidden input. It stays in that PowerShell window only and is cleared when the script ends.
2. Refresh live pool data and run the preflight. Any `FAIL` stops everything before gas is spent. `warn` lines are informational; for example, a role address that is a plain wallet instead of a Safe.
3. Ask you to type `DEPLOY`, then deploy. If the connection to the Robinhood RPC drops (it happens on this PC), it retries up to 3 times with a fresh full deployment. A half-finished attempt holds no funds and the app never lists it.
4. Export the addresses into the website and build it.

If it keeps failing on connection errors, try another internet connection, or set `ROBINHOOD_RPC_URL` in `launch.env` to a private RPC.

## 4. Publish the site

Commit and push `contracts/deployments/robinhood.json` and `app/src/generated/`, then merge to `main`. Netlify rebuilds and the site switches from "not live yet" to live.

In Netlify's environment variables:
- The "Trade $WELL on Pons" button links to your token's Pons page automatically. Nothing to set.
- Make sure `NEXT_PUBLIC_ENABLE_LOCAL` is **not** set.

## 5. Hand control to the timelock (admin multisig)

```powershell
node contracts\scripts\timelock-accept.js
```

It prints two Safe transactions and the current status:
- **Step 1, now:** schedule. In the admin Safe: New transaction > Transaction Builder > paste `to` and `data`.
- **Step 2, after 48 hours:** execute. Run the script again; it says `READY` when it's time.

Until step 2 is done, the deployer wallet still owns the oracle, registry and swap adapter. Keep that key safe for those 48 hours, then it controls nothing.

## 6. Start the keeper

In the `keeper` folder: `.\start.ps1` for a dry run (sends nothing), then `.\start.ps1 -Live`, which asks for the keeper
wallet's key with hidden input. Its first live cycle places each Well's price range, so run it before announcing.

## Known limits at launch

- **Buy-and-burn of $WELL starts once $WELL graduates on Pons.** Its trading pool only exists after graduation. Until then, protocol fees collect safely in the DrawdownRetire contract (which has no withdrawal path). When it graduates, run `node contracts\scripts\register-well-pool.js`: it checks the pool is live and prints the one transaction that registers it (from the deployer wallet before the 48h handoff, from the admin Safe after). The keeper then starts buying and burning on its next cycle.
- **No external audit yet.** Caps start small: $25,000 per Well, and the META Credit Line takes $10,000 in supply and $5,000 in borrows.
