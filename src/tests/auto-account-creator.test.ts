import { test } from "node:test";
import assert from "node:assert";
import { getDatabase } from "../core/database.ts";
import { invalidateAccountsCache } from "../core/accounts.ts";
import {
  clearAccountCooldown,
  markAccountRateLimited,
} from "../core/account-manager.ts";
import {
  areAllAccountsUnavailable,
  countAvailableAccounts,
  getAutoCreateStatus,
} from "../services/auto-account-creator.ts";
import { config } from "../core/config.ts";

function clearKnownCooldowns(ids: string[]): void {
  for (const id of ids) clearAccountCooldown(id);
}

function withCleanAccounts(fn: () => void | Promise<void>) {
  return async () => {
    const originalEnv = process.env.QWEN_ACCOUNTS;
    delete process.env.QWEN_ACCOUNTS;
    const db = getDatabase();
    const existing = db
      .prepare("SELECT id, email, password FROM accounts")
      .all() as Array<{ id: string; email: string; password: string }>;
    const knownIds = [
      ...existing.map((row) => row.id),
      "auto-1",
      "auto-2",
    ];
    clearKnownCooldowns(knownIds);
    db.prepare("DELETE FROM accounts").run();
    invalidateAccountsCache();
    try {
      await fn();
    } finally {
      clearKnownCooldowns(["auto-1", "auto-2"]);
      db.prepare("DELETE FROM accounts").run();
      const insert = db.prepare(
        "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
      );
      for (const row of existing) {
        insert.run(row.id, row.email, row.password);
      }
      invalidateAccountsCache();
      if (originalEnv !== undefined) process.env.QWEN_ACCOUNTS = originalEnv;
      else delete process.env.QWEN_ACCOUNTS;
    }
  };
}

test(
  "AutoCreator: empty pool is unavailable",
  withCleanAccounts(() => {
    assert.strictEqual(areAllAccountsUnavailable(), true);
    assert.strictEqual(countAvailableAccounts(), 0);
  }),
);

test(
  "AutoCreator: all rate-limited accounts are unavailable",
  withCleanAccounts(() => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    ).run("auto-1", "auto1@test.com", "password1");
    db.prepare(
      "INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)",
    ).run("auto-2", "auto2@test.com", "password2");
    invalidateAccountsCache();

    assert.strictEqual(areAllAccountsUnavailable(), false);
    assert.strictEqual(countAvailableAccounts(), 2);

    markAccountRateLimited("auto-1", 60_000, "RateLimited");
    markAccountRateLimited("auto-2", 60_000, "RateLimited");

    assert.strictEqual(areAllAccountsUnavailable(), true);
    assert.strictEqual(countAvailableAccounts(), 0);

    clearAccountCooldown("auto-1");
    assert.strictEqual(areAllAccountsUnavailable(), false);
    assert.strictEqual(countAvailableAccounts(), 1);
  }),
);

test("AutoCreator: status exposes config flags", () => {
  const status = getAutoCreateStatus();
  assert.strictEqual(typeof status.enabled, "boolean");
  assert.strictEqual(status.enabled, config.accountCreator.enabled);
  assert.strictEqual(typeof status.busy, "boolean");
  assert.strictEqual(typeof status.message, "string");
  assert.ok(status.cooldownRemainingMs >= 0);
});
