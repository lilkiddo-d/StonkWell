// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IPairPositionManager as NPM } from "../pairs/IPairPositionManager.sol";
import { ManagedStageLedger } from "./ManagedStageLedger.sol";
import { V3Observation } from "./V3Observation.sol";
import { MarketSpringV3Math as V3Math } from "../libraries/MarketSpringV3Math.sol";

interface IPaidPosition {
    function vault() external view returns (address);
    function token0() external view returns (IERC20);
    function token1() external view returns (IERC20);
    function liquidity() external view returns (uint128);
    function pendingFees() external view returns (uint256, uint256);
    function balances() external view returns (uint256, uint256);
    function balancesAtPrice(uint160 price) external view returns (uint256, uint256);
    function loose() external view returns (uint256, uint256);
    function validateMarket() external view;
    function validateRebalance(int24 lo, int24 hi, uint256 requestId, uint256 deadline)
        external
        view;
    function completeRebalance(uint256 requestId) external;
    function validate(int24 lower, int24 upper) external view;
    function required(uint128 added, int24 lower, int24 upper)
        external
        view
        returns (uint256, uint256);
    function add(uint128 target, int24 lower, int24 upper)
        external
        returns (uint128, uint256, uint256);
    function harvest() external returns (uint256, uint256);
    function remove(uint256 n, uint256 d) external returns (uint256, uint256);
    function recover(uint8 blocked)
        external
        returns (
            uint256 liveFees,
            uint256 livePrincipal,
            uint256 blockedFees,
            uint256 blockedPrincipal
        );
    function collectBlocked(uint8 blocked) external returns (uint256);
    function beginRecovery() external returns (uint256[2] memory fees, uint256[2] memory principal);
}

interface IManagedRangeVault {
    function admin() external view returns (address);
    function guardian() external view returns (address);
    function position() external view returns (address);
    function epoch() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function stopped() external view returns (bool);
    function recovery() external view returns (bool);
    function lower() external view returns (int24);
    function upper() external view returns (int24);
    function lastRebalance() external view returns (uint256);
}

interface IStagedVaultValue {
    function idle() external view returns (uint256, uint256);
    function valuation() external view returns (IStagedValuation);
    function maxSwapLossBps() external view returns (uint16);
}

interface IStagedValuation {
    function value(uint256 a, uint256 b) external view returns (uint256);
}

interface INPMFactory {
    function factory() external view returns (address);
}

/// @notice Prototype delta of PairV3Position. Fixed custody; no arbitrary swaps or recipients.
contract ManagedV3Position is IPaidPosition {
    using SafeERC20 for IERC20;
    address public immutable vault;
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    IUniswapV3Pool public immutable pool;
    NPM public immutable manager;
    V3Observation public immutable observation;
    uint128 public immutable liquidityFloor;
    uint24 public immutable maximumTickDeviation;
    uint256 public tokenId;
    bool public recovering;
    uint8 public blockedIndex;

    struct RangeRequest {
        int24 lower;
        int24 upper;
        uint64 expiresAt;
        uint256 configuration;
    }
    uint256 public rangeRequestNonce;
    uint256 public lastRequestedRebalance;
    uint256 public constant REQUEST_TTL = 10 minutes;
    uint256 public constant REQUEST_INTERVAL = 2 hours;
    RangeRequest public rangeRequest;
    event RangeRequested(
        uint256 indexed id,
        uint256 indexed configuration,
        int24 lower,
        int24 upper,
        uint64 expiresAt
    );
    event RangeCancelled(uint256 indexed id);
    event RangeExecuted(uint256 indexed id);

    ManagedStageLedger public stageLedger;

    function stagedRebalance()
        external
        view
        returns (uint256, uint256, uint256, uint256, uint64, uint64, uint256, int24, int24, bool)
    {
        return stageLedger.stagedRebalance();
    }

    function stageNonce() external view returns (uint256) {
        return stageLedger.stageNonce();
    }

    function stageUnfinished() external view returns (bool) {
        return stageLedger.unfinished();
    }
    uint256 public constant CHUNK_INTERVAL = 60;

    function MAX_CHUNK_LOSS_BPS() external view returns (uint256) {
        return stageLedger.chunkLimitBps();
    }

    function MAX_STAGE_LOSS_BPS() external view returns (uint256) {
        return stageLedger.stageLimitBps();
    }
    event RebalanceChunk(
        uint256 indexed id, uint256 indexed configuration, uint256 loss, bool finished
    );
    event StageCancelled(uint256 indexed id);

    error Invalid();
    error Receipt();
    modifier onlyVault() {
        if (msg.sender != vault) revert Invalid();
        _;
    }

    constructor(
        address v,
        address p,
        address npm,
        address factory,
        uint128 floor,
        uint24 deviation
    ) {
        pool = IUniswapV3Pool(p);
        manager = NPM(npm);
        vault = v;
        address a = pool.token0();
        address b = pool.token1();
        if (
            v == address(0) || a >= b || floor == 0 || deviation == 0 || deviation > 200
                || IUniswapV3Factory(factory).getPool(a, b, pool.fee()) != p
                || INPMFactory(npm).factory() != factory
        ) revert Invalid();
        token0 = IERC20(a);
        token1 = IERC20(b);
        liquidityFloor = floor;
        maximumTickDeviation = deviation;
        observation = new V3Observation();
        stageLedger = new ManagedStageLedger(v);
    }

    function _position()
        private
        view
        returns (uint128 liq, int24 lower, int24 upper, uint128 owed0, uint128 owed1)
    {
        if (tokenId == 0) return (0, 0, 0, 0, 0);
        (
            ,,
            address a,
            address b,
            uint24 fee,
            int24 l,
            int24 u,
            uint128 q,,,
            uint128 o0,
            uint128 o1
        ) = manager.positions(tokenId);
        if (a != address(token0) || b != address(token1) || fee != pool.fee()) revert Invalid();
        return (q, l, u, o0, o1);
    }

    function liquidity() external view returns (uint128 q) {
        (q,,,,) = _position();
    }

    function validateMarket() public view {
        if (recovering) revert Invalid();
        (, int24 tick,,,,, bool unlocked) = pool.slot0();
        (int24 mean, uint128 harmonic) = observation.consult(pool, 1800);
        int256 d = int256(tick) - mean;
        int256 bound = int256(uint256(maximumTickDeviation));
        if (
            !unlocked || harmonic < liquidityFloor || pool.liquidity() < liquidityFloor || d > bound
                || d < -bound
        ) {
            revert Invalid();
        }
    }

    function validate(int24 lower, int24 upper) public view {
        validateMarket();
        (, int24 tick,,,,,) = pool.slot0();
        int24 spacing = pool.tickSpacing();
        if (
            lower >= upper || lower % spacing != 0 || upper % spacing != 0 || tick <= lower
                || tick >= upper
        ) {
            revert Invalid();
        }
    }

    /// @notice Immediate range-change intent, not a conditional price order.
    /// New requests must contain the current price and cannot inhibit automatic management.
    function requestRange(
        int24 lo,
        int24 hi,
        uint64 expiresAt,
        uint256 configuration,
        uint256 expectedId
    ) external {
        IManagedRangeVault v = IManagedRangeVault(vault);
        if (
            msg.sender != v.admin() || v.position() != address(this) || v.totalSupply() == 0
                || v.recovery() || v.stopped() || configuration != v.epoch()
                || expectedId != rangeRequestNonce || lo < -887272 || hi > 887272
                || (lo == v.lower() && hi == v.upper() && this.liquidity() != 0)
        ) revert Invalid();
        // This is transaction freshness, not a price signal or a user-funds lock.
        // forge-lint: disable-next-line(block-timestamp)
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + REQUEST_TTL) {
            revert Invalid();
        }
        _requestInterval();
        validate(lo, hi);
        rangeRequest = RangeRequest(lo, hi, expiresAt, configuration);
        emit RangeRequested(++rangeRequestNonce, configuration, lo, hi, expiresAt);
    }

    function cancelRange(uint256 expectedId) external {
        IManagedRangeVault v = IManagedRangeVault(vault);
        if (
            (msg.sender != v.admin() && msg.sender != v.guardian())
                || expectedId != rangeRequestNonce || rangeRequest.expiresAt == 0
        ) revert Invalid();
        rangeRequest.expiresAt = 0;
        emit RangeCancelled(rangeRequestNonce++);
    }

    /// @notice Metadata validity only. Never blocks automatic rebalancing.
    function rangeRequestActive() public view returns (bool) {
        IManagedRangeVault v = IManagedRangeVault(vault);
        // Chain-time expiry bounds a signed instruction; zero denotes cancellation/completion.
        // forge-lint: disable-next-line(block-timestamp)
        return rangeRequest.expiresAt >= block.timestamp && rangeRequest.expiresAt != 0
            && rangeRequest.configuration == v.epoch() && v.totalSupply() != 0 && !v.stopped()
            && !v.recovery();
    }

    function _requestInterval() private view {
        // Only successful requested execution starts this interval; automatic execution does not.
        if (
            lastRequestedRebalance != 0
                // forge-lint: disable-next-line(block-timestamp)
                && block.timestamp < lastRequestedRebalance + REQUEST_INTERVAL
        ) {
            revert Invalid();
        }
    }

    function validateRebalance(int24 lo, int24 hi, uint256 requestId, uint256 deadline)
        external
        view
    {
        // Keeper plan freshness, unchanged from the vault's original execution checks.
        // forge-lint: disable-next-line(block-timestamp)
        if (deadline < block.timestamp || deadline > block.timestamp + 600) revert Invalid();
        validate(lo, hi);
        IManagedRangeVault v = IManagedRangeVault(vault);
        if (stagedRebalanceActive()) revert Invalid();
        if (requestId != 0) {
            if (
                requestId != rangeRequestNonce || !rangeRequestActive() || lo != rangeRequest.lower
                    || hi != rangeRequest.upper
            ) revert Invalid();
            _requestInterval();
            return;
        }
        if (stageLedger.unfinished()) {
            ManagedStageLedger.State memory s = stageLedger.state();
            _automaticRange(lo, hi, s.lower, s.upper);
        } else {
            _automaticRange(lo, hi, v.lower(), v.upper());
        }
    }

    function _automaticRange(int24 lo, int24 hi, int24 oldLo, int24 oldHi) private view {
        IManagedRangeVault v = IManagedRangeVault(vault);
        (, int24 tick,,,,,) = pool.slot0();
        int24 spacing = pool.tickSpacing();
        int256 center = (int256(lo) + hi) / 2;
        // Automatic management retains its two-hour interval regardless of pending requests.
        if (
            // forge-lint: disable-next-line(block-timestamp)
            block.timestamp < v.lastRebalance() + 2 hours
                || int256(hi) - lo != int256(oldHi) - oldLo || tick > oldLo && tick < oldHi
                || center > int256(tick) + spacing || center < int256(tick) - spacing
        ) revert Invalid();
    }

    /// @notice Called only after the vault's successful rebuild and exact inventory checks.
    function completeRebalance(uint256 requestId) external onlyVault {
        if (requestId == 0) return;
        if (requestId != rangeRequestNonce || !rangeRequestActive()) revert Invalid();
        _requestInterval();
        lastRequestedRebalance = block.timestamp;
        rangeRequest.expiresAt = 0;
        emit RangeExecuted(requestId);
    }

    function stagedRebalanceActive() public view returns (bool) {
        IManagedRangeVault v = IManagedRangeVault(vault);
        ManagedStageLedger.State memory s = stageLedger.state();
        // Waiting never clears the cumulative loss ledger.
        return s.active && v.position() == address(this) && v.totalSupply() != 0 && !v.stopped()
            && !v.recovery();
    }

    function cancelStagedRebalance(uint256 id) external {
        IManagedRangeVault v = IManagedRangeVault(vault);
        if (
            (msg.sender != v.admin() && msg.sender != v.guardian()) || id != stageLedger.state().id
                || !stageLedger.state().active
        ) revert Invalid();
        stageLedger.cancel();
        emit StageCancelled(id);
    }

    function validateChunk(int24 lo, int24 hi, uint256 requestId, uint256 id, uint256 deadline)
        public
        view
    {
        if (id == 0) {
            // Cancelling or invalidating a plan cannot bypass inter-chunk spacing.
            // forge-lint: disable-next-line(block-timestamp)
            if (
                stageLedger.unfinished()
                    // forge-lint: disable-next-line(block-timestamp)
                    && block.timestamp < uint256(stageLedger.state().lastStepAt) + CHUNK_INTERVAL
            ) {
                revert Invalid();
            }
            this.validateRebalance(lo, hi, requestId, deadline);
            return;
        }
        ManagedStageLedger.State memory s = stageLedger.state();
        // Chain-time spacing prevents rapid repeated trades, not price validation.
        // forge-lint: disable-next-line(block-timestamp)
        if (
            !stagedRebalanceActive() || s.id != id || requestId != 0
                // forge-lint: disable-next-line(block-timestamp)
                || block.timestamp < s.lastStepAt + CHUNK_INTERVAL
                // forge-lint: disable-next-line(block-timestamp)
                || deadline < block.timestamp || deadline > block.timestamp + 600
        ) revert Invalid();
        validate(lo, hi);
        // A changed target uses the ordinary out-of-range policy without starting a new ledger.
        if (s.lower != lo || s.upper != hi) _automaticRange(lo, hi, s.lower, s.upper);
    }

    function recordChunk(
        int24 lo,
        int24 hi,
        uint256 requestId,
        uint256 id,
        uint256 deadline,
        uint256 beforeValue,
        uint256 afterValue,
        uint256 inputValue,
        bool finished
    ) external onlyVault {
        validateChunk(lo, hi, requestId, id, deadline);
        uint256 recordedId = stageLedger.record(
            lo, hi, beforeValue, afterValue, inputValue, finished, requestId != 0
        );
        emit RebalanceChunk(
            recordedId,
            IManagedRangeVault(vault).epoch() + 1,
            beforeValue > afterValue ? beforeValue - afterValue : 0,
            finished
        );
    }

    function endEmptyStage() external onlyVault {
        stageLedger.endEmpty();
    }

    /// @notice Retain the original non-upgradeable loss ledger instead of copying or clearing it.
    function inheritState(ManagedV3Position source) external onlyVault {
        IManagedRangeVault v = IManagedRangeVault(vault);
        if (
            v.position() != address(source) || source.vault() != vault
                || address(source) == address(this) || tokenId != 0 || stageLedger.stageNonce() != 0
                || rangeRequestNonce != 0
        ) revert Invalid();
        stageLedger = source.stageLedger();
        lastRequestedRebalance = source.lastRequestedRebalance();
        rangeRequestNonce = source.rangeRequestNonce() + 1;
    }

    function required(uint128 q, int24 lower, int24 upper)
        public
        view
        returns (uint256 a, uint256 b)
    {
        (uint160 price,,,,,,) = pool.slot0();
        uint160 lo = V3Math.getSqrtRatioAtTick(lower);
        uint160 hi = V3Math.getSqrtRatioAtTick(upper);
        if (price <= lo || price >= hi) revert Invalid();
        // Invert the NPM's LiquidityAmounts formula, including its floored intermediate.
        // Merely rounding core amount0 delta upward can still mint target-1 liquidity.
        uint256 intermediate = Math.mulDiv(price, hi, 1 << 96);
        if (intermediate == 0) revert Invalid();
        a = Math.mulDiv(q, uint256(hi) - price, intermediate, Math.Rounding.Ceil);
        b = Math.mulDiv(q, uint256(price) - lo, 1 << 96, Math.Rounding.Ceil);
    }

    function pendingFees() external view returns (uint256 f0, uint256 f1) {
        if (tokenId == 0 || recovering) return (0, 0);
        (
            ,,,,,
            int24 lo,
            int24 hi,
            uint128 q,
            uint256 last0,
            uint256 last1,
            uint128 owed0,
            uint128 owed1
        ) = manager.positions(tokenId);
        f0 = owed0;
        f1 = owed1;
        if (q == 0) return (f0, f1);
        (, int24 tick,,,,,) = pool.slot0();
        (,, uint256 low0, uint256 low1,,,,) = pool.ticks(lo);
        (,, uint256 high0, uint256 high1,,,,) = pool.ticks(hi);
        uint256 global0 = pool.feeGrowthGlobal0X128();
        uint256 global1 = pool.feeGrowthGlobal1X128();
        unchecked {
            uint256 inside0 = global0 - (tick >= lo ? low0 : global0 - low0)
                - (tick < hi ? high0 : global0 - high0);
            uint256 inside1 = global1 - (tick >= lo ? low1 : global1 - low1)
                - (tick < hi ? high1 : global1 - high1);
            f0 += Math.mulDiv(inside0 - last0, q, 1 << 128);
            f1 += Math.mulDiv(inside1 - last1, q, 1 << 128);
        }
    }

    function loose() public view returns (uint256, uint256) {
        return (token0.balanceOf(address(this)), token1.balanceOf(address(this)));
    }

    function balances() external view returns (uint256 a, uint256 b) {
        (uint160 price,,,,,,) = pool.slot0();
        return balancesAtPrice(price);
    }

    /// @notice Value LP composition at an independently supplied price, not the pool's spot.
    function balancesAtPrice(uint160 price) public view returns (uint256 a, uint256 b) {
        if (
            price <= V3Math.getSqrtRatioAtTick(-887272)
                || price >= V3Math.getSqrtRatioAtTick(887272)
        ) {
            revert Invalid();
        }
        (a, b) = loose();
        (uint128 q, int24 lo, int24 hi,,) = _position();
        if (q != 0) {
            (uint256 x, uint256 y) = V3Math.getAmountsForLiquidity(
                price, V3Math.getSqrtRatioAtTick(lo), V3Math.getSqrtRatioAtTick(hi), q
            );
            a += x;
            b += y;
        }
    }

    function add(uint128 target, int24 lower, int24 upper)
        external
        onlyVault
        returns (uint128 added, uint256 used0, uint256 used1)
    {
        validate(lower, upper);
        (uint256 a, uint256 b) = required(target, lower, upper);
        uint256 before0 = token0.balanceOf(address(this));
        uint256 before1 = token1.balanceOf(address(this));
        if (target == 0 || before0 < a || before1 < b) revert Invalid();
        token0.forceApprove(address(manager), a);
        token1.forceApprove(address(manager), b);
        if (tokenId == 0) {
            (tokenId, added, used0, used1) = manager.mint(
                NPM.MintParams(
                    address(token0),
                    address(token1),
                    pool.fee(),
                    lower,
                    upper,
                    a,
                    b,
                    0,
                    0,
                    address(this),
                    block.timestamp
                )
            );
        } else {
            (, int24 lo, int24 hi,,) = _position();
            if (lo != lower || hi != upper) revert Invalid();
            (added, used0, used1) = manager.increaseLiquidity(
                NPM.IncreaseLiquidityParams(tokenId, a, b, 0, 0, block.timestamp)
            );
        }
        token0.forceApprove(address(manager), 0);
        token1.forceApprove(address(manager), 0);
        if (
            added < target || before0 - token0.balanceOf(address(this)) != used0
                || before1 - token1.balanceOf(address(this)) != used1
        ) revert Receipt();
        // Only the current contribution refund. Unsolicited old position inventory is not swept into this refund.
        _send(token0, a - used0);
        _send(token1, b - used1);
    }

    function harvest() external onlyVault returns (uint256 a, uint256 b) {
        if (recovering) revert Invalid();
        (a, b) = _collect(type(uint128).max, type(uint128).max);
        _send(token0, token0.balanceOf(address(this)));
        _send(token1, token1.balanceOf(address(this)));
    }

    function remove(uint256 n, uint256 d) external onlyVault returns (uint256 a, uint256 b) {
        if (recovering || n == 0 || n > d) revert Invalid();
        uint256 idle0 = token0.balanceOf(address(this));
        uint256 idle1 = token1.balanceOf(address(this));
        (uint128 q,,,,) = _position();
        uint128 cut = SafeCast.toUint128(Math.mulDiv(q, n, d));
        if (cut != 0) {
            (uint256 x, uint256 y) = manager.decreaseLiquidity(
                NPM.DecreaseLiquidityParams(tokenId, cut, 0, 0, block.timestamp)
            );
            (a, b) = _collect(type(uint128).max, type(uint128).max);
            // Caller checkpoints fees immediately before removal; no swap/callback ownership mutation between.
            if (a != x || b != y) revert Receipt();
        }
        a += Math.mulDiv(idle0, n, d);
        b += Math.mulDiv(idle1, n, d);
        if (n == d && tokenId != 0) {
            manager.burn(tokenId);
            tokenId = 0;
        }
        _send(token0, a);
        _send(token1, b);
    }

    function beginRecovery()
        external
        onlyVault
        returns (uint256[2] memory fees, uint256[2] memory principal)
    {
        if (recovering) revert Invalid();
        recovering = true;
        // decreaseLiquidity checkpoints fee growth without transferring either token.
        // NPM collect(0,0) is forbidden, so derive fees from owed minus returned principal.
        (uint128 q,,,,) = _position();
        if (q != 0) {
            (principal[0], principal[1]) = manager.decreaseLiquidity(
                NPM.DecreaseLiquidityParams(tokenId, q, 0, 0, block.timestamp)
            );
        }
        (,,, uint128 owed0, uint128 owed1) = _position();
        fees[0] = uint256(owed0) - principal[0];
        fees[1] = uint256(owed1) - principal[1];
        principal[0] += token0.balanceOf(address(this));
        principal[1] += token1.balanceOf(address(this));
    }

    function recover(uint8 blocked)
        external
        onlyVault
        returns (
            uint256 liveFees,
            uint256 livePrincipal,
            uint256 blockedFees,
            uint256 blockedPrincipal
        )
    {
        if (recovering || blocked > 1) revert Invalid();
        recovering = true;
        blockedIndex = blocked;
        (uint256 f0, uint256 f1) =
            _collect(blocked == 0 ? 0 : type(uint128).max, blocked == 1 ? 0 : type(uint128).max);
        liveFees = blocked == 0 ? f1 : f0;
        (uint128 q,,, uint128 owed0, uint128 owed1) = _position();
        blockedFees = blocked == 0 ? owed0 : owed1;
        uint256 p0 = 0;
        uint256 p1 = 0;
        if (q != 0) {
            (p0, p1) = manager.decreaseLiquidity(
                NPM.DecreaseLiquidityParams(tokenId, q, 0, 0, block.timestamp)
            );
        }
        (uint256 a, uint256 b) =
            _collect(blocked == 0 ? 0 : type(uint128).max, blocked == 1 ? 0 : type(uint128).max);
        livePrincipal = blocked == 0 ? p1 : p0;
        blockedPrincipal = blocked == 0 ? p0 : p1;
        if ((blocked == 0 ? b : a) != livePrincipal) revert Receipt();
        IERC20 live = blocked == 0 ? token1 : token0;
        // Include preexisting position loose inventory as principal, excluding just-collected fees.
        uint256 liveTotal = live.balanceOf(address(this));
        livePrincipal = liveTotal - liveFees;
        IERC20 bad = blocked == 0 ? token0 : token1;
        blockedPrincipal += bad.balanceOf(address(this));
        _send(live, liveTotal);
    }

    function collectBlocked(uint8 blocked) external onlyVault returns (uint256 amount) {
        if (!recovering || blocked > 1) revert Invalid();
        _collect(blocked == 0 ? type(uint128).max : 0, blocked == 1 ? type(uint128).max : 0);
        IERC20 token = blocked == 0 ? token0 : token1;
        amount = token.balanceOf(address(this));
        _send(token, amount);
        (uint128 q,,, uint128 o0, uint128 o1) = _position();
        if (tokenId != 0 && q == 0 && o0 == 0 && o1 == 0) {
            manager.burn(tokenId);
            tokenId = 0;
        }
    }

    function _collect(uint128 max0, uint128 max1) private returns (uint256 a, uint256 b) {
        if (tokenId == 0) return (0, 0);
        uint256 before0 = token0.balanceOf(address(this));
        uint256 before1 = token1.balanceOf(address(this));
        (a, b) = manager.collect(NPM.CollectParams(tokenId, address(this), max0, max1));
        if (
            token0.balanceOf(address(this)) - before0 != a
                || token1.balanceOf(address(this)) - before1 != b
        ) {
            revert Receipt();
        }
    }

    function _send(IERC20 t, uint256 n) private {
        if (n == 0) return;
        uint256 b = t.balanceOf(vault);
        uint256 own = t.balanceOf(address(this));
        t.safeTransfer(vault, n);
        if (t.balanceOf(vault) - b != n || own - t.balanceOf(address(this)) != n) revert Receipt();
    }
}
