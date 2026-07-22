import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVerification } from "../services/temp-mail.ts";
import { reserveCdpPort } from "../services/aliyun-captcha-api.ts";

test("Qwen activation is link-first (not OTP-only)", () => {
  const result = extractVerification({
    id: "qwen-1",
    subject: "Please activate your Qwen account",
    from: "noreply@qwen.ai",
    text: "Click the button below to activate your account",
    html: '<a href="https://chat.qwen.ai/auth/verify?token=abc">Activate</a>',
  });
  assert.ok(result.link, "expected activation link");
  assert.match(result.link!, /verify\?token=abc/);
});

test("reserveCdpPort returns a free TCP port", async () => {
  const port = await reserveCdpPort();
  assert.equal(typeof port, "number");
  assert.ok(port > 0 && port <= 65535);
});
