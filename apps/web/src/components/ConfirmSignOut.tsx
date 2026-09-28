"use client";
import { ConfirmButton } from "@/components/ConfirmButton";

/** Sign out, after asking. The server route clears the session and redirects to /login. */
export function ConfirmSignOut() {
  return (
    <div className="signout">
      <ConfirmButton
        label="Sign out"
        confirmLabel="Sign out"
        question="Sign out of the support console?"
        detail="You'll need a new sign-in link from /login to come back."
        onConfirm={() => {
          const form = document.createElement("form");
          form.method = "post";
          form.action = "/auth/signout";
          document.body.appendChild(form);
          form.submit();
        }}
      />
    </div>
  );
}
