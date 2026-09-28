const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const config = require("../app.json");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "outputs/qa/compile");
fs.mkdirSync(output, { recursive: true });
const compiler =
  process.env.WECHAT_COMPILER_DIR ||
  "C:/Program Files (x86)/Tencent/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec";
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    [command, result.stdout, result.stderr].join("\n"),
  );
  if (result.stderr) console.log(result.stderr.trim());
}
for (const file of [
  "app.js",
  ...config.pages.map((p) => p + ".js"),
  ...fs
    .readdirSync(path.join(root, "utils"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => "utils/" + f),
]) {
  run(process.execPath, ["--check", file]);
  assert.ok(
    !fs.readFileSync(path.join(root, file), "utf8").includes("\uFFFD"),
    file + ": encoding",
  );
}
for (const file of config.pages)
  JSON.parse(fs.readFileSync(path.join(root, file + ".json"), "utf8"));
run(path.join(compiler, "wcc.exe"), [
  "-o",
  path.join(output, "wxml.js"),
  ...config.pages.map((p) => p + ".wxml"),
]);
run(path.join(compiler, "wcsc.exe"), [
  "-o",
  path.join(output, "wxss.js"),
  "app.wxss",
  ...config.pages.map((p) => p + ".wxss"),
]);
console.log(
  "JS, JSON, WXML and WXSS checked: " + config.pages.length + " pages",
);
