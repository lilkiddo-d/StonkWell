"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, parseAbiItem, type Address } from "viem";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { wellAbi, wellOracleAbi } from "@/generated/abis";

const ONE_SHARE = 10n ** 12n;
const YIELD_WINDOW_BLOCKS = 200_000n;
const YEAR = 365 * 24 * 3600;
// Annualizing fees from a few minutes of history gives absurd rates (a young chain or fresh deployment).
const MIN_YIELD_SECONDS = 3600;

export function useWellStats(well: Address | undefined) {
  const w = { address: well, abi: wellAbi } as const;
  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(well) },
    contracts: [
      { ...w, functionName: "totalAssets" },
      { ...w, functionName: "heldValueCap" },
      { ...w, functionName: "priceFresh" },
      { ...w, functionName: "paused" },
      { ...w, functionName: "totalSupply" },
      { ...w, functionName: "convertToAssets", args: [ONE_SHARE] },
      { ...w, functionName: "protocolShareBps" },
      { ...w, functionName: "holdings" },
      { ...w, functionName: "equityToken" },
      { ...w, functionName: "oracle" },
    ],
  });
  const r = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const holdings = r<readonly [bigint, bigint]>(7);
  return {
    isLoading,
    heldValue: r<bigint>(0),
    cap: r<bigint>(1),
    priceFresh: r<boolean>(2),
    paused: r<boolean>(3),
    totalSupply: r<bigint>(4),
    sharePrice: r<bigint>(5),
    protocolShareBps: r<number>(6),
    equityHeld: holdings?.[0],
    usdgHeld: holdings?.[1],
    equityToken: r<Address>(8),
    oracle: r<Address>(9),
  };
}

export function useWellAccount(well: Address | undefined, usdg: Address | undefined) {
  const { address } = useAccount();
  const enabled = Boolean(well && usdg && address);
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled },
    contracts: [
      { address: well, abi: wellAbi, functionName: "balanceOf", args: [address!] },
      { address: well, abi: wellAbi, functionName: "maxWithdraw", args: [address!] },
      { address: well, abi: wellAbi, functionName: "maxDeposit", args: [address!] },
      { address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [address!] },
    ],
  });
  const r = (i: number) => (data?.[i]?.status === "success" ? (data[i].result as bigint) : undefined);
  return { address, shares: r(0), maxWithdraw: r(1), maxDeposit: r(2), usdgBalance: r(3) };
}

const feesHarvested = parseAbiItem(
  "event FeesHarvested(uint256 equityFees, uint256 usdgFees, uint256 protocolEquity, uint256 protocolUsdg)"
);

/// Yield Rate: depositor-share fees harvested over a recent block window, annualized against current Held Value.
export function useYieldRate(well: Address | undefined, heldValue: bigint | undefined, equityToken?: Address, oracle?: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["yieldRate", well, heldValue?.toString()],
    enabled: Boolean(client && well && heldValue && equityToken && oracle),
    refetchInterval: 120_000,
    queryFn: async (): Promise<number | null> => {
      const latest = await client!.getBlock();
      const from = latest.number > YIELD_WINDOW_BLOCKS ? latest.number - YIELD_WINDOW_BLOCKS : 0n;
      const [logs, first] = await Promise.all([
        client!.getLogs({ address: well, event: feesHarvested, fromBlock: from, toBlock: latest.number }),
        client!.getBlock({ blockNumber: from }),
      ]);
      const seconds = Number(latest.timestamp - first.timestamp);
      if (seconds < MIN_YIELD_SECONDS || !heldValue) return null;
      let usdg = 0n;
      let equity = 0n;
      for (const l of logs) {
        usdg += l.args.usdgFees! - l.args.protocolUsdg!;
        equity += l.args.equityFees! - l.args.protocolEquity!;
      }
      const equityValue =
        equity === 0n
          ? 0n
          : await client!.readContract({ address: oracle!, abi: wellOracleAbi, functionName: "usdgValue", args: [equityToken!, equity] });
      return (Number(usdg + equityValue) / Number(heldValue)) * (YEAR / seconds);
    },
  });
}
