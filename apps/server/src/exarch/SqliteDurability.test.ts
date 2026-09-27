// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { WAL_SIZE_LIMIT_BYTES, makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";

it.effect("opens the engine database with NORMAL sync and a 64 MB page cache", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-durability-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [journal] = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
    const [sync] = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
    const [cache] = yield* sql<{ readonly cache_size: number }>`PRAGMA cache_size`;
    const [walLimit] = yield* sql<{
      readonly journal_size_limit: number;
    }>`PRAGMA journal_size_limit`;
    const [checkpoint] = yield* sql<{
      readonly wal_autocheckpoint: number;
    }>`PRAGMA wal_autocheckpoint`;

    assert.equal(journal?.journal_mode, "wal");
    // 1 is NORMAL; SQLite's default is 2, FULL.
    assert.equal(sync?.synchronous, 1);
    assert.equal(cache?.cache_size, -64 * 1024);
    // Upstream's WAL cap and SQLite's default checkpoint interval are unchanged.
    assert.equal(walLimit?.journal_size_limit, WAL_SIZE_LIMIT_BYTES);
    assert.equal(checkpoint?.wal_autocheckpoint, 1000);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
