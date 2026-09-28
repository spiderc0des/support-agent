"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export type NavLink = { href: string; label: string; count?: number };

function isActive(pathname: string, href: string) {
  return href === "/review" ? pathname === "/review" : pathname === href || pathname.startsWith(`${href}/`);
}

/** The desktop nav row. The same list feeds MobileNav, so the two can't drift. */
export function NavLinks({ links }: { links: NavLink[] }) {
  const pathname = usePathname();
  return (
    <nav className="nav-desktop" aria-label="Main">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className={isActive(pathname, l.href) ? "active" : ""} aria-current={isActive(pathname, l.href) ? "page" : undefined}>
          {l.label}
          {l.count ? <span className="nav-count">{l.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** The same links behind a menu button on small screens. */
export function MobileNav({ links, footer }: { links: NavLink[]; footer: NavLink[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="nav-mobile">
      <button type="button" className="menu-btn" onClick={() => setOpen((o) => !o)} aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
          {open ? <path d="M4 4l12 12M16 4L4 16" /> : <path d="M3 5h14M3 10h14M3 15h14" />}
        </svg>
      </button>
      {open ? (
        <div className="mobile-panel">
          {[...links, ...footer].map((l) => (
            <Link key={l.href} href={l.href} className={isActive(pathname, l.href) ? "active" : ""}>
              {l.label}
              {l.count ? <span className="nav-count">{l.count}</span> : null}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
