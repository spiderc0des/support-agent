/** Static wordmark. Brand direction: top-left, not animated, not over-styled. */
export function Logo() {
  return (
    <span className="logo" aria-label="RelayPay">
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <rect width="28" height="28" rx="6" fill="#17365d" />
        <path d="M8 18h8l-3 3M20 10h-8l3-3" stroke="#ffffff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      RelayPay
    </span>
  );
}
