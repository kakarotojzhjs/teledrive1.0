import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  FileArchive,
  Link2,
  Loader2,
  Lock,
  LogOut,
  RefreshCw,
  Settings2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileIcon } from "@/components/files/FileIcon";
import { FolderIcon } from "@/components/files/FolderIcon";
import { formatFileSize } from "@/components/files/FileBrowser";
import { copyText, requestShareFolder } from "@/components/share/ShareFolderDialog";
import { useAuthStore } from "@/stores/authStore";
import { useFileStore } from "@/stores/fileStore";
import { shareAccountKey, useShareStore, type ReceivedShare } from "@/stores/shareStore";
import { leaveShare, listSharedFiles, openSharedLink } from "@/lib/share/folderShare";
import {
  WrongSharePasswordError,
  forgetProtectedShare,
  isProtectedShare,
  refreshProtectedShare,
  restoreProtectedShareKeys,
  unlockProtectedShare,
} from "@/lib/share/protectedShare";
import { normalizeFolderPath } from "@/lib/files/pathUtils";
import { downloadFileFromTelegram } from "@/lib/telegram/downloader";
import { downloadSelectionAsZip } from "@/lib/telegram/zipDownloader";
import type { TeleFile } from "@/lib/types";

const rowCls =
  "flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[#f0f4f9] dark:bg-[#161719] hover:bg-[#e1e7ef] dark:hover:bg-[#1f2124] text-[#1f1f1f] dark:text-[#e3e3e3]";

function dirEntry(name: string, parent: string, channelId: string): TeleFile {
  return {
    id: `share_dir_${channelId}_${parent}/${name}`,
    name,
    size: 0,
    mime: "inode/directory",
    folderPath: parent,
    messageId: 0,
    channelId,
    uploadedAt: 0,
  };
}

function downloadOne(file: TeleFile) {
  downloadFileFromTelegram(file.channelId, file.messageId, file.name, undefined, {
    segments: file.segments,
    enc: file.enc,
    plainSize: file.enc?.plainSize ?? file.size,
  }).catch((err) => {
    console.error("[SharedPage] download failed", err);
    toast.error(err?.message || "Download failed");
  });
}

function SharedBrowser({ share, onBack }: { share: ReceivedShare; onBack: () => void }) {
  const { t } = useTranslation("share");
  const account = shareAccountKey(useAuthStore((s) => s.phoneNumber));
  const upsertReceived = useShareStore((s) => s.upsertReceived);
  const removeReceived = useShareStore((s) => s.removeReceived);
  const [path, setPath] = useState("/");
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  // Protected shares: re-register saved decryption keys after an app restart.
  useEffect(() => {
    if (!share.locked || !share.unlocked) return;
    void restoreProtectedShareKeys(share.channelId).then((ok) => {
      if (!ok) upsertReceived(account, { ...share, unlocked: false, files: [] });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [share.channelId]);

  const { folders, files } = useMemo(() => {
    const here = normalizeFolderPath(path);
    const sub = new Set<string>();
    const list: TeleFile[] = [];
    for (const f of share.files) {
      const fp = normalizeFolderPath(f.folderPath);
      if (fp === here) list.push(f);
      else if (here === "/" ? fp.startsWith("/") : fp.startsWith(`${here}/`)) {
        const rest = fp.slice(here === "/" ? 1 : here.length + 1);
        const first = rest.split("/")[0];
        if (first) sub.add(first);
      }
    }
    return { folders: [...sub].sort((a, b) => a.localeCompare(b)), files: list };
  }, [share.files, path]);

  const crumbs = normalizeFolderPath(path).split("/").filter(Boolean);

  const refresh = async () => {
    setLoading(true);
    try {
      if (share.locked) {
        const r = await refreshProtectedShare(share.channelId);
        if (!r) {
          upsertReceived(account, { ...share, unlocked: false, files: [] });
          return;
        }
        upsertReceived(account, { ...share, title: r.title, files: r.files, openedAt: Date.now() });
        return;
      }
      const list = await listSharedFiles(share.channelId);
      upsertReceived(account, { ...share, files: list, openedAt: Date.now() });
    } catch (err: any) {
      toast.error(err?.message || t("refreshError", "Could not refresh"));
    } finally {
      setLoading(false);
    }
  };

  const downloadZip = (subPath: string, name: string) => {
    // Re-root the shared tree under a synthetic top folder so the ZIP keeps the structure.
    const top = `/${share.title}`;
    const all = share.files.map((f) => ({
      ...f,
      folderPath: normalizeFolderPath(`${top}${normalizeFolderPath(f.folderPath)}`),
    }));
    const target =
      subPath === "/"
        ? dirEntry(share.title, "/", share.channelId)
        : (() => {
            const full = normalizeFolderPath(`${top}${subPath}`);
            const parent = full.slice(0, full.lastIndexOf("/")) || "/";
            return dirEntry(name, parent, share.channelId);
          })();
    downloadSelectionAsZip(all, [target]).catch((err) => toast.error(err?.message || "ZIP failed"));
  };

  const leave = async () => {
    if (!window.confirm(t("leaveConfirm", "Remove this shared folder from your list?"))) return;
    try {
      await leaveShare(share.channelId);
    } catch (err) {
      console.warn(err);
    }
    await forgetProtectedShare(share.channelId);
    removeReceived(account, share.channelId);
    onBack();
  };

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || unlocking) return;
    setUnlocking(true);
    try {
      const r = await unlockProtectedShare(share.channelId, password);
      upsertReceived(account, { ...share, title: r.title, files: r.files, unlocked: true, openedAt: Date.now() });
      setPassword("");
    } catch (err: any) {
      toast.error(
        err instanceof WrongSharePasswordError
          ? t("wrongPassword", "Wrong password")
          : err?.message || t("openError", "Could not open this link")
      );
    } finally {
      setUnlocking(false);
    }
  };

  if (share.locked && !share.unlocked) {
    return (
      <div className="flex flex-col gap-4 p-4 sm:p-6 max-w-md">
        <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
          <span className="ml-1.5">{t("back", "Back")}</span>
        </Button>
        <div className="flex items-center gap-2 text-base font-semibold">
          <Lock className="h-4 w-4" /> {t("lockedTitle", "This folder is password protected")}
        </div>
        <form onSubmit={unlock} className="flex gap-2">
          <Input
            type="password"
            autoFocus
            placeholder={t("enterPassword", "Enter the password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" disabled={unlocking || !password}>
            {unlocking ? <Loader2 className="h-4 w-4 animate-spin" /> : t("unlock", "Unlock")}
          </Button>
        </form>
        <Button variant="ghost" size="sm" className="self-start text-red-600" onClick={leave}>
          <LogOut className="h-4 w-4" />
          <span className="ml-1.5">{t("remove", "Remove")}</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6 max-w-4xl">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={t("back", "Back")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <nav className="flex items-center gap-1 text-sm min-w-0 flex-1 overflow-x-auto">
          <button className="font-semibold hover:underline truncate" onClick={() => setPath("/")}>
            {share.title}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 opacity-60" />
              <button className="hover:underline" onClick={() => setPath(`/${crumbs.slice(0, i + 1).join("/")}`)}>
                {c}
              </button>
            </span>
          ))}
        </nav>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
        <Button
          size="sm"
          onClick={() => downloadZip(normalizeFolderPath(path), crumbs[crumbs.length - 1] || share.title)}
          disabled={share.files.length === 0}
        >
          <FileArchive className="h-4 w-4" />
          <span className="ml-1.5">{t("downloadZip", "Download ZIP")}</span>
        </Button>
        <Button variant="ghost" size="sm" className="text-red-600" onClick={leave}>
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        {folders.map((name) => (
          <div key={`d:${name}`} className={`${rowCls} cursor-pointer`} onClick={() => setPath(normalizeFolderPath(`${path}/${name}`))}>
            <FolderIcon size="sm" className="h-5 w-5 shrink-0" />
            <span className="text-sm font-medium truncate flex-1">{name}</span>
            <ChevronRight className="h-4 w-4 opacity-60" />
          </div>
        ))}
        {files.map((f) => (
          <div key={f.id} className={rowCls}>
            <FileIcon name={f.name} mime={f.mime} size="sm" />
            <span className="text-sm truncate flex-1">{f.name}</span>
            <span className="text-xs opacity-70 shrink-0">{formatFileSize(f.size)}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("preview", "Preview")}
              onClick={() => window.dispatchEvent(new CustomEvent("teledrive-preview-file", { detail: f }))}
            >
              <Eye className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label={t("download", "Download")} onClick={() => downloadOne(f)}>
              <Download className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {folders.length === 0 && files.length === 0 && (
          <p className="text-sm opacity-70 py-8 text-center">{t("emptyFolder", "This folder is empty.")}</p>
        )}
      </div>
    </div>
  );
}

export default function SharedPage() {
  const { t } = useTranslation("share");
  const navigate = useNavigate();
  const account = shareAccountKey(useAuthStore((s) => s.phoneNumber));
  const owned = useShareStore((s) => s.owned[account]) ?? [];
  const received = useShareStore((s) => s.received[account]) ?? [];
  const upsertReceived = useShareStore((s) => s.upsertReceived);
  const myFiles = useFileStore((s) => s.files);

  const [link, setLink] = useState("");
  const [opening, setOpening] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const openShare = received.find((r) => r.channelId === openId);
  if (openShare) return <SharedBrowser share={openShare} onBack={() => setOpenId(null)} />;

  const handleOpen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!link.trim() || opening) return;
    setOpening(true);
    try {
      const res = await openSharedLink(link);
      const locked = await isProtectedShare(res.channelId);
      upsertReceived(account, {
        channelId: res.channelId,
        link: link.trim(),
        title: locked ? "🔒" : res.title,
        openedAt: Date.now(),
        files: locked ? [] : res.files,
        locked,
        unlocked: false,
      });
      setLink("");
      setOpenId(res.channelId);
    } catch (err: any) {
      toast.error(err?.message || t("openError", "Could not open this link"));
    } finally {
      setOpening(false);
    }
  };

  const manage = (folderPath: string) => {
    const parent = folderPath.slice(0, folderPath.lastIndexOf("/")) || "/";
    const name = folderPath.slice(folderPath.lastIndexOf("/") + 1);
    const folder =
      myFiles.find(
        (f) =>
          (f.mime === "inode/directory" || f.mime === "application/x-directory") &&
          f.name === name &&
          normalizeFolderPath(f.folderPath) === parent
      ) ?? dirEntry(name, parent, myFiles[0]?.channelId ?? "");
    requestShareFolder(folder);
  };

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 max-w-4xl">
      <section className="space-y-2">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Link2 className="h-4 w-4" /> {t("openTitle", "Open a shared link")}
        </h2>
        <form onSubmit={handleOpen} className="flex gap-2">
          <Input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://t.me/+xxxxxxxx"
            className="text-sm"
          />
          <Button type="submit" disabled={opening || !link.trim()}>
            {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : t("open", "Open")}
          </Button>
        </form>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Users className="h-4 w-4" /> {t("withMe", "Shared with me")}
        </h2>
        {received.length === 0 ? (
          <p className="text-sm opacity-70">{t("withMeEmpty", "Folders shared with you will appear here.")}</p>
        ) : (
          received.map((r) => (
            <div key={r.channelId} className={`${rowCls} cursor-pointer`} onClick={() => setOpenId(r.channelId)}>
              <FolderIcon size="sm" className="h-5 w-5 shrink-0" />
              <span className="text-sm font-medium truncate flex-1">{r.title}</span>
              {r.locked && <Lock className="h-3.5 w-3.5 opacity-70" />}
              <span className="text-xs opacity-70">{t("filesCount", "{{count}} files", { count: r.files.length })}</span>
              <ChevronRight className="h-4 w-4 opacity-60" />
            </div>
          ))
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Link2 className="h-4 w-4" /> {t("byMe", "Shared by me")}
        </h2>
        {owned.length === 0 ? (
          <p className="text-sm opacity-70">
            {t("byMeEmpty", "Right-click a folder in My Drive and choose “Share link”.")}
          </p>
        ) : (
          owned.map((s) => (
            <div key={s.channelId} className={rowCls}>
              <FolderIcon size="sm" className="h-5 w-5 shrink-0" />
              <button
                className="text-sm font-medium truncate flex-1 text-left hover:underline"
                onClick={() => navigate(`/drive/folder${s.folderPath}`)}
              >
                {s.folderPath}
              </button>
              {s.locked && <Lock className="h-3.5 w-3.5 opacity-70" />}
              <span className="text-xs opacity-70 hidden sm:inline">{t("filesCount", "{{count}} files", { count: s.fileCount })}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("copy", "Copy link")}
                onClick={async () => {
                  if (await copyText(s.link)) toast.success(t("copied", "Link copied"));
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" aria-label={t("manage", "Manage")} onClick={() => manage(s.folderPath)}>
                <Settings2 className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
