# Lab: run the desktop core against a local jump host and mock fleet

```bash
# 1. mock Elasticsearch fleet (80 clusters on https://127.0.0.1:9470/c<N>) — from the esfleet kit
cd esfleet/lab && LAT_MS=5 TLS_KEY=/tmp/lab/s.key TLS_CRT=/tmp/lab/s.crt node mockfleet.mjs &

# 2. a restricted sshd on 127.0.0.1:2222 acting as the jump host
useradd --system --create-home --shell /usr/sbin/nologin jump; usermod -p '*' jump   # '*' = no password, NOT locked
ssh-keygen -t ed25519 -N '' -f /tmp/lab/client_ed25519
install -d -m700 -o jump -g jump /home/jump/.ssh
( printf 'restrict,port-forwarding,permitopen="*:9470" '; cat /tmp/lab/client_ed25519.pub ) > /home/jump/.ssh/authorized_keys
chown jump:jump /home/jump/.ssh/authorized_keys; chmod 600 /home/jump/.ssh/authorized_keys
cat > /tmp/lab/sshd_config <<CFG
Port 2222
ListenAddress 127.0.0.1
HostKey /tmp/lab/host_ed25519
PasswordAuthentication no
AllowTcpForwarding yes
PermitOpen *:9470
PermitTTY no
Match User jump
    ForceCommand /bin/false
CFG
ssh-keygen -t ed25519 -N '' -f /tmp/lab/host_ed25519; mkdir -p /run/sshd; /usr/sbin/sshd -f /tmp/lab/sshd_config

# 3. the core with the UI in a browser
cargo run -p espro-core --features bridge --bin espro-bridge -- ui 8765
#    open http://127.0.0.1:8765/ and pick lab/clusters.yaml (edit keyFile / paths first)
```

`clusters.yaml` here routes two clusters through `jumpwin` (127.0.0.1:2222) and one directly;
`clusters-nocred.yaml` has no credential and an encrypted key, to exercise both prompts.
