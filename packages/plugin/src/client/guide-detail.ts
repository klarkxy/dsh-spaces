import { redactPublicReason } from "../../../../src/shared/public-reason";
/** Presentation errors use the same bounded secret/path redaction as public server reasons. */
export function publicGuideDetail(text: string): string {
  return redactPublicReason(text, 2000);
}
