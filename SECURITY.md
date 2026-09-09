# Security

**Reporting.** Open a private security advisory on GitHub or e-mail the maintainer; please do
not file public issues for vulnerabilities.

**What the app does and does not do**

- Sends only `GET`/`HEAD` and search-family `POST` requests to Elasticsearch while `readOnly`
  is true (the default). The check is in the Rust core, before a socket is opened.
- Lets a write out in exactly two cases, both requiring a deliberate act:
  - `readOnly: false` in the config file — writes are allowed everywhere.
  - An action the operator took in the UI after ticking *Allow writes*: a request typed in
    the REST console, a snapshot created or deleted, an index opened, closed or removed.
    That unlock lives in the core's memory for the session (never on disk, gone on
    restart), and it is not sufficient by itself — the request must also be marked as one
    the operator asked for. A background refresh, a page load or any future code path
    still cannot write while the session is unlocked.
- Never writes a credential in plain text. Credentials typed in the UI are held in memory;
  when saved to `config_cluster.json` they are encrypted with AES-256-GCM under a key derived
  from a master password (PBKDF2-HMAC-SHA512, 600 000 rounds, random salt and nonce).
  Optionally the credential is stored in the OS vault (Windows Credential Manager).
- Verifies TLS against the OS trust store; a certificate the OS does not trust is shown to the
  operator once and pinned (SHA-256) on explicit consent. A changed certificate is refused.
- Opens SSH connections with the operator's key file; host keys are confirmed once and pinned.
  Passphrases are asked for and kept in memory only.
- Listens only on 127.0.0.1 (the in-process SOCKS5 proxy for tunnelled clusters).
- Writes: `pins.json` (fingerprints), `config_cluster.json`, the WebView profile. The write
  unlock is never among them.

**Not covered.** The Windows binaries are not code-signed. Verify `SHA256SUMS.txt` from the
release, or build from source.
