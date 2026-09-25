// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRecoverySnapshot {
    function recoveryFactory() external view returns (RecoveryEscrowFactory);
    function balanceAtCase(address owner, uint8 side) external view returns (uint256);
}

/// @notice One immutable token/case. Unpaid units share actual backing, including issuer losses.
/// New receipts are distributed to the original snapshot; already-paid claims are never clawed back.
contract RecoveryLedger is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant SCALE = 1e27;
    IERC20 public immutable token;
    address public immutable vault;
    address public immutable fundingAuthority;
    address public immutable root;
    // Original deployment recipients; fee payouts follow the vault's current factory feeRecipients(vault).
    address public immutable treasury;
    address public immutable buyback;
    uint8 public immutable side;
    uint256 public immutable snapshotSupply;
    uint256 public immutable nominal;
    uint256 public immutable protocolNominal;
    uint256 public immutable buybackNominal;
    uint256 public epoch = 1;
    uint256 public totalUnits;
    uint256 public holderIndex;
    uint256 public protocolUnits;
    uint256 public buybackUnits;
    mapping(address => uint256) public claimEpoch;
    mapping(address => uint256) public claimedUnits;
    error Invalid();
    event Funded(uint256 assets, uint256 units, uint256 epoch);
    event Paid(address indexed owner, address indexed receiver, uint256 assets, uint256 units);
    event ZeroBacking(uint256 indexed epoch);

    constructor(
        IERC20 t,
        uint8 i,
        address treasury_,
        address buyback_,
        uint256 supply,
        uint256 n,
        uint256 p,
        uint256 b,
        address vault_,
        address funder_,
        address root_
    ) {
        if (
            address(t).code.length == 0 || i > 1 || treasury_ == address(0)
                || buyback_ == address(0) || supply == 0 || p + b > n
        ) revert Invalid();
        token = t;
        if (vault_ == address(0) || funder_ == address(0)) revert Invalid();
        vault = vault_;
        fundingAuthority = funder_;
        root = root_ == address(0) ? address(this) : root_;
        side = i;
        treasury = treasury_;
        buyback = buyback_;
        snapshotSupply = supply;
        nominal = n;
        protocolNominal = p;
        buybackNominal = b;
    }

    function _allocate(uint256 units) private {
        uint256 p = nominal == 0 ? 0 : Math.mulDiv(units, protocolNominal, nominal);
        uint256 b = nominal == 0 ? 0 : Math.mulDiv(units, buybackNominal, nominal);
        protocolUnits += p;
        buybackUnits += b;
        totalUnits += units;
        holderIndex += Math.mulDiv(units - p - b, SCALE, snapshotSupply);
    }

    function _sync() private returns (uint256 balance) {
        balance = token.balanceOf(address(this));
        if (balance == 0 && totalUnits != 0) {
            // Old units have zero value. Future recoveries still belong to the original snapshot.
            totalUnits = 0;
            holderIndex = 0;
            protocolUnits = 0;
            buybackUnits = 0;
            ++epoch;
            emit ZeroBacking(epoch);
        } else if (balance != 0 && totalUnits == 0) {
            // Donations with no outstanding units also belong to this case, never the next funder.
            _allocate(balance * 1e18);
        }
    }

    function fund(uint256 amount) external virtual nonReentrant {
        if (msg.sender != fundingAuthority) revert Invalid();
        _fund(fundingAuthority, amount);
    }

    function _fund(address source, uint256 amount) internal {
        if (amount == 0) revert Invalid();
        uint256 beforeBalance = _sync();
        uint256 units =
            totalUnits == 0 ? amount * 1e18 : Math.mulDiv(amount, totalUnits, beforeBalance);
        if (units == 0) revert Invalid();
        token.safeTransferFrom(source, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert Invalid();
        _allocate(units);
        emit Funded(amount, units, epoch);
    }

    function claimable(address owner) external view returns (uint256) {
        if (totalUnits == 0) return 0;
        uint256 earned =
            Math.mulDiv(IRecoverySnapshot(vault).balanceAtCase(owner, side), holderIndex, SCALE);
        uint256 paid = claimEpoch[owner] == epoch ? claimedUnits[owner] : 0;
        return Math.mulDiv(earned - paid, token.balanceOf(address(this)), totalUnits);
    }

    function claim(address receiver, uint256 minimum)
        external
        nonReentrant
        returns (uint256 amount)
    {
        if (receiver == address(0) || receiver == address(this)) {
            revert Invalid();
        }
        uint256 balance = _sync();
        uint256 earned = Math.mulDiv(
            IRecoverySnapshot(vault).balanceAtCase(msg.sender, side), holderIndex, SCALE
        );
        uint256 paid = claimEpoch[msg.sender] == epoch ? claimedUnits[msg.sender] : 0;
        uint256 units = earned - paid;
        amount = totalUnits == 0 ? 0 : Math.mulDiv(units, balance, totalUnits);
        if (amount < minimum) revert Invalid();
        if (amount == 0) return 0;
        claimedUnits[msg.sender] = earned;
        claimEpoch[msg.sender] = epoch;
        _pay(receiver, amount, units);
        emit Paid(msg.sender, receiver, amount, units);
    }

    function claimFees(bool forBuyback) external nonReentrant returns (uint256 amount) {
        uint256 balance = _sync();
        uint256 units = forBuyback ? buybackUnits : protocolUnits;
        amount = totalUnits == 0 ? 0 : Math.mulDiv(units, balance, totalUnits);
        if (amount == 0) return 0;
        if (forBuyback) buybackUnits = 0;
        else protocolUnits = 0;
        (address operations, address reserve) =
            IRecoverySnapshot(vault).recoveryFactory().feeRecipients(vault);
        address receiver = forBuyback ? reserve : operations;
        if (receiver == address(0) || receiver == address(this) || receiver == vault) {
            revert Invalid();
        }
        _pay(receiver, amount, units);
        emit Paid(receiver, receiver, amount, units);
    }

    function _pay(address to, uint256 amount, uint256 units) private {
        totalUnits -= units;
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 beforeRecipient = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (
            beforeBalance - token.balanceOf(address(this)) != amount
                || token.balanceOf(to) - beforeRecipient != amount
        ) revert Invalid();
    }
}

/// @notice Stable recovery entry point. Failed funding rolls forward, never erasing old claim units.
/// Each segment is independently claimable; enumeration is bounded by the caller's chosen page.
contract RecoveryEscrow is RecoveryLedger {
    using SafeERC20 for IERC20;
    RecoveryLedger[] private laterSegments;
    mapping(address => bool) public isLaterSegment;
    event SegmentOpened(uint256 indexed index, address indexed segment, bytes32 failureHash);

    constructor(
        IERC20 t,
        uint8 i,
        address treasury_,
        address buyback_,
        uint256 supply,
        uint256 n,
        uint256 p,
        uint256 b,
        address vault_
    ) RecoveryLedger(t, i, treasury_, buyback_, supply, n, p, b, vault_, vault_, address(0)) { }

    function segmentCount() external view returns (uint256) {
        return laterSegments.length + 1;
    }

    function segmentAt(uint256 index) external view returns (address) {
        return index == 0 ? address(this) : address(laterSegments[index - 1]);
    }

    struct Payment {
        address escrow;
        uint256 amount;
        bool available;
    }

    /// @notice Five payments at most, with independent failures and no full-history scan.
    function claimPage(address owner, uint256 offset)
        external
        view
        returns (uint256 total, Payment[] memory rows)
    {
        total = laterSegments.length + 1;
        if (offset >= total) revert Invalid();
        uint256 size = total - offset;
        if (size > 5) size = 5;
        rows = new Payment[](size);
        for (uint256 i; i < size; ++i) {
            uint256 index = offset + i;
            address escrow = index == 0 ? address(this) : address(laterSegments[index - 1]);
            rows[i].escrow = escrow;
            try RecoveryLedger(escrow).claimable(owner) returns (uint256 amount) {
                rows[i].amount = amount;
                rows[i].available = true;
            } catch { }
        }
    }

    /// @dev Only the outer, locked fund() call can attempt accounting in the original segment.
    /// An inner failure rolls back accounting and token transfers before starting another segment.
    function fundInitial(uint256 amount) external {
        if (msg.sender != address(this) || !_reentrancyGuardEntered()) revert Invalid();
        _fund(vault, amount);
    }

    function _next(bytes memory failure) private returns (RecoveryLedger segment) {
        segment = new RecoveryLedger(
            token,
            side,
            treasury,
            buyback,
            snapshotSupply,
            nominal,
            protocolNominal,
            buybackNominal,
            vault,
            address(this),
            address(this)
        );
        laterSegments.push(segment);
        isLaterSegment[address(segment)] = true;
        emit SegmentOpened(laterSegments.length, address(segment), keccak256(failure));
    }

    function fund(uint256 amount) external override nonReentrant {
        if (msg.sender != vault || amount == 0) revert Invalid();
        RecoveryLedger current;
        if (laterSegments.length == 0) {
            try this.fundInitial(amount) {
                return;
            } catch (bytes memory failure) {
                current = _next(failure);
            }
        } else {
            current = laterSegments[laterSegments.length - 1];
        }
        // Old backing stays here; only this funding call's measured receipt may move to a leaf.
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(vault, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert Invalid();
        token.forceApprove(address(current), amount);
        try current.fund(amount) { }
        catch (bytes memory failure) {
            token.forceApprove(address(current), 0);
            current = _next(failure);
            token.forceApprove(address(current), amount);
            current.fund(amount); // Failure reverts the entire rollover, including creation and pull.
        }
        token.forceApprove(address(current), 0);
        if (token.balanceOf(address(this)) != beforeBalance) revert Invalid();
    }
}

interface IRecoveryFeeConfiguration {
    function recoveryFactory() external view returns (address);
    function admin() external view returns (address);
    function keeper() external view returns (address);
    function treasury() external view returns (address);
    function buyback() external view returns (address);
    function position() external view returns (address);
    function router() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function recoveryEscrow(uint256) external view returns (address);
    function valuation() external view returns (address);
}

/// @notice Shared deployment code and per-vault fee destinations. Only each vault's admin may update.
contract RecoveryEscrowFactory {
    using SafeERC20 for IERC20;

    struct Recipients {
        address operations;
        address reserve;
    }
    mapping(address => Recipients) private recipients;
    error InvalidRecipients();
    error Unauthorized();
    event FeeRecipientsChanged(
        address indexed vault,
        address oldOperations,
        address oldReserve,
        address newOperations,
        address newReserve
    );

    /// @notice Changes unclaimed and future fee destinations, never fee rates or holder claims.
    /// Zero storage means the vault's original constructor recipients, not an unassigned recipient.
    function feeRecipients(address vault)
        public
        view
        returns (address operations, address reserve)
    {
        Recipients memory r = recipients[vault];
        if (r.operations != address(0)) return (r.operations, r.reserve);
        IRecoveryFeeConfiguration v = IRecoveryFeeConfiguration(vault);
        return (v.treasury(), v.buyback());
    }

    /// @notice Compact caller-scoped lookup used by the vault at payout time.
    function payoutRecipients() external view returns (address operations, address reserve) {
        return feeRecipients(msg.sender);
    }

    /// @notice Uses only the caller's exact temporary allowance. Cannot pull from a foreign vault.
    function payFees(IERC20 token, uint256 operationsAmount, uint256 reserveAmount) external {
        (address operations, address reserve) = feeRecipients(msg.sender);
        _pay(token, msg.sender, operations, operationsAmount);
        _pay(token, msg.sender, reserve, reserveAmount);
        if (token.allowance(msg.sender, address(this)) != 0) revert InvalidRecipients();
    }

    function _pay(IERC20 token, address from, address to, uint256 amount) private {
        if (amount == 0) return;
        uint256 beforeFrom = token.balanceOf(from);
        uint256 beforeTo = token.balanceOf(to);
        token.safeTransferFrom(from, to, amount);
        if (
            beforeFrom - token.balanceOf(from) != amount || token.balanceOf(to) - beforeTo != amount
        ) {
            revert InvalidRecipients();
        }
    }

    function setFeeRecipients(address vault, address operations, address reserve) external {
        IRecoveryFeeConfiguration v = IRecoveryFeeConfiguration(vault);
        if (msg.sender != v.admin()) revert Unauthorized();
        if (v.recoveryFactory() != address(this)) revert InvalidRecipients();
        address[10] memory forbidden = [
            address(0),
            address(this),
            vault,
            v.keeper(),
            v.position(),
            v.router(),
            v.token0(),
            v.token1(),
            v.recoveryEscrow(0),
            v.valuation()
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            if (operations == forbidden[i] || reserve == forbidden[i]) revert InvalidRecipients();
        }
        address escrow1 = v.recoveryEscrow(1);
        if (operations == escrow1 || reserve == escrow1) revert InvalidRecipients();
        address escrow0 = forbidden[8];
        if (_isLater(escrow0, operations, reserve) || _isLater(escrow1, operations, reserve)) {
            revert InvalidRecipients();
        }
        (address oldOperations, address oldReserve) = feeRecipients(vault);
        recipients[vault] = Recipients(operations, reserve);
        emit FeeRecipientsChanged(vault, oldOperations, oldReserve, operations, reserve);
    }

    function _isLater(address root_, address operations, address reserve)
        private
        view
        returns (bool)
    {
        if (root_ == address(0)) return false;
        RecoveryEscrow rootEscrow = RecoveryEscrow(root_);
        return rootEscrow.isLaterSegment(operations) || rootEscrow.isLaterSegment(reserve);
    }

    function create(
        IERC20 t,
        uint8 i,
        address treasury,
        address buyback,
        uint256 supply,
        uint256 nominal,
        uint256 p,
        uint256 b
    ) external returns (RecoveryEscrow) {
        return new RecoveryEscrow(t, i, treasury, buyback, supply, nominal, p, b, msg.sender);
    }
}
