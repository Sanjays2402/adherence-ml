import type { Metadata } from "next";
import SettingsClient from "./client";

export const metadata: Metadata = {
  title: "settings // adherence.ml",
  description:
    "Workspace profile, notification preferences, data export, and full account wipe.",
};

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return <SettingsClient />;
}
