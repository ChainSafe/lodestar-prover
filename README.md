# Lodestar Prover

This repository contains the Lodestar light client and prover packages:

| Package | Description |
| ------- | ----------- |
| [`@lodestar/light-client`](./packages/light-client) | Ethereum consensus light client |
| [`@lodestar/prover`](./packages/prover) | Verified execution JSON-RPC provider and proxy built on the light client |

## Development

```bash
corepack enable
pnpm install
pnpm build
```

Useful checks:

```bash
pnpm lint
pnpm check-types
pnpm test:unit
```

## License

Apache-2.0 [ChainSafe Systems](https://chainsafe.io)
