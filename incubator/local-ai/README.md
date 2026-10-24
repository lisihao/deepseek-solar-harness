# DSH Solar Local AI

`@lisihao/dsh-solar-local-ai` adds a **Local AI** page for a self-hosted OpenAI-compatible model server (oMLX, vLLM, LM Studio, Ollama, and similar). Enter the server address and an optional API key, refresh its models, select the ones to use, and save. The selected models then appear in the composer's model picker.

The page appears as a tab in the **Model subscriptions** section when `@lisihao/dsh-solar-subscription-hub` is loaded, and as its own Settings section when it is not. It is never shown in both places.

## How it works

The plugin adds no model adapter. Saving writes one hand-declared route, `local-ai`, into the official `@deepseek-ai/dsh-llm-pi-ai` settings namespace, using the OpenAI Chat Completions protocol. Model calls, model discovery, and credentials go through the Harness's own `llm-pi-ai`, settings, and credential services. The **Models** settings page shows the same route.

- **Refresh models** calls `llm/discoverModels`, which runs `GET {address}/models` in the Host. A key typed into the page is used for that request only. After the route has been saved, the stored key is used when the field is empty.
- **Save and enable** writes `llm-pi-ai.providers.local-ai` with `displayName`, `api: openai-completions`, `baseURL`, `apiKeyEnv: LOCAL_AI_API_KEY`, and the selected models. Discovery supplies each model's id, plus its name, context window, output cap, and input types when the server reports them. Fields already in that profile that the page does not edit, such as `headers`, are kept. A new route also gets `streamIdleTimeoutMs: 900000`, and an existing value is kept. `llm-pi-ai` aborts a stream after 300,000 ms (5 minutes) without a byte by default. In one installed-app check, a local server busy with another client's 86K-token prefill went past that limit on the first attempt.
- **API key.** A typed key is stored write-only through the credential service as `LOCAL_AI_API_KEY`. If the field is left empty and no key is stored yet, the page stores the placeholder `local-ai-no-key`. `llm-pi-ai` refuses a hand-declared OpenAI route without any key ("No API key for provider: local-ai"), and a server that requires no key ignores the header.
- **Remove** deletes the route and the stored key, and turns the Tailscale gateway off.

## Tailscale (userspace)

A `tailscaled` started with `--tun=userspace-networking` creates no network interface. Ordinary sockets therefore cannot reach 100.x addresses, but the node's SOCKS5 server can. In **Tailscale (userspace)** mode, the plugin's Host half opens a loopback gateway on `127.0.0.1:<port>`, and the saved route points at it:

```
http://127.0.0.1:18765/tailnet/100.114.161.62:8000/v1  →  SOCKS5 127.0.0.1:1055  →  100.114.161.62:8000/v1
```

- The gateway listens on `127.0.0.1` only, and it relays only to Tailscale addresses: `100.64.0.0/10`, `fd7a:115c:a1e0::/48`, and `*.ts.net`. Other targets get HTTP 403. It never connects to them, so it cannot be used as a general proxy.
- Host names are resolved by the proxy (`socks5h`), so MagicDNS names such as `mac.tail2f40bf.ts.net` work.
- Request and response bodies are streamed. An unreachable proxy or target returns HTTP 502 with a message that names the proxy.
- The gateway runs only while `tailscale.enabled` is set. The page sets it when you refresh or save in Tailscale mode, and clears it when you save in direct mode or remove the route.

The userspace node must run with a SOCKS5 server, for example:

```bash
tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 --socket=$HOME/.local/share/tailscale-userspace/tailscaled.sock --statedir=$HOME/.local/share/tailscale-userspace
```

The model server must listen on an address that its own tailnet IP can reach, not on `127.0.0.1` only.

## Configuration

Profile entry `solar-local-ai`. The `tailscale` object is volatile: the page edits it through the settings service, and a change restarts the gateway without remounting the plugin.

| Field | Default | Meaning |
|---|---|---|
| `tailscale.enabled` | `false` | Run the loopback gateway |
| `tailscale.port` | `18765` | Gateway port on `127.0.0.1` (1024–65535). If it changes, save the page again, because the route's `baseURL` contains it |
| `tailscale.proxy` | `socks5://127.0.0.1:1055` | SOCKS5 address of the userspace `tailscaled` |

If the port is already in use, the gateway logs an error naming the port, and refresh and model calls fail until another port is chosen.

## Data

The plugin writes no files. It stores state in the profile settings (`llm-pi-ai.providers.local-ai` and `solar-local-ai.tailscale`) and in the credential store (`LOCAL_AI_API_KEY`).

## Verification

- `incubator/local-ai/tests` (Vitest) covers:
  - address normalization;
  - Tailscale address rules;
  - gateway URL round-trips;
  - form validation and recovery;
  - the Remote call shapes;
  - hub and standalone registration;
  - the gateway against a real SOCKS5 stub and a streaming upstream: relay, MagicDNS, refusal, 502, port conflict, and close.
- `tools/local-ai-plugin-test.mjs` installs the built package into a scratch `DSH_HOME` with the published `dsh` CLI and boots it under plain Node. A probe enables the gateway through `settings.mutate`, discovers models, and streams a reply from a fake OpenAI server reached only through the gateway and a SOCKS5 stub. It then moves the gateway to another port and stops it. No real model is called.
- An installed-app check against a real local server is recorded in the pull request, not here. So is the real userspace `tailscaled` path on a second machine.
