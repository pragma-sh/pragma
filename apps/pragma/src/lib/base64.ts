/**
 * Base64 helpers for the binary payloads that cross IPC as text (alert clips,
 * chunked file reads). `atob` yields a binary string, never bytes, so every
 * caller needs the same char-code widening — it lives here once.
 */

/** Decodes standard base64 into the raw bytes it encodes. */
export function decodeBase64(contents: string): Uint8Array {
  const binary = atob(contents);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
