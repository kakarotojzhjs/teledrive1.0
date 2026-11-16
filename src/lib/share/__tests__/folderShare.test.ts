import { describe, expect, it, vi } from "vitest";

vi.mock("../../telegram/client", () => ({ getClient: vi.fn() }));

import { collectFolderFiles, folderFullPath, parseInviteHash } from "../folderShare";
import type { TeleFile } from "../../types";

const f = (over: Partial<TeleFile>): TeleFile => ({
  id: Math.random().toString(36),
  name: "a.txt",
  size: 1,
  mime: "text/plain",
  folderPath: "/",
  messageId: 10,
  channelId: "-1001",
  uploadedAt: 0,
  ...over,
});

describe("parseInviteHash", () => {
  it("parses common link formats", () => {
    expect(parseInviteHash("https://t.me/+AbCdEf123456")).toBe("AbCdEf123456");
    expect(parseInviteHash("t.me/joinchat/AbCdEf123456")).toBe("AbCdEf123456");
    expect(parseInviteHash("tg://join?invite=AbCdEf123456")).toBe("AbCdEf123456");
    expect(parseInviteHash("  +AbCdEf123456 ")).toBe("AbCdEf123456");
  });
  it("rejects garbage", () => {
    expect(parseInviteHash("https://example.com")).toBeNull();
    expect(parseInviteHash("")).toBeNull();
  });
});

describe("collectFolderFiles", () => {
  it("returns descendants only, skipping trashed and folders", () => {
    const folder = f({ name: "Docs", mime: "inode/directory", folderPath: "/", messageId: 0 });
    const files = [
      folder,
      f({ name: "in.txt", folderPath: "/Docs" }),
      f({ name: "deep.txt", folderPath: "/Docs/Sub" }),
      f({ name: "trash.txt", folderPath: "/Docs", trashed: true }),
      f({ name: "other.txt", folderPath: "/Docs2" }),
      f({ name: "Sub", folderPath: "/Docs", mime: "inode/directory", messageId: 0 }),
    ];
    expect(folderFullPath(folder)).toBe("/Docs");
    expect(collectFolderFiles(files, "/Docs").map((x) => x.name).sort()).toEqual(["deep.txt", "in.txt"]);
  });
});
