import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// ACP mode has no quota request, so ask Copilot's SDK server mode, which speaks
// JSON-RPC in LSP-style Content-Length frames over stdio.
const SERVER_MODE_FLAGS = ["--headless", "--no-auto-update", "--stdio"];
const AUTH_STATUS_ID = 1;
const QUOTA_ID = 2;

const CopilotAuthStatus = Schema.Struct({
  isAuthenticated: Schema.Boolean,
  host: Schema.optionalKey(Schema.String),
  login: Schema.optionalKey(Schema.String),
});

// Its `resetDate` is when Copilot read the quota, not the next reset, so it is left out.
const CopilotQuotaSnapshot = Schema.Struct({
  isUnlimitedEntitlement: Schema.optionalKey(Schema.Boolean),
  entitlementRequests: Schema.optionalKey(Schema.Number),
  remainingPercentage: Schema.Number,
  tokenBasedBilling: Schema.optionalKey(Schema.Boolean),
});
export type CopilotQuotaSnapshot = typeof CopilotQuotaSnapshot.Type;

const CopilotQuota = Schema.Struct({
  quotaSnapshots: Schema.Struct({
    premium_interactions: Schema.optionalKey(CopilotQuotaSnapshot),
  }),
});

const JsonRpcResponse = Schema.Struct({
  id: Schema.Number,
  result: Schema.optionalKey(Schema.Unknown),
});

const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcResponse));
const decodeAuthStatus = Schema.decodeUnknownOption(CopilotAuthStatus);
const decodeQuota = Schema.decodeUnknownEffect(CopilotQuota);

function copilotServerModeArgs(acpArgs: ReadonlyArray<string>): ReadonlyArray<string> {
  // Repeating a flag is a usage error for the CLI.
  return [
    ...acpArgs.filter((arg) => arg !== "--acp" && !SERVER_MODE_FLAGS.includes(arg)),
    ...SERVER_MODE_FLAGS,
  ];
}

function frame(id: number, method: string): Uint8Array {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function readFrames(
  pending: Uint8Array,
  chunk: Uint8Array,
): readonly [rest: Uint8Array, bodies: ReadonlyArray<string>] {
  let buffer = Buffer.concat([pending, chunk]);
  const bodies: string[] = [];
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const start = headerEnd + 4;
    const length = Number(
      /content-length:\s*(\d+)/i.exec(buffer.toString("latin1", 0, headerEnd))?.[1],
    );
    if (!Number.isSafeInteger(length)) {
      buffer = buffer.subarray(start);
      continue;
    }
    if (buffer.length < start + length) break;
    bodies.push(buffer.toString("utf8", start, start + length));
    buffer = buffer.subarray(start + length);
  }
  return [buffer, bodies];
}

/** Token-billed plans name the premium request allowance AI credits. */
export function copilotQuotaToUsageLimits(input: {
  readonly checkedAt: string;
  readonly premium: CopilotQuotaSnapshot | undefined;
}): ServerProviderUsageLimits {
  const { checkedAt, premium } = input;
  if (
    premium === undefined ||
    premium.isUnlimitedEntitlement === true ||
    (premium.entitlementRequests !== undefined && premium.entitlementRequests <= 0)
  ) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const window: ServerProviderUsageWindow = {
    id: "premium_interactions",
    kind: "monthly",
    label: premium.tokenBasedBilling === true ? "AI credits" : "Premium requests",
    usedPercent: clampPercent(100 - premium.remainingPercentage),
  };
  return makeUsageLimits({ checkedAt, windows: [window] });
}

/** Asks the Copilot CLI behind an ACP launch command for its signed-in account's allowance. */
export const readCopilotUsageLimits = Effect.fn("readCopilotUsageLimits")(function* <E, R>(
  resolveAcpSpawn: Effect.Effect<AcpSessionRuntime.AcpSpawnInput, E, R>,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const spawn = yield* resolveAcpSpawn;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const digest = yield* Digest.Digest;
    const extendEnv = spawn.extendEnv ?? true;
    const args = copilotServerModeArgs(spawn.args);
    // Match the ACP runtime: local commands arrive already resolved.
    const command =
      spawn.shell === false
        ? { command: spawn.command, args, shell: false }
        : yield* resolveSpawnCommand(spawn.command, args, {
            ...(spawn.env === undefined ? {} : { env: spawn.env }),
            extendEnv,
          });
    const child = yield* spawner.spawn(
      ChildProcess.make(command.command, command.args, {
        ...(spawn.cwd === undefined ? {} : { cwd: spawn.cwd }),
        ...(spawn.env === undefined ? {} : { env: spawn.env }),
        extendEnv,
        shell: command.shell,
        stdin: {
          stream: Stream.make(
            frame(AUTH_STATUS_ID, "auth.getStatus"),
            frame(QUOTA_ID, "account.getQuota"),
          ),
        },
      }),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    const responses = yield* child.stdout.pipe(
      Stream.mapAccum(
        (): Uint8Array => new Uint8Array(0),
        (pending, chunk) => {
          const [rest, bodies] = readFrames(pending, chunk);
          return [rest, bodies.flatMap((body) => Option.toArray(decodeResponse(body)))] as const;
        },
      ),
      Stream.filter((response) => response.id === AUTH_STATUS_ID || response.id === QUOTA_ID),
      Stream.take(2),
      Stream.runCollect,
    );
    const result = (id: number) => responses.find((response) => response.id === id)?.result;
    const account = Option.getOrUndefined(decodeAuthStatus(result(AUTH_STATUS_ID)));
    if (account?.isAuthenticated === false) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Sign in to Copilot to show usage limits.",
      });
    }
    const quota = yield* decodeQuota(result(QUOTA_ID));
    const limits = copilotQuotaToUsageLimits({
      checkedAt,
      premium: quota.quotaSnapshots.premium_interactions,
    });
    if (!account?.login) return limits;
    // The login is no secret; hashing it lets every environment signed in to it count once.
    const credentialFingerprint = yield* digest
      .digest(
        Digest.sha256,
        new TextEncoder().encode(`github-copilot\0${account.host ?? ""}\0${account.login}`),
      )
      .pipe(Effect.map(Hex.encode));
    return { ...limits, credentialFingerprint };
  }).pipe(
    Effect.scoped,
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Copilot could not report usage limits.",
      }),
    ),
  );
});
