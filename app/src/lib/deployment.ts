"use client";

import { useAccount } from "wagmi";
import { deployments, type Deployment } from "@/generated/deployments";
import { defaultChainId } from "./wagmi";

export function useDeployment(): { deployment: Deployment | null; chainId: number } {
  const { chainId: walletChain } = useAccount();
  const chainId = walletChain && deployments[walletChain] ? walletChain : defaultChainId;
  return { deployment: deployments[chainId] ?? null, chainId };
}
