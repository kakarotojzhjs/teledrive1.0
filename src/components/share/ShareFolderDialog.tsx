import { useEffect, useMemo, useState } from "react";
import { Copy, Check, Link2, Loader2, Lock, RefreshCw, Trash2, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TeleFile } from "@/lib/types";
import { useFileStore } from "@/stores/fileStore";
import { useAuthStore } from "@/stores/authStore";
import { shareAccountKey, useShareStore } from "@/stores/shareStore";
import {
  collectFolderFiles,
  folderFullPath,
  revokeShare,
  shareFolder,
  syncShare,
  type ShareProgress,
} from "@/lib/share/folderShare";
import { forgetProtectedShare, shareFolderProtected, syncProtectedShare } from "@/lib/share/protectedShare";

export const SHARE_FOLDER_EVENT = "teledrive-share-folder";

/** Open the share dialog for a folder from anywhere (context menu, actions menu…). */
export function requestShareFolder(folder: TeleFile): void {
  window.dispatchEvent(new CustomEvent(SHARE_FOLDER_EVENT, { detail: { folder } }));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function ShareFolderDialog() {
  const { t } = useTranslation("share");
  const files = useFileStore((s) => s.files);
  const account = shareAccountKey(useAuthStore((s) => s.phoneNumber));
  const owned = useShareStore((s) => s.owned[account]);
  const upsertOwned = useShareStore((s) => s.upsertOwned);
  const removeOwned = useShareStore((s) => s.removeOwned);

  const [folder, setFolder] = useState<TeleFile | null>(null);
  const [busy, setBusy] = useState<null | "create" | "sync" | "revoke">(null);
  const [progress, setProgress] = useState<ShareProgress | null>(null);
  const [copied, setCopied] = useState(false);
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");

  useEffect(() => {
    const handler = (e: Event) => {
      const f = (e as CustomEvent<{ folder: TeleFile }>).detail?.folder;
      if (!f) return;
      setFolder(f);
      setProgress(null);
      setCopied(false);
      setPassword("");
      setPassword2("");
      const enc = collectFolderFiles(useFileStore.getState().files, folderFullPath(f)).some((x) => x.enc);
      setProtect(enc);
    };
    window.addEventListener(SHARE_FOLDER_EVENT, handler);
    return () => window.removeEventListener(SHARE_FOLDER_EVENT, handler);
  }, []);

  const path = folder ? folderFullPath(folder) : "";
  const existing = useMemo(
    () => (owned ?? []).find((s) => s.folderPath === path),
    [owned, path]
  );
  const stats = useMemo(() => {
    if (!folder) return { total: 0, encrypted: 0 };
    const list = collectFolderFiles(files, path);
    return { total: list.length, encrypted: list.filter((f) => f.enc).length };
  }, [files, folder, path]);

  const shareCount = protect ? stats.encrypted : stats.total - stats.encrypted;

  const close = () => {
    if (busy) return;
    setFolder(null);
  };

  const handleCreate = async () => {
    if (!folder) return;
    setBusy("create");
    try {
      if (protect) {
        if (password.length < 6) throw new Error(t("passwordShort", "Password must have at least 6 characters"));
        if (password !== password2) throw new Error(t("passwordMismatch", "Passwords don't match"));
      }
      const res = protect
        ? await shareFolderProtected(folder, files, password, setProgress)
        : { ...(await shareFolder(folder, files, setProgress)), skippedPlain: 0 };
      upsertOwned(account, {
        locked: protect,
        channelId: res.channelId,
        link: res.link,
        title: res.title,
        folderPath: path,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        fileCount: res.shared,
      });
      toast.success(t("created", "Link created — {{count}} files shared", { count: res.shared }));
      if (res.skippedEncrypted > 0)
        toast.warning(t("skippedEncrypted", "{{count}} encrypted files were not shared", { count: res.skippedEncrypted }));
      if (res.skippedPlain > 0)
        toast.warning(t("skippedPlain", "{{count}} unencrypted files were not included", { count: res.skippedPlain }));
      if (res.failed > 0) toast.warning(t("failedSome", "{{count}} files failed to share", { count: res.failed }));
    } catch (err: any) {
      toast.error(err?.message || t("createError", "Could not create the share link"));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const handleSync = async () => {
    if (!existing) return;
    setBusy("sync");
    try {
      const r = existing.locked
        ? await syncProtectedShare(existing.channelId, existing.folderPath, files, setProgress)
        : await syncShare(existing.channelId, existing.folderPath, files, setProgress);
      upsertOwned(account, {
        ...existing,
        updatedAt: Date.now(),
        fileCount: collectFolderFiles(files, existing.folderPath).filter((f) => (existing.locked ? !!f.enc : !f.enc)).length,
      });
      toast.success(t("synced", "Share updated (+{{added}} / −{{removed}})", r));
    } catch (err: any) {
      toast.error(err?.message || t("syncError", "Could not update the share"));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const handleRevoke = async () => {
    if (!existing) return;
    if (!window.confirm(t("revokeConfirm", "Stop sharing? The link will stop working for everyone."))) return;
    setBusy("revoke");
    try {
      await revokeShare(existing.channelId);
      await forgetProtectedShare(existing.channelId);
    } catch (err) {
      console.warn("[ShareFolderDialog] revoke failed", err);
    } finally {
      removeOwned(account, existing.channelId);
      setBusy(null);
      toast.success(t("revoked", "Sharing stopped"));
    }
  };

  const handleCopy = async () => {
    if (!existing) return;
    const ok = await copyText(existing.link);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } else toast.error(t("copyError", "Could not copy"));
  };

  return (
    <Dialog open={!!folder} onOpenChange={(o) => !o && close()}>
      <DialogContent className="rounded-2xl sm:rounded-3xl max-w-sm sm:max-w-md p-6 bg-white dark:bg-[#0e1015] border border-slate-200/90 dark:border-white/[0.08] shadow-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Share2 className="h-5 w-5 text-[#0b57d0] dark:text-[#a8c7fa]" />
            <DialogTitle className="text-base sm:text-lg font-bold text-slate-900 dark:text-white truncate">
              {t("title", "Share “{{name}}”", { name: folder?.name ?? "" })}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-[#444746] dark:text-[#C4C7C5]">
            {t(
              "description",
              "Anyone with the link can view and download the files in this folder — in TeleDrive (Shared) or directly in Telegram."
            )}
          </DialogDescription>
        </DialogHeader>

        {existing ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input readOnly value={existing.link} className="text-xs font-mono" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="outline" size="icon" onClick={handleCopy} aria-label={t("copy", "Copy link")}>
                {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            {existing.locked && (
              <p className="text-[11px] flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                <Lock className="h-3.5 w-3.5" />
                {t("lockedInfo", "Password protected — send the password to people separately.")}
              </p>
            )}
            <p className="text-[11px] text-[#444746] dark:text-[#C4C7C5]">
              {t("sharedInfo", "{{count}} files shared · updated {{date}}", {
                count: existing.fileCount,
                date: new Date(existing.updatedAt).toLocaleString(),
              })}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="flex items-start gap-2.5 cursor-pointer rounded-xl border border-slate-200 dark:border-white/[0.08] p-3">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={protect}
                disabled={!!busy}
                onChange={(e) => setProtect(e.target.checked)}
              />
              <div className="text-xs">
                <div className="font-semibold flex items-center gap-1.5 text-[#1f1f1f] dark:text-[#e3e3e3]">
                  <Lock className="h-3.5 w-3.5" /> {t("protectTitle", "Protect with password")}
                </div>
                <div className="text-[#444746] dark:text-[#C4C7C5]">
                  {t(
                    "protectDesc",
                    "Only encrypted files are shared. In Telegram nobody sees names or contents — only TeleDrive with the password opens them."
                  )}
                </div>
              </div>
            </label>
            {protect && (
              <div className="space-y-2">
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={t("password", "Password (min. 6 characters)")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={t("passwordConfirm", "Confirm password")}
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                />
              </div>
            )}
            <div className="rounded-xl bg-[#f0f4f9] dark:bg-[#161719] p-3 text-xs text-[#1f1f1f] dark:text-[#e3e3e3] space-y-1">
              <div>{t("willShare", "{{count}} files will be shared.", { count: shareCount })}</div>
              {protect && stats.total - stats.encrypted > 0 && (
                <div className="text-amber-600 dark:text-amber-400">
                  {t("plainNote", "{{count}} unencrypted files will be skipped (they would be visible in Telegram).", {
                    count: stats.total - stats.encrypted,
                  })}
                </div>
              )}
              {!protect && stats.encrypted > 0 && (
                <div className="text-amber-600 dark:text-amber-400">
                  {t("encryptedNote", "{{count}} encrypted files will be skipped (recipients can't decrypt them).", {
                    count: stats.encrypted,
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {progress && (
          <div className="space-y-1">
            <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">
              <div
                className="h-full bg-[#0b57d0] transition-all"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
            <p className="text-[11px] text-[#444746] dark:text-[#C4C7C5] truncate">
              {progress.done}/{progress.total} {progress.current ? `· ${progress.current}` : ""}
            </p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between pt-1">
          {existing ? (
            <>
              <Button variant="ghost" className="text-red-600 hover:text-red-700" disabled={!!busy} onClick={handleRevoke}>
                {busy === "revoke" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                <span className="ml-1.5">{t("revoke", "Stop sharing")}</span>
              </Button>
              <Button variant="outline" disabled={!!busy} onClick={handleSync}>
                {busy === "sync" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                <span className="ml-1.5">{t("sync", "Update contents")}</span>
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={!!busy} onClick={close}>
                {t("cancel", "Cancel")}
              </Button>
              <Button disabled={!!busy || shareCount === 0 || (protect && !password)} onClick={handleCreate}>
                {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                <span className="ml-1.5">{t("create", "Create link")}</span>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
