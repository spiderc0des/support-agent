import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RelayPay Support",
  description: "Talk to RelayPay's support assistant about payments, payouts, invoicing and your account.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
