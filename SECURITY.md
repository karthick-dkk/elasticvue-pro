# Security

**Reporting.** Open a private security advisory on GitHub or e-mail the maintainer; please do
not file public issues for vulnerabilities.

**What the app does and does not do**

- Sends only `GET`/`HEAD` and search-family `POST` requests to Elasticsearch while `readOnly`
  is true (the default). The check is in the Rust core, before a socket is opened.
- Never writes a credential in plain text. Credentials typed in the UI are held in memory;
  when saved to `config_cluster.json` they are encrypted with AES-256-GCM under a key derived
  from a master password (PBKDF2-HMAC-SHA512, 600 000 rounds, random salt and nonce).
  Optionally the credential is stored in the OS vault (Windows Credential Manager).
- Verifies TLS against the OS trust store; a certificate the OS does not trust is shown to the
  operator once and pinned (SHA-256) on explicit consent. A changed certificate is refused.
- Opens SSH connections with the operator's key file; host keys are confirmed once and pinned.
  Passphrases are asked for and kept in memory only.
- Listens only on 127.0.0.1 (the in-process SOCKS5 proxy for tunnelled clusters).
- Writes: `pins.json` (fingerprints), `config_cluster.json`, the WebView profile.

**Not covered.** The Windows binaries are not code-signed. Verify `SHA256SUMS.txt` from the
release, or build from source.
