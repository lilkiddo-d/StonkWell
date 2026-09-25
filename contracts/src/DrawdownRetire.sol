// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title DrawdownRetire
/// @notice Spends protocol fees on $WELL and burns every $WELL it holds.
/// @dev There is deliberately no withdrawal or rescue path: assets leave only as burned $WELL.
///      Keeper runs are capped per input token and rate-limited, bounding what a bad quote can lose.
contract DrawdownRetire is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    ERC20Burnable public immutable wellToken;
    ISwapAdapter public immutable swapAdapter;

    uint32 public minInterval;
    uint64 public lastDrawdown;
    bool public halted;
    uint256 public totalRetired;
    mapping(address token => uint256) public maxInputPerRun;
    mapping(address token => uint256) public totalSpent;

    event Drawdown(address indexed tokenIn, uint256 amountIn, uint256 wellOut);
    event Retired(uint256 amount, uint256 totalRetired);
    event InputLimitSet(address indexed token, uint256 maxPerRun);
    event MinIntervalSet(uint32 minInterval);
    event HaltSet(bool halted);

    error InvalidConfig();
    error IsHalted();
    error OverLimit();
    error TooSoon();
    error SwapShortfall(uint256 received, uint256 minimum);

    constructor(
        ERC20Burnable wellToken_,
        ISwapAdapter swapAdapter_,
        address admin,
        address guardian,
        address keeper,
        uint32 minInterval_
    ) {
        if (
            address(wellToken_) == address(0) || address(swapAdapter_) == address(0)
                || admin == address(0) || guardian == address(0) || keeper == address(0)
        ) revert InvalidConfig();
        wellToken = wellToken_;
        swapAdapter = swapAdapter_;
        minInterval = minInterval_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        _grantRole(KEEPER_ROLE, keeper);
    }

    /// @notice Swaps `amountIn` of a fee token into $WELL and retires the proceeds.
    function drawdown(IERC20 tokenIn, uint256 amountIn, uint256 minWellOut, bytes calldata route)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (uint256 wellOut)
    {
        if (halted) revert IsHalted();
        if (
            address(tokenIn) == address(wellToken) || amountIn == 0 || minWellOut == 0
                || amountIn > maxInputPerRun[address(tokenIn)]
        ) revert OverLimit();
        if (block.timestamp < uint256(lastDrawdown) + minInterval) revert TooSoon();
        lastDrawdown = uint64(block.timestamp);

        uint256 before = wellToken.balanceOf(address(this));
        tokenIn.forceApprove(address(swapAdapter), amountIn);
        swapAdapter.swap(address(tokenIn), address(wellToken), amountIn, minWellOut, address(this), route);
        tokenIn.forceApprove(address(swapAdapter), 0);
        wellOut = wellToken.balanceOf(address(this)) - before;
        if (wellOut < minWellOut) revert SwapShortfall(wellOut, minWellOut);

        totalSpent[address(tokenIn)] += amountIn;
        emit Drawdown(address(tokenIn), amountIn, wellOut);
        _retire(wellToken.balanceOf(address(this)));
    }

    /// @notice Burns any $WELL sent here directly. Callable by anyone.
    function retireHeld() external nonReentrant {
        _retire(wellToken.balanceOf(address(this)));
    }

    function _retire(uint256 amount) private {
        if (amount == 0) return;
        wellToken.burn(amount);
        totalRetired += amount;
        emit Retired(amount, totalRetired);
    }

    function setInputLimit(address token, uint256 maxPerRun) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxInputPerRun[token] = maxPerRun;
        emit InputLimitSet(token, maxPerRun);
    }

    function setMinInterval(uint32 interval) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minInterval = interval;
        emit MinIntervalSet(interval);
    }

    function halt() external onlyRole(GUARDIAN_ROLE) {
        halted = true;
        emit HaltSet(true);
    }

    function resume() external onlyRole(DEFAULT_ADMIN_ROLE) {
        halted = false;
        emit HaltSet(false);
    }
}
