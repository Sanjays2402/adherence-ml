import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/layout/sidebar";
import InstallPrompt from "@/components/layout/install-prompt";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "adherence.ml // observability",
  description: "Online metrics, calibration, and intervention queue for the adherence risk model.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "adherence",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icon-512.svg",
    apple: "/icon-192.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0b0d",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${plexSans.variable} ${plexMono.variable}`}>
      <body className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)] font-sans antialiased">
        <div className="flex min-h-screen flex-col md:flex-row">
          <Sidebar />
          <main className="flex-1 min-w-0">{children}</main>
        </div>
        <InstallPrompt />
      </body>
    </html>
  );
}
