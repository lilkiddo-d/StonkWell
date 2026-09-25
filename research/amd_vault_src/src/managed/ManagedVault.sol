// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Checkpoints } from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IPaidPosition } from "./ManagedV3Position.sol";
import { RecoveryEscrow, RecoveryEscrowFactory } from "./RecoveryEscrow.sol";

interface IPaidRebalanceRouter {
    function rebalanceSwap(bool zero, uint256 amount, uint256 minimum, uint160 limit) external;
}

interface IPaidAcquisition {
    function acquire() external;
}

interface IPaidValuation {
    function validatePool() external view;
    // Must be from the same independently validated oracle quote as value(), in pool token order.
    function sqrtPriceX96() external view returns (uint160);
    function value(uint256 amount0, uint256 amount1) external view returns (uint256);
}

/// @notice User-paid proportional stock/USDG ownership with native entry and independent token exits.
contract ManagedVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace256;
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    address public immutable admin;
    address public immutable guardian;
    address public immutable keeper;
    // Deployment identity pins. recoveryFactory.feeRecipients(vault) reports current destinations.
    address public immutable treasury;
    address public immutable buyback;
    uint128 public immutable minimumLiquidity;
    IPaidValuation public immutable valuation;
    IPaidPosition public position;
    address public router;
    address public immutable bootstrapper;
    uint16 public immutable maxSwapLossBps;
    RecoveryEscrowFactory public immutable recoveryFactory;
    uint256 public constant VERSION = 2;
    int24 public lower;
    int24 public upper;
    uint256 public epoch;
    bool public entryOpen;
    bool public restartRequired;
    bool public stopped;
    uint256 public performanceIndex = 1e18;
    uint256 public peakIndex = 1e18;
    uint256 public referenceValue;
    uint256 public referenceSupply;
    uint256 public reviewNonce;
    uint256 public lastRebalance;
    uint256 public executionNonce;
    uint256 public constant MIN_VALUE = 1000;
    uint256[2] public protocolFees;
    uint256[2] public buybackFees;
    uint256[2] public quarantined;
    uint256[2] public grossFees;
    // Recovery retires this vault. Each token has independent immutable snapshot ownership.
    bool public recovery;
    uint8 public blocked;
    bool[2] public caseOpened;
    uint256[2] public caseSupply;
    RecoveryEscrow[2] public recoveryEscrow;
    mapping(uint8 => mapping(address => Checkpoints.Trace256)) private snapshots;

    struct RebalanceSwap {
        uint256 requestId; // Zero preserves automatic management; nonzero binds an admin request.
        bool zeroForOne;
        uint256 amount;
        uint256 minimumOut;
        uint160 sqrtLimit;
    }

    struct Join {
        uint256 shares;
        uint128 bootstrapLiquidity;
        uint256 maximum0;
        uint256 maximum1;
        uint256 minShares;
        uint256 deadline;
        uint256 configuration;
        address receiver;
        bool acquire;
    }
    error Invalid();
    error Unauthorized();
    error Closed();
    error Minimum();
    error Receipt();
    error RecoveryShortfall();
    event Joined(
        address indexed payer,
        address indexed receiver,
        uint256 shares,
        uint256 used0,
        uint256 used1
    );
    event Exited(
        address indexed owner,
        address indexed receiver,
        uint256 shares,
        uint256 amount0,
        uint256 amount1
    );
    event LossObserved(uint256 index, uint256 peak, bool stopped);
    event RecoveryOpened(uint8 blocked, uint256 supply, uint256 nominal);
    enum RebalanceResult {
        Executed,
        LossStopped
    }
    event Rebalanced(uint256 nonce, int24 lower, int24 upper);
    event RebalanceStopped(uint256 indexed nonce, uint256 indexed configuration, uint256 index);
    event Configured(uint256 indexed configuration, int24 lower, int24 upper, bool open);
    event Reviewed(uint256 indexed reviewNonce, uint256 indexed configuration, bool stopped);
    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    constructor(
        IERC20 a,
        IERC20 b,
        address admin_,
        address guardian_,
        address keeper_,
        address treasury_,
        address buyback_,
        IPaidValuation oracle,
        uint128 minL,
        string memory name_,
        string memory symbol_,
        uint16 swapLossBps,
        RecoveryEscrowFactory recoveryFactory_
    ) ERC20(name_, symbol_) {
        if (
            address(a) >= address(b) || address(a).code.length == 0 || address(b).code.length == 0
                || admin_ == address(0) || guardian_ == address(0) || keeper_ == address(0)
                || keeper_ == admin_ || keeper_ == guardian_ || treasury_ == address(0)
                || buyback_ == address(0) || minL == 0 || address(oracle).code.length == 0
                || swapLossBps == 0 || swapLossBps > 500 || bytes(name_).length == 0
                || bytes(symbol_).length == 0
        ) revert Invalid();
        token0 = a;
        token1 = b;
        admin = admin_;
        guardian = guardian_;
        keeper = keeper_;
        treasury = treasury_;
        buyback = buyback_;
        minimumLiquidity = minL;
        valuation = oracle;
        bootstrapper = msg.sender;
        maxSwapLossBps = swapLossBps;
        if (address(recoveryFactory_).code.length == 0) revert Invalid();
        recoveryFactory = recoveryFactory_;
    }

    function bind(IPaidPosition p, address r) external nonReentrant {
        if (msg.sender != admin && msg.sender != bootstrapper) revert Unauthorized();
        if (
            address(position) != address(0) || p.vault() != address(this) || p.token0() != token0
                || p.token1() != token1 || r.code.length == 0
        ) revert Invalid();
        position = p;
        router = r;
    }

    function configure(int24 lo, int24 hi, bool open) external onlyAdmin nonReentrant {
        if (recovery || lo >= hi || (totalSupply() != 0 && (lo != lower || hi != upper))) {
            revert Invalid();
        }
        lower = lo;
        upper = hi;
        entryOpen = open;
        ++epoch;
        emit Configured(epoch, lo, hi, open);
    }

    function pauseEntry() external nonReentrant {
        if (msg.sender != guardian && msg.sender != admin) revert Unauthorized();
        entryOpen = false;
        ++epoch;
        emit Configured(epoch, lower, upper, false);
    }

    function idle() public view returns (uint256 a, uint256 b) {
        a = token0.balanceOf(address(this)) - protocolFees[0] - buybackFees[0] - quarantined[0];
        b = token1.balanceOf(address(this)) - protocolFees[1] - buybackFees[1] - quarantined[1];
        if (caseOpened[0]) a = 0;
        if (caseOpened[1]) b = 0;
    }

    function inventory() public view returns (uint256 a, uint256 b) {
        (a, b) = idle();
        if (!recovery) {
            (uint256 x, uint256 y) = position.balances();
            a += x;
            b += y;
        }
    }

    function _harvest() private {
        (uint256 a, uint256 b) = position.harvest();
        _fees(0, a);
        _fees(1, b);
    }

    function _fees(uint8 i, uint256 amount) private {
        grossFees[i] += amount;
        protocolFees[i] += amount / 10;
        buybackFees[i] += amount / 5;
    }

    function quote(uint256 s, uint128 firstL)
        public
        view
        returns (uint128 target, uint256 amount0, uint256 amount1, uint256 idle0, uint256 idle1)
    {
        uint256 supply = totalSupply();
        if (supply == 0) {
            target = firstL;
            if (target < minimumLiquidity) revert Minimum();
        } else {
            uint128 l = position.liquidity();
            if (l == 0 || s == 0) revert Invalid();
            target = SafeCast.toUint128(Math.mulDiv(l, s, supply, Math.Rounding.Ceil));
            (uint256 a, uint256 b) = idle();
            // Harvest moves this existing inventory into idle without changing holder ownership.
            // Future swap fees still require an execution-time quote and user maxima.
            (uint256 loose0, uint256 loose1) = position.loose();
            a += loose0;
            b += loose1;
            (uint256 fee0, uint256 fee1) = position.pendingFees();
            a += fee0 - fee0 / 10 - fee0 / 5;
            b += fee1 - fee1 / 10 - fee1 / 5;
            idle0 = Math.mulDiv(a, s, supply, Math.Rounding.Ceil);
            idle1 = Math.mulDiv(b, s, supply, Math.Rounding.Ceil);
        }
        (amount0, amount1) = position.required(target, lower, upper);
        amount0 += idle0;
        amount1 += idle1;
    }

    function join(Join calldata j) external nonReentrant returns (uint256 minted) {
        if (
            !entryOpen || restartRequired || stopped || recovery || j.configuration != epoch
                // Chain-time expiry; price and token receipts are validated independently.
                // forge-lint: disable-next-line(block-timestamp)
                || block.timestamp > j.deadline || j.receiver == address(0)
                || j.receiver == address(this) || j.receiver == router
                || j.receiver == address(position)
        ) revert Closed();
        position.validate(lower, upper);
        valuation.validatePool();
        if (j.acquire) {
            if (msg.sender != router) revert Unauthorized();
            IPaidAcquisition(router).acquire();
        }
        position.validate(lower, upper);
        valuation.validatePool();
        _harvest();
        uint256 supply = totalSupply();
        if (supply == 0) {
            // No transfer and no administrator-paid skim. Historical reserves were subtracted first.
            (uint256 a, uint256 b) = idle();
            quarantined[0] += a;
            quarantined[1] += b;
        }
        (uint128 target, uint256 need0, uint256 need1, uint256 h0, uint256 h1) =
            quote(j.shares, j.bootstrapLiquidity);
        if (need0 > j.maximum0 || need1 > j.maximum1) revert Minimum();
        _pull(token0, msg.sender, need0);
        _pull(token1, msg.sender, need1);
        _send(token0, address(position), need0 - h0);
        _send(token1, address(position), need1 - h1);
        (uint128 added, uint256 used0, uint256 used1) = position.add(target, lower, upper);
        minted = supply == 0 ? added : j.shares;
        if (minted < j.minShares || minted == 0 || added < target) revert Minimum();
        _mint(j.receiver, minted);
        if (referenceSupply == 0) {
            referenceValue = _oracleValue();
            referenceSupply = totalSupply();
        }
        _send(token0, msg.sender, need0 - used0 - h0);
        _send(token1, msg.sender, need1 - used1 - h1);
        emit Joined(msg.sender, j.receiver, minted, used0 + h0, used1 + h1);
    }

    function redeem(
        uint256 shares,
        address owner,
        address receiver,
        uint256 min0,
        uint256 min1,
        uint256 deadline
    ) external nonReentrant returns (uint256 a, uint256 b) {
        if (
            recovery || shares == 0 || shares > balanceOf(owner) || receiver == address(0)
                // Owner-supplied transaction expiry.
                // forge-lint: disable-next-line(block-timestamp)
                || block.timestamp > deadline
        ) revert Invalid();
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _harvest();
        uint256 supply = totalSupply();
        (uint256 h0, uint256 h1) = idle();
        (a, b) = position.remove(shares, supply);
        a += Math.mulDiv(h0, shares, supply);
        b += Math.mulDiv(h1, shares, supply);
        if (a < min0 || b < min1 || (a == 0 && b == 0)) revert Minimum();
        _burn(owner, shares);
        if (totalSupply() == 0) {
            restartRequired = true;
            entryOpen = false;
            ++epoch;
        }
        _send(token0, receiver, a);
        _send(token1, receiver, b);
        emit Exited(owner, receiver, shares, a, b);
    }

    function observe() external nonReentrant returns (bool) {
        if (msg.sender != keeper && msg.sender != guardian && msg.sender != admin) {
            revert Unauthorized();
        }
        if (recovery) revert Closed();
        _harvest();
        return _observe();
    }

    function _oracleValue() private view returns (uint256) {
        // Market integrity is independent of the chosen LP range: out-of-range positions can be observed.
        position.validateMarket();
        (uint256 a, uint256 b) = idle();
        (uint256 x, uint256 y) = position.balancesAtPrice(valuation.sqrtPriceX96());
        return valuation.value(a + x, b + y);
    }

    function _observe() private returns (bool) {
        uint256 s = totalSupply();
        if (s == 0) return stopped;
        uint256 v = _oracleValue();
        // Preserve price-per-share ratios without flooring raw V/S. Materiality is in total USDG units.
        if (referenceValue >= MIN_VALUE && referenceSupply != 0) {
            uint256 ratio = Math.mulDiv(v, referenceSupply, s);
            performanceIndex = Math.mulDiv(performanceIndex, ratio, referenceValue);
        }
        peakIndex = Math.max(peakIndex, performanceIndex);
        if (Math.mulDiv(peakIndex - performanceIndex, 10000, peakIndex) >= 1000) stopped = true;
        referenceValue = v;
        referenceSupply = s;
        emit LossObserved(performanceIndex, peakIndex, stopped);
        return stopped;
    }

    function reviewRestart() external onlyAdmin nonReentrant {
        if (recovery || totalSupply() != 0 || position.liquidity() != 0 || !restartRequired) {
            revert Invalid();
        }
        position.validate(lower, upper); // Validated source must refuse invalid price even for nonzero probe inputs.
        valuation.value(1e6, 1e6);
        restartRequired = false;
        referenceSupply = 0;
        referenceValue = 0;
        ++reviewNonce;
        ++epoch;
        emit Reviewed(reviewNonce, epoch, stopped);
        // Deliberately does not clear a preexisting latched stop or erase performance history.
    }

    function reviewEmptyLoss() external onlyAdmin nonReentrant {
        if (recovery || totalSupply() != 0 || position.liquidity() != 0 || !stopped) {
            revert Invalid();
        }
        position.validate(lower, upper);
        valuation.value(1e6, 1e6);
        stopped = false;
        performanceIndex = 1e18;
        peakIndex = 1e18;
        referenceValue = 0;
        referenceSupply = 0;
        ++reviewNonce;
        ++epoch;
        emit Reviewed(reviewNonce, epoch, stopped);
    }

    function reviewLoss() external onlyAdmin nonReentrant {
        if (recovery || totalSupply() == 0) revert Invalid();
        position.validate(lower, upper);
        _harvest();
        referenceValue = _oracleValue();
        referenceSupply = totalSupply();
        performanceIndex = 1e18;
        peakIndex = 1e18;
        stopped = false;
        ++reviewNonce;
        ++epoch;
        emit Reviewed(reviewNonce, epoch, stopped);
    }

    function rebalanceWithSwap(
        int24 lo,
        int24 hi,
        uint128 target,
        uint256 nonce,
        uint256 configuration,
        uint256 deadline,
        RebalanceSwap calldata swap
    ) external nonReentrant returns (RebalanceResult) {
        return _rebalance(lo, hi, target, nonce, configuration, deadline, swap);
    }

    function _rebalance(
        int24 lo,
        int24 hi,
        uint128 target,
        uint256 nonce,
        uint256 configuration,
        uint256 deadline,
        RebalanceSwap memory swap
    ) private returns (RebalanceResult) {
        if (msg.sender != keeper) revert Unauthorized();
        if (
            recovery || stopped || totalSupply() == 0 || nonce != executionNonce
                || configuration != epoch
        ) {
            revert Closed();
        }
        position.validateRebalance(lo, hi, swap.requestId, deadline);
        valuation.validatePool();
        _harvest(); // Persist newly observed stop without reverting it away.
        if (_observe()) {
            // A revert would erase the newly latched stop. Emit an explicit terminal outcome.
            emit RebalanceStopped(nonce, configuration, performanceIndex);
            return RebalanceResult.LossStopped;
        }
        position.remove(1, 1);
        (uint256 a, uint256 b) = idle();
        uint256 beforeValue = valuation.value(a, b);
        if (swap.amount != 0) {
            IERC20 input = swap.zeroForOne ? token0 : token1;
            if (swap.amount > (swap.zeroForOne ? a : b)) revert Minimum();
            input.forceApprove(router, swap.amount);
            IPaidRebalanceRouter(router)
                .rebalanceSwap(swap.zeroForOne, swap.amount, swap.minimumOut, swap.sqrtLimit);
            input.forceApprove(router, 0);
            (a, b) = idle();
            uint256 minimumValue =
                Math.mulDiv(beforeValue, 10000 - maxSwapLossBps, 10000, Math.Rounding.Ceil);
            uint256 afterValue = valuation.value(a, b);
            if (afterValue < minimumValue) revert Minimum();
        }
        (uint256 need0, uint256 need1) = position.required(target, lo, hi);
        if (target < minimumLiquidity || need0 > a || need1 > b) revert Minimum();
        _send(token0, address(position), need0);
        _send(token1, address(position), need1);
        (uint128 added, uint256 spent0, uint256 spent1) = position.add(target, lo, hi);
        if (added < target || spent0 > need0 || spent1 > need1) revert Receipt();
        (uint256 after0, uint256 after1) = inventory();
        if (after0 + 2 < a || after1 + 2 < b) revert Receipt();
        position.completeRebalance(swap.requestId);
        lower = lo;
        upper = hi;
        ++epoch;
        ++executionNonce;
        lastRebalance = block.timestamp;
        _observe();
        emit Rebalanced(nonce, lo, hi);
        return RebalanceResult.Executed;
    }

    function claimFees(uint8 i) external nonReentrant {
        // The fixed-size case array rejects invalid sides before any approval or external call.
        if (caseOpened[i]) revert Closed();
        IERC20 t = i == 0 ? token0 : token1;
        uint256 p = protocolFees[i];
        uint256 b = buybackFees[i];
        protocolFees[i] = 0;
        buybackFees[i] = 0;
        RecoveryEscrowFactory factory = recoveryFactory;
        t.forceApprove(address(factory), p + b);
        factory.payFees(t, p, b);
    }

    function claimOwnerless(uint8 i) external nonReentrant {
        if (i > 1 || caseOpened[i]) revert Invalid();
        uint256 n = quarantined[i];
        quarantined[i] = 0;
        _send(i == 0 ? token0 : token1, treasury, n);
    }

    function openRecovery(uint8 i) external nonReentrant {
        _openRecovery(i, false);
    }

    function openDualRecovery() external nonReentrant {
        _openRecovery(0, true);
    }

    function _openRecovery(uint8 i, bool both) private {
        if (msg.sender != guardian && msg.sender != admin) revert Unauthorized();
        if (i > 1 || totalSupply() == 0 || caseOpened[i]) revert Invalid();
        uint256[2] memory f;
        uint256[2] memory p;
        if (!recovery) {
            recovery = true;
            blocked = i;
            entryOpen = false;
            ++epoch;
            (f, p) = position.beginRecovery();
            _startCase(i, f[i], p[i]);
            if (both) {
                _startCase(1 - i, f[1 - i], p[1 - i]);
            } else {
                uint8 live = 1 - i;
                IERC20 t = live == 0 ? token0 : token1;
                uint256 beforeBalance = t.balanceOf(address(this));
                uint256 got = position.collectBlocked(live);
                if (t.balanceOf(address(this)) - beforeBalance != got || got != f[live] + p[live]) {
                    revert Receipt();
                }
                _fees(live, f[live]);
            }
        } else {
            // Liquidity was already removed; a later freeze snapshots only the remaining live owners.
            _startCase(i, 0, 0);
        }
    }

    function _startCase(uint8 i, uint256 f, uint256 p) private {
        IERC20 t = i == 0 ? token0 : token1;
        caseOpened[i] = true;
        caseSupply[i] = totalSupply();
        uint256 nominal = t.balanceOf(address(this)) + f + p;
        uint256 protocol = protocolFees[i] + f / 10 + quarantined[i];
        uint256 buy = buybackFees[i] + f / 5;
        grossFees[i] += f;
        protocolFees[i] = 0;
        buybackFees[i] = 0;
        quarantined[i] = 0;
        recoveryEscrow[i] =
            recoveryFactory.create(t, i, treasury, buyback, caseSupply[i], nominal, protocol, buy);
        emit RecoveryOpened(i, caseSupply[i], nominal);
    }

    function balanceAtCase(address owner, uint8 side) public view returns (uint256) {
        if (side > 1 || !caseOpened[side]) return 0;
        (bool exists,, uint256 val) = snapshots[side][owner].latestCheckpoint();
        return exists ? val : balanceOf(owner);
    }

    function redeemHealthy(uint256 shares, address receiver, uint256 minimum)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (
            !recovery || caseOpened[0] && caseOpened[1] || shares == 0
                || shares > balanceOf(msg.sender) || receiver == address(0)
        ) revert Invalid();
        uint8 i = caseOpened[0] ? 1 : 0;
        IERC20 live = i == 0 ? token0 : token1;
        uint256 available =
            live.balanceOf(address(this)) - protocolFees[i] - buybackFees[i] - quarantined[i];
        amount = Math.mulDiv(available, shares, totalSupply());
        if (amount < minimum) revert Minimum();
        _burn(msg.sender, shares);
        _send(live, receiver, amount);
    }

    function retireRecoveryShares(uint256 shares) external nonReentrant {
        if (!caseOpened[0] || !caseOpened[1]) revert Invalid();
        _burn(msg.sender, shares);
    }

    function collectRecovery(uint8 i) external nonReentrant {
        if (i > 1 || !caseOpened[i]) revert Invalid();
        IERC20 t = i == 0 ? token0 : token1;
        uint256 beforeBalance = t.balanceOf(address(this));
        uint256 got = position.collectBlocked(i);
        if (t.balanceOf(address(this)) - beforeBalance != got) revert Receipt();
        uint256 amount = t.balanceOf(address(this));
        if (amount == 0) return;
        t.forceApprove(address(recoveryEscrow[i]), amount);
        recoveryEscrow[i].fund(amount);
        t.forceApprove(address(recoveryEscrow[i]), 0);
    }

    function _update(address from, address to, uint256 amount) internal override {
        for (uint8 i; i < 2; ++i) {
            if (caseOpened[i]) {
                _snapshot(i, from);
                _snapshot(i, to);
            }
        }
        super._update(from, to, amount);
    }

    function _snapshot(uint8 i, address who) private {
        if (who == address(0)) return;
        (bool exists,,) = snapshots[i][who].latestCheckpoint();
        if (!exists) snapshots[i][who].push(1, balanceOf(who));
    }

    function _pull(IERC20 t, address from, uint256 n) private {
        if (n == 0) return;
        uint256 b = t.balanceOf(address(this));
        uint256 f = t.balanceOf(from);
        t.safeTransferFrom(from, address(this), n);
        if (t.balanceOf(address(this)) - b != n || f - t.balanceOf(from) != n) revert Receipt();
    }

    function _send(IERC20 t, address to, uint256 n) private {
        if (n == 0) return;
        uint256 b = t.balanceOf(to);
        uint256 own = t.balanceOf(address(this));
        t.safeTransfer(to, n);
        if (t.balanceOf(to) - b != n || own - t.balanceOf(address(this)) != n) revert Receipt();
    }
}
