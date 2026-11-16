import { Api, utils } from "telegram";
import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";
import { getClient } from "../telegram/client";
import { canonicalChannelId } from "../telegram/peerId";
import { normalizeFolderPath } from "../files/pathUtils";
import { resolveFileSegments } from "../files/segmentHelpers";
import { getSecret, saveSecret, deleteSecret } from "../secure/vault";
import {
  base64ToBytes,
  bytesToBase64,
  registerExternalDecryptionKey,
  requireEncryptionKey,
} from "../secure/e2ee";
import type { TeleFile, TeleFileEncryption, TeleFileSegment } from "../types";
import { collectFolderFiles, folderFullPath, type FolderShareResult, type ShareProgress } from "./folderShare";

/**
 * Password-protected folder shares.
 *
 * Only client-side encrypted (TDE1) files are shared. Their ciphertext is
 * cloned into a share channel with NO caption and an anonymous file name, so
 * someone opening the link in Telegram sees only unreadable `.tde` blobs.
 *
 * Everything readable — real file names, folder tree, sizes and the file
 * decryption keys — lives in an encrypted manifest posted as text messages:
 *   AES-256-GCM( gzip(JSON) ) with a key from PBKDF2-SHA256(password, salt).
 * Recipients type the password in TeleDrive to unlock and browse/download.
 */

const LOCK_PREFIX = "teledrive_share_lock:";
const MANIFEST_CHUNK = 3500;
const PBKDF2_ITERATIONS = 310_000;
const MANIFEST_SCAN_PAGES = 5;

interface LockedEntry {
  src: string;
  name: string;
  folder: string;
  size: number;
  mime: string;
  enc: TeleFileEncryption;
  ids: number[];
  segSizes: number[];
  at: number;
}

interface LockedManifest {
  v: 1;
  title: string;
  savedAt: number;
  files: LockedEntry[];
  /** fileSalt (enc.s) → raw AES key, base64 */
  keys: Record<string, string>;
}

interface FoundManifest {
  msgIds: number[];
  saltB64: string;
  data: string;
}

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto indisponível.");
  return s;
};
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
const strict = (b: Uint8Array) => {
  const out = new Uint8Array(new ArrayBuffer(b.byteLength));
  out.set(b);
  return out;
};

export class WrongSharePasswordError extends Error {
  constructor() {
    super("Senha incorreta.");
    this.name = "WrongSharePasswordError";
  }
}

async function deriveShareKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey("raw", strict(new TextEncoder().encode(password)), "PBKDF2", false, [
    "deriveKey",
  ]);
  return subtle().deriveKey(
    { name: "PBKDF2", salt: strict(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

async function importAesKey(rawB64: string): Promise<CryptoKey> {
  return subtle().importKey("raw", strict(base64ToBytes(rawB64)), { name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

async function sealManifest(m: LockedManifest, key: CryptoKey): Promise<string> {
  const iv = rand(12);
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv }, key, strict(gzipSync(strToU8(JSON.stringify(m)), { level: 9 })))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return bytesToBase64(out);
}

async function openManifest(data: string, key: CryptoKey): Promise<LockedManifest> {
  const bytes = base64ToBytes(data);
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: "AES-GCM", iv: strict(bytes.slice(0, 12)) }, key, strict(bytes.slice(12)));
  } catch {
    throw new WrongSharePasswordError();
  }
  const m = JSON.parse(strFromU8(gunzipSync(new Uint8Array(plain))));
  if (!m || m.v !== 1 || !Array.isArray(m.files)) throw new Error("Manifesto do compartilhamento inválido.");
  return m as LockedManifest;
}

async function postManifest(peer: any, data: string, saltB64: string): Promise<number[]> {
  const client = getClient();
  const id = bytesToBase64(rand(6)).replace(/[^\w]/g, "");
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += MANIFEST_CHUNK) chunks.push(data.slice(i, i + MANIFEST_CHUNK));
  const ids: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const header = JSON.stringify({ id, i, n: chunks.length, s: saltB64 });
    const sent: any = await client.sendMessage(peer, { message: `${LOCK_PREFIX}${header}\n${chunks[i]}` });
    ids.push(Number(sent.id));
  }
  return ids;
}

/** Newest complete encrypted manifest in the channel, or null if it isn't a protected share. */
async function findManifest(peer: any): Promise<FoundManifest | null> {
  const client = getClient();
  const groups = new Map<string, { n: number; s: string; parts: Map<number, { text: string; msgId: number }>; newest: number }>();
  let offsetId = 0;
  for (let page = 0; page < MANIFEST_SCAN_PAGES; page++) {
    const msgs: any[] = await client.getMessages(peer, { limit: 100, ...(offsetId > 0 ? { offsetId } : {}) });
    if (!Array.isArray(msgs) || msgs.length === 0) break;
    let oldest = offsetId;
    for (const msg of msgs) {
      const mid = Number(msg?.id);
      if (!(mid > 0)) continue;
      oldest = oldest === 0 ? mid : Math.min(oldest, mid);
      const text = String(msg?.message ?? "");
      if (!text.startsWith(LOCK_PREFIX)) continue;
      const nl = text.indexOf("\n");
      if (nl < 0) continue;
      try {
        const h = JSON.parse(text.slice(LOCK_PREFIX.length, nl));
        if (!groups.has(h.id)) groups.set(h.id, { n: h.n, s: h.s, parts: new Map(), newest: 0 });
        const g = groups.get(h.id)!;
        g.parts.set(Number(h.i), { text: text.slice(nl + 1), msgId: mid });
        g.newest = Math.max(g.newest, mid);
      } catch {
        /* ignore malformed */
      }
    }
    const complete = [...groups.values()].filter((g) => g.parts.size === g.n).sort((a, b) => b.newest - a.newest);
    if (complete.length > 0) {
      const g = complete[0];
      const ordered = [...g.parts.entries()].sort((a, b) => a[0] - b[0]);
      return { saltB64: g.s, data: ordered.map(([, p]) => p.text).join(""), msgIds: ordered.map(([, p]) => p.msgId) };
    }
    if (oldest === offsetId || msgs.length < 100) break;
    offsetId = oldest;
  }
  return null;
}

/** True when the channel holds a password-protected share. */
export async function isProtectedShare(channelId: string): Promise<boolean> {
  const peer = await getClient().getInputEntity(canonicalChannelId(channelId));
  return (await findManifest(peer)) !== null;
}

async function exportKeysFor(files: TeleFile[]): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};
  for (const f of files) {
    const salt = f.enc?.s;
    if (!salt || keys[salt]) continue;
    const key = await requireEncryptionKey(salt);
    keys[salt] = bytesToBase64(new Uint8Array(await subtle().exportKey("raw", key)));
  }
  return keys;
}

async function cloneCiphertext(srcPeer: any, destPeer: any, file: TeleFile): Promise<LockedEntry> {
  const client = getClient();
  const segs = resolveFileSegments(file);
  if (segs.length === 0) throw new Error("no segments");
  const msgs = await client.getMessages(srcPeer, { ids: segs.map((s) => s.messageId) });
  const byId = new Map<number, any>();
  for (const m of Array.isArray(msgs) ? msgs : []) if (m?.id) byId.set(Number(m.id), m);
  const ids: number[] = [];
  const segSizes: number[] = [];
  for (const seg of segs) {
    const doc = byId.get(seg.messageId)?.media?.document;
    if (!doc) throw new Error("document missing");
    const sent: any = await client.sendFile(destPeer, { file: doc, forceDocument: true, caption: "" });
    ids.push(Number(sent.id));
    segSizes.push(Number(doc.size) || seg.size || 0);
  }
  return {
    src: file.id,
    name: file.name,
    folder: "/",
    size: file.size,
    mime: file.mime,
    enc: file.enc!,
    ids,
    segSizes,
    at: file.uploadedAt,
  };
}

function relFolder(root: string, fp: string): string {
  return normalizeFolderPath(normalizeFolderPath(fp).slice(normalizeFolderPath(root).length));
}

const ownerSecretKey = (channelId: string) => `share_lock_owner_${canonicalChannelId(channelId)}`;
const recvSecretKey = (channelId: string) => `share_lock_keys_${canonicalChannelId(channelId)}`;

/** Create a password-protected share with the encrypted files of `folder`. */
export async function shareFolderProtected(
  folder: TeleFile,
  allFiles: TeleFile[],
  password: string,
  onProgress?: (p: ShareProgress) => void
): Promise<FolderShareResult & { skippedPlain: number }> {
  if (password.length < 6) throw new Error("A senha precisa ter pelo menos 6 caracteres.");
  const client = getClient();
  if (!client.connected) await client.connect();

  const root = folderFullPath(folder);
  const candidates = collectFolderFiles(allFiles, root);
  const encrypted = candidates.filter((f) => f.enc?.v === 1);
  const skippedPlain = candidates.length - encrypted.length;
  if (encrypted.length === 0) {
    throw new Error("Esta pasta não tem arquivos criptografados para compartilhar com senha.");
  }

  // Unlock/export keys first so a locked vault fails before creating anything.
  const keys = await exportKeysFor(encrypted);

  const result: any = await client.invoke(
    new Api.channels.CreateChannel({
      title: `TeleDrive 🔒 ${bytesToBase64(rand(3)).replace(/[^\w]/g, "").slice(0, 4)}`,
      about: "Compartilhamento protegido por senha. Abra no TeleDrive para ver o conteúdo.",
      broadcast: true,
    })
  );
  const channel = (result?.chats || [])[0];
  if (!channel) throw new Error("Falha ao criar o canal de compartilhamento.");
  const channelId = canonicalChannelId(utils.getPeerId(channel));
  const destPeer = utils.getInputPeer(channel);
  const srcPeer = await client.getInputEntity(canonicalChannelId(encrypted[0].channelId));

  const entries: LockedEntry[] = [];
  let failed = 0;
  for (let i = 0; i < encrypted.length; i++) {
    const f = encrypted[i];
    onProgress?.({ done: i, total: encrypted.length, current: f.name });
    try {
      const e = await cloneCiphertext(srcPeer, destPeer, f);
      e.folder = relFolder(root, f.folderPath);
      entries.push(e);
    } catch (err) {
      failed++;
      console.warn("[protectedShare] clone failed", f.name, err);
    }
    onProgress?.({ done: i + 1, total: encrypted.length });
  }

  const salt = rand(16);
  const shareKey = await deriveShareKey(password, salt);
  const saltB64 = bytesToBase64(salt);
  const manifest: LockedManifest = { v: 1, title: folder.name, savedAt: Date.now(), files: entries, keys };
  await postManifest(destPeer, await sealManifest(manifest, shareKey), saltB64);

  // Owner keeps the derived key so "Update contents" works without retyping the password.
  const rawShareKey = bytesToBase64(new Uint8Array(await subtle().exportKey("raw", shareKey)));
  await saveSecret(ownerSecretKey(channelId), JSON.stringify({ s: saltB64, k: rawShareKey }));

  const invite: any = await client.invoke(new Api.messages.ExportChatInvite({ peer: destPeer, title: "TeleDrive" }));
  if (typeof invite?.link !== "string") throw new Error("Telegram não retornou o link de convite.");

  return {
    channelId,
    link: invite.link,
    title: folder.name,
    shared: entries.length,
    skippedEncrypted: 0,
    skippedPlain,
    failed,
  };
}

/** Owner: bring a protected share up to date (same link, same password). */
export async function syncProtectedShare(
  channelId: string,
  folderPath: string,
  allFiles: TeleFile[],
  onProgress?: (p: ShareProgress) => void
): Promise<{ added: number; removed: number }> {
  const client = getClient();
  if (!client.connected) await client.connect();
  const secret = await getSecret(ownerSecretKey(channelId));
  if (!secret) throw new Error("A chave deste compartilhamento não está neste aparelho.");
  const { s: saltB64, k } = JSON.parse(secret);
  const shareKey = await importAesKey(k);

  const peer = await client.getInputEntity(canonicalChannelId(channelId));
  const found = await findManifest(peer);
  if (!found) throw new Error("Manifesto do compartilhamento não encontrado.");
  const manifest = await openManifest(found.data, shareKey);

  const root = normalizeFolderPath(folderPath);
  const wanted = collectFolderFiles(allFiles, root).filter((f) => f.enc?.v === 1);
  const wantedById = new Map(wanted.map((f) => [f.id, f]));
  const keep = manifest.files.filter((e) => {
    const f = wantedById.get(e.src);
    return f && f.name === e.name && relFolder(root, f.folderPath) === e.folder;
  });
  const keptSrc = new Set(keep.map((e) => e.src));
  const removedIds = manifest.files.filter((e) => !keep.includes(e)).flatMap((e) => e.ids);
  const toAdd = wanted.filter((f) => !keptSrc.has(f.id));

  const added: LockedEntry[] = [];
  if (toAdd.length > 0) {
    const srcPeer = await client.getInputEntity(canonicalChannelId(toAdd[0].channelId));
    for (let i = 0; i < toAdd.length; i++) {
      onProgress?.({ done: i, total: toAdd.length, current: toAdd[i].name });
      try {
        const e = await cloneCiphertext(srcPeer, peer, toAdd[i]);
        e.folder = relFolder(root, toAdd[i].folderPath);
        added.push(e);
      } catch (err) {
        console.warn("[protectedShare] sync clone failed", toAdd[i].name, err);
      }
      onProgress?.({ done: i + 1, total: toAdd.length });
    }
  }

  const files = [...keep, ...added];
  const keys = { ...manifest.keys, ...(await exportKeysFor(added.map((e) => ({ enc: e.enc }) as TeleFile))) };
  const next: LockedManifest = { ...manifest, savedAt: Date.now(), files, keys };
  await postManifest(peer, await sealManifest(next, shareKey), saltB64);

  const del = [...removedIds, ...found.msgIds];
  for (let i = 0; i < del.length; i += 100) {
    await client.deleteMessages(peer, del.slice(i, i + 100), { revoke: true });
  }
  return { added: added.length, removed: manifest.files.length - keep.length };
}

function toTeleFiles(m: LockedManifest, channelId: string): TeleFile[] {
  return m.files
    .map((e) => {
      const segments: TeleFileSegment[] = e.ids.map((id, i) => ({ messageId: id, size: e.segSizes[i] ?? 0 }));
      return {
        id: `share_${channelId}_${e.ids[0]}`,
        name: e.name,
        size: e.size,
        mime: e.mime,
        folderPath: normalizeFolderPath(e.folder),
        messageId: e.ids[0],
        channelId,
        uploadedAt: e.at,
        enc: e.enc,
        ...(segments.length > 1 ? { segments } : {}),
      } as TeleFile;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function registerKeys(keys: Record<string, string>): Promise<void> {
  for (const [salt, raw] of Object.entries(keys)) {
    registerExternalDecryptionKey(salt, await importAesKey(raw));
  }
}

/** Recipient: unlock a protected share with its password. */
export async function unlockProtectedShare(
  channelId: string,
  password: string
): Promise<{ title: string; files: TeleFile[] }> {
  const client = getClient();
  if (!client.connected) await client.connect();
  const peer = await client.getInputEntity(canonicalChannelId(channelId));
  const found = await findManifest(peer);
  if (!found) throw new Error("Este compartilhamento não é protegido por senha.");
  const key = await deriveShareKey(password, base64ToBytes(found.saltB64));
  const manifest = await openManifest(found.data, key);
  await registerKeys(manifest.keys);
  const k = bytesToBase64(new Uint8Array(await subtle().exportKey("raw", key)));
  await saveSecret(recvSecretKey(channelId), JSON.stringify({ keys: manifest.keys, k }));
  return { title: manifest.title, files: toTeleFiles(manifest, channelId) };
}

/** Recipient: reload the file list using the share key saved at unlock time. */
export async function refreshProtectedShare(channelId: string): Promise<{ title: string; files: TeleFile[] } | null> {
  const raw = await getSecret(recvSecretKey(channelId)).catch(() => null);
  if (!raw) return null;
  const saved = JSON.parse(raw);
  if (!saved?.k) return null;
  const client = getClient();
  if (!client.connected) await client.connect();
  const peer = await client.getInputEntity(canonicalChannelId(channelId));
  const found = await findManifest(peer);
  if (!found) return null;
  try {
    const manifest = await openManifest(found.data, await importAesKey(saved.k));
    await registerKeys(manifest.keys);
    await saveSecret(recvSecretKey(channelId), JSON.stringify({ keys: manifest.keys, k: saved.k }));
    return { title: manifest.title, files: toTeleFiles(manifest, channelId) };
  } catch {
    return null;
  }
}

/** Recipient: re-register saved keys after an app restart. Returns false if none are stored. */
export async function restoreProtectedShareKeys(channelId: string): Promise<boolean> {
  const raw = await getSecret(recvSecretKey(channelId)).catch(() => null);
  if (!raw) return false;
  try {
    const saved = JSON.parse(raw);
    await registerKeys(saved?.keys ?? {});
    return true;
  } catch {
    return false;
  }
}

export async function forgetProtectedShare(channelId: string): Promise<void> {
  await deleteSecret(recvSecretKey(channelId)).catch(() => {});
  await deleteSecret(ownerSecretKey(channelId)).catch(() => {});
}

/** @internal exposed for unit tests only */
export const __test = { sealManifest, openManifest, deriveShareKey };
