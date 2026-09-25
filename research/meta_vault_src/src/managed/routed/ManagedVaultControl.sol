// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IPaidPosition } from "../ManagedV3Position.sol";
import { IPaidValuation } from "../ManagedVault.sol";

interface IControlVault {
    function admin() external view returns (address);
    function guardian() external view returns (address);
    function token0() external view returns (IERC20);
    function token1() external view returns (IERC20);
    function totalSupply() external view returns (uint256);
    function minimumLiquidity() external view returns (uint128);
    function lower() external view returns (int24);
    function upper() external view returns (int24);
    function idle() external view returns (uint256, uint256);
    function position() external view returns (IPaidPosition);
    function router() external view returns (address);
    function valuation() external view returns (IPaidValuation);
    function recovery() external view returns (bool);
    function maxSwapLossBps() external view returns (uint16);
    function migrateComponents(IPaidPosition position, address router) external;
}

interface IControlPosition {
    function pool() external view returns (address);
    function manager() external view returns (address);
    function tokenId() external view returns (uint256);
    function recovering() external view returns (bool);
    function stageNonce() external view returns (uint256);
    function stageLedger() external view returns (address);
    function rangeRequestNonce() external view returns (uint256);
    function liquidityFloor() external view returns (uint128);
    function maximumTickDeviation() external view returns (uint24);
}

interface IControlRouter {
    function vault() external view returns (address);
    function pool() external view returns (address);
    function asset() external view returns (address);
    function kyberProvider() external view returns (address);
}

interface IControlProvider {
    function authorizedCaller() external view returns (address);
    function aggregator() external view returns (address);
    function aggregationExecutor() external view returns (address);
}

interface IControlOracle {
    function asset() external view returns (address);
    function validatePosition(address position) external view;
}

interface IControlVenue {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function consumer() external view returns (address);
    function router() external view returns (address);
    function poolManager() external view returns (address);
    function referencePool() external view returns (address);
}

interface IKeeperControlVault {
    function keeper() external view returns (address);
    function epoch() external view returns (uint256);
    function executionNonce() external view returns (uint256);
    function applyKeeper(address next) external;
}

/// @notice Immutable companion to a share vault. No delegatecall, custody, allowances or arbitrary calls.
/// Read-only accounting helpers reduce the vault's runtime. Typed custody and keeper changes
/// require guardian approval after 24 hours. Admin or guardian can immediately pause keepers.
contract ManagedVaultControl is ReentrancyGuard {
    IControlVault public immutable vault;
    uint256 public constant REVIEW_DELAY = 24 hours;
    uint256 public proposalNonce;
    bool public executing;

    struct Proposal {
        bytes32 digest;
        uint64 proposedAt;
        address sourcePosition;
        address sourceRouter;
        address destinationPosition;
        address destinationRouter;
        bool approved;
    }
    Proposal public proposal;
    error Invalid();
    error Unauthorized();
    error Minimum();
    error Receipt();
    event MigrationProposed(
        uint256 indexed id,
        bytes32 indexed digest,
        address position,
        address router,
        uint64 proposedAt
    );
    event MigrationApproved(bytes32 indexed digest);
    event MigrationCancelled(bytes32 indexed digest);
    event MigrationExecuted(bytes32 indexed digest);

    constructor() {
        vault = IControlVault(msg.sender);
    }

    bool public keeperPaused;
    uint256 public keeperProposalNonce;

    struct KeeperProposal {
        bytes32 digest;
        uint64 proposedAt;
        address currentKeeper;
        address nextKeeper;
        address admin;
        address guardian;
        uint256 epoch;
        uint256 executionNonce;
        bool resume;
        bool approved;
    }
    KeeperProposal public keeperProposal;
    event KeeperPaused(uint256 indexed nonce, address indexed keeper);
    event KeeperChangeProposed(
        bytes32 indexed digest, address indexed nextKeeper, bool resume, uint64 proposedAt
    );
    event KeeperChangeApproved(bytes32 indexed digest);
    event KeeperChangeCancelled(bytes32 indexed digest);
    event KeeperChangeExecuted(bytes32 indexed digest, address indexed keeper, bool paused);

    function _keeperVault() private view returns (IKeeperControlVault) {
        return IKeeperControlVault(address(vault));
    }

    /// @notice Immediate containment. Repeated pauses also veto outstanding approvals.
    function pauseKeeper() external nonReentrant {
        if (msg.sender != vault.guardian() && msg.sender != vault.admin()) revert Unauthorized();
        if (vault.recovery()) revert Invalid();
        keeperPaused = true;
        delete keeperProposal;
        ++keeperProposalNonce;
        address current = _keeperVault().keeper();
        _keeperVault().applyKeeper(current);
        emit KeeperPaused(keeperProposalNonce, current);
    }

    /// @notice Rotation and resume are distinct exact operations, each reviewed for 24 hours.
    function proposeKeeperChange(address next, bool resume)
        external
        nonReentrant
        returns (bytes32 digest)
    {
        address admin = vault.admin();
        address guardian = vault.guardian();
        if (msg.sender != admin || admin == guardian) revert Unauthorized();
        IKeeperControlVault v = _keeperVault();
        address current = v.keeper();
        if (
            !keeperPaused || vault.recovery() || next == address(0) || next == admin
                || next == guardian || (resume ? next != current : next == current)
        ) revert Invalid();
        uint256 epoch = v.epoch();
        uint256 nonce = v.executionNonce();
        digest = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                address(vault),
                ++keeperProposalNonce,
                admin,
                guardian,
                current,
                next,
                epoch,
                nonce,
                resume
            )
        );
        keeperProposal = KeeperProposal(
            digest,
            SafeCast.toUint64(block.timestamp),
            current,
            next,
            admin,
            guardian,
            epoch,
            nonce,
            resume,
            false
        );
        emit KeeperChangeProposed(digest, next, resume, keeperProposal.proposedAt);
    }

    function _checkKeeperChange(bytes32 digest) private view {
        KeeperProposal memory p = keeperProposal;
        IKeeperControlVault v = _keeperVault();
        if (
            digest == bytes32(0) || p.digest != digest || !keeperPaused || vault.recovery()
                || p.admin != vault.admin() || p.guardian != vault.guardian()
                || p.admin == p.guardian || p.currentKeeper != v.keeper() || p.epoch != v.epoch()
                || p.executionNonce != v.executionNonce()
        ) revert Invalid();
        if (
            digest
                != keccak256(
                    abi.encode(
                        block.chainid,
                        address(this),
                        address(vault),
                        keeperProposalNonce,
                        p.admin,
                        p.guardian,
                        p.currentKeeper,
                        p.nextKeeper,
                        p.epoch,
                        p.executionNonce,
                        p.resume
                    )
                )
        ) revert Invalid();
    }

    function approveKeeperChange(bytes32 digest) external nonReentrant {
        if (msg.sender != vault.guardian() || msg.sender == vault.admin()) revert Unauthorized();
        _checkKeeperChange(digest);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(keeperProposal.proposedAt) + REVIEW_DELAY) revert Invalid();
        keeperProposal.approved = true;
        emit KeeperChangeApproved(digest);
    }

    function cancelKeeperChange(bytes32 digest) external nonReentrant {
        if (msg.sender != vault.admin() && msg.sender != vault.guardian()) revert Unauthorized();
        if (digest == bytes32(0) || keeperProposal.digest != digest) revert Invalid();
        delete keeperProposal;
        ++keeperProposalNonce;
        emit KeeperChangeCancelled(digest);
    }

    function executeKeeperChange(bytes32 digest) external nonReentrant {
        _checkKeeperChange(digest);
        KeeperProposal memory p = keeperProposal;
        if (!p.approved) revert Invalid();
        delete keeperProposal;
        ++keeperProposalNonce;
        _keeperVault().applyKeeper(p.nextKeeper);
        if (p.resume) keeperPaused = false;
        emit KeeperChangeExecuted(digest, p.nextKeeper, keeperPaused);
    }

    /// @dev Retains the original ceiling rounding and pre-harvest fee treatment.
    function quote(uint256 s, uint128 firstL)
        external
        view
        returns (uint128 target, uint256 amount0, uint256 amount1, uint256 idle0, uint256 idle1)
    {
        uint256 supply = vault.totalSupply();
        IPaidPosition p = vault.position();
        if (supply == 0) {
            target = firstL;
            if (target < vault.minimumLiquidity()) revert Minimum();
        } else {
            uint128 l = p.liquidity();
            if (l == 0 || s == 0) revert Invalid();
            target = SafeCast.toUint128(Math.mulDiv(l, s, supply, Math.Rounding.Ceil));
            (uint256 a, uint256 b) = vault.idle();
            (uint256 loose0, uint256 loose1) = p.loose();
            (uint256 fee0, uint256 fee1) = p.pendingFees();
            idle0 = Math.mulDiv(
                a + loose0 + fee0 - fee0 / 10 - fee0 / 5, s, supply, Math.Rounding.Ceil
            );
            idle1 = Math.mulDiv(
                b + loose1 + fee1 - fee1 / 10 - fee1 / 5, s, supply, Math.Rounding.Ceil
            );
        }
        (amount0, amount1) = p.required(target, vault.lower(), vault.upper());
        amount0 += idle0;
        amount1 += idle1;
    }

    function oracleValue() external view returns (uint256) {
        IPaidPosition p = vault.position();
        p.validateMarket();
        (uint256 a, uint256 b) = vault.idle();
        IPaidValuation val = vault.valuation();
        (uint256 x, uint256 y) = p.balancesAtPrice(val.sqrtPriceX96());
        return val.value(a + x, b + y);
    }

    function checkUnwind(uint256 before0, uint256 before1, uint256 a, uint256 b) external view {
        IPaidPosition p = vault.position();
        (uint256 x, uint256 y) = p.balances();
        if (
            vault.token0().balanceOf(address(vault)) != before0 + a
                || vault.token1().balanceOf(address(vault)) != before1 + b || p.liquidity() != 0
                || x != 0 || y != 0
        ) revert Receipt();
    }

    function swapValues(bool zero, uint256 amount)
        external
        view
        returns (uint256 beforeValue, uint256 inputValue)
    {
        (uint256 a, uint256 b) = vault.idle();
        if (amount > (zero ? a : b)) revert Minimum();
        IPaidValuation val = vault.valuation();
        beforeValue = val.value(a, b);
        inputValue = val.value(zero ? amount : 0, zero ? 0 : amount);
    }

    function checkSwapValue(uint256 beforeValue) external view returns (uint256 afterValue) {
        (uint256 a, uint256 b) = vault.idle();
        afterValue = vault.valuation().value(a, b);
        if (
            afterValue
                < Math.mulDiv(
                    beforeValue, 10000 - vault.maxSwapLossBps(), 10000, Math.Rounding.Ceil
                )
        ) revert Minimum();
    }

    function validatePool() external view {
        // Original immutable feed, decimals, deviation and token pair; only custody venue changes.
        IControlOracle(address(vault.valuation())).validatePosition(address(vault.position()));
    }

    /// @notice The guardian must review these runtime hashes, including immutable configuration.
    /// A future component is trusted only by this explicit dual authorization, never by a proxy upgrade.
    function destinationIdentity(address p, address r) public view returns (bytes32) {
        IPaidPosition position = IPaidPosition(p);
        IControlPosition details = IControlPosition(p);
        IControlRouter router = IControlRouter(r);
        address pool = details.pool();
        address manager = details.manager();
        address provider = router.kyberProvider();
        IControlProvider kyber = IControlProvider(provider);
        if (
            p == r || p == address(vault.position()) || r == vault.router()
                || position.vault() != address(vault) || router.vault() != address(vault)
                || position.token0() != vault.token0() || position.token1() != vault.token1()
                || router.pool() != pool
                || router.asset() != IControlOracle(address(vault.valuation())).asset()
                || kyber.authorizedCaller() != r
                || IControlVenue(pool).token0() != address(vault.token0())
                || IControlVenue(pool).token1() != address(vault.token1())
                || details.liquidityFloor()
                    < IControlPosition(address(vault.position())).liquidityFloor()
                || details.maximumTickDeviation()
                    > IControlPosition(address(vault.position())).maximumTickDeviation()
        ) revert Invalid();
        bytes32 venueIdentity;
        if (pool == manager) {
            IControlVenue venue = IControlVenue(pool);
            if (venue.consumer() != p || venue.router() != r) revert Invalid();
            venueIdentity =
                keccak256(abi.encode(_pin(venue.poolManager()), _pin(venue.referencePool())));
        }
        return keccak256(
            abi.encode(
                _pin(p),
                _pin(r),
                _pin(pool),
                _pin(manager),
                _pin(provider),
                _pin(kyber.aggregator()),
                _pin(kyber.aggregationExecutor()),
                venueIdentity
            )
        );
    }

    function _pin(address a) private view returns (bytes32) {
        if (a.code.length == 0) revert Invalid();
        return keccak256(abi.encode(a, a.codehash));
    }

    function _digest(address p, address r, uint256 nonce) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                address(vault),
                nonce,
                address(vault.position()),
                vault.router(),
                destinationIdentity(p, r)
            )
        );
    }

    function propose(address p, address r, uint256 expectedNonce, address expectedSource)
        external
        nonReentrant
    {
        if (msg.sender != vault.admin() || vault.admin() == vault.guardian()) {
            revert Unauthorized();
        }
        if (
            vault.recovery() || expectedNonce != proposalNonce
                || expectedSource != address(vault.position())
        ) revert Invalid();
        bytes32 digest = _digest(p, r, ++proposalNonce);
        proposal = Proposal(
            digest,
            SafeCast.toUint64(block.timestamp),
            address(vault.position()),
            vault.router(),
            p,
            r,
            false
        );
        emit MigrationProposed(proposalNonce, digest, p, r, proposal.proposedAt);
    }

    function cancel(bytes32 digest) external nonReentrant {
        if (msg.sender != vault.admin() && msg.sender != vault.guardian()) revert Unauthorized();
        if (digest == bytes32(0) || proposal.digest != digest) revert Invalid();
        delete proposal;
        ++proposalNonce;
        emit MigrationCancelled(digest);
    }

    function approve(bytes32 digest) external nonReentrant {
        if (msg.sender != vault.guardian() || msg.sender == vault.admin()) revert Unauthorized();
        _check(digest);
        // The wait is on the on-chain proposal, not the time a UI prepared a signature.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(proposal.proposedAt) + REVIEW_DELAY) revert Invalid();
        proposal.approved = true;
        emit MigrationApproved(digest);
    }

    function _check(bytes32 digest) private view {
        Proposal memory q = proposal;
        if (
            digest == bytes32(0) || q.digest != digest || vault.recovery()
                || q.sourcePosition != address(vault.position()) || q.sourceRouter != vault.router()
                || _digest(q.destinationPosition, q.destinationRouter, proposalNonce) != digest
        ) revert Invalid();
    }

    function execute(bytes32 digest) external nonReentrant {
        // Permissionless relay only after both exact authorizations; no caller-chosen recipient or action.
        _check(digest);
        Proposal memory q = proposal;
        IControlPosition p = IControlPosition(q.destinationPosition);
        if (
            !q.approved || p.tokenId() != 0 || p.recovering() || p.stageNonce() != 0
                || p.rangeRequestNonce() != 0
        ) revert Invalid();
        executing = true;
        vault.migrateComponents(IPaidPosition(q.destinationPosition), q.destinationRouter);
        // Every future destination must retain the original ledger address as well.
        if (p.stageLedger() != IControlPosition(q.sourcePosition).stageLedger()) revert Invalid();
        executing = false;
        delete proposal;
        emit MigrationExecuted(digest);
    }
}
