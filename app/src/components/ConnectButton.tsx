"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { shortAddress } from "@/lib/format";
import { wagmiConfig } from "@/lib/wagmi";

export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  if (!isConnected) {
    const injected = connectors[0];
    return (
      <button className="btn btn-primary" disabled={!injected || isPending} onClick={() => connect({ connector: injected })}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  const supported = wagmiConfig.chains.some((c) => c.id === chainId);
  if (!supported) {
    return (
      <button className="btn btn-warn" onClick={() => switchChain({ chainId: wagmiConfig.chains[0].id })}>
        Switch to Robinhood Chain
      </button>
    );
  }

  return (
    <button className="btn" onClick={() => disconnect()} title="Disconnect">
      {shortAddress(address!)}
    </button>
  );
}
