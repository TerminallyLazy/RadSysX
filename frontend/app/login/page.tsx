"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, ShieldCheck } from "lucide-react";

import { clinicalApi } from "@/lib/clinical/client";

const PERSONAS = [
  {
    username: "demo-radiologist",
    label: "Demo Radiologist",
    note: "Primary local reading persona for clinical workflow validation.",
  },
  {
    username: "attending-radiologist",
    label: "Attending Radiologist",
    note: "Higher-trust persona for signoff-oriented workflow checks.",
  },
  {
    username: "qa-reviewer",
    label: "QA Reviewer",
    note: "Read/audit-focused persona for governance and trace validation.",
  },
];

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedUser, setSelectedUser] = useState(PERSONAS[0].username);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextPath = useMemo(() => {
    const next = searchParams.get("next");
    return next && next.startsWith("/") ? next : "/worklist";
  }, [searchParams]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await clinicalApi.localLogin({ username: selectedUser });
      router.replace(nextPath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start clinical session.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.18),_transparent_38%),linear-gradient(180deg,_#020617,_#0f172a)] px-6 py-12 text-slate-100">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-[2rem] border border-cyan-400/20 bg-slate-950/70 p-8 shadow-2xl shadow-cyan-950/20 backdrop-blur">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.28em] text-cyan-300/80">
                <ShieldCheck className="h-4 w-4" />
                RadSysX Clinical Access
              </div>
              <h1 className="mt-3 text-3xl font-semibold text-white">Local RadSysX clinical login</h1>
              <p className="mt-3 max-w-2xl text-sm text-slate-300">
                This phase uses backend-issued signed cookies over seeded personas so the worklist,
                launch, reporting, AI, and audit flows all derive actor context server-side.
              </p>
            </div>
            <Link
              href="/"
              className="rounded-full border border-slate-700 bg-slate-900/60 px-4 py-2 text-sm text-slate-200 transition hover:border-cyan-400/50 hover:text-white"
            >
              Research workstation
            </Link>
          </div>

          <form onSubmit={(event) => void handleSubmit(event)} className="mt-8 grid gap-4">
            {PERSONAS.map((persona) => {
              const checked = selectedUser === persona.username;
              return (
                <label
                  key={persona.username}
                  className={`grid cursor-pointer gap-2 rounded-3xl border px-5 py-4 transition ${
                    checked
                      ? "border-cyan-300/60 bg-cyan-300/10"
                      : "border-slate-800 bg-slate-950/70 hover:border-cyan-400/30"
                  }`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-base font-medium text-white">{persona.label}</div>
                      <div className="mt-1 text-sm text-slate-400">{persona.note}</div>
                    </div>
                    <input
                      type="radio"
                      name="persona"
                      checked={checked}
                      onChange={() => setSelectedUser(persona.username)}
                      className="h-4 w-4 accent-cyan-300"
                    />
                  </div>
                </label>
              );
            })}

            {error && (
              <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="mt-2 inline-flex items-center justify-center gap-2 rounded-full bg-cyan-300 px-5 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-70"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {submitting ? "Signing in" : "Enter clinical workspace"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
