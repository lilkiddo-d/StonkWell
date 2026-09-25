"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { erc20Abi, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

type TxState = { busy: boolean; message?: string; error?: string };

export function useTx() {
  const client = usePublicClient();
  const queryClient = useQueryClient();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<TxState>({ busy: false });

  async function wait(hash: Hash) {
    if (!client) throw new Error("No RPC client");
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Transaction reverted");
  }

  async function ensureAllowance(token: Address, spender: Address, amount: bigint) {
    if (!client || !address) throw new Error("Connect a wallet first");
    const current = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, spender],
    });
    if (current >= amount) return;
    setState({ busy: true, message: "Approving…" });
    await wait(await writeContractAsync({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] }));
  }

  async function run(label: string, steps: (helpers: { ensureAllowance: typeof ensureAllowance }) => Promise<Hash>) {
    setState({ busy: true, message: `${label}…` });
    try {
      const hash = await steps({ ensureAllowance });
      setState({ busy: true, message: `${label}: confirming…` });
      await wait(hash);
      setState({ busy: false, message: `${label}: confirmed` });
      await queryClient.invalidateQueries();
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setState({ busy: false, error: err.shortMessage || err.message || "Transaction failed" });
    }
  }

  return { ...state, run, writeContractAsync };
}

export function TxStatus({ message, error }: { message?: string; error?: string }) {
  if (error) return <p className="tx-status error">{error}</p>;
  if (message) return <p className="tx-status">{message}</p>;
  return null;
}
