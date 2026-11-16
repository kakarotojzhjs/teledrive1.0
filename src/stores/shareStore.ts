import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TeleFile } from "@/lib/types";

/** A folder this account shared by link. */
export interface OwnedShare {
  channelId: string;
  link: string;
  title: string;
  /** Full virtual path of the shared folder in the owner's drive. */
  folderPath: string;
  createdAt: number;
  updatedAt: number;
  fileCount: number;
}

/** A folder someone else shared with this account. */
export interface ReceivedShare {
  channelId: string;
  link: string;
  title: string;
  openedAt: number;
  files: TeleFile[];
}

interface ShareState {
  /** Keyed by account phone so multi-account installs stay isolated. */
  owned: Record<string, OwnedShare[]>;
  received: Record<string, ReceivedShare[]>;
  upsertOwned: (account: string, share: OwnedShare) => void;
  removeOwned: (account: string, channelId: string) => void;
  upsertReceived: (account: string, share: ReceivedShare) => void;
  removeReceived: (account: string, channelId: string) => void;
}

export const useShareStore = create<ShareState>()(
  persist(
    (set) => ({
      owned: {},
      received: {},
      upsertOwned: (account, share) =>
        set((s) => ({
          owned: {
            ...s.owned,
            [account]: [share, ...(s.owned[account] ?? []).filter((x) => x.channelId !== share.channelId)],
          },
        })),
      removeOwned: (account, channelId) =>
        set((s) => ({
          owned: { ...s.owned, [account]: (s.owned[account] ?? []).filter((x) => x.channelId !== channelId) },
        })),
      upsertReceived: (account, share) =>
        set((s) => ({
          received: {
            ...s.received,
            [account]: [share, ...(s.received[account] ?? []).filter((x) => x.channelId !== share.channelId)],
          },
        })),
      removeReceived: (account, channelId) =>
        set((s) => ({
          received: {
            ...s.received,
            [account]: (s.received[account] ?? []).filter((x) => x.channelId !== channelId),
          },
        })),
    }),
    { name: "teledrive-shares-v1" }
  )
);

export function shareAccountKey(phone: string | null | undefined): string {
  return phone || "default";
}
