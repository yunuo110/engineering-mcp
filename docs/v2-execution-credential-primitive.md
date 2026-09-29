# Execution credential primitive (Phase 3B0-R3)

`execution-credential.exe` is a one-shot development-stage native primitive. Its
build identity is `engineering-execution-credential/1`. It does not provision
accounts, write files, set ACLs, start workers, or act as a credential authority.

The only commands are `seal`, `unseal`, and `--version`. `seal` reads the existing
four-field bootstrap identity frame from stdin and writes a binary envelope to
stdout. `unseal` reverses that operation. The frame fields, in order, are Keeper
username (UTF-8), Keeper password (NUL-terminated UTF-16LE), Worker username,
and Worker password. Each field has a little-endian uint32 byte length. Username
fields are bounded to 256 bytes and password fields to 1024 bytes. Both commands
reject malformed or trailing input before returning a successful result.

The envelope contains `EMCPCRED`, little-endian uint32 version `1`, little-endian
uint32 protected-blob length, and the DPAPI blob. The complete envelope is
bounded to 16 KiB. The helper uses classic DPAPI CurrentUser with
`CRYPTPROTECT_UI_FORBIDDEN`, no optional entropy, and no machine-scope flag.
Stderr contains only fixed error categories and an optional numeric error code.

For a future production provisioning design, sealing must execute under the
Core identity with its profile loaded. An operator sealing under the operator's
own identity does not create a Core-unsealable runtime credential. A future
provisioning layer, not this helper, must privately supply stdin and atomically
store the envelope under an approved credential-root ACL. A future Core runtime
path would unseal under that same Core identity/profile, pass the bounded frame
to bootstrap, and clear its owned buffers. Neither path is wired in this phase.

The current Controller, trusted-launch config, runtime manifest, and
`verifyTrustedRuntime()` are unchanged. Production account provisioning,
credential-root ACLs, rotation, recovery, and deployment remain unresolved.
This primitive is not production admission or cutover authorization.
