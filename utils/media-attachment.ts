/**
 * What a file becomes on its way to Claude.
 *
 * One branch decides whether a picture is seen or merely mentioned. Inlined,
 * it arrives as base64 the model can look at; passed as a path, it arrives as
 * a filename the model can only read. Both are correct in their place and both
 * are silent when wrong: an over-large inline carries megabytes into a payload
 * that did not need them, and a path where an inline was needed means the
 * operator sends a screenshot and gets an answer about its filename.
 *
 * It lived inside `deliverMedia`, between a download and a queue write, where
 * no test could reach it.
 */

/** Above this, an image travels as a path rather than as bytes. */
export const IMAGE_INLINE_MAX_BYTES = 5 * 1024 * 1024;

export interface MediaFacts {
  /** How the file was announced — "Photo", "Document", and so on. */
  description: string;
  mimeType?: string | null;
  /** Bytes, when they have been read. Absent means "not read, so not inline". */
  byteLength?: number;
  /** Where the file is, as the session sees it. */
  hostPath: string;
  filename?: string | null;
  caption: string;
}

export type Attachment =
  | { type: "image"; base64: string; mime: string; path: string; caption: string }
  | { type: "image"; path: string; mime: string; caption: string }
  | { type: "file"; path: string; name: string | null; mime: string | null; caption: string };

/**
 * Whether this is a picture.
 *
 * The mime type first, and the description as a fallback — a photo forwarded
 * from Telegram routinely arrives with no mime at all, and treating it as a
 * file is how a screenshot becomes a path the model cannot see.
 */
export function isImage(facts: Pick<MediaFacts, "description" | "mimeType">): boolean {
  if ((facts.mimeType ?? "").startsWith("image/")) return true;
  return facts.description.startsWith("Photo");
}

/** Whether an image of this size travels as bytes. */
export function fitsInline(byteLength: number | undefined): boolean {
  return typeof byteLength === "number" && byteLength <= IMAGE_INLINE_MAX_BYTES;
}

/**
 * The attachment Claude receives.
 *
 * `base64` is passed in rather than read here: reading the file is the part
 * that has to touch the disk, and keeping it out is what makes the decision
 * testable at all.
 */
export function attachmentFor(facts: MediaFacts, base64?: string): Attachment {
  if (!isImage(facts)) {
    return {
      type: "file",
      path: facts.hostPath,
      name: facts.filename ?? null,
      mime: facts.mimeType ?? null,
      caption: facts.caption,
    };
  }

  // The default matters: an image with no mime is still an image, and JPEG is
  // what Telegram sends. Passing nothing through would leave the model to
  // guess at bytes it has been handed.
  const mime = facts.mimeType ?? "image/jpeg";

  if (base64 !== undefined && fitsInline(facts.byteLength)) {
    return { type: "image", base64, mime, path: facts.hostPath, caption: facts.caption };
  }
  return { type: "image", path: facts.hostPath, mime, caption: facts.caption };
}

/** The image types the Anthropic API accepts as base64 blocks. */
export const ANTHROPIC_IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type AnthropicImageMime = (typeof ANTHROPIC_IMAGE_MIMES)[number];

/**
 * The media type to declare for an inline image block.
 *
 * The API takes four and no others, and the previous code declared every
 * picture as JPEG whatever it was — so a PNG was handed over under the wrong
 * name and the model was left to sort it out. Narrowed here: the true type
 * when it is one the API knows, JPEG when it is not, because a picture
 * declared wrongly still beats a request refused.
 */
export function anthropicImageMime(mimeType: string | null | undefined): AnthropicImageMime {
  const found = ANTHROPIC_IMAGE_MIMES.find((m) => m === mimeType);
  return found ?? "image/jpeg";
}
