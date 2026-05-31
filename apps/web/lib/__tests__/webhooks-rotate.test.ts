/**
 * Webhook signing-secret rotation: dual-secret grace window.
 *
 * Proves:
 *   - rotateEndpointSecret returns a brand new plaintext, persists only the hash,
 *     and moves the prior secret into the secondary slot with an expiry.
 *   - endpointSigningSecrets returns BOTH hashes while the window is open and
 *     drops the secondary once expired (and purges it from disk).
 *   - revokeEndpointSecondary clears the secondary immediately, even if the
 *     window has not expired.
 *   - createHmac-based co-signing yields two distinct valid signatures while the
 *     window is open and one (new-only) signature once the window closes.
 *
 * Run with: pnpm tsx lib/__tests__/webhooks-rotate.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";

const tmp = mkdtempSync(path.join(tmpdir(), "wh-rotate-"));
process.env.ADHERENCE_DATA_DIR = tmp;

function fail(msg: string): never {
  console.error("FAIL:", msg);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
function ok(cond: unknown, msg: string) {
  if (!cond) fail(msg);
}

async function main() {
  const {
    createEndpoint,
    rotateEndpointSecret,
    revokeEndpointSecondary,
    endpointSigningSecrets,
    MIN_GRACE_MS,
  } = await import("../webhooks-store");

  // Create an endpoint and capture the original secret + hash.
  const created = await createEndpoint({
    name: "rot-test",
    url: "https://example.com/hook",
  });
  const originalSecret = created.secret;
  const originalHash = created.record.secret_hash;
  ok(originalSecret.startsWith("whsec_"), "secret prefix");
  ok(originalHash.length === 64, "sha256 hex hash");

  // Pre-rotation: only primary signs.
  const pre = await endpointSigningSecrets(created.record.id);
  ok(pre && pre.primary === originalHash, "primary == original hash");
  ok(pre && pre.secondary === null, "no secondary pre-rotation");

  // Rotate with a 10-minute grace window.
  const result = await rotateEndpointSecret(created.record.id, 10 * 60 * 1000);
  ok(result !== null, "rotate returned a result");
  ok(result!.secret.startsWith("whsec_"), "new secret prefix");
  ok(result!.secret !== originalSecret, "new secret differs from old");
  ok(
    result!.record.secret_hash !== originalHash,
    "stored primary hash changed",
  );
  ok(
    result!.record.secondary_secret_hash === originalHash,
    "old hash moved into secondary slot",
  );
  ok(
    result!.secondary_expires_at > Date.now() + 5 * 60 * 1000,
    "secondary expiry roughly +10m in the future",
  );

  // Mid-window: BOTH hashes sign and produce distinct, valid HMACs.
  const keys = await endpointSigningSecrets(created.record.id);
  ok(keys && keys.primary === result!.record.secret_hash, "primary updated");
  ok(keys && keys.secondary === originalHash, "secondary returned during window");

  const body = '{"event":"run.created","id":"r_1"}';
  const ts = Math.floor(Date.now() / 1000);
  const macPrimary = createHmac("sha256", keys!.primary)
    .update(`${ts}.${body}`)
    .digest("hex");
  const macSecondary = createHmac("sha256", keys!.secondary!)
    .update(`${ts}.${body}`)
    .digest("hex");
  ok(macPrimary !== macSecondary, "primary and secondary MACs differ");
  ok(macPrimary.length === 64 && macSecondary.length === 64, "hex length");

  // Revoke secondary immediately.
  const cleared = await revokeEndpointSecondary(created.record.id);
  ok(cleared === true, "revokeEndpointSecondary cleared an active secondary");
  const afterRevoke = await endpointSigningSecrets(created.record.id);
  ok(afterRevoke && afterRevoke.secondary === null, "secondary gone after revoke");
  // Idempotent: a second revoke is a no-op and returns false.
  const cleared2 = await revokeEndpointSecondary(created.record.id);
  ok(cleared2 === false, "second revoke is a no-op");

  // Lazy expiry GC: rotate again, then fast-forward by writing an
  // expired timestamp directly to disk and confirm endpointSigningSecrets
  // drops it on next read.
  const result2 = await rotateEndpointSecret(created.record.id, MIN_GRACE_MS);
  ok(result2 !== null, "second rotate ok");
  // Tamper the store: set secondary_expires_at to the past.
  const fs = await import("node:fs/promises");
  const storePath = path.join(tmp, "webhooks.json");
  const raw = JSON.parse(await fs.readFile(storePath, "utf8"));
  const target = raw.endpoints.find((e: { id: string }) => e.id === created.record.id);
  ok(!!target, "endpoint round-trips through disk");
  target.secondary_expires_at = Date.now() - 1000;
  await fs.writeFile(storePath, JSON.stringify(raw), "utf8");

  const afterExpiry = await endpointSigningSecrets(created.record.id);
  ok(
    afterExpiry && afterExpiry.secondary === null,
    "expired secondary is not returned",
  );
  // Allow the lazy purge writeQueue to flush before we read the file again.
  await new Promise((r) => setTimeout(r, 50));
  const purged = JSON.parse(await fs.readFile(storePath, "utf8"));
  const purgedTarget = purged.endpoints.find(
    (e: { id: string }) => e.id === created.record.id,
  );
  ok(
    purgedTarget.secondary_secret_hash === null &&
      purgedTarget.secondary_expires_at === null,
    "expired secondary purged from disk",
  );

  rmSync(tmp, { recursive: true, force: true });
  console.log("PASS webhooks-rotate.test.ts");
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
