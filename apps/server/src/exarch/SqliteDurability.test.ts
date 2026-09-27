// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as AuthPairingLinks from "../persistence/AuthPairingLinks.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { WAL_SIZE_LIMIT_BYTES, makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { fullySyncedAuthPairingLinks } from "./SqliteDurability.ts";

const withTempDatabase = <A, E, R>(use: (dbPath: string) => Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-durability-"));
    return use(NodePath.join(tempDir, "state.sqlite")).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });

const databaseLayer = (dbPath: string) =>
  makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));

const readSynchronous = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
  return row?.synchronous;
});

const sessionInput = (id: string, now: DateTime.Utc) => ({
  sessionId: AuthSessionId.make(id),
  subject: "owner",
  scopes: [],
  method: "bearer-access-token" as const,
  client: {
    label: null,
    ipAddress: null,
    userAgent: null,
    deviceType: "desktop" as const,
    os: null,
    browser: null,
  },
  issuedAt: now,
  expiresAt: DateTime.add(now, { hours: 1 }),
});

const pairingLinkInput = (id: string, now: DateTime.Utc) => ({
  id,
  credential: `credential-${id}`,
  method: "one-time-token" as const,
  scopes: [],
  subject: "owner",
  label: null,
  proofKeyThumbprint: null,
  createdAt: now,
  expiresAt: DateTime.add(now, { hours: 1 }),
});

const AUTH_WRITE = /^\s*(INSERT|UPDATE|DELETE)\b[^;]*\bauth_(sessions|pairing_links)\b/i;

type Execute = (...args: Array<unknown>) => unknown;

// Records the connection's synchronous level at the moment each auth-table
// write executes, by watching node:sqlite for the length of the test.
const recordAuthWriteSyncLevels = Effect.acquireRelease(
  Effect.sync(() => {
    const levels: Array<number> = [];
    const owners = new WeakMap<StatementSync, DatabaseSync>();
    const originals = {
      prepare: DatabaseSync.prototype.prepare,
      run: StatementSync.prototype.run as Execute,
      all: StatementSync.prototype.all as Execute,
    };
    const recordThenCall = (original: Execute) =>
      function (this: StatementSync, ...params: Array<unknown>) {
        const database = owners.get(this);
        if (database !== undefined && AUTH_WRITE.test(this.sourceSQL)) {
          const row = originals.prepare.call(database, "PRAGMA synchronous").get();
          levels.push(Number(row?.synchronous));
        }
        return original.apply(this, params);
      };
    Object.assign(DatabaseSync.prototype, {
      prepare(this: DatabaseSync, source: string) {
        const statement = originals.prepare.call(this, source);
        owners.set(statement, this);
        return statement;
      },
    });
    Object.assign(StatementSync.prototype, {
      run: recordThenCall(originals.run),
      all: recordThenCall(originals.all),
    });
    return { levels, originals };
  }),
  ({ originals }) =>
    Effect.sync(() => {
      Object.assign(DatabaseSync.prototype, { prepare: originals.prepare });
      Object.assign(StatementSync.prototype, { run: originals.run, all: originals.all });
    }),
);

it.effect("opens the engine database with NORMAL sync and a 64 MB page cache", () =>
  withTempDatabase((dbPath) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [journal] = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
      const [cache] = yield* sql<{ readonly cache_size: number }>`PRAGMA cache_size`;
      const [walLimit] = yield* sql<{
        readonly journal_size_limit: number;
      }>`PRAGMA journal_size_limit`;
      const [checkpoint] = yield* sql<{
        readonly wal_autocheckpoint: number;
      }>`PRAGMA wal_autocheckpoint`;

      assert.equal(journal?.journal_mode, "wal");
      // 1 is NORMAL; SQLite's default is 2, FULL.
      assert.equal(yield* readSynchronous, 1);
      assert.equal(cache?.cache_size, -64 * 1024);
      // Upstream's WAL cap and SQLite's default checkpoint interval are unchanged.
      assert.equal(walLimit?.journal_size_limit, WAL_SIZE_LIMIT_BYTES);
      assert.equal(checkpoint?.wal_autocheckpoint, 1000);
    }).pipe(Effect.provide(databaseLayer(dbPath))),
  ),
);

it.effect("commits every auth write with FULL sync and then returns to NORMAL", () =>
  withTempDatabase((dbPath) =>
    Effect.gen(function* () {
      const { levels } = yield* recordAuthWriteSyncLevels;
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const links = yield* AuthPairingLinks.AuthPairingLinkRepository;

      // A new repository method fails here, so a refresh decides whether it
      // writes auth state and needs FULL sync.
      assert.deepEqual(Object.keys(sessions).toSorted(), [
        "create",
        "createIfAbsent",
        "createReplacingActive",
        "getById",
        "listActive",
        "revoke",
        "revokeAllExcept",
        "setClientConnection",
        "setLastConnectedAt",
      ]);
      assert.deepEqual(Object.keys(links).toSorted(), [
        "consumeAvailable",
        "create",
        "getByCredential",
        "listActive",
        "revoke",
      ]);

      const now = yield* DateTime.now;
      const session = (id: string) => sessionInput(id, now);
      const link = (id: string) => pairingLinkInput(id, now);

      yield* sessions.create(session("first"));
      yield* sessions.createIfAbsent(session("second"));
      yield* links.create(link("consumed"));
      yield* links.create(link("revoked"));
      const replaced = yield* sessions.createReplacingActive({
        session: session("third"),
        revokedAt: now,
      });
      yield* sessions.setLastConnectedAt({
        sessionId: AuthSessionId.make("third"),
        lastConnectedAt: now,
      });
      yield* sessions.setClientConnection({
        sessionId: AuthSessionId.make("third"),
        surface: "desktop",
        appVersion: "1.0.0",
      });
      const consumed = yield* links.consumeAvailable({
        credential: "credential-consumed",
        proofKeyThumbprint: null,
        consumedAt: now,
        now,
      });
      const linkRevoked = yield* links.revoke({ id: "revoked", revokedAt: now });
      yield* sessions.create(session("fourth"));
      const sessionRevoked = yield* sessions.revoke({
        sessionId: AuthSessionId.make("fourth"),
        revokedAt: now,
      });
      yield* sessions.create(session("fifth"));
      const othersRevoked = yield* sessions.revokeAllExcept({
        currentSessionId: AuthSessionId.make("third"),
        revokedAt: now,
      });

      // The writes did their work.
      assert.deepEqual([...replaced].toSorted(), ["first", "second"]);
      assert.isTrue(Option.isSome(consumed));
      assert.isTrue(linkRevoked);
      assert.isTrue(sessionRevoked);
      assert.deepEqual([...othersRevoked], ["fifth"]);

      // Every auth statement ran at 2, FULL. createReplacingActive is two
      // statements in one transaction, so 13 calls make 14 statements.
      assert.deepEqual(
        levels,
        Array.from({ length: 14 }, () => 2),
      );
      assert.equal(yield* readSynchronous, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(AuthSessions.layer, AuthPairingLinks.layer).pipe(
          Layer.provideMerge(databaseLayer(dbPath)),
        ),
      ),
    ),
  ),
);

it.effect("runs auth writes one at a time so none restores NORMAL under another", () =>
  withTempDatabase((dbPath) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const seen: Array<number | undefined> = [];
      // Yields between the pragma and the write, as a busy runtime can.
      const slowWrite = Effect.yieldNow.pipe(
        Effect.andThen(readSynchronous),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.map((level) => {
          seen.push(level);
        }),
        Effect.orDie,
      );
      const unused = () => Effect.die("unused");
      const links = yield* fullySyncedAuthPairingLinks({
        create: () => slowWrite,
        consumeAvailable: unused,
        listActive: unused,
        revoke: unused,
        getByCredential: unused,
      });

      const now = yield* DateTime.now;
      yield* Effect.all(
        [links.create(pairingLinkInput("a", now)), links.create(pairingLinkInput("b", now))],
        { concurrency: "unbounded" },
      );

      assert.deepEqual(seen, [2, 2]);
      assert.equal(yield* readSynchronous, 1);
    }).pipe(Effect.provide(databaseLayer(dbPath))),
  ),
);
