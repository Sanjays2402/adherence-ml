/**
 * Settings store: workspace profile + notification preferences.
 *
 * File-backed JSON, same dependency-free pattern as runs-store and
 * api-keys-store. Single-tenant by design (this repo runs as one
 * workspace per process). Multi-tenant SaaS would key by user_id.
 *
 * Also hosts the GDPR-style "wipe my data" routine that nukes every
 * file-backed store under ADHERENCE_DATA_DIR.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface NotificationPrefs {
  email_on_high_risk: boolean;
  email_weekly_digest: boolean;
  webhook_on_run_created: boolean;
  toast_on_long_run: boolean;
}

export interface Profile {
  display_name: string;
  contact_email: string;
  org: string;
  timezone: string;
}

export interface Settings {
  version: 1;
  profile: Profile;
  notifications: NotificationPrefs;
  updated_at: number;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  profile: {
    display_name: "Workspace owner",
    contact_email: "",
    org: "",
    timezone: "UTC",
  },
  notifications: {
    email_on_high_risk: true,
    email_weekly_digest: true,
    webhook_on_run_created: true,
    toast_on_long_run: true,
  },
  updated_at: 0,
};

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "settings.json");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

export async function readSettings(): Promise<Settings> {
  ensureDir();
  if (!existsSync(STORE_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      version: 1,
      profile: { ...DEFAULT_SETTINGS.profile, ...(parsed.profile ?? {}) },
      notifications: {
        ...DEFAULT_SETTINGS.notifications,
        ...(parsed.notifications ?? {}),
      },
      updated_at: parsed.updated_at ?? 0,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export interface SettingsPatch {
  profile?: Partial<Profile>;
  notifications?: Partial<NotificationPrefs>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePatch(patch: SettingsPatch): string | null {
  if (patch.profile) {
    const { display_name, contact_email, org, timezone } = patch.profile;
    if (display_name !== undefined) {
      if (typeof display_name !== "string") return "display_name must be a string";
      if (display_name.length > 80) return "display_name too long (80 max)";
    }
    if (contact_email !== undefined && contact_email !== "") {
      if (typeof contact_email !== "string" || !EMAIL_RE.test(contact_email)) {
        return "contact_email is not a valid email";
      }
    }
    if (org !== undefined && (typeof org !== "string" || org.length > 80)) {
      return "org must be a string up to 80 chars";
    }
    if (timezone !== undefined && (typeof timezone !== "string" || timezone.length > 64)) {
      return "timezone must be a string up to 64 chars";
    }
  }
  if (patch.notifications) {
    for (const [k, v] of Object.entries(patch.notifications)) {
      if (typeof v !== "boolean") return `notifications.${k} must be boolean`;
    }
  }
  return null;
}

export async function writeSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await readSettings();
  const next: Settings = {
    version: 1,
    profile: { ...current.profile, ...(patch.profile ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
    updated_at: Date.now(),
  };
  ensureDir();
  const line = JSON.stringify(next, null, 2);
  writeQueue = writeQueue.then(() => fs.writeFile(STORE_PATH, line, "utf8"));
  await writeQueue;
  return next;
}

// Files this app writes. Keep in sync with the other stores.
const MANAGED_FILES = [
  "settings.json",
  "runs.jsonl",
  "api-keys.json",
  "usage.json",
  "shares.json",
  "webhooks.json",
  "webhook-deliveries.jsonl",
  "audit.jsonl",
];

export interface WipeReport {
  removed: string[];
  missing: string[];
  data_dir: string;
}

export interface WipePreview {
  data_dir: string;
  would_remove: Array<{ file: string; size_bytes: number }>;
  would_skip: string[];
  total_bytes: number;
}

export async function previewWipe(): Promise<WipePreview> {
  ensureDir();
  const would_remove: Array<{ file: string; size_bytes: number }> = [];
  const would_skip: string[] = [];
  let total_bytes = 0;
  for (const f of MANAGED_FILES) {
    const p = path.join(DATA_DIR, f);
    if (existsSync(p)) {
      const st = await fs.stat(p);
      would_remove.push({ file: f, size_bytes: st.size });
      total_bytes += st.size;
    } else {
      would_skip.push(f);
    }
  }
  return { data_dir: DATA_DIR, would_remove, would_skip, total_bytes };
}

export async function wipeAllData(): Promise<WipeReport> {
  ensureDir();
  const removed: string[] = [];
  const missing: string[] = [];
  for (const f of MANAGED_FILES) {
    const p = path.join(DATA_DIR, f);
    if (existsSync(p)) {
      await fs.rm(p, { force: true });
      removed.push(f);
    } else {
      missing.push(f);
    }
  }
  return { removed, missing, data_dir: DATA_DIR };
}

export async function exportAllData(): Promise<Record<string, unknown>> {
  ensureDir();
  const out: Record<string, unknown> = {
    exported_at: new Date().toISOString(),
    data_dir: DATA_DIR,
    files: {},
  };
  const files = out.files as Record<string, unknown>;
  for (const f of MANAGED_FILES) {
    const p = path.join(DATA_DIR, f);
    if (!existsSync(p)) {
      files[f] = null;
      continue;
    }
    const raw = await fs.readFile(p, "utf8");
    if (f.endsWith(".jsonl")) {
      files[f] = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { _raw: line };
          }
        });
    } else {
      try {
        files[f] = JSON.parse(raw);
      } catch {
        files[f] = { _raw: raw };
      }
    }
  }
  return out;
}
