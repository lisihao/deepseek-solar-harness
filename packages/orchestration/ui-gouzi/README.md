# @deepseek-ai/dsh-ui-gouzi

English | [中文](README.zh.md)

The Gouzi roster for the browser: one sidebar entry that opens a dialog listing the long-lived execution members of this main instance, and the controls to adopt, edit, wake, rest, and retire them. The Host half serves `/api/gouzi` on the same origin as the Web UI; the browser half draws six inline SVG avatars and a five-step adoption wizard (avatar, name, home, role and projects, confirmation). The home step picks the machine the member lives on: this machine, an SSH machine added earlier, or a new one (address, port, user, password). The project step never asks for a typed path: it lists the user's most recently used workspaces as checkboxes (the current one preselected) and a button that opens the Host's native folder picker; the chosen absolute paths go to `/api/gouzi` as `projects`. On an SSH machine the step browses that machine's folders instead and offers only Git repositories.

`GET /api/gouzi` returns `GouziDashboardV1`: the limit of ten, how many members hold a slot, whether this caller may manage, whether this Host can start members, and every member that is not archived. Each member carries `membership`, `connection`, and `activity` plus one `state` reduced by `gouziPrimaryState`: a member outside `enabled` shows its membership, an unreachable member shows that before its last activity, and otherwise the activity shows. `POST` takes a `GouziControlRequest` and requires the `x-dsh-gouzi-control: 1` header; a loopback owner, `cockpit`, and `admin` devices may manage, while `pocket` devices only read and a `gouzi` credential is refused.

Adoption resolves every project path to a repository identity before it creates anything, so a bad path leaves no half-made member. It then pairs the chosen host once (the local machine unless `hostId` names an SSH host), creates the member in `provisioning`, asks `ctx.gouziHost` to provision and start its process, records the endpoint, and enables the member. If the process fails to start, the member keeps its slot in `provisioning` and the failure is reported as `GOUZI_START_FAILED`; waking it retries. Adoptions run one at a time. Retiring moves the member to `retiring`, stops its process tree including its Resident daemon, and archives it only when that tree is gone; a working member cannot rest or retire.

Adding a machine takes two requests so the user decides about trust before any login. `host-inspect` reads the key the machine presents without logging in and returns its fingerprint. `host-add` carries the fingerprint the user confirmed and the login password; the Provider refuses the machine if the key changed in between, logs in once, installs a dedicated key, and checks that DSH Desktop with the Gouzi agent is installed. The password travels only in that one same-origin request body, is not stored or logged, and is not part of any response. `host-remove` is refused while a live member lives on the host, and `browse` lists one folder level on a host. Every request that names a host needs the same manage permission as adoption.

`GouziHostService` is the Service Definition for hosts and for starting and stopping member processes on them. This package consumes it; the Desktop product provides it. A Server without the service lists members but reports `hostAvailable: false` and refuses adopt, wake, rest, and retire with `GOUZI_HOST_UNAVAILABLE`.

Config: `grantDeadlineMs` (default two hours, 60 seconds to 24 hours) is the lifetime of the execution grants issued to every member this panel creates.

## Model Experience

None, as this trusted browser roster registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; the roster is a Host projection outside the model context.

## Known Limitations and Deferred Work

- A member on an SSH host reaches the main instance through a local SSH port forward and needs DSH Desktop 3.36.0 or newer installed on that host. A task still takes its workspace identity from a clean Git checkout on the main instance, so a repository that exists only on the SSH host cannot receive tasks yet. A per-host resource budget and re-pairing of a host belong to later phases.
- The panel offers no way to see a member's task history or to send it work directly; work reaches a member through a TaskGraph node that prefers its operator.
- The roster is polled every three seconds while open and every twenty seconds otherwise; it does not subscribe to events.
