import { describe, expect, it, vi } from "vitest";
import { DriveClient, readDriveBytes } from "../src/sync/drive";

describe("Drive download bounds", () => {
  it("reads files inside the byte budget", async () => {
    expect(await readDriveBytes(new Response(new Uint8Array([1, 2, 3])), 3)).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("rejects an oversized advertised response", async () => {
    await expect(readDriveBytes(new Response("", { headers: { "Content-Length": "100" } }), 4)).rejects.toMatchObject({ status: 413 });
  });
  it("cancels a stream that exceeds its budget even with a false length", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(3)); }, cancel });
    await expect(readDriveBytes(new Response(stream, { headers: { "Content-Length": "1" } }), 4)).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("does not send notebook bytes to an unexpected resumable-upload destination", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { headers: { Location: "https://example.org/upload" } }));
    const drive = new DriveClient(async () => "synthetic-token", () => {}, fetcher);
    await expect(drive.create("folder", "file", "application/pdf", {}, new Uint8Array(6 * 1024 * 1024))).rejects.toThrow("Unexpected Drive upload destination");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
