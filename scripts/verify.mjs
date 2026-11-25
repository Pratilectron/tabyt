/*
 * Verify TabYT's source and build output. Exits non-zero on the first problem
 * so it can be used in CI or before loading the extension in a browser.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}
function warn(message) {
  warnings.push(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${relative(root, path)} is not valid JSON: ${error.message}`);
    return null;
  }
}

function walk(dir, list) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, list);
    else list.push(full);
  }
  return list;
}

const ALLOWED_HOSTS = new Set([
  "*://www.youtube.com/*",
  "*://m.youtube.com/*",
  "*://music.youtube.com/*",
  "*://youtube.com/*"
]);

function verifyManifest(dir, browser) {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) {
    fail(`missing ${relative(root, path)} (run npm run build)`);
    return;
  }
  const manifest = readJson(path);
  if (!manifest) return;

  if (manifest.manifest_version !== 3) fail(`${browser}: manifest_version must be 3`);
  if (manifest.version !== pkg.version) {
    fail(`${browser}: manifest version ${manifest.version} does not match package version ${pkg.version}`);
  }
  if (!manifest.name || !manifest.description) fail(`${browser}: name and description are required`);

  const background = manifest.background || {};
  if (browser === "chrome" && background.service_worker !== "background.js") {
    fail("chrome: background.service_worker must be background.js");
  }
  if (browser === "firefox") {
    if (!Array.isArray(background.scripts) || !background.scripts.includes("background.js")) {
      fail("firefox: background.scripts must include background.js");
    }
    if (!Array.isArray(background.scripts) || !background.scripts.includes("lib/core.js")) {
      fail("firefox: background.scripts must load lib/core.js before background.js");
    }
  }

  const matches = manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].matches;
  if (!Array.isArray(matches) || !matches.length) fail(`${browser}: content_scripts[0].matches is empty`);
  else {
    for (const pattern of matches) {
      if (!ALLOWED_HOSTS.has(pattern)) fail(`${browser}: unexpected content-script match ${pattern}`);
    }
  }

  const hosts = manifest.host_permissions || [];
  if (!hosts.length) fail(`${browser}: host_permissions is empty`);
  for (const pattern of hosts) {
    if (!ALLOWED_HOSTS.has(pattern)) fail(`${browser}: unexpected host permission ${pattern}`);
  }
  if (hosts.some((pattern) => pattern.includes("*.youtube.com"))) {
    fail(`${browser}: broad *.youtube.com permission is not allowed`);
  }

  const permissions = manifest.permissions || [];
  for (const required of ["storage", "alarms", "notifications", "scripting"]) {
    if (!permissions.includes(required)) fail(`${browser}: missing permission ${required}`);
  }
  if ((manifest.optional_permissions || []).includes("processes")) {
    warn(`${browser}: the processes permission is Dev channel only and will trigger warnings on Chrome Stable`);
  }

  const popup = manifest.action && manifest.action.default_popup;
  if (!popup) fail(`${browser}: action.default_popup is missing`);
  else if (!existsSync(join(dir, popup))) fail(`${browser}: popup file ${popup} is missing`);

  const options = manifest.options_ui && manifest.options_ui.page;
  if (!options) fail(`${browser}: options_ui.page is missing`);
  else {
    const file = options.split("#")[0].split("?")[0];
    if (!existsSync(join(dir, file))) fail(`${browser}: options page ${file} is missing`);
  }

  if (!manifest.content_security_policy || !manifest.content_security_policy.extension_pages) {
    fail(`${browser}: extension_pages CSP is missing`);
  }

  const iconEntries = Object.entries(manifest.icons || {});
  if (!iconEntries.length) fail(`${browser}: icons are missing`);
  for (const [size, iconPath] of iconEntries) {
    const full = join(dir, iconPath);
    if (!existsSync(full)) {
      fail(`${browser}: icon ${iconPath} is missing`);
      continue;
    }
    const header = readFileSync(full).subarray(0, 24);
    if (header[0] !== 0x89 || header.toString("ascii", 1, 4) !== "PNG") {
      fail(`${browser}: ${iconPath} is not a PNG`);
      continue;
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (width !== Number(size) || height !== Number(size)) {
      fail(`${browser}: ${iconPath} is ${width}x${height}, expected ${size}x${size}`);
    }
  }

  const referenced = [
    popup,
    options && options.split("#")[0].split("?")[0],
    ...(background.scripts || []),
    background.service_worker,
    ...((manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]))
  ].filter(Boolean);
  for (const file of referenced) {
    if (!existsSync(join(dir, file))) fail(`${browser}: referenced file ${file} is missing`);
  }

  if (manifest.minimum_chrome_version && browser !== "chrome") {
    warn(`${browser}: minimum_chrome_version is Chrome-specific`);
  }
}

/* ---------------------------------------------------------------------- */
/* Source checks                                                          */
/* ---------------------------------------------------------------------- */

const sourceFiles = walk(join(root, "src"), []);
const jsFiles = sourceFiles.filter((file) => extname(file) === ".js");

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`syntax error in ${relative(root, file)}: ${(result.stderr || "").trim().split("\n")[0]}`);
  }
  const text = readFileSync(file, "utf8");
  if (/\beval\s*\(/.test(text)) fail(`${relative(root, file)} uses eval()`);
  if (/new\s+Function\s*\(/.test(text)) fail(`${relative(root, file)} uses new Function()`);
  if (/\bfetch\s*\(/.test(text) || /XMLHttpRequest/.test(text)) {
    fail(`${relative(root, file)} performs a network request`);
  }
}

const htmlFiles = sourceFiles.filter((file) => extname(file) === ".html");
for (const file of htmlFiles) {
  const text = readFileSync(file, "utf8");
  if (/<(script|link|img)[^>]+(src|href)=["']https?:/i.test(text)) {
    fail(`${relative(root, file)} loads a remote asset`);
  }
  const ids = [...text.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) fail(`${relative(root, file)} has duplicate ids: ${[...new Set(duplicates)].join(", ")}`);
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(text)) {
    fail(`${relative(root, file)} contains an inline script, which the MV3 CSP blocks`);
  }
}

const coreSource = readFileSync(join(root, "src", "lib", "core.js"), "utf8");
if (!coreSource.includes('var VERSION = "' + pkg.version + '"')) {
  fail("src/lib/core.js VERSION does not match package.json");
}

for (const browser of ["chrome", "firefox"]) {
  const sourceManifest = readJson(join(root, "manifests", `${browser}.json`));
  if (!sourceManifest) continue;
  if (sourceManifest.version !== pkg.version) {
    fail(`manifests/${browser}.json version ${sourceManifest.version} does not match package.json`);
  }
}

const devManifestPath = join(root, "manifest.json");
if (!existsSync(devManifestPath)) {
  fail("manifest.json is missing from the project folder, so Chrome cannot load it unpacked");
} else {
  const devManifest = readJson(devManifestPath);
  if (devManifest) {
    if (devManifest.version !== pkg.version) {
      fail(`manifest.json version ${devManifest.version} does not match package.json`);
    }
    if (!devManifest.background || devManifest.background.service_worker !== "src/background.js") {
      fail("manifest.json service_worker must be src/background.js");
    }
    const devFiles = [
      devManifest.background && devManifest.background.service_worker,
      devManifest.action && devManifest.action.default_popup,
      devManifest.options_ui && devManifest.options_ui.page && devManifest.options_ui.page.split("#")[0].split("?")[0],
      ...Object.values(devManifest.icons || {}),
      ...((devManifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]))
    ].filter(Boolean);
    for (const file of devFiles) {
      if (!existsSync(join(root, file))) fail(`manifest.json references missing file ${file}`);
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Build output checks                                                    */
/* ---------------------------------------------------------------------- */

if (existsSync(join(root, "dist"))) {
  for (const browser of ["chrome", "firefox"]) {
    const dir = join(root, "dist", browser);
    if (!existsSync(dir)) {
      fail(`dist/${browser} is missing (run npm run build)`);
      continue;
    }
    verifyManifest(dir, browser);
    const files = walk(dir, []);
    if (!files.some((file) => file.endsWith(join("ui", "dashboard.js")))) {
      fail(`dist/${browser} is missing ui/dashboard.js`);
    }
    if (files.some((file) => file.includes(`${sep}node_modules${sep}`))) {
      fail(`dist/${browser} contains node_modules`);
    }
  }
} else {
  warn("dist/ does not exist yet; run npm run build");
}

/* ---------------------------------------------------------------------- */

for (const message of warnings) console.warn(`warning: ${message}`);
if (errors.length) {
  for (const message of errors) console.error(`error: ${message}`);
  console.error(`\nTabYT verification failed with ${errors.length} error${errors.length === 1 ? "" : "s"}.`);
  process.exit(1);
}
console.log(`TabYT verification passed${warnings.length ? ` with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}.`);
