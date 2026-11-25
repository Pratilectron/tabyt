/*
 * Build TabYT for Chrome and Firefox.
 *
 * The extension has no bundler and no runtime dependencies. This script
 * copies the source tree into dist/<browser>, writes the browser-specific
 * manifest with the package version, and optionally creates store-ready ZIPs.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const args = new Set(process.argv.slice(2));
const clean = !args.has("--no-clean");
const zip = args.has("--zip");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const BROWSERS = ["chrome", "firefox"];

if (clean) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

function copySource(target) {
  const source = join(root, "src");
  cpSync(source, target, { recursive: true });
  /*
   * Keep the build free of stray editor files. Hidden files are not part of
   * the extension.
   */
  for (const name of readdirSync(target)) {
    if (name.startsWith(".")) rmSync(join(target, name), { recursive: true, force: true });
  }
}

function writeManifest(target, browser) {
  const path = join(root, "manifests", `${browser}.json`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.version = version;
  writeFileSync(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function prefixExtensionPath(file) {
  const hashIndex = file.indexOf("#");
  const queryIndex = file.indexOf("?");
  let cut = file.length;
  if (hashIndex !== -1) cut = Math.min(cut, hashIndex);
  if (queryIndex !== -1) cut = Math.min(cut, queryIndex);
  const path = file.slice(0, cut);
  const suffix = file.slice(cut);
  return (path.startsWith("src/") ? path : `src/${path}`) + suffix;
}

function prefixIconMap(icons) {
  const next = {};
  for (const [size, iconPath] of Object.entries(icons || {})) {
    next[size] = prefixExtensionPath(iconPath);
  }
  return next;
}

/*
 * Chrome's Load unpacked looks for manifest.json in the folder the user
 * selects. The project folder is that folder during development, while the
 * extension files live under src/.
 */
function writeDevManifest() {
  const manifest = JSON.parse(readFileSync(join(root, "manifests", "chrome.json"), "utf8"));
  const firefox = JSON.parse(readFileSync(join(root, "manifests", "firefox.json"), "utf8"));
  manifest.version = version;
  manifest.browser_specific_settings = firefox.browser_specific_settings;
  manifest.background.service_worker = prefixExtensionPath(manifest.background.service_worker);
  manifest.action.default_popup = prefixExtensionPath(manifest.action.default_popup);
  manifest.action.default_icon = prefixIconMap(manifest.action.default_icon);
  manifest.icons = prefixIconMap(manifest.icons);
  if (manifest.options_ui && manifest.options_ui.page) {
    manifest.options_ui.page = prefixExtensionPath(manifest.options_ui.page);
  }
  for (const entry of manifest.content_scripts || []) {
    entry.js = (entry.js || []).map(prefixExtensionPath);
    if (entry.css) entry.css = entry.css.map(prefixExtensionPath);
  }
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function listFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files.sort();
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC = crcTable();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function createZip(dir, zipPath) {
  const files = listFiles(dir);
  const now = new Date();
  const stamp = dosDateTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = relative(dir, file).split(sep).join("/");
    const data = readFileSync(file);
    const nameBuffer = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuffer, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBuffer.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  writeFileSync(zipPath, Buffer.concat([...chunks, centralBuffer, end]));
  return files.length;
}

writeDevManifest();
console.log(`wrote manifest.json for unpacked loads of the project folder (v${version})`);

for (const browser of BROWSERS) {
  const target = join(dist, browser);
  mkdirSync(target, { recursive: true });
  copySource(target);
  writeManifest(target, browser);
  console.log(`built dist/${browser} (v${version})`);

  if (zip) {
    const zipPath = join(dist, `tabyt-${browser}-v${version}.zip`);
    const count = createZip(target, zipPath);
    console.log(`packed ${relative(root, zipPath)} (${count} files)`);
  }
}

if (!existsSync(join(dist, "chrome", "manifest.json"))) {
  throw new Error("Build did not produce a Chrome manifest.");
}
