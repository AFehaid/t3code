import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { copilotQuotaToUsageLimits, readCopilotUsageLimits } from "./copilotUsageLimits.ts";

const frame = (message: unknown) => {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};

function serverMode(stdout: string, chunkSize: number) {
  const spawned: Array<ReadonlyArray<string>> = [];
  const bytes = Buffer.from(stdout);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize));
  }
  const spawner = ChildProcessSpawner.make((command) => {
    spawned.push((command as unknown as { readonly args: ReadonlyArray<string> }).args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.fromIterable(chunks),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { spawned, spawner };
}

const read = (stdout: string, chunkSize = 7) => {
  const { spawned, spawner } = serverMode(stdout, chunkSize);
  return readCopilotUsageLimits(
    Effect.succeed({ command: "copilot", args: ["--acp", "--stdio", "--model", "fast"] }),
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provide(NodeCrypto.layer),
    Effect.map((limits) => ({ limits, spawned })),
  );
};

it.effect("reads the premium allowance from Copilot's server mode", () =>
  Effect.gen(function* () {
    const premium = {
      isUnlimitedEntitlement: false,
      entitlementRequests: 300,
      usedRequests: 75,
      remainingPercentage: 75,
      resetDate: "2026-11-09T21:12:16.284Z",
    };
    // Responses may arrive in any order and split anywhere, including inside a header.
    const { limits, spawned } = yield* read(
      frame({
        jsonrpc: "2.0",
        id: 2,
        result: { quotaSnapshots: { premium_interactions: premium } },
      }) +
        frame({
          jsonrpc: "2.0",
          id: 1,
          result: { isAuthenticated: true, host: "https://github.com", login: "octocat" },
        }),
    );
    assert.deepStrictEqual(spawned, [
      ["--model", "fast", "--headless", "--no-auto-update", "--stdio"],
    ]);
    assert.deepStrictEqual(limits.windows, [
      {
        id: "premium_interactions",
        kind: "monthly",
        label: "Premium requests",
        usedPercent: 25,
      },
    ]);
    assert.match(limits.credentialFingerprint ?? "", /^[0-9a-f]{64}$/);

    const signedOut = yield* read(
      frame({ jsonrpc: "2.0", id: 1, result: { isAuthenticated: false } }) +
        frame({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "Not authenticated" } }),
    );
    assert.deepStrictEqual(signedOut.limits.unavailable, {
      reason: "probeFailed",
      message: "Sign in to Copilot to show usage limits.",
    });

    const silent = yield* read("");
    assert.deepStrictEqual(silent.limits.unavailable, {
      reason: "probeFailed",
      message: "Copilot could not report usage limits.",
    });
  }),
);

it("maps Copilot quota snapshots to a monthly window", () => {
  const checkedAt = "2026-11-15T00:00:00.000Z";
  const base = { entitlementRequests: 300, remainingPercentage: 40 };
  assert.deepStrictEqual(
    copilotQuotaToUsageLimits({ checkedAt, premium: { ...base, tokenBasedBilling: true } }).windows,
    [{ id: "premium_interactions", kind: "monthly", label: "AI credits", usedPercent: 60 }],
  );
  for (const premium of [
    { ...base, isUnlimitedEntitlement: true },
    { ...base, entitlementRequests: 0 },
    undefined,
  ]) {
    assert.deepStrictEqual(copilotQuotaToUsageLimits({ checkedAt, premium }), {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported" },
    });
  }
});
