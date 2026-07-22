import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVerification } from "../services/temp-mail.ts";

test("temp-mail: extracts 6-digit verification code", () => {
  const result = extractVerification({
    id: "1",
    subject: "Qwen verification code",
    from: "noreply@qwen.ai",
    text: "Your verification code is: 482913\nIt expires in 10 minutes.",
    html: "",
  });
  assert.equal(result.code, "482913");
});

test("temp-mail: extracts verification link", () => {
  const result = extractVerification({
    id: "2",
    subject: "Confirm your email",
    from: "security@qwen.ai",
    text: "Open https://chat.qwen.ai/auth/verify?token=abc123 to continue",
    html: '<a href="https://chat.qwen.ai/auth/verify?token=abc123">Verify</a>',
  });
  assert.ok(result.link);
  assert.match(result.link!, /verify\?token=abc123/);
});

test("temp-mail: prefers labeled code over random numbers", () => {
  const result = extractVerification({
    id: "3",
    subject: "Security",
    from: "qwen",
    text: "Order 20240101\nVerification code: 991122",
    html: "",
  });
  assert.equal(result.code, "991122");
});

test("temp-mail: extracts Qwen activation link from HTML button", () => {
  const result = extractVerification({
    id: "4",
    subject: "Activate your Qwen account",
    from: "noreply@qwen.ai",
    text: "Please activate your account",
    html: '<a href="https://chat.qwen.ai/auth/verify?token=xyz789&amp;email=a%40b.com">Activate account</a>',
  });
  assert.ok(result.link);
  assert.match(result.link!, /chat\.qwen\.ai\/auth\/verify\?token=xyz789/);
});

test("temp-mail: ignores temp-mail host links without verify markers", () => {
  const result = extractVerification({
    id: "5",
    subject: "Inbox",
    from: "system",
    text: "Open https://tuamaeaquelaursa.com/foo for inbox",
    html: '<a href="https://tuamaeaquelaursa.com/foo">inbox</a>',
  });
  // Should not treat the temp-mail host as an activation link
  assert.equal(result.link, undefined);
});
