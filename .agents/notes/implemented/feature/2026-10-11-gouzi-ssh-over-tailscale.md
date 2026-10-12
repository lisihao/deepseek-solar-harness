# Agent Note: Gouzi SSH hosts over Tailscale

Status: implemented

English | [中文](2026-10-11-gouzi-ssh-over-tailscale.zh.md)

## Problem

An SSH host was reached only at the address the user typed, with `ssh-keyscan` and `ssh` connecting directly. A host added on the home network (`192.168.2.200`) could not be reached from another network, although the same machine answers over Tailscale with the same host key. A host could not be edited, and one cannot be removed while a member lives on it, so such a host and its members stayed unreachable.

## Decision

A host has an optional route, `{ via: "tailscale", socket? }`. A routed connection runs the Tailscale CLI as `ssh`'s `ProxyCommand` (`<cli> [--socket=…] nc <address> <port>`). `host-route` changes the address, port, and route of an existing host; it is accepted only when the machine at the new address presents the key already pinned, so the host keeps its identity and its members stay where they are. The new connection is proven with the remote agent before anything is kept, and the forwards of the host's members are closed, awaited, and reopened through the new route.

A request may name only the socket path. The CLI comes from `ssh.tailscale` in the Desktop configuration, or from `/opt/homebrew/bin`, `/usr/local/bin`, and the Tailscale app, in that order; if none exists the error names every path tried. A GUI-launched app has a short `PATH`, so a bare `tailscale` is never relied on.

Because `ProxyCommand` is run by a shell and `ssh` expands `%` tokens in it, the address and port are written into it directly (never `%h`/`%p`), every part is shell-quoted, and the socket may contain only `[A-Za-z0-9._/+@~=-]`. Control actions are available to cockpit and admin devices, so a free-text command or a request-supplied binary would be command execution on the main machine.

A routed connection ignores the user's own ssh configuration (`-F /dev/null`), so an alias there, such as a `HostKeyAlias` for the same address, cannot change which pinned key is looked up. `ssh-keyscan` has no relay support, so a routed host key is read by letting `ssh` reach the key exchange and record the key in a scratch file; that file's line is the pin, named as later connections look it up.

## Alternatives considered

**A free-text `ProxyCommand` per host.** It covers any proxy but lets any manager device run arbitrary commands. Rejected; adding another relay later means a new route kind with its own validation.

**Remove and re-add the host.** Impossible while a member lives on it, and it would retire the member.

**Trust the new address without comparing keys.** It would let a changed address move a member onto a different machine. The pinned fingerprint is the identity.

## Consequences

Hosts work from any network where Tailscale runs. The Tailscale socket path is stored with the host. A routed first connection can take several seconds (relay), so its connect timeout is 25 s instead of 10 s. Failure to reach tailscaled is reported as "Tailscale is not running or the socket path is wrong".

This was verified against a real `sshd` with a stand-in CLI that relays and records its arguments. Over the real tailnet only the host key was compared (the mini's key through the relay equals the pinned one); waking a member through Tailscale needs an installed build that contains this change, and the machine's DSH Desktop must still speak the current agent protocol.
