"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";

const NAV = [
  { href: "/wells", label: "Wells" },
  { href: "/borrow", label: "Borrow Desk" },
  { href: "/programs", label: "Programs" },
  { href: "/docs", label: "Docs" },
];

export function Header() {
  const pathname = usePathname();
  return (
    <header className="header">
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden>◎</span> STONKWELL
      </Link>
      <nav className="nav">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={pathname.startsWith(n.href) ? "active" : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <ConnectButton />
    </header>
  );
}
