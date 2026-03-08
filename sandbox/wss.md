# WebSocket Connection to Remote Browser from Gondolin VM

## Solution

Use **mapped TCP egress** to bypass Gondolin's HTTP MITM layer. This creates a raw TCP tunnel so TLS and WebSocket upgrades work natively.

```ts
const created = await VM.create({
  dns: {
    mode: "synthetic",
    syntheticHostMapping: "per-host",
  },
  tcp: {
    hosts: {
      "sbrowser.sidget.net:443": "sbrowser.sidget.net:443",
    },
  },
});
```

Key points:
- Synthetic DNS still resolves to a VM-internal IP (expected)
- The TCP tunnel presents the real server certificate (Let's Encrypt), not a MITM cert
- `httpHooks` and `allowWebSockets` are not needed — the tunnel bypasses HTTP processing entirely
- Verify with: `echo | openssl s_client -connect sbrowser.sidget.net:443 2>&1 | grep issuer`

## What didn't work

1. `allowWebSockets: true` — no effect, Gondolin's HTTP/WS bridge is incompatible with Playwright's WS client
2. `createHttpHooks({ blockInternalRanges: false })` — no effect
3. `debug: ["net", "http", "ws"]` — no useful output

## Reference

- [Gondolin mapped TCP egress docs](https://earendil-works.github.io/gondolin/sdk-network/#mapped-tcp-egress-optional)
