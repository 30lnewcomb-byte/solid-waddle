import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

test("state backup script has valid Bash syntax", () => {
    assert.doesNotThrow(() => {
        execFileSync("bash", ["-n", path.join(root, "scripts/backup-state.sh")], {
            cwd: root,
            stdio: "pipe",
        });
    });
});
