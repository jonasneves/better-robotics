// Dashboard identity: one ed25519 keypair per browser-origin, persisted in
// IndexedDB. Used to (a) auto-authorize SSH on prepared Pis and (b) sign
// BLE auth challenges (when gated ops land). Private key is extractable
// so the user can download an OpenSSH-format backup and SSH from a shell.
import { $ } from "./dom.js";

const DB_NAME = "better-robotics";
const STORE   = "keys";
const KEY_ID  = "dashboard-ed25519";
const COMMENT = "better-robotics";

let _cached = null;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(id) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbPut(id, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, id);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadOrGenerate() {
  if (_cached) return _cached;
  const existing = await idbGet(KEY_ID);
  if (existing) return (_cached = existing);
  const kp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  );
  const record = { publicKey: kp.publicKey, privateKey: kp.privateKey, createdAt: Date.now() };
  await idbPut(KEY_ID, record);
  return (_cached = record);
}

const te = (s) => new TextEncoder().encode(s);
const concat = (...parts) => {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);  // SSH wire: big-endian
  return b;
};
const sshStr = (bytes) => concat(u32(bytes.length), bytes);
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

async function pubkeyRaw() {
  const r = await loadOrGenerate();
  return new Uint8Array(await crypto.subtle.exportKey("raw", r.publicKey));
}

// SSH pubkey wire: uint32 "ssh-ed25519" || uint32 raw32.
async function pubkeyWire() {
  return concat(sshStr(te("ssh-ed25519")), sshStr(await pubkeyRaw()));
}

export async function pubkeySsh() {
  return `ssh-ed25519 ${b64(await pubkeyWire())} ${COMMENT}`;
}

export async function fingerprint() {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await pubkeyWire()));
  return `SHA256:${b64(hash).replace(/=+$/, "")}`;
}

export async function sign(message) {
  const r = await loadOrGenerate();
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, r.privateKey, message));
}

// OpenSSH private key format (unencrypted). Format ref:
//   https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
// Structure: magic || cipher(none) || kdf(none) || kdfopts() || nkeys(1) ||
//            pubkey_blob || privkey_section_padded_to_block_size(8).
export async function exportOpenSshPrivateKey() {
  const r = await loadOrGenerate();
  const pubRaw = await pubkeyRaw();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", r.privateKey));
  // PKCS8 tail = [0x04, 0x20, seed_32_bytes]; seed is the last 32 bytes.
  const seed = pkcs8.slice(-32);
  const priv64 = concat(seed, pubRaw);  // OpenSSH "private" = seed || pub.

  const pubWire = await pubkeyWire();
  const check = crypto.getRandomValues(new Uint8Array(4));
  let section = concat(
    check, check,
    sshStr(te("ssh-ed25519")),
    sshStr(pubRaw),
    sshStr(priv64),
    sshStr(te(COMMENT)),
  );
  // Pad to 8-byte block size with 1,2,3,…
  const padLen = (8 - (section.length % 8)) % 8;
  if (padLen) {
    const pad = new Uint8Array(padLen);
    for (let i = 0; i < padLen; i++) pad[i] = i + 1;
    section = concat(section, pad);
  }

  const body = concat(
    te("openssh-key-v1\0"),
    sshStr(te("none")),    // cipher
    sshStr(te("none")),    // kdf
    sshStr(new Uint8Array(0)),  // kdfoptions
    u32(1),                // nkeys
    sshStr(pubWire),
    sshStr(section),
  );
  const wrapped = b64(body).match(/.{1,70}/g).join("\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function downloadBlob(filename, text, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function initAuthUI() {
  await loadOrGenerate();
  const fp = await fingerprint();
  const pub = await pubkeySsh();
  $("key-fingerprint").textContent = fp;

  $("key-copy-pub").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pub);
      const btn = $("key-copy-pub");
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1500);
    } catch {}
  });

  $("key-download").addEventListener("click", async () => {
    // OpenSSH format; place in ~/.ssh/id_better_robotics with mode 600.
    // Public key is available via the Copy-public button next to it, so we
    // skip downloading the .pub — avoids Chrome's multi-file-download prompt.
    downloadBlob("id_better_robotics", await exportOpenSshPrivateKey());
  });
}
