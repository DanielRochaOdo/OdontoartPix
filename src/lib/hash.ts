import crypto from "crypto";

export function hashCpf(cpf: string) {
  return crypto.createHash("sha256").update(cpf).digest("hex");
}

export function hashAssociatedCode(associatedCode: string) {
  return crypto.createHash("sha256").update(`associated-code:${associatedCode}`).digest("hex");
}
