import { describe, expect, it, vi } from "vitest";

vi.mock("../../telegram/client", () => ({ getClient: vi.fn() }));
vi.mock("../../secure/vault", () => ({
  getSecret: vi.fn(async () => null),
  saveSecret: vi.fn(async () => {}),
  deleteSecret: vi.fn(async () => {}),
}));

import { __test, WrongSharePasswordError } from "../protectedShare";

const salt = new Uint8Array(16).fill(7);
const manifest = {
  v: 1 as const,
  title: "Fotos secretas",
  savedAt: 1,
  files: [
    {
      src: "f1",
      name: "a.jpg",
      folder: "/sub",
      size: 10,
      mime: "image/jpeg",
      enc: { v: 1 as const, s: "c2FsdA==" },
      ids: [5],
      segSizes: [42],
      at: 0,
    },
  ],
  keys: { "c2FsdA==": "AAAA" },
};

describe("protected share manifest", () => {
  it("round-trips with the right password and hides plaintext", async () => {
    const key = await __test.deriveShareKey("senha-forte", salt);
    const sealed = await __test.sealManifest(manifest, key);
    expect(sealed).not.toContain("Fotos");
    expect(atob(sealed)).not.toContain("a.jpg");
    const again = await __test.deriveShareKey("senha-forte", salt);
    expect(await __test.openManifest(sealed, again)).toEqual(manifest);
  });

  it("rejects a wrong password", async () => {
    const sealed = await __test.sealManifest(manifest, await __test.deriveShareKey("senha-forte", salt));
    await expect(__test.openManifest(sealed, await __test.deriveShareKey("errada!", salt))).rejects.toBeInstanceOf(
      WrongSharePasswordError
    );
  });
});
