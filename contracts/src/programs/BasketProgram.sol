// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Well} from "../Well.sol";

/// @title BasketProgram
/// @notice One USDG deposit spread across several Wells. The keeper moves capital between listed
///         Wells as their Yield Rates change, within a per-Well allocation ceiling.
/// @dev Launches closed (`heldValueCap` 0). USDG exits are served from idle balance only;
///      `redeemInKind` always returns the holder's slice of every Well position instead.
contract BasketProgram is ERC4626, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    uint256 public constant MAX_WELLS = 8;
    uint256 private constant BPS = 10_000;

    Well[] private _wells;
    mapping(address => bool) public isListed;

    uint256 public heldValueCap;
    uint16 public maxAllocationBps = 4_000;

    event WellListed(address indexed well);
    event WellDelisted(address indexed well);
    event Allocated(address indexed well, uint256 assets, uint256 shares);
    event Deallocated(address indexed well, uint256 shares, uint256 assets);
    event RedeemedInKind(address indexed owner, address indexed receiver, uint256 shares, uint256 usdg);
    event HeldValueCapSet(uint256 cap);
    event MaxAllocationSet(uint16 bps);

    error InvalidConfig();
    error NotListed();
    error OverAllocated();
    error StillHeld();

    constructor(IERC20 usdg, address admin, address guardian, address keeper, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(usdg)
    {
        if (admin == address(0) || guardian == address(0) || keeper == address(0) || admin == guardian) {
            revert InvalidConfig();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        _grantRole(KEEPER_ROLE, keeper);
    }

    function wells() external view returns (Well[] memory) {
        return _wells;
    }

    function allPricesFresh() public view returns (bool) {
        for (uint256 i; i < _wells.length; ++i) {
            if (_wells[i].balanceOf(address(this)) != 0 && !_wells[i].priceFresh()) return false;
        }
        return true;
    }

    function totalAssets() public view override returns (uint256 total) {
        total = IERC20(asset()).balanceOf(address(this));
        for (uint256 i; i < _wells.length; ++i) {
            uint256 shares = _wells[i].balanceOf(address(this));
            if (shares != 0) total += _wells[i].convertToAssets(shares);
        }
    }

    function maxDeposit(address) public view override returns (uint256) {
        if (paused() || !allPricesFresh()) return 0;
        uint256 held = totalAssets();
        return heldValueCap > held ? heldValueCap - held : 0;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        return assets == 0 ? 0 : _convertToShares(assets, Math.Rounding.Floor);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (!allPricesFresh()) return 0;
        return Math.min(super.maxWithdraw(owner), IERC20(asset()).balanceOf(address(this)));
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (!allPricesFresh()) return 0;
        return Math.min(
            super.maxRedeem(owner),
            _convertToShares(IERC20(asset()).balanceOf(address(this)), Math.Rounding.Floor)
        );
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    /// @notice Burns Program shares for pro-rata idle USDG plus Well shares, with no price check.
    function redeemInKind(uint256 shares, address receiver, address owner)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        if (shares == 0) revert InvalidConfig();
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        uint256 supply = totalSupply();
        _burn(owner, shares);
        usdgOut = Math.mulDiv(IERC20(asset()).balanceOf(address(this)), shares, supply);
        if (usdgOut != 0) IERC20(asset()).safeTransfer(receiver, usdgOut);
        for (uint256 i; i < _wells.length; ++i) {
            uint256 part = Math.mulDiv(_wells[i].balanceOf(address(this)), shares, supply);
            if (part != 0) IERC20(address(_wells[i])).safeTransfer(receiver, part);
        }
        emit RedeemedInKind(owner, receiver, shares, usdgOut);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ---------------------------------------------------------------- keeper

    function allocate(Well well, uint256 assets) external onlyRole(KEEPER_ROLE) whenNotPaused nonReentrant {
        if (!isListed[address(well)]) revert NotListed();
        IERC20(asset()).forceApprove(address(well), assets);
        uint256 shares = well.deposit(assets, address(this));
        uint256 inWell = well.convertToAssets(well.balanceOf(address(this)));
        if (inWell * BPS > totalAssets() * maxAllocationBps) revert OverAllocated();
        emit Allocated(address(well), assets, shares);
    }

    function deallocate(Well well, uint256 shares) external onlyRole(KEEPER_ROLE) nonReentrant {
        if (!isListed[address(well)]) revert NotListed();
        uint256 assets = well.redeem(shares, address(this), address(this));
        emit Deallocated(address(well), shares, assets);
    }

    // ---------------------------------------------------------------- governance

    function listWell(Well well) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (isListed[address(well)] || _wells.length >= MAX_WELLS || well.asset() != asset()) revert InvalidConfig();
        isListed[address(well)] = true;
        _wells.push(well);
        emit WellListed(address(well));
    }

    function delistWell(Well well) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!isListed[address(well)]) revert NotListed();
        if (well.balanceOf(address(this)) != 0) revert StillHeld();
        isListed[address(well)] = false;
        for (uint256 i; i < _wells.length; ++i) {
            if (_wells[i] == well) {
                _wells[i] = _wells[_wells.length - 1];
                _wells.pop();
                break;
            }
        }
        emit WellDelisted(address(well));
    }

    function setHeldValueCap(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        heldValueCap = cap;
        emit HeldValueCapSet(cap);
    }

    function lowerHeldValueCap(uint256 cap) external onlyRole(GUARDIAN_ROLE) {
        if (cap > heldValueCap) revert InvalidConfig();
        heldValueCap = cap;
        emit HeldValueCapSet(cap);
    }

    function setMaxAllocationBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps == 0 || bps > BPS) revert InvalidConfig();
        maxAllocationBps = bps;
        emit MaxAllocationSet(bps);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
