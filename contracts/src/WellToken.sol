// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title WellToken ($WELL)
/// @notice Fixed-supply token. Supply only ever shrinks, through DrawdownRetire or voluntary burns.
contract WellToken is ERC20, ERC20Burnable {
    constructor(address recipient, uint256 supply) ERC20("Stonkwell", "WELL") {
        _mint(recipient, supply);
    }
}
