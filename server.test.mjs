import test from "node:test";
import assert from "node:assert/strict";
import { isDockerBrowserAddress, isPublicIpv4, makeFramingSafeHeaders, parseBrowserTarget, validateTarget } from "./server.mjs";

test("outbound tunnel is limited to Docker clients and public IPv4 addresses", () => {
    assert.equal(isDockerBrowserAddress("172.18.0.2"), true);
    assert.equal(isDockerBrowserAddress("::ffff:172.18.0.2"), true);
    assert.equal(isDockerBrowserAddress("10.0.0.4"), false);
    assert.equal(isPublicIpv4("93.184.216.34"), true);
    assert.equal(isPublicIpv4("127.0.0.1"), false);
    assert.equal(isPublicIpv4("169.254.169.254"), false);
    assert.equal(isPublicIpv4("192.168.1.1"), false);
});

test("browser navigation accepts only HTTP or HTTPS without embedded credentials", () => {
    assert.equal(parseBrowserTarget("example.org/path"), "https://example.org/path");
    assert.equal(parseBrowserTarget("http://127.0.0.1:8000/"), "http://127.0.0.1:8000/");
    assert.throws(() => parseBrowserTarget("javascript:alert(1)"), /Only HTTP or HTTPS/);
    assert.throws(() => parseBrowserTarget("https://user:pass@example.org/"), /without embedded credentials/);
});

test("target validation permits HTTPS OpenAI subdomains only", () => {
    assert.equal(validateTarget("https://s.openai.com/path").hostname, "s.openai.com");
    assert.throws(() => validateTarget("http://chatgpt.com/"), /Only HTTPS URLs/);
    assert.throws(() => validateTarget("https://chatgpt.com.example.org/"), /Only HTTPS URLs/);
    assert.throws(() => validateTarget("https://example.org/"), /Only HTTPS URLs/);
    assert.throws(() => validateTarget("https://chatgpt.com:8443/"), /Only HTTPS URLs/);
});

test("frame policy rewrite removes only framing restrictions", () => {
    const headers = makeFramingSafeHeaders(new Headers({
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy": "default-src 'self'; frame-ancestors 'self'; script-src 'nonce-test'",
        "content-security-policy-report-only": "frame-ancestors 'none'",
        "set-cookie": "session=secret",
    }));

    assert.equal(headers.has("x-frame-options"), false);
    assert.equal(headers.get("content-security-policy"), "default-src 'self'; script-src 'nonce-test'");
    assert.equal(headers.get("content-security-policy-report-only"), "frame-ancestors 'none'");
    assert.equal(headers.has("set-cookie"), false);
});