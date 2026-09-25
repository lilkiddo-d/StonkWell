// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/// @notice Pool observation only. No unused asset decimals or price orientation.
contract V3Observation {
    error InsufficientLiquidity();

    function consult(IUniswapV3Pool pool, uint32 twapSeconds)
        external
        view
        returns (int24 arithmeticMeanTick, uint128 harmonicLiquidity)
    {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapSeconds;
        (int56[] memory ticks, uint160[] memory secondsPerLiquidity) = pool.observe(secondsAgos);
        int56 tickDelta = ticks[1] - ticks[0];
        // A mean of valid Uniswap ticks remains within the int24 tick domain.
        // forge-lint: disable-next-line(unsafe-typecast)
        arithmeticMeanTick = int24(tickDelta / int56(uint56(twapSeconds)));
        if (tickDelta < 0 && tickDelta % int56(uint56(twapSeconds)) != 0) --arithmeticMeanTick;
        uint160 liquidityDelta = secondsPerLiquidity[1] - secondsPerLiquidity[0];
        if (liquidityDelta == 0) revert InsufficientLiquidity();
        uint192 secondsAgoX160 = uint192(twapSeconds) * type(uint160).max;
        // This is Uniswap OracleLibrary's bounded harmonic-liquidity formula.
        // forge-lint: disable-next-line(unsafe-typecast)
        harmonicLiquidity = uint128(secondsAgoX160 / (uint192(liquidityDelta) << 32));
    }
}
