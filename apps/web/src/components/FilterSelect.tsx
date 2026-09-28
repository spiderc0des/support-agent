"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** A dropdown filter that updates one query parameter and keeps the rest. */
export function FilterSelect({ name, label, options, anyLabel }: { name: string; label: string; options: readonly string[]; anyLabel: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <select
      className="field select-inline"
      aria-label={label}
      value={params.get(name) ?? ""}
      onChange={(e) => {
        const next = new URLSearchParams(params);
        if (e.target.value) next.set(name, e.target.value);
        else next.delete(name);
        router.push(`${pathname}?${next}`);
      }}
    >
      <option value="">{anyLabel}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o.replace(/_/g, " ")}
        </option>
      ))}
    </select>
  );
}
