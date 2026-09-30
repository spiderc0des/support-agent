import { Logo } from "@/components/Logo";
import { VoiceCall } from "@/components/VoiceCall";

export default function Home() {
  const phone = process.env.NEXT_PUBLIC_SUPPORT_PHONE;
  return (
    <div className="page">
      <header className="header">
        <Logo />
        <a href="/review" className="header-link">
          Support team
        </a>
      </header>
      <main className="main">
        <section className="card">
          <h1>RelayPay Support</h1>
          <p className="lede">
            Speak with our support assistant about payments, payouts, invoicing, or your account. It can connect you
            with a specialist when you need one.
          </p>

          <p className="note privacy">
            Never share passwords, one-time codes, or card numbers on a call.
            {phone ? (
              <>
                {" "}
                Prefer the phone? Call <a href={`tel:${phone.replace(/\s/g, "")}`}>{phone}</a>.
              </>
            ) : null}
          </p>

          <VoiceCall
            publicKey={process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ?? ""}
            assistantId={process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID ?? ""}
          />
        </section>
      </main>
      <footer className="footer">Calls are recorded in our support logs so the team can follow up.</footer>
    </div>
  );
}
