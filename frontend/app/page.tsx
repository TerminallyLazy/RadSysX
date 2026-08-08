"use client";

import Link from "next/link";
import { Beaker, ShieldCheck, Workflow } from "lucide-react";

import { getPublicAppMode } from "@/lib/env";

const SURFACES = [
  {
    title: "Clinical",
    body:
      "Governed worklist, opaque launch sessions, audited reporting, AI orchestration, and backend-mediated derived DICOM persistence.",
    href: "/worklist",
    icon: ShieldCheck,
  },
  {
    title: "Research",
    body:
      "Prototype and experimentation surface. It remains distinct from clinical governance, but the authoritative viewer path is now OHIF.",
    href: "/login",
    icon: Beaker,
  },
];

export default function Page() {
  const appMode = getPublicAppMode();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.14),_transparent_38%),linear-gradient(180deg,_#020617,_#0f172a)] px-6 py-12 text-slate-100">
      <div className="mx-auto max-w-5xl">
        <section className="rounded-[2rem] border border-cyan-400/20 bg-slate-950/70 p-8 shadow-2xl shadow-cyan-950/20 backdrop-blur">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.28em] text-cyan-300/80">
            <Workflow className="h-4 w-4" />
            RadSysX Platform
          </div>
          <h1 className="mt-4 text-4xl font-semibold text-white">
            OHIF is now the only viewer runtime.
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-300">
            The bespoke browser viewer and the Next.js fallback `/viewer` route are retired.
            Governed imaging launches resolve into the dedicated OHIF app, while research and
            clinical remain separate surfaces with different workflow rules.
          </p>
          <div className="mt-6 inline-flex rounded-full border border-cyan-400/20 bg-cyan-300/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.24em] text-cyan-100">
            Shell mode: {appMode}
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {SURFACES.map((surface) => {
              const Icon = surface.icon;
              return (
                <Link
                  key={surface.title}
                  href={surface.href}
                  className="rounded-[1.5rem] border border-slate-800 bg-slate-950/70 p-6 transition hover:border-cyan-400/30 hover:bg-slate-950"
                >
                  <div className="flex items-center gap-3 text-cyan-200">
                    <Icon className="h-5 w-5" />
                    <span className="text-lg font-medium text-white">{surface.title}</span>
                  </div>
                  <p className="mt-4 text-sm leading-6 text-slate-300">{surface.body}</p>
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
