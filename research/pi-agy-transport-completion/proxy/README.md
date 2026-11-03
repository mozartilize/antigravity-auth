# Sanitized Antigravity MITM capture

`capture_antigravity.py` is the mitmproxy addon used for the investigation,
made safe for repository storage. The original one-off addon selected the first
six request headers and accidentally captured a bearer token. This version uses
an explicit allowlist and never records authorization, request IDs, prompts,
system instructions, or successful model output.

## Run

Create an isolated environment outside the repository:

```bash
python3 -m venv /tmp/antigravity-mitm
/tmp/antigravity-mitm/bin/pip install mitmproxy
```

Start the proxy:

```bash
ANTIGRAVITY_CAPTURE_FILE=/tmp/antigravity-capture.jsonl \
  /tmp/antigravity-mitm/bin/mitmdump \
  --listen-host 127.0.0.1 \
  --listen-port 41002 \
  --scripts ./capture_antigravity.py
```

In another shell, run Pi through it:

```bash
HTTPS_PROXY=http://127.0.0.1:41002 \
NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem" \
pi --no-session --no-tools \
  --model google/antigravity-claude-sonnet-5-5 \
  -p 'say hi'
```

mitmproxy creates its local CA on first start. Trust that CA only for the
single diagnostic process. Do not install or commit its private key.

The historical sanitized record is in
`../results/proxy-claude-429.sanitized.jsonl`.
