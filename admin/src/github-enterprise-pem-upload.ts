/**
 * admin/src/github-enterprise-pem-upload.ts
 * Parses the private-key field of the GHE settings form (GHE-1.12): a pasted
 * value or an uploaded .pem file. Pure and key-service free; errors are fixed
 * strings that never include any submitted content.
 */

/** A PEM private key is ~1.7 KB (RSA 2048) to ~3.3 KB (RSA 4096); 16 KB is generous. */
export const MAX_PEM_BYTES = 16 * 1024;

const PEM_PRIVATE_KEY =
  /^-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----$/;

export type PemResult =
  | { ok: true; pem: string }
  | { ok: false; error: string };

/** Returns the key from the uploaded file when one was chosen, else the pasted text. */
export async function readPrivateKeyField(form: FormData): Promise<PemResult> {
  const file = form.get("privateKeyFile");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_PEM_BYTES) {
      return {
        ok: false,
        error: `The key file is too large (limit ${MAX_PEM_BYTES / 1024} KB).`,
      };
    }
    return checkPem(await file.text(), "The file is not a PEM private key.");
  }
  const pasted = form.get("privateKey")?.toString() ?? "";
  if (!pasted.trim()) {
    return { ok: false, error: "Paste a private key or choose a .pem file." };
  }
  // Pasted values keep their bytes as before; the API validates them.
  return { ok: true, pem: pasted };
}

function checkPem(text: string, error: string): PemResult {
  // Validated trimmed, stored as-is so an upload matches a paste byte for byte.
  return PEM_PRIVATE_KEY.test(text.trim())
    ? { ok: true, pem: text }
    : { ok: false, error };
}
