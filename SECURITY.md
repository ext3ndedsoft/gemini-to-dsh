# Security policy

The threat model, the local attack surface and a pre-publication checklist live in
[docs/security.md](docs/security.md). Read that first; it explains why the bridge
listens on loopback only, why the egress shim refuses browser writes, and where the
account tokens and the OAuth client are kept.

## Reporting a vulnerability

Open a private advisory rather than a public issue:

<https://github.com/ext3ndedsoft/gemini-to-dsh/security/advisories/new>

Please include the version (`git describe --tags`), the platform, and the smallest
reproduction you have. Expect an answer within a few days.

## Scope

In scope: the bridge and shim (`bridge/`), the three plugins (`plugins/`), and
anything that lets a local process or a web page reach account data, tokens, or the
egress configuration without the operator's intent.

Out of scope: Google's Cloud Code transport changing under us, the availability of
third-party smart-DNS relays, and anything that requires an attacker who can already
read the operator's home directory.