// Release-time state checks that never execute code from a rollback target.
//
// A schema contract records SQLite's observable table/index/trigger/view shape.
// Compatibility is intentionally conservative: existing definitions must be
// unchanged, while independent new tables and narrowly safe appended columns
// are allowed. This lets an older DeckTerm binary ignore additive schema
// without ever starting that binary against production state as a probe.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type SqliteScalar = string | number | null;

export interface SchemaColumn {
  cid: number;
  name: string;
  type: string;
  notNull: number;
  defaultValue: SqliteScalar;
  primaryKey: number;
  hidden: number;
}

export interface SchemaForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  onUpdate: string;
  onDelete: string;
  match: string;
}

export interface SchemaIndexColumn {
  seqno: number;
  cid: number;
  name: string | null;
  descending: number;
  collation: string | null;
  key: number;
}

export interface SchemaIndex {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  sql: string | null;
  columns: SchemaIndexColumn[];
}

export interface SchemaTable {
  name: string;
  withoutRowid: number;
  strict: number;
  createParts: string[];
  columns: SchemaColumn[];
  foreignKeys: SchemaForeignKey[];
  indexes: SchemaIndex[];
}

export interface SchemaObject {
  name: string;
  tableName: string;
  sql: string;
}

export interface SchemaContractV1 {
  version: 1;
  release: string;
  capturedAt: string;
  tables: SchemaTable[];
  views: SchemaObject[];
  triggers: SchemaObject[];
}

const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateReleaseId(value: string): string {
  if (!RELEASE_RE.test(value) || value === "." || value === "..") {
    throw new Error(
      "Release ID must be a safe path token using letters, numbers, dot, underscore, or dash",
    );
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function requireRegularFile(path: string, label: string): void {
  const entry = lstatSync(path);
  const uid = process.getuid?.();
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    (uid != null && entry.uid !== uid)
  ) {
    throw new Error(
      `${label} must be a regular file owned by the service account`,
    );
  }
}

function splitCreateTableSql(sql: string): string[] {
  const start = sql.indexOf("(");
  const end = sql.lastIndexOf(")");
  if (start < 0 || end <= start) {
    throw new Error(`Cannot parse CREATE TABLE statement: ${sql}`);
  }
  const body = sql.slice(start + 1, end);
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;

  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    current += char;
    if (quote) {
      if (quote === "]") {
        if (char === "]") quote = null;
      } else if (char === quote) {
        if (body[index + 1] === quote) {
          current += body[++index];
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "[") {
      quote = "]";
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
    } else if (char === "," && depth === 0) {
      current = current.slice(0, -1);
      parts.push(current.trim());
      current = "";
    }
  }
  if (quote || depth !== 0 || !current.trim()) {
    throw new Error(`Cannot parse CREATE TABLE body: ${sql}`);
  }
  parts.push(current.trim());
  return parts;
}

function firstDefinitionIdentifier(definition: string): string | null {
  const value = definition.trimStart();
  const upper = value.toUpperCase();
  if (
    upper.startsWith("CONSTRAINT ") ||
    upper.startsWith("PRIMARY ") ||
    upper.startsWith("UNIQUE ") ||
    upper.startsWith("CHECK ") ||
    upper.startsWith("FOREIGN ")
  ) {
    return null;
  }
  if (value[0] === '"' || value[0] === "`" || value[0] === "[") {
    const closing = value[0] === "[" ? "]" : value[0];
    const end = value.indexOf(closing, 1);
    return end > 0 ? value.slice(1, end) : null;
  }
  return value.match(/^[^\s]+/)?.[0] ?? null;
}

function captureTable(db: Database, name: string, sql: string): SchemaTable {
  const quoted = quoteIdentifier(name);
  const tableList = db
    .query("PRAGMA table_list")
    .all()
    .find((row) => (row as { name: string }).name === name) as
    { wr: number; strict: number } | undefined;
  if (!tableList)
    throw new Error(`Table disappeared while capturing schema: ${name}`);

  const columns = db
    .query(`PRAGMA table_xinfo(${quoted})`)
    .all()
    .map((row) => {
      const value = row as Record<string, SqliteScalar>;
      return {
        cid: Number(value.cid),
        name: String(value.name),
        type: String(value.type ?? ""),
        notNull: Number(value.notnull),
        defaultValue: value.dflt_value,
        primaryKey: Number(value.pk),
        hidden: Number(value.hidden),
      } satisfies SchemaColumn;
    });

  const foreignKeys = db
    .query(`PRAGMA foreign_key_list(${quoted})`)
    .all()
    .map((row) => {
      const value = row as Record<string, SqliteScalar>;
      return {
        id: Number(value.id),
        seq: Number(value.seq),
        table: String(value.table),
        from: String(value.from),
        to: value.to === null ? null : String(value.to),
        onUpdate: String(value.on_update),
        onDelete: String(value.on_delete),
        match: String(value.match),
      } satisfies SchemaForeignKey;
    });

  const indexes = db
    .query(`PRAGMA index_list(${quoted})`)
    .all()
    .map((row) => {
      const value = row as Record<string, SqliteScalar>;
      const indexName = String(value.name);
      const indexSql = db
        .query(
          "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
        )
        .get(indexName) as { sql: string | null } | null;
      const indexColumns = db
        .query(`PRAGMA index_xinfo(${quoteIdentifier(indexName)})`)
        .all()
        .map((columnRow) => {
          const column = columnRow as Record<string, SqliteScalar>;
          return {
            seqno: Number(column.seqno),
            cid: Number(column.cid),
            name: column.name === null ? null : String(column.name),
            descending: Number(column.desc),
            collation: column.coll === null ? null : String(column.coll),
            key: Number(column.key),
          } satisfies SchemaIndexColumn;
        });
      return {
        name: indexName,
        unique: Number(value.unique),
        origin: String(value.origin),
        partial: Number(value.partial),
        sql: indexSql?.sql ?? null,
        columns: indexColumns,
      } satisfies SchemaIndex;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    name,
    withoutRowid: Number(tableList.wr),
    strict: Number(tableList.strict),
    createParts: splitCreateTableSql(sql),
    columns,
    foreignKeys,
    indexes,
  };
}

export function captureSchemaContract(
  databasePathInput: string,
  releaseInput: string,
  now = new Date(),
): SchemaContractV1 {
  const release = validateReleaseId(releaseInput);
  const databasePath = resolve(databasePathInput);
  requireRegularFile(databasePath, "Schema database");
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    const objects = db
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
          "WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view', 'trigger') " +
          "ORDER BY type, name",
      )
      .all() as Array<{
      type: "table" | "view" | "trigger";
      name: string;
      tbl_name: string;
      sql: string | null;
    }>;
    const tables: SchemaTable[] = [];
    const views: SchemaObject[] = [];
    const triggers: SchemaObject[] = [];
    for (const object of objects) {
      if (!object.sql) {
        throw new Error(`Schema object has no SQL definition: ${object.name}`);
      }
      if (object.type === "table") {
        tables.push(captureTable(db, object.name, object.sql));
      } else {
        const captured = {
          name: object.name,
          tableName: object.tbl_name,
          sql: object.sql,
        };
        (object.type === "view" ? views : triggers).push(captured);
      }
    }
    return {
      version: 1,
      release,
      capturedAt: now.toISOString(),
      tables: tables.sort((a, b) => a.name.localeCompare(b.name)),
      views,
      triggers,
    };
  } finally {
    db.close();
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// SQLite identifier comparison folds ASCII case, but does not perform general
// Unicode case folding. Use the same boundary for cross-object references.
function sqliteIdentifierKey(value: string): string {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32),
  );
}

function isSafeAppendedDefault(
  value: SqliteScalar,
  nullable: boolean,
): boolean {
  if (value === null) return nullable;
  if (typeof value !== "string") return false;
  const sql = value.trim();
  if (/^NULL$/i.test(sql)) return nullable;
  // An arbitrary SQLite expression can return NULL or throw on an old insert.
  // Accept only literal values; expressions require an explicit migration review.
  return (
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(sql) ||
    /^'(?:[^']|'')*'$/s.test(sql) ||
    /^X'(?:[0-9a-f]{2})*'$/i.test(sql)
  );
}

function checkSchemaCompatibility(
  rollback: SchemaContractV1,
  current: SchemaContractV1,
): string[] {
  const errors: string[] = [];
  const currentTables = new Map(
    current.tables.map((table) => [sqliteIdentifierKey(table.name), table]),
  );
  const rollbackTableNames = new Set(
    rollback.tables.map((table) => sqliteIdentifierKey(table.name)),
  );

  for (const oldTable of rollback.tables) {
    const nextTable = currentTables.get(sqliteIdentifierKey(oldTable.name));
    if (!nextTable) {
      errors.push(`table removed: ${oldTable.name}`);
      continue;
    }
    if (
      oldTable.withoutRowid !== nextTable.withoutRowid ||
      oldTable.strict !== nextTable.strict
    ) {
      errors.push(`table mode changed: ${oldTable.name}`);
    }
    if (nextTable.columns.length < oldTable.columns.length) {
      errors.push(`columns removed from table: ${oldTable.name}`);
      continue;
    }
    for (let index = 0; index < oldTable.columns.length; index++) {
      if (!same(oldTable.columns[index], nextTable.columns[index])) {
        errors.push(
          `existing column changed: ${oldTable.name}.${oldTable.columns[index].name}`,
        );
      }
    }
    const addedColumns = nextTable.columns.slice(oldTable.columns.length);
    for (const column of addedColumns) {
      if (
        column.primaryKey !== 0 ||
        column.hidden !== 0 ||
        // STRICT affinity can reject even a non-null literal (INTEGER DEFAULT
        // 'text'). Default-bearing additions to STRICT tables need review.
        (nextTable.strict !== 0 &&
          column.defaultValue !== null &&
          !/^NULL$/i.test(String(column.defaultValue).trim())) ||
        !isSafeAppendedDefault(column.defaultValue, column.notNull === 0)
      ) {
        errors.push(
          `new column is unsafe for old inserts: ${oldTable.name}.${column.name}`,
        );
      }
    }
    if (!same(oldTable.foreignKeys, nextTable.foreignKeys)) {
      errors.push(`foreign keys changed: ${oldTable.name}`);
    }

    if (nextTable.createParts.length < oldTable.createParts.length) {
      errors.push(`CREATE TABLE contract shrank: ${oldTable.name}`);
    } else {
      for (let index = 0; index < oldTable.createParts.length; index++) {
        if (oldTable.createParts[index] !== nextTable.createParts[index]) {
          errors.push(`CREATE TABLE definition changed: ${oldTable.name}`);
          break;
        }
      }
      const addedParts = nextTable.createParts.slice(
        oldTable.createParts.length,
      );
      for (const [index, part] of addedParts.entries()) {
        // SQLite permits comments between CHECK and its opening parenthesis.
        // Conservatively refuse the keyword even inside a quoted definition;
        // a false-positive hold is safer than accepting an old-insert break.
        if (/\bCHECK\b/i.test(part)) {
          errors.push(
            `new column CHECK can reject old inserts: ${oldTable.name}.${addedColumns[index]?.name ?? "unknown"}`,
          );
        }
      }
      if (
        addedParts.length !== addedColumns.length ||
        addedParts.some(
          (part, index) =>
            firstDefinitionIdentifier(part) !== addedColumns[index]?.name,
        )
      ) {
        errors.push(`non-column table constraint added: ${oldTable.name}`);
      }
    }

    const nextIndexes = new Map(
      nextTable.indexes.map((item) => [item.name, item]),
    );
    for (const oldIndex of oldTable.indexes) {
      const nextIndex = nextIndexes.get(oldIndex.name);
      if (!nextIndex || !same(oldIndex, nextIndex)) {
        errors.push(
          `index removed or changed: ${oldTable.name}.${oldIndex.name}`,
        );
      }
    }
    for (const nextIndex of nextTable.indexes) {
      if (!oldTable.indexes.some((item) => item.name === nextIndex.name)) {
        errors.push(
          `index added to existing table: ${oldTable.name}.${nextIndex.name}`,
        );
      }
    }
  }

  for (const newTable of current.tables) {
    if (rollbackTableNames.has(sqliteIdentifierKey(newTable.name))) continue;
    for (const foreignKey of newTable.foreignKeys) {
      if (rollbackTableNames.has(sqliteIdentifierKey(foreignKey.table))) {
        errors.push(
          `new table foreign key targets existing table: ${newTable.name}.${foreignKey.from} -> ${foreignKey.table}`,
        );
      }
    }
  }

  const rollbackViews = new Map(
    rollback.views.map((item) => [sqliteIdentifierKey(item.name), item]),
  );
  const currentViews = new Map(
    current.views.map((item) => [sqliteIdentifierKey(item.name), item]),
  );
  for (const [name, oldView] of rollbackViews) {
    if (!same(oldView, currentViews.get(name)))
      errors.push(`view changed: ${name}`);
  }

  const rollbackTriggers = new Map(
    rollback.triggers.map((item) => [sqliteIdentifierKey(item.name), item]),
  );
  const currentTriggers = new Map(
    current.triggers.map((item) => [sqliteIdentifierKey(item.name), item]),
  );
  for (const [name, oldTrigger] of rollbackTriggers) {
    if (!same(oldTrigger, currentTriggers.get(name))) {
      errors.push(`trigger changed: ${name}`);
    }
  }
  const rollbackViewNames = new Set(rollbackViews.keys());
  for (const trigger of current.triggers) {
    const targetName = sqliteIdentifierKey(trigger.tableName);
    if (!rollbackTriggers.has(sqliteIdentifierKey(trigger.name))) {
      if (rollbackTableNames.has(targetName)) {
        errors.push(`trigger added to existing table: ${trigger.name}`);
      } else if (rollbackViewNames.has(targetName)) {
        errors.push(`trigger added to existing view: ${trigger.name}`);
      }
    }
  }
  return [...new Set(errors)];
}

export function assertAdditiveSchemaCompatibility(
  rollback: SchemaContractV1,
  current: SchemaContractV1,
): void {
  const errors = checkSchemaCompatibility(rollback, current);
  if (errors.length > 0) {
    throw new Error(
      `Rollback schema compatibility failed:\n- ${errors.join("\n- ")}`,
    );
  }
}

function requireContractRelease(
  contract: SchemaContractV1,
  expectedRelease: string,
  label: string,
): void {
  validateReleaseId(expectedRelease);
  if (contract.release !== expectedRelease) {
    throw new Error(
      `${label} contract belongs to ${contract.release}, expected ${expectedRelease}`,
    );
  }
}

function validateContract(value: unknown): SchemaContractV1 {
  if (!value || typeof value !== "object") {
    throw new Error("Schema contract must be a JSON object");
  }
  const contract = value as Partial<SchemaContractV1>;
  if (
    contract.version !== 1 ||
    typeof contract.release !== "string" ||
    !Array.isArray(contract.tables) ||
    !Array.isArray(contract.views) ||
    !Array.isArray(contract.triggers)
  ) {
    throw new Error("Schema contract format is invalid");
  }
  validateReleaseId(contract.release);
  return contract as SchemaContractV1;
}

export function readSchemaContract(pathInput: string): SchemaContractV1 {
  const path = resolve(pathInput);
  requireRegularFile(path, "Schema contract");
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(
      "Schema contract must not be accessible by group or other users",
    );
  }
  try {
    return validateContract(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Schema contract")) {
      throw error;
    }
    throw new Error(`Schema contract is invalid: ${path}`, { cause: error });
  }
}

function writeContractAtomic(
  pathInput: string,
  contract: SchemaContractV1,
): void {
  const path = resolve(pathInput);
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentEntry = lstatSync(parent);
  const uid = process.getuid?.();
  if (
    parentEntry.isSymbolicLink() ||
    !parentEntry.isDirectory() ||
    realpathSync(parent) !== parent ||
    (uid != null && parentEntry.uid !== uid)
  ) {
    throw new Error("Schema contract directory is unsafe");
  }
  chmodSync(parent, 0o700);

  if (existsSync(path)) {
    const existing = readSchemaContract(path);
    const comparableExisting = { ...existing, capturedAt: contract.capturedAt };
    if (!same(comparableExisting, contract)) {
      throw new Error(
        `Existing schema contract disagrees with release ${contract.release}`,
      );
    }
    return;
  }

  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.partial`,
  );
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
  const parentFd = openSync(parent, "r");
  try {
    fsyncSync(parentFd);
  } finally {
    closeSync(parentFd);
  }
}

export function captureAndWriteSchemaContract(
  databasePath: string,
  release: string,
  outputPath: string,
): SchemaContractV1 {
  const contract = captureSchemaContract(databasePath, release);
  writeContractAtomic(outputPath, contract);
  return contract;
}

export async function verifyReleaseHealth(options: {
  url: string;
  release: string;
  requirePreflight: boolean;
}): Promise<void> {
  validateReleaseId(options.release);
  const response = await fetch(options.url, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Health endpoint returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (body.status !== "ok" || body.release !== options.release) {
    throw new Error(
      `Health release mismatch: expected ${options.release}, got ${String(body.release ?? "<none>")}`,
    );
  }
  if (options.requirePreflight && body.preflight !== true) {
    throw new Error("Candidate health did not identify a preflight process");
  }
  if (!options.requirePreflight && body.preflight === true) {
    throw new Error("Live health unexpectedly identifies a preflight process");
  }
}

function usage(): never {
  console.error(
    "Usage:\n" +
      "  bun scripts/release-state.ts capture <database> <release> <contract>\n" +
      "  bun scripts/release-state.ts check-database <rollback-contract> <database> <current-release>\n" +
      "  bun scripts/release-state.ts check-contracts <rollback-contract> <rollback-release> <current-contract> <current-release>\n" +
      "  bun scripts/release-state.ts health <url> <release> <preflight|live>",
  );
  process.exit(2);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "capture" && args.length === 3) {
      const contract = captureAndWriteSchemaContract(args[0], args[1], args[2]);
      console.log(
        JSON.stringify({
          release: contract.release,
          contract: resolve(args[2]),
        }),
      );
    } else if (command === "check-database" && args.length === 3) {
      const rollback = readSchemaContract(args[0]);
      const current = captureSchemaContract(args[1], args[2]);
      assertAdditiveSchemaCompatibility(rollback, current);
      console.log(JSON.stringify({ compatible: true }));
    } else if (command === "check-contracts" && args.length === 4) {
      const rollback = readSchemaContract(args[0]);
      const current = readSchemaContract(args[2]);
      requireContractRelease(rollback, args[1], "Rollback");
      requireContractRelease(current, args[3], "Current");
      assertAdditiveSchemaCompatibility(rollback, current);
      console.log(JSON.stringify({ compatible: true }));
    } else if (
      command === "health" &&
      args.length === 3 &&
      (args[2] === "preflight" || args[2] === "live")
    ) {
      await verifyReleaseHealth({
        url: args[0],
        release: args[1],
        requirePreflight: args[2] === "preflight",
      });
      console.log(JSON.stringify({ healthy: true, release: args[1] }));
    } else {
      usage();
    }
  } catch (error) {
    console.error(
      `release-state failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
