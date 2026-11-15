import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { RequirementField, RequirementGroup } from "../types";
import { ErrorText, Field } from "./ui";

export interface RequirementsValue {
  type: string;
  details: Record<string, string>;
  /** True when every required field is filled and matches its pattern. */
  valid: boolean;
}

function check(field: RequirementField, value: string): string | null {
  const v = value.trim();
  if (!v) return field.required ? "Required" : null;
  if (field.minLength && v.length < field.minLength) return `At least ${field.minLength} characters`;
  if (field.maxLength && v.length > field.maxLength) return `At most ${field.maxLength} characters`;
  if (field.validationRegexp) {
    try {
      if (!new RegExp(field.validationRegexp).test(v)) return field.example ? `Check the format, e.g. ${field.example}` : "Check the format";
    } catch {
      /* a pattern JavaScript can't parse: let the provider validate it */
    }
  }
  return null;
}

/**
 * Renders the payout form a provider describes (Wise "account requirements"): the fields differ by
 * country and currency, and some choices (like the country) reveal more fields.
 */
export function RequirementsForm({
  rail,
  currency,
  amount,
  onChange,
}: {
  rail: string;
  currency: string;
  amount: string;
  onChange: (value: RequirementsValue | null) => void;
}) {
  const [groups, setGroups] = useState<RequirementGroup[] | null>(null);
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const amountRef = useRef(amount);
  amountRef.current = amount;

  // The fields depend on the currency, not the amount, so they're loaded once per currency.
  useEffect(() => {
    let live = true;
    setGroups(null);
    setValues({});
    setTouched({});
    setError(null);
    setLoading(true);
    const amt = Number(amountRef.current) > 0 ? amountRef.current : "100";
    api
      .post<{ quoteId: string; groups: RequirementGroup[] }>("/api/payments/payout-requirements", { rail, currency, amount: amt })
      .then((r) => {
        if (!live) return;
        setQuoteId(r.quoteId);
        setGroups(r.groups);
        setType(r.groups[0]?.type ?? "");
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [rail, currency]);

  const group = groups?.find((g) => g.type === type);
  const fields = useMemo(() => group?.fields.flatMap((f) => f.group) ?? [], [group]);

  useEffect(() => {
    if (!group) return onChange(null);
    const details: Record<string, string> = {};
    for (const f of fields) if (values[f.key]?.trim()) details[f.key] = values[f.key].trim();
    onChange({ type: group.type, details, valid: fields.every((f) => !check(f, values[f.key] ?? "")) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, fields, values]);

  async function refresh(next: Record<string, string>) {
    if (!quoteId || !group) return;
    const details: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) if (v.trim()) details[k] = v.trim();
    try {
      const r = await api.post<{ quoteId: string; groups: RequirementGroup[] }>("/api/payments/payout-requirements", {
        rail,
        currency,
        amount: Number(amountRef.current) > 0 ? amountRef.current : "100",
        quoteId,
        type: group.type,
        details,
      });
      setGroups(r.groups);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function set(field: RequirementField, value: string) {
    const next = { ...values, [field.key]: value };
    setValues(next);
    if (field.refreshRequirementsOnChange && value) refresh(next);
  }

  if (loading) return <div className="skeleton" style={{ height: 120 }} aria-label="Loading the details Wise needs" />;
  if (error && !groups) return <ErrorText error={error} />;
  if (!groups?.length) return <p className="muted small">Wise doesn't offer payouts in {currency} yet.</p>;

  return (
    <div className="stack" style={{ gap: 12 }}>
      {groups.length > 1 && (
        <Field label="Receive by">
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            {groups.map((g) => (
              <option key={g.type} value={g.type}>{g.title}</option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-2">
        {fields.map((f) => {
          const problem = touched[f.key] ? check(f, values[f.key] ?? "") : null;
          const label = `${f.name}${f.required ? "" : " (optional)"}`;
          return (
            <Field key={f.key} label={label} hint={problem ? <span className="error-text">{problem}</span> : undefined}>
              {f.valuesAllowed?.length ? (
                <select
                  className="input"
                  value={values[f.key] ?? ""}
                  onChange={(e) => set(f, e.target.value)}
                  onBlur={() => setTouched({ ...touched, [f.key]: true })}
                  required={f.required}
                >
                  <option value="">Choose…</option>
                  {f.valuesAllowed.map((v) => (
                    <option key={v.key} value={v.key}>{v.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="input"
                  type={f.type === "date" ? "date" : "text"}
                  value={values[f.key] ?? ""}
                  placeholder={f.example ?? undefined}
                  onChange={(e) => set(f, e.target.value)}
                  onBlur={() => setTouched({ ...touched, [f.key]: true })}
                  required={f.required}
                  autoComplete="off"
                />
              )}
            </Field>
          );
        })}
      </div>
      <ErrorText error={error} />
    </div>
  );
}
