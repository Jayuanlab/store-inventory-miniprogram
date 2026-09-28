const fs = require("fs");
const path = require("path");

const files = ["app.json", "project.config.json", "sitemap.json", "package.json"];

for (const file of files) {
  const fullPath = path.join(process.cwd(), file);
  JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

console.log("JSON files are valid.");
