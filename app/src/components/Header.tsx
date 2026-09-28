"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ConnectButton } from "./ConnectButton";

const NAV = [
  { href: "/wells", label: "Wells" },
  { href: "/borrow", label: "Borrow Desk" },
  { href: "/programs", label: "Programs" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/docs", label: "Docs" },
];

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  return (
    <header className="header">
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden>◎</span> STONKWELL
      </Link>
      <nav id="site-nav" className={open ? "nav open" : "nav"}>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={pathname.startsWith(n.href) ? "active" : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <ConnectButton />
      <button
        className="menu-btn"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="site-nav"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "✕" : "☰"}
      </button>
    </header>
  );
}
