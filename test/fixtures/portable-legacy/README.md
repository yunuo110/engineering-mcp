# Portable legacy regression fixtures

**TEST FIXTURE — SANITIZED — NOT PRODUCTION EVIDENCE.**

These inputs preserve the legacy C2C binding, protocol, pipe, and Grok probe
regression shapes while replacing machine identities and paths with synthetic
values. The original local artifacts are excluded from the repository commit.
No fixture is a deployment recipe or proof of a historical production byte.

The compressed ingress source map is decoded by `test/c2c-ingress-v1.test.ts`.
`Bindings.cs.in` is the same sanitized template in plaintext so the isolated
PowerShell binding-generation test can consume it without a deployment script.
The Grok scripts are self-test fixtures; the tests never invoke a real model.

Sanitized ingress source-map SHA-256 (uncompressed JSON):
`286e1b39db898757e032d32ae1061763cb7788afa50672fee9a4f353acadb841`

Sanitized Phase-1 Grok fixture SHA-256 (LF-normalized):
`289e6a9eabad6ea2e3261dd2b1c5c0880dd5c9fdcb5296d120d083070e509173`
