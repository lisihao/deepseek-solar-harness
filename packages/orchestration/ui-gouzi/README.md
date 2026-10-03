# @deepseek-ai/dsh-ui-gouzi

English | [中文](README.zh.md)

The Gouzi roster for the browser: one sidebar entry that opens a dialog listing the long-lived execution members of this main instance, and the controls to adopt, edit, wake, rest, and retire them. The Host half serves `/api/gouzi` on the same origin as the Web UI; the browser half draws six inline SVG avatars and a four-step adoption wizard (avatar, name, role and projects, confirmation).

`GET /api/gouzi` returns `GouziDashboardV1`: the limit of ten, how many members hold a slot, whether this caller may manage, whether this Host can start members, and every member that is not archived. Each member carries `membership`, `connection`, and `activity` plus one `state` reduced by `gouziPrimaryState`: a member outside `enabled` shows its membership, an unreachable member shows that before its last activity, and otherwise the activity shows. `POST` takes a `GouziControlRequest` and requires the `x-dsh-gouzi-control: 1` header; a loopback owner, `cockpit`, and `admin` devices may manage, while `pocket` devices only read and a `gouzi` credential is refused.

Adoption resolves every project path to a repository identity before it creates anything, so a bad path leaves no half-made member. It then pairs the local host once, creates the member in `provisioning`, asks `ctx.gouziHost` to provision and start its process, records the endpoint, and enables the member. If the process fails to start, the member keeps its slot in `provisioning` and the failure is reported as `GOUZI_START_FAILED`; waking it retries. Adoptions run one at a time. Retiring moves the member to `retiring`, stops its process tree including its Resident daemon, and archives it only when that tree is gone; a working member cannot rest or retire.

`GouziHostService` is the Service Definition for starting and stopping member processes. This package consumes it; the Desktop product provides it. A Server without the service lists members but reports `hostAvailable: false` and refuses adopt, wake, rest, and retire with `GOUZI_HOST_UNAVAILABLE`.

Config: `grantDeadlineMs` (default two hours, 60 seconds to 24 hours) is the lifetime of the execution grants issued to every member this panel creates.

## Model Experience

None, as this trusted browser roster registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; the roster is a Host projection outside the model context.

## Known Limitations and Deferred Work

- The first version runs members only on the machine that runs this Server. Pairing another host, remote credentials, and a per-host resource budget belong to the next phase.
- The panel offers no way to see a member's task history or to send it work directly; work reaches a member through a TaskGraph node that prefers its operator.
- The roster is polled every three seconds while open and every twenty seconds otherwise; it does not subscribe to events.
