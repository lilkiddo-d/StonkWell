// Protocol-fee pipeline: BorrowDesk reserves -> FeeRouter -> DrawdownRetire -> $WELL burned.
const { ethers } = require("ethers");
const abis = require("../abis");
const { exec, reason, blockTime } = require("../chain");
const { logger } = require("../log");
const { buildRoute } = require("../routes");

const BPS = 10_000n;
const WAD = 10n ** 18n;

/// Fee tokens the protocol can hold: USDG plus every Well's Equity Token.
function feeTokens(ctx) {
  const list = [{ symbol: "USDG", address: ethers.getAddress(ctx.dep.usdg) }];
  for (const [ticker, w] of Object.entries(ctx.dep.wells || {})) list.push({ symbol: ticker, address: ethers.getAddress(w.equityToken) });
  return list;
}

function erc20(ctx, address) {
  return new ethers.Contract(address, abis.ERC20, ctx.provider);
}

// ---------------------------------------------------------------- FeeRouter.routeMany

async function runFeeRouter(ctx) {
  const log = logger("route", "FeeRouter");
  if (!ctx.cfg.feeRouter.enabled || !ctx.dep.feeRouter) return;
  const router = new ethers.Contract(ctx.dep.feeRouter, abis.FeeRouter, ctx.runner);
  const held = [];
  for (const t of feeTokens(ctx)) {
    const bal = await erc20(ctx, t.address).balanceOf(ctx.dep.feeRouter);
    if (bal > 0n) held.push({ ...t, bal });
  }
  if (held.length === 0) {
    log.info("nothing to route");
    return;
  }
  log.info("routing to DrawdownRetire", { tokens: held.map((t) => `${t.symbol}:${t.bal}`).join(",") });
  await exec(ctx, log, router, "routeMany", [held.map((t) => t.address)], "routeMany");
}

// ---------------------------------------------------------------- DrawdownRetire.drawdown

async function runDrawdown(ctx) {
  const log = logger("drawdown", "DrawdownRetire");
  const cfg = ctx.cfg.drawdown;
  if (!cfg.enabled || !ctx.dep.drawdownRetire) return;
  const dd = new ethers.Contract(ctx.dep.drawdownRetire, abis.DrawdownRetire, ctx.runner);

  if (!(await dd.hasRole(await dd.KEEPER_ROLE(), ctx.keeper))) {
    log.warn("keeper address lacks KEEPER_ROLE on DrawdownRetire; skipping", { keeper: ctx.keeper });
    return;
  }
  if (await dd.halted()) {
    log.info("halted by guardian, skipping");
    return;
  }
  // lastDrawdown and minInterval are shared by every input token: at most one drawdown per interval.
  const [last, interval, now] = await Promise.all([dd.lastDrawdown(), dd.minInterval(), blockTime(ctx.provider)]);
  const next = last + interval;
  if (now < next) {
    log.info("rate limited by minInterval", { nextInSec: next - now });
    return;
  }

  const oracle = ctx.dep.oracle ? new ethers.Contract(ctx.dep.oracle, abis.WellOracle, ctx.provider) : null;
  const candidates = [];
  for (const t of feeTokens(ctx)) {
    const [bal, cap] = await Promise.all([erc20(ctx, t.address).balanceOf(ctx.dep.drawdownRetire), dd.maxInputPerRun(t.address)]);
    if (bal === 0n) continue;
    if (cap === 0n) {
      log.warn("fee token held but maxInputPerRun is 0; governance must set an input limit", { token: t.symbol, balance: bal });
      continue;
    }
    const amount = bal < cap ? bal : cap;
    let value = null;
    if (t.symbol === "USDG") value = amount;
    else if (oracle) {
      try {
        if (await oracle.isFresh(t.address)) value = await oracle.usdgValue(t.address, amount);
      } catch {}
    }
    candidates.push({ ...t, bal, cap, amount, value });
  }
  if (candidates.length === 0) {
    log.info("no fee tokens to draw down");
    return;
  }
  // Largest known USDG value first; unpriced (stale) tokens last.
  candidates.sort((a, b) => (a.value === null ? 1 : b.value === null ? -1 : a.value > b.value ? -1 : a.value < b.value ? 1 : 0));

  for (const c of candidates) {
    const tlog = logger("drawdown", c.symbol);
    let route;
    let path;
    try {
      const spec = cfg.routes[c.symbol] ?? cfg.routes[c.address] ?? cfg.routes[c.address.toLowerCase()] ?? cfg.defaultRoute;
      ({ route, path } = buildRoute(ctx, spec, c.address, ctx.dep.wellToken));
    } catch (e) {
      tlog.error("bad route config", { reason: e.message });
      continue;
    }
    const pathText = path ? path.map((a) => symbolOf(ctx, a)).join("->") : "adapter-default";

    // Quote: simulate the real drawdown from the keeper with minWellOut = 1. Its return value is the
    // $WELL the swap delivered, which is exactly what the minimum protects.
    let quoted;
    try {
      quoted = await dd.drawdown.staticCall(c.address, c.amount, 1n, route, { from: ctx.keeper });
    } catch (e) {
      const why = reason(e);
      const hint = path && path.includes(ethers.ZeroAddress)
        ? "route uses native ETH; the swap adapter must support native ETH hops and the hooked Pons $WELL pool first"
        : undefined;
      tlog.warn("quote failed, skipping this token", { amountIn: c.amount, path: pathText, reason: why, hint });
      continue;
    }
    const minOut = (quoted * (BPS - BigInt(cfg.slippageBps))) / BPS;
    if (minOut === 0n) {
      tlog.warn("quote returned no $WELL, skipping", { amountIn: c.amount, path: pathText });
      continue;
    }
    tlog.info("drawing down", {
      amountIn: c.amount,
      balance: c.bal,
      cap: c.cap,
      valueUsdg: c.value === null ? "unpriced" : ethers.formatUnits(c.value, 6),
      path: pathText,
      quotedWell: ethers.formatEther(quoted),
      minWellOut: ethers.formatEther(minOut),
      slippageBps: cfg.slippageBps,
    });
    const r = await exec(ctx, tlog, dd, "drawdown", [c.address, c.amount, minOut, route], "drawdown");
    if (r.ok) return; // the shared minInterval allows one per run
  }
}

function symbolOf(ctx, a) {
  if (a === ethers.ZeroAddress) return "ETH";
  if (a.toLowerCase() === String(ctx.dep.usdg).toLowerCase()) return "USDG";
  if (a.toLowerCase() === String(ctx.dep.wellToken).toLowerCase()) return "WELL";
  for (const [t, w] of Object.entries(ctx.dep.wells || {})) if (a.toLowerCase() === w.equityToken.toLowerCase()) return t;
  return a;
}

// ---------------------------------------------------------------- BorrowDesk

async function runBorrowDesks(ctx) {
  for (const [ticker, address] of Object.entries(ctx.dep.creditLines || {})) {
    const log = logger("borrowdesk", ticker);
    const desk = new ethers.Contract(address, abis.BorrowDesk, ctx.runner);
    const state = (ctx.state.desks[address] ||= { lastClaim: 0, accounts: new Set(), scanned: null });
    if (ctx.cfg.borrowDesk.claimReserves) {
      try {
        await claimReserves(ctx, log, desk, state);
      } catch (e) {
        log.error("claimReserves check failed", { reason: reason(e) });
      }
    }
    if (ctx.cfg.borrowDesk.logUnhealthy) {
      try {
        await logUnhealthy(ctx, log, desk, state);
      } catch (e) {
        log.error("health scan failed", { reason: reason(e) });
      }
    }
  }
}

async function claimReserves(ctx, log, desk, state) {
  const interval = ctx.cfg.borrowDesk.claimIntervalSeconds * 1000;
  if (state.lastClaim && Date.now() - state.lastClaim < interval) return;
  const [reserves, debt] = await Promise.all([desk.reserves(), desk.totalDebt()]);
  // claimReserves accrues first, so reserves can grow from outstanding debt even when stored reserves are 0.
  if (reserves === 0n && debt === 0n) {
    log.info("no reserves to claim");
    state.lastClaim = Date.now();
    return;
  }
  // Interest over a short gap can round reserves to zero, which reverts ZeroAmount: not an error.
  const r = await exec(ctx, log, desk, "claimReserves", [], "claimReserves", ["ZeroAmount"]);
  if (r.ok) state.lastClaim = Date.now();
}

// Liquidations are not automated. This only reports accounts below health factor 1.
async function logUnhealthy(ctx, log, desk, state) {
  const latest = await ctx.provider.getBlockNumber();
  let from = state.scanned === null ? Number(ctx.cfg.borrowDesk.scanFromBlock || 0) : state.scanned + 1;
  const chunk = Number(ctx.cfg.borrowDesk.scanChunkBlocks || 50_000);
  while (from <= latest) {
    const to = Math.min(from + chunk - 1, latest);
    const events = await desk.queryFilter(desk.filters.Borrowed(), from, to);
    for (const ev of events) state.accounts.add(ev.args.account);
    state.scanned = to;
    from = to + 1;
  }
  if (!(await desk.well().then((w) => new ethers.Contract(w, abis.Well, ctx.provider).priceFresh()))) {
    log.info("price stale; health factors unavailable", { borrowers: state.accounts.size });
    return;
  }
  let unhealthy = 0;
  for (const account of state.accounts) {
    if ((await desk.debtOf(account)) === 0n) continue;
    const hf = await desk.healthFactor(account);
    if (hf < WAD) {
      unhealthy++;
      log.warn("UNHEALTHY account (liquidation is not automated)", { account, healthFactor: ethers.formatEther(hf), debt: await desk.debtOf(account) });
    }
  }
  log.info("health scan done", { borrowers: state.accounts.size, unhealthy });
}

module.exports = { runFeeRouter, runDrawdown, runBorrowDesks };
