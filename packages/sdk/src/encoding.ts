const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encodes bytes to base64 without `Buffer`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    output += BASE64[first >> 2];
    output += BASE64[((first & 0b11) << 4) | (second >> 4)];
    output += index + 1 < bytes.length ? BASE64[((second & 0b1111) << 2) | (third >> 6)] : "=";
    output += index + 2 < bytes.length ? BASE64[third & 0b111111] : "=";
  }
  return output;
}

/** Decodes base64 to bytes without `Buffer`. */
export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/\s/g, "");
  if (clean.length % 4 !== 0) {
    throw new TypeError("invalid base64 length");
  }
  const bytes: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const chars = [clean[index], clean[index + 1], clean[index + 2], clean[index + 3]] as const;
    const values = chars.map((char) => (char === "=" ? 0 : BASE64.indexOf(char ?? "")));
    if (values.some((number) => number < 0)) {
      throw new TypeError("invalid base64 character");
    }
    const first = values[0] ?? 0;
    const second = values[1] ?? 0;
    const third = values[2] ?? 0;
    const fourth = values[3] ?? 0;
    bytes.push((first << 2) | (second >> 4));
    if (chars[2] !== "=") {
      bytes.push(((second & 0b1111) << 4) | (third >> 2));
    }
    if (chars[3] !== "=") {
      bytes.push(((third & 0b11) << 6) | fourth);
    }
  }
  return new Uint8Array(bytes);
}
