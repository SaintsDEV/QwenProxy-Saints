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
