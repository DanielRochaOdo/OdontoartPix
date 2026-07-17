export function stripCpf(value: string) {
  return value.replace(/\D/g, "");
}

export function isValidCpf(value: string) {
  const cpf = stripCpf(value);
  if (!/^\d{11}$/.test(cpf)) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const calc = (base: string, factor: number) => {
    let sum = 0;
    for (const digit of base) sum += Number(digit) * factor--;
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };

  const d1 = calc(cpf.slice(0, 9), 10);
  const d2 = calc(cpf.slice(0, 10), 11);
  return d1 === Number(cpf[9]) && d2 === Number(cpf[10]);
}

export function maskCpf(value: string) {
  const cpf = stripCpf(value);
  if (cpf.length !== 11) return "***.***.***-**";
  return `***.***.***-${cpf.slice(-2)}`;
}
