// app/layout.tsx (Next.js 13+)
import "@/styles/globals.css";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/Toaster";

const inter = Inter({ subsets: ["latin"] });

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className="antialiased">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </head>
      <body className={`${inter.className} min-h-screen overflow-hidden bg-white text-foreground dark:bg-[#0a0d13]`}>
        <main className="h-screen">
          {children}
        </main>
        <Toaster />
      </body>
    </html>
  );
}
