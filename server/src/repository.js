const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { initialize } = require("./common");
const { upgrade } = require("./suppliers");
let database;
function connection() {
  if (database) return database;
  const filename =
    process.env.STORE_DB_PATH ||
    path.join(__dirname, "..", "data", "store.sqlite");
  if (filename !== ":memory:")
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  database = new DatabaseSync(filename);
  database.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value))); CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, record_key TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(collection, record_key));",
  );
  if (
    !database.prepare("SELECT 1 FROM metadata WHERE key = 'initialized'").get()
  ) {
    const source =
      process.env.STORE_SEED_PATH ||
      path.join(__dirname, "..", "data", "store.json");
    const seed = JSON.parse(fs.readFileSync(source, "utf8"));
    if (filename !== ":memory:") {
      const backup = path.join(
        path.dirname(filename),
        "before-erp-upgrade.json",
      );
      if (!fs.existsSync(backup)) fs.copyFileSync(source, backup);
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      persist(upgrade(initialize(seed)));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return database;
}
function persist(store) {
  const db = database;
  db.exec("DELETE FROM metadata; DELETE FROM records;");
  const meta = db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
  const record = db.prepare(
    "INSERT INTO records(collection,record_key,position,value) VALUES (?,?,?,?)",
  );
  meta.run("initialized", "true");
  for (const [key, value] of Object.entries(store)) {
    if (!Array.isArray(value)) {
      meta.run(key, JSON.stringify(value));
      continue;
    }
    meta.run(`array:${key}`, "true");
    value.forEach((item, position) =>
      record.run(key, String(position), position, JSON.stringify(item)),
    );
  }
}
function readStore() {
  const db = connection();
  const store = {};
  for (const row of db.prepare("SELECT key,value FROM metadata").all()) {
    if (row.key.startsWith("array:")) store[row.key.slice(6)] = [];
    else if (row.key !== "initialized") store[row.key] = JSON.parse(row.value);
  }
  for (const row of db
    .prepare(
      "SELECT collection,value FROM records ORDER BY collection,position",
    )
    .all())
    store[row.collection].push(JSON.parse(row.value));
  return upgrade(initialize(store));
}
// Read and write under one database lock, after the HTTP body has arrived.
function transaction(work) {
  const db = connection();
  db.exec("BEGIN IMMEDIATE");
  try {
    const store = readStore();
    const result = work(store);
    if (result && typeof result.then === "function")
      throw new Error("Transaction callback must be synchronous");
    persist(store);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function writeStore(store) {
  const db = connection();
  db.exec("BEGIN IMMEDIATE");
  try {
    persist(upgrade(initialize(store)));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function resetStore(store) {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Reset is only available in isolated tests");
  writeStore(store);
}
module.exports = { readStore, transaction, writeStore, resetStore };
