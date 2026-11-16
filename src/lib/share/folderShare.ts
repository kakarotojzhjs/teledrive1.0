import { Api, utils } from "telegram";
import { getClient } from "../telegram/client";
import { canonicalChannelId } from "../telegram/peerId";
import { normalizeFolderPath } from "../files/pathUtils";
import { resolveFileSegments } from "../files/segmentHelpers";
import type { TeleFile, TeleFileSegment } from "../types";

/**
 * Folder sharing by link.
 *
 * Sharing a folder creates a dedicated Telegram channel ("TeleDrive Share · <name>"),
 * clones every file of the folder into it (zero-byte server clone — the same
 * MTProto documents are re-sent, nothing is re-uploaded) and exports an invite
 * link. Anyone with the link can:
 *   - open it in Telegram and see/download the files directly, or
 *   - paste it in TeleDrive ("Shared with me") to browse the folder tree and
 *     download files / the whole folder as ZIP.
 *
 * The shared channel is self-describing: every file message carries a
 * `teledrive_file:{folder,name,src}` caption with the path relative to the
 * shared folder root, so no separate index is needed. Revoking deletes the
 * channel for everyone.
 *
 * Client-side encrypted (TDE1) files are skipped: recipients do not have the
 * owner's key, so the bytes would be unreadable.
 */

export const SHARE_CHANNEL_PREFIX = "TeleDrive Share · ";
const FILE_CAPTION = "teledrive_file:";
const PART_CAPTION = "teledrive_file_part:";
const PAGE_SIZE = 100;
const MAX_SCAN_MESSAGES = 20_000;

export interface ShareProgress {
  done: number;
  total: number;
  current?: string;
}

export interface FolderShareResult {
  channelId: string;
  link: string;
  title: string;
  shared: number;
  skippedEncrypted: number;
  failed: number;
}

export interface SharedFolderContents {
  channelId: string;
  title: string;
  files: TeleFile[];
}

function isDirectory(f: TeleFile): boolean {
  return f.mime === "inode/directory" || f.mime === "application/x-directory";
}

export function folderFullPath(folder: TeleFile): string {
  const parent = normalizeFolderPath(folder.folderPath);
  return parent === "/" ? `/${folder.name}` : `${parent}/${folder.name}`;
}

/** Files (not folders) that live under `rootPath`, excluding trashed ones. */
export function collectFolderFiles(allFiles: TeleFile[], rootPath: string): TeleFile[] {
  const root = normalizeFolderPath(rootPath);
  return allFiles.filter((f) => {
    if (isDirectory(f) || f.trashed || !(Number(f.messageId) > 0)) return false;
    const fp = normalizeFolderPath(f.folderPath);
    return fp === root || fp.startsWith(`${root}/`);
  });
}

function relativeFolder(rootPath: string, filePath: string): string {
  const root = normalizeFolderPath(rootPath);
  const fp = normalizeFolderPath(filePath);
  return normalizeFolderPath(fp.slice(root.length));
}

/** Extracts the invite hash from t.me/+HASH, t.me/joinchat/HASH or tg://join?invite=HASH. */
export function parseInviteHash(link: string): string | null {
  const s = link.trim();
  const patterns = [
    /t(?:elegram)?\.me\/\+([\w-]+)/i,
    /t(?:elegram)?\.me\/joinchat\/([\w-]+)/i,
    /tg:\/\/join\?invite=([\w-]+)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  if (/^\+?[\w-]{10,}$/.test(s)) return s.replace(/^\+/, "");
  return null;
}

async function createShareChannel(title: string): Promise<{ entity: any; channelId: string }> {
  const client = getClient();
  const result: any = await client.invoke(
    new Api.channels.CreateChannel({
      title: `${SHARE_CHANNEL_PREFIX}${title}`.slice(0, 128),
      about: "Pasta compartilhada pelo TeleDrive. Abra este link no TeleDrive (Compartilhados) ou baixe os arquivos aqui.",
      broadcast: true,
    })
  );
  const channel = (result?.chats || [])[0];
  if (!channel) throw new Error("Falha ao criar o canal de compartilhamento.");
  return { entity: channel, channelId: canonicalChannelId(utils.getPeerId(channel)) };
}

async function exportInvite(peer: any): Promise<string> {
  const client = getClient();
  const invite: any = await client.invoke(
    new Api.messages.ExportChatInvite({ peer, title: "TeleDrive" })
  );
  const link = invite?.link;
  if (typeof link !== "string" || !link) throw new Error("Telegram não retornou o link de convite.");
  return link;
}

/**
 * Clone one TeleDrive file (all its segments) into `destPeer`, captioned with
 * its path relative to the shared root.
 */
async function cloneIntoShare(
  srcPeer: any,
  destPeer: any,
  file: TeleFile,
  relFolder: string
): Promise<void> {
  const client = getClient();
  const segs = resolveFileSegments(file);
  if (segs.length === 0) throw new Error("no segments");
  const msgs = await client.getMessages(srcPeer, { ids: segs.map((s) => s.messageId) });
  const byId = new Map<number, any>();
  for (const m of Array.isArray(msgs) ? msgs : []) if (m?.id) byId.set(Number(m.id), m);

  for (let i = 0; i < segs.length; i++) {
    const doc = byId.get(segs[i].messageId)?.media?.document;
    if (!doc) throw new Error("document missing");
    const meta = {
      folder: relFolder,
      name: file.name,
      src: file.id,
      ...(segs.length > 1 ? { seg: i, totalSegs: segs.length } : {}),
    };
    const caption = i === 0 ? `${FILE_CAPTION}${JSON.stringify(meta)}` : `${PART_CAPTION}${JSON.stringify(meta)}`;
    await client.sendFile(destPeer, { file: doc, forceDocument: true, caption });
  }
}

/** Create a share channel for `folder`, clone its files and return the invite link. */
export async function shareFolder(
  folder: TeleFile,
  allFiles: TeleFile[],
  onProgress?: (p: ShareProgress) => void
): Promise<FolderShareResult> {
  const client = getClient();
  if (!client.connected) await client.connect();

  const root = folderFullPath(folder);
  const candidates = collectFolderFiles(allFiles, root);
  const plain = candidates.filter((f) => !f.enc);
  const skippedEncrypted = candidates.length - plain.length;
  if (plain.length === 0) {
    throw new Error(
      skippedEncrypted > 0
        ? "Esta pasta só tem arquivos criptografados, que não podem ser compartilhados."
        : "Esta pasta está vazia."
    );
  }

  const { entity, channelId } = await createShareChannel(folder.name);
  const destPeer = utils.getInputPeer(entity);
  const srcPeer = await client.getInputEntity(canonicalChannelId(plain[0].channelId));

  let done = 0;
  let failed = 0;
  onProgress?.({ done, total: plain.length });
  for (const file of plain) {
    onProgress?.({ done, total: plain.length, current: file.name });
    try {
      await cloneIntoShare(srcPeer, destPeer, file, relativeFolder(root, file.folderPath));
    } catch (err) {
      failed++;
      console.warn("[folderShare] clone failed", file.name, err);
    }
    done++;
    onProgress?.({ done, total: plain.length });
  }

  const link = await exportInvite(destPeer);
  return {
    channelId,
    link,
    title: folder.name,
    shared: plain.length - failed,
    skippedEncrypted,
    failed,
  };
}

/** Parse a share-channel message into a file (primary) or a part. */
function parseShareMessage(
  msg: any,
  channelId: string
):
  | { kind: "file"; file: TeleFile; totalSegs: number; key: string }
  | { kind: "part"; key: string; seg: number; segment: TeleFileSegment }
  | null {
  const doc = msg?.media?.document;
  if (!doc) return null;
  const caption = String(msg?.message ?? "").trim();
  const isPrimary = caption.startsWith(FILE_CAPTION);
  const isPart = caption.startsWith(PART_CAPTION);
  if (!isPrimary && !isPart) return null;

  let meta: any;
  try {
    meta = JSON.parse(caption.slice(isPrimary ? FILE_CAPTION.length : PART_CAPTION.length));
  } catch {
    return null;
  }
  if (!meta || typeof meta.folder !== "string") return null;

  const attrs: any[] = Array.isArray(doc.attributes) ? doc.attributes : [];
  const fnAttr = attrs.find((a) => a?.className === "DocumentAttributeFilename");
  const name: string =
    (typeof meta.name === "string" && meta.name.trim()) ||
    (typeof fnAttr?.fileName === "string" && fnAttr.fileName.trim()) ||
    `file-${Number(msg.id)}`;
  const folder = normalizeFolderPath(meta.folder);
  const key = `${meta.src ?? ""}|${folder}|${name}`;
  const size = Number(doc.size) || 0;

  if (isPart) {
    return { kind: "part", key, seg: Number(meta.seg) || 0, segment: { messageId: Number(msg.id), size } };
  }
  const totalSegs = Number(meta.totalSegs) || 1;
  return {
    kind: "file",
    key,
    totalSegs,
    file: {
      id: `share_${channelId}_${Number(msg.id)}`,
      name,
      size,
      mime: doc.mimeType || "application/octet-stream",
      folderPath: folder,
      messageId: Number(msg.id),
      channelId,
      uploadedAt: (Number(msg.date) || 0) * 1000,
    },
  };
}

/** Read every shared file from a share channel (read-only). */
export async function listSharedFiles(channelId: string): Promise<TeleFile[]> {
  const client = getClient();
  if (!client.connected) await client.connect();
  const peer = await client.getInputEntity(canonicalChannelId(channelId));

  const primaries = new Map<string, { file: TeleFile; totalSegs: number }>();
  const parts = new Map<string, Map<number, TeleFileSegment>>();
  let offsetId = 0;
  let scanned = 0;

  while (scanned < MAX_SCAN_MESSAGES) {
    const page: any[] = await client.getMessages(peer, {
      filter: new Api.InputMessagesFilterDocument(),
      limit: PAGE_SIZE,
      ...(offsetId > 0 ? { offsetId } : {}),
    });
    if (!Array.isArray(page) || page.length === 0) break;
    let oldest = offsetId;
    for (const msg of page) {
      const id = Number(msg?.id);
      if (!(id > 0)) continue;
      oldest = oldest === 0 ? id : Math.min(oldest, id);
      scanned++;
      const parsed = parseShareMessage(msg, channelId);
      if (!parsed) continue;
      if (parsed.kind === "file") {
        // Newest wins if the same file was shared twice.
        if (!primaries.has(parsed.key)) primaries.set(parsed.key, { file: parsed.file, totalSegs: parsed.totalSegs });
      } else {
        if (!parts.has(parsed.key)) parts.set(parsed.key, new Map());
        const m = parts.get(parsed.key)!;
        if (!m.has(parsed.seg)) m.set(parsed.seg, parsed.segment);
      }
    }
    if (oldest === offsetId || page.length < PAGE_SIZE) break;
    offsetId = oldest;
  }

  const files: TeleFile[] = [];
  for (const [key, { file, totalSegs }] of primaries) {
    if (totalSegs > 1) {
      const p = parts.get(key);
      const segments: TeleFileSegment[] = [{ messageId: file.messageId, size: file.size }];
      let complete = true;
      for (let i = 1; i < totalSegs; i++) {
        const s = p?.get(i);
        if (!s) {
          complete = false;
          break;
        }
        segments.push(s);
      }
      if (!complete) continue;
      file.segments = segments;
      file.size = segments.reduce((a, s) => a + s.size, 0);
    }
    files.push(file);
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Join (or reuse) the channel behind an invite link and list its files. */
export async function openSharedLink(link: string): Promise<SharedFolderContents> {
  const hash = parseInviteHash(link);
  if (!hash) throw new Error("Link inválido. Use um link no formato https://t.me/+XXXX");
  const client = getClient();
  if (!client.connected) await client.connect();

  const check: any = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
  let chat: any = check?.chat;
  if (check?.className !== "ChatInviteAlready") {
    const updates: any = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
    chat = (updates?.chats || [])[0];
  }
  if (!chat) throw new Error("Não foi possível entrar no compartilhamento.");

  const channelId = canonicalChannelId(utils.getPeerId(chat));
  const rawTitle = String(chat.title || "Compartilhado");
  const title = rawTitle.startsWith(SHARE_CHANNEL_PREFIX)
    ? rawTitle.slice(SHARE_CHANNEL_PREFIX.length)
    : rawTitle;
  const files = await listSharedFiles(channelId);
  return { channelId, title, files };
}

/**
 * Bring an existing share up to date with the folder: clone new files and
 * delete messages of files that were removed/trashed. The link stays the same.
 */
export async function syncShare(
  shareChannelId: string,
  folderPath: string,
  allFiles: TeleFile[],
  onProgress?: (p: ShareProgress) => void
): Promise<{ added: number; removed: number }> {
  const client = getClient();
  if (!client.connected) await client.connect();
  const destPeer = await client.getInputEntity(canonicalChannelId(shareChannelId));
  const root = normalizeFolderPath(folderPath);
  const wanted = collectFolderFiles(allFiles, root).filter((f) => !f.enc);

  // Map src id → message ids currently in the share.
  const present = new Map<string, number[]>();
  let offsetId = 0;
  for (let scanned = 0; scanned < MAX_SCAN_MESSAGES; ) {
    const page: any[] = await client.getMessages(destPeer, {
      filter: new Api.InputMessagesFilterDocument(),
      limit: PAGE_SIZE,
      ...(offsetId > 0 ? { offsetId } : {}),
    });
    if (!Array.isArray(page) || page.length === 0) break;
    let oldest = offsetId;
    for (const msg of page) {
      const id = Number(msg?.id);
      if (!(id > 0)) continue;
      oldest = oldest === 0 ? id : Math.min(oldest, id);
      scanned++;
      const caption = String(msg?.message ?? "");
      const prefix = caption.startsWith(FILE_CAPTION) ? FILE_CAPTION : caption.startsWith(PART_CAPTION) ? PART_CAPTION : null;
      if (!prefix) continue;
      try {
        const meta = JSON.parse(caption.slice(prefix.length));
        const key = `${meta.src}|${normalizeFolderPath(meta.folder)}|${meta.name}`;
        if (!present.has(key)) present.set(key, []);
        present.get(key)!.push(id);
      } catch {
        /* ignore */
      }
    }
    if (oldest === offsetId || page.length < PAGE_SIZE) break;
    offsetId = oldest;
  }

  const wantedKeys = new Map<string, TeleFile>();
  for (const f of wanted) wantedKeys.set(`${f.id}|${relativeFolder(root, f.folderPath)}|${f.name}`, f);

  const toAdd = [...wantedKeys.entries()].filter(([k]) => !present.has(k));
  const toRemove = [...present.entries()].filter(([k]) => !wantedKeys.has(k)).flatMap(([, ids]) => ids);

  if (toRemove.length > 0) {
    for (let i = 0; i < toRemove.length; i += 100) {
      await client.deleteMessages(destPeer, toRemove.slice(i, i + 100), { revoke: true });
    }
  }

  let added = 0;
  if (toAdd.length > 0) {
    const srcPeer = await client.getInputEntity(canonicalChannelId(toAdd[0][1].channelId));
    let done = 0;
    onProgress?.({ done, total: toAdd.length });
    for (const [, file] of toAdd) {
      onProgress?.({ done, total: toAdd.length, current: file.name });
      try {
        await cloneIntoShare(srcPeer, destPeer, file, relativeFolder(root, file.folderPath));
        added++;
      } catch (err) {
        console.warn("[folderShare] sync clone failed", file.name, err);
      }
      done++;
      onProgress?.({ done, total: toAdd.length });
    }
  }
  return { added, removed: toRemove.length };
}

/** Stop sharing: deletes the share channel for everyone (owner only). */
export async function revokeShare(channelId: string): Promise<void> {
  const client = getClient();
  if (!client.connected) await client.connect();
  const channel = await client.getInputEntity(canonicalChannelId(channelId));
  await client.invoke(new Api.channels.DeleteChannel({ channel }));
}

/** Leave a share you opened from someone else's link. */
export async function leaveShare(channelId: string): Promise<void> {
  const client = getClient();
  if (!client.connected) await client.connect();
  const channel = await client.getInputEntity(canonicalChannelId(channelId));
  await client.invoke(new Api.channels.LeaveChannel({ channel }));
}
