// Minimal IPv4 CIDR check. Empty list = allow all. IPv6 denied when a list is set
// (UNVERIFIED whether Anthropic egress ever uses IPv6).
const toInt = (ip: string) => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
export function ipAllowed(ip: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const n = toInt(ip);
  return cidrs.some((c) => {
    const [net, b] = c.split("/");
    const bits = Number(b ?? 32);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (toInt(net) & mask);
  });
}
