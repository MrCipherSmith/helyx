/**
 * Whether a picture is seen or merely mentioned.
 *
 * Inlined, an image arrives as bytes the model can look at; passed as a path,
 * it arrives as a filename it can only read. Both are correct in their place
 * and both fail quietly when wrong — the operator sends a screenshot and gets
 * an answer about its filename, with nothing anywhere saying why.
 */

import { describe, test, expect } from "bun:test";
import {
  attachmentFor,
  isImage,
  fitsInline,
  IMAGE_INLINE_MAX_BYTES,
} from "../../utils/media-attachment.ts";

const base = { hostPath: "/home/altsay/downloads/a.jpg", caption: "смотри" };

describe("recognising a picture", () => {
  test("by its mime type", () => {
    expect(isImage({ description: "Document", mimeType: "image/png" })).toBe(true);
  });

  test("or, failing that, by how it was announced", () => {
    // A photo forwarded from Telegram routinely arrives with no mime at all,
    // and treating it as a file is how a screenshot becomes a path.
    expect(isImage({ description: "Photo: скрин", mimeType: undefined })).toBe(true);
    expect(isImage({ description: "Photo", mimeType: null })).toBe(true);
  });

  test("and a document stays a document", () => {
    expect(isImage({ description: "Document", mimeType: "application/pdf" })).toBe(false);
    expect(isImage({ description: "Document", mimeType: undefined })).toBe(false);
    expect(isImage({ description: "Voice", mimeType: "audio/ogg" })).toBe(false);
  });

  test("a mime that merely mentions images is not one", () => {
    // `startsWith`, so a document *about* images is not an image.
    expect(isImage({ description: "Document", mimeType: "text/image-notes" })).toBe(false);
  });
});

describe("the inline limit", () => {
  test("both sides of it", () => {
    // The boundary itself, because a `<` that should be `<=` costs one byte of
    // difference and shows up only on files of exactly the wrong size.
    expect(fitsInline(IMAGE_INLINE_MAX_BYTES)).toBe(true);
    expect(fitsInline(IMAGE_INLINE_MAX_BYTES + 1)).toBe(false);
    expect(fitsInline(0)).toBe(true);
  });

  test("an unread file does not fit", () => {
    // Absent bytes mean the file was never read, and inlining what has not
    // been read is not possible — the caller must not be able to ask for it.
    expect(fitsInline(undefined)).toBe(false);
  });
});

describe("what Claude receives", () => {
  test("a small image travels as bytes", () => {
    const out = attachmentFor(
      { ...base, description: "Photo", mimeType: "image/png", byteLength: 1000 },
      "QUJD",
    );

    expect(out).toEqual({
      type: "image",
      base64: "QUJD",
      mime: "image/png",
      path: base.hostPath,
      caption: "смотри",
    });
  });

  test("a large image travels as a path", () => {
    // Inlining it would carry megabytes into a payload that did not need them.
    const out = attachmentFor(
      { ...base, description: "Photo", mimeType: "image/png", byteLength: IMAGE_INLINE_MAX_BYTES + 1 },
      "QUJD",
    );

    expect(out).toEqual({ type: "image", mime: "image/png", path: base.hostPath, caption: "смотри" });
  });

  test("an image with no mime is still an image, and JPEG is the guess", () => {
    // Telegram's own photos arrive this way. Passing nothing through would
    // leave the model to guess at bytes it has been handed.
    const out = attachmentFor({ ...base, description: "Photo", byteLength: 10 }, "QUJD") as { mime: string };
    expect(out.mime).toBe("image/jpeg");
  });

  test("a file is never inlined, whatever its size", () => {
    const out = attachmentFor(
      { ...base, description: "Document", mimeType: "application/pdf", byteLength: 10, filename: "spec.pdf" },
      "QUJD",
    );

    expect(out).toEqual({
      type: "file",
      path: base.hostPath,
      name: "spec.pdf",
      mime: "application/pdf",
      caption: "смотри",
    });
  });

  test("a file with no name or mime says so, rather than inventing one", () => {
    const out = attachmentFor({ ...base, description: "Document" });
    expect(out).toEqual({ type: "file", path: base.hostPath, name: null, mime: null, caption: "смотри" });
  });

  test("an image whose bytes were never read travels as a path", () => {
    // The caller reads the file only when it might be inlined; with no bytes
    // there is nothing to inline and the path is the whole answer.
    const out = attachmentFor({ ...base, description: "Photo", mimeType: "image/png" });
    expect(out).toEqual({ type: "image", mime: "image/png", path: base.hostPath, caption: "смотри" });
  });

  test("the caption and the path travel with every shape", () => {
    // The caption is what the operator actually said about the file, and the
    // path is the only way the session can open it.
    const shapes = [
      attachmentFor({ ...base, description: "Photo", byteLength: 1 }, "QQ=="),
      attachmentFor({ ...base, description: "Photo", byteLength: IMAGE_INLINE_MAX_BYTES + 1 }, "QQ=="),
      attachmentFor({ ...base, description: "Document" }),
    ];

    for (const shape of shapes) {
      expect([shape.type, shape.caption]).toEqual([shape.type, "смотри"]);
      expect([shape.type, shape.path]).toEqual([shape.type, base.hostPath]);
    }
  });
});
