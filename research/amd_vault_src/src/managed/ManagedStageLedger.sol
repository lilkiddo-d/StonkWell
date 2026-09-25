// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface IConfigurableLedgerVault {
    function VERSION() external view returns (uint256);
    function maxChunkLossBps() external view returns (uint16);
    function maxStageLossBps() external view returns (uint16);
}

interface ILedgerValuation {
    function value(uint256 a, uint256 b) external view returns (uint256);
}

interface ILedgerVault {
    function position() external view returns (address);
    function totalSupply() external view returns (uint256);
    function epoch() external view returns (uint256);
    function idle() external view returns (uint256, uint256);
    function valuation() external view returns (ILedgerValuation);
    function maxSwapLossBps() external view returns (uint16);
}

/// @notice Non-upgradeable economic ledger; custody migration retains this exact contract.
/// Only the vault's current position may charge it. Plan cancellation never forgives spent loss.
contract ManagedStageLedger {
    ILedgerVault public immutable vault;
    bool public immutable configurable;
    uint256 public basisPerShare;

    struct State {
        uint256 id;
        uint256 configuration;
        uint256 budgetPerShare;
        uint256 spentPerShare;
        uint64 startedAt;
        uint64 lastStepAt;
        uint256 steps;
        int24 lower;
        int24 upper;
        bool active;
    }
    State public stagedRebalance;
    uint256 public stageNonce;
    bool public unfinished;
    error Invalid();
    modifier onlyPosition() {
        if (msg.sender != vault.position()) revert Invalid();
        _;
    }

    constructor(address v) {
        vault = ILedgerVault(v);
        bool enabled;
        try IConfigurableLedgerVault(v).VERSION() returns (uint256 version) {
            enabled = version == 6 || version == 7;
        } catch { }
        configurable = enabled;
    }

    function chunkLimitBps() public view returns (uint256) {
        return configurable ? IConfigurableLedgerVault(address(vault)).maxChunkLossBps() : 50;
    }

    function stageLimitBps() public view returns (uint256) {
        return configurable
            ? IConfigurableLedgerVault(address(vault)).maxStageLossBps()
            : Math.min(150, vault.maxSwapLossBps());
    }

    /// @dev Called atomically by the vault setter. Lowering below spent loss is rejected.
    /// No timer, target, job id or loss charge is reset, even after cancellation.
    function refreshLimits() external {
        if (msg.sender != address(vault) || !configurable) revert Invalid();
        if (unfinished) {
            uint256 budget = Math.mulDiv(basisPerShare, stageLimitBps(), 10000);
            if (budget < stagedRebalance.spentPerShare) revert Invalid();
            stagedRebalance.budgetPerShare = budget;
        }
    }

    function state() external view returns (State memory) {
        return stagedRebalance;
    }

    function cancel() external onlyPosition {
        stagedRebalance.active = false;
    }

    function endEmpty() external onlyPosition {
        if (vault.totalSupply() != 0) revert Invalid();
        unfinished = false;
        stagedRebalance.active = false;
    }

    function record(
        int24 lo,
        int24 hi,
        uint256 beforeValue,
        uint256 afterValue,
        uint256 inputValue,
        bool finished,
        bool requested
    ) external onlyPosition returns (uint256) {
        uint256 supply = vault.totalSupply();
        if (supply == 0 || beforeValue < 1000) revert Invalid();
        State storage s = stagedRebalance;
        bool continuing = unfinished;
        if (continuing) {
            // An admin edit cannot declare an existing economic job complete.
            if (requested && finished) revert Invalid();
            // Chain-time spacing survives pause, cancellation, and custody handoff.
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp < uint256(s.lastStepAt) + 60) revert Invalid();
        } else {
            s.id = ++stageNonce;
            basisPerShare = Math.mulDiv(beforeValue, 1e18, supply);
            s.budgetPerShare = Math.mulDiv(basisPerShare, stageLimitBps(), 10000);
            s.spentPerShare = 0;
            s.startedAt = SafeCast.toUint64(block.timestamp);
            s.steps = 0;
        }
        if (finished) {
            (uint256 a, uint256 b) = vault.idle();
            if (vault.valuation().value(a, b) > Math.mulDiv(afterValue, 300, 10000)) {
                revert Invalid();
            }
        }
        uint256 loss = beforeValue > afterValue ? beforeValue - afterValue : 0;
        if (loss > Math.mulDiv(inputValue, chunkLimitBps(), 10000)) revert Invalid();
        s.spentPerShare += Math.mulDiv(loss, 1e18, supply, Math.Rounding.Ceil);
        if (s.spentPerShare > s.budgetPerShare) revert Invalid();
        // Keep the completion target across arbitrary admin edits, including edits
        // recorded as unfinished and followed by a separate completing transaction.
        if (!continuing || !requested) {
            s.lower = lo;
            s.upper = hi;
        }
        s.configuration = vault.epoch() + 1;
        s.lastStepAt = SafeCast.toUint64(block.timestamp);
        ++s.steps;
        s.active = !finished;
        unfinished = !finished;
        return s.id;
    }
}
