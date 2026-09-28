const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");

async function main() {
  const source = path.resolve(
    process.env.STORE_DB_PATH ||
      path.join(__dirname, "../server/data/store.sqlite"),
  );
  if (!fs.existsSync(source))
    throw new Error("Store database not found. Start the backend first.");
  const folder = path.resolve(__dirname, "../server/backups");
  fs.mkdirSync(folder, { recursive: true });
  const destination = path.join(
    folder,
    "store-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sqlite",
  );
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(database, destination);
    const copy = new DatabaseSync(destination, { readOnly: true });
    try {
      if (copy.prepare("PRAGMA quick_check").get().quick_check !== "ok")
        throw new Error("Backup integrity check failed");
      console.log("Verified SQLite backup: " + destination);
    } finally {
      copy.close();
    }
  } finally {
    database.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
