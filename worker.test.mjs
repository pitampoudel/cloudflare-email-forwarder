import assert from "node:assert/strict";
import worker from "./worker.js";

const tests = [];

function test(name, fn) {
    tests.push({name, fn});
}

function createCtx() {
    return {
        waitUntil() {
            // No-op for unit tests.
        },
    };
}

function createMessage({to, from, subject, forwardImpl}) {
    const headers = new Headers();
    headers.set("subject", subject ?? "Test subject");

    const message = {
        to,
        from,
        headers,
        forwards: [],
        rejects: [],
        async forward(target, rewrittenHeaders) {
            this.forwards.push({target, rewrittenHeaders});
            if (forwardImpl) {
                return forwardImpl(target, rewrittenHeaders, this.forwards.length);
            }
        },
        setReject(reason) {
            this.rejects.push(reason);
        },
    };

    return message;
}

test("retries with configured sender when initial forward fails", async () => {
    const message = createMessage({
        to: "support@yourcompany.com",
        from: "alice@external.com",
        forwardImpl: (target, rewrittenHeaders, attempt) => {
            assert.equal(target, "team@example.com");
            if (attempt === 1) {
                assert.equal(rewrittenHeaders, undefined);
                throw new Error("spoofing_protection");
            }
            assert.equal(rewrittenHeaders.get("From"), "forwarder@your-domain.com");
            assert.equal(rewrittenHeaders.get("Reply-To"), "alice@external.com");
        },
    });

    const env = {
        ROUTES_JSON: JSON.stringify({
            "support@yourcompany.com": {
                targets: ["team@example.com"],
                sender: "forwarder@your-domain.com",
            },
        }),
    };

    await worker.email(message, env, createCtx());

    assert.equal(message.forwards.length, 2);
    assert.deepEqual(message.rejects, []);
});

test("derives a fallback sender from recipient domain when sender is not configured", async () => {
    const message = createMessage({
        to: "support@yourcompany.com",
        from: "alice@external.com",
        forwardImpl: (target, rewrittenHeaders, attempt) => {
            assert.equal(target, "team@example.com");
            if (attempt === 1) {
                throw new Error("spoofing_protection");
            }
            assert.equal(rewrittenHeaders.get("From"), "forwarder@yourcompany.com");
            assert.equal(rewrittenHeaders.get("Reply-To"), "alice@external.com");
        },
    });

    const env = {
        ROUTES_JSON: JSON.stringify({
            "support@yourcompany.com": {
                targets: ["team@example.com"],
            },
        }),
    };

    await worker.email(message, env, createCtx());

    assert.equal(message.forwards.length, 2);
    assert.deepEqual(message.rejects, []);
});

test("treats a string target as one address", async () => {
    const message = createMessage({
        to: "ops@yourcompany.com",
        from: "alice@external.com",
    });

    const env = {
        ROUTES_JSON: JSON.stringify({
            "ops@yourcompany.com": {
                targets: "oncall@yourcompany.com",
            },
        }),
    };

    await worker.email(message, env, createCtx());

    assert.equal(message.forwards.length, 1);
    assert.equal(message.forwards[0].target, "oncall@yourcompany.com");
    assert.deepEqual(message.rejects, []);
});

test("rejects when no valid forwarding targets are configured", async () => {
    const message = createMessage({
        to: "ops@yourcompany.com",
        from: "alice@external.com",
    });

    const env = {
        ROUTES_JSON: JSON.stringify({
            "ops@yourcompany.com": {
                targets: ["not-an-email"],
            },
        }),
    };

    await worker.email(message, env, createCtx());

    assert.equal(message.forwards.length, 0);
    assert.deepEqual(message.rejects, ["Unknown address"]);
});

async function run() {
    let failures = 0;

    for (const {name, fn} of tests) {
        try {
            await fn();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures += 1;
            console.error(`FAIL ${name}`);
            console.error(error);
        }
    }

    if (failures > 0) {
        process.exitCode = 1;
    }
}

await run();
