import Link from "next/link";
import { ROLE_LABEL, type StaffRole } from "@relaypay/shared/enums";
import { Logo } from "@/components/Logo";
import { NavLinks, MobileNav, type NavLink } from "@/components/NavLinks";
import { displayName, initials, type Profile } from "@/lib/auth";

/**
 * The console header. Work comes first in the nav (overview, tickets,
 * escalations), records next (conversations, evaluations), admin last and
 * only for admins. Profile is the avatar, not a nav item, so there's one
 * route to it.
 */
export function AppHeader({ profile, openTickets, openEscalations }: { profile: Profile & { role: StaffRole }; openTickets: number; openEscalations: number }) {
  const links: NavLink[] = [
    { href: "/review", label: "Overview" },
    { href: "/review/tickets", label: "Tickets", count: openTickets },
    { href: "/review/escalations", label: "Escalations", count: openEscalations },
    { href: "/review/conversations", label: "Conversations" },
    { href: "/review/evals", label: "Evaluations" },
    ...(profile.role === "admin" ? [{ href: "/review/admin", label: "Admin" }] : []),
  ];
  const footer: NavLink[] = [
    { href: "/review/profile", label: "Your profile" },
    { href: "/", label: "Voice page" },
  ];

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/review" className="brand-link" aria-label="RelayPay support console">
          <Logo />
          <span className="brand-sub">Support</span>
        </Link>
        <NavLinks links={links} />
        <div className="header-right">
          <Link href="/" className="header-link">
            Voice page
          </Link>
          <Link href="/review/profile" className="avatar" title={`${displayName(profile)} · ${ROLE_LABEL[profile.role]}`} aria-label={`Signed in as ${displayName(profile)}. Open your profile.`}>
            {initials(profile)}
          </Link>
          <MobileNav links={links} footer={footer} />
        </div>
      </div>
    </header>
  );
}
