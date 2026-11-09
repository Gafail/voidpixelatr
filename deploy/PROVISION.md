# VoidPixelatr — provisioning the container

VoidPixelatr is a **static site**. Its container serves one thing: files out
of `/var/www/voidpixelatr` over nginx. No runtime, no service, no proxy, no
tunnel, no domain.

The steps below follow `~/Desktop/Local-LXC-Host.md` §3. Two of them need
Proxmox and router credentials that are **not** stored in this repo, so they
have to be done by hand in the web UIs.

> **`.112` is already live.** The container for this project exists, with the
> hostname `VoidPixelatr` and the address `192.168.100.112`. This checklist is
> kept for the day the project needs a *second* box, or for a rebuild from
> scratch.

---

## 1. Clone the template  *(Proxmox web UI — manual)*

**Datacenter → node → LXC → select the source container → Clone → Full clone.**

| Setting | Value |
|---|---|
| Source | **the template** (based on `.197`) — **not** `.199`, which would copy TheVoidCo's own site across |
| Clone type | **Full** — a linked clone shares disks with the source |
| Hostname | `VoidPixelatr` |
| Storage | whatever the other containers use |
| Cores | 1 |
| Memory | 256 MB |
| Disk | 32 GB — Proxmox grows the filesystem to fill the rootfs, so do not tune this |

**Record the new MAC address.** Proxmox generates a fresh one for a full clone,
in the `bc:24:11:xx:xx:xx` range. You need it for step 2.

---

## 2. Reserve the address  *(router web UI — manual)*

The guests are DHCP-addressed; the target IP comes from the router, not from
Proxmox. Add a **static lease** binding the new MAC from step 1 to a free
address in `192.168.100.0/24`.

Pick an address that is **not** already in use. As of this writing the
following are taken — check the router's lease table before choosing:

| Address | What it is |
|---|---|
| `.100` | VoidPixlr |
| `.109` | voidtrackr |
| `.112` | **VoidPixelatr — this one** |
| `.191` | voidwalkr |
| `.195` | VoidFlippr |
| `.197` | retired |
| `.198` | VoidRecll |
| `.199` | TheVoidCo |
| `.200` | **occupied by an unrelated device** — do not use |
| `.202` | occupied |
| `.211`–`.221` | the Proxmox cluster |
| `.193`, `.194` | unknown devices — avoid |

The guest needs no change at all for a DHCP reservation. If you would rather
pin it in the guest, see §3 step 2(b) of the runbook.

> The checked-in `deploy/nginx/voidpixelatr.conf` names `192.0.2.0` — the RFC
> 5737 documentation address — as a placeholder. `scripts/deploy.sh`
> substitutes the real address when it installs the file. **Leave the
> placeholder alone**; it can never collide with a live machine.

---

## 3. Set the hostname

```bash
pct set <new-vmid> --hostname VoidPixelatr
```

or from inside the guest:

```bash
hostnamectl set-hostname VoidPixelatr
```

---

## 4. Regenerate the SSH host keys — **do not skip**

A clone inherits the source container's `/etc/ssh/ssh_host_*`. Two live
containers then share a host identity and every client refuses to connect to
the second one with `REMOTE HOST IDENTIFICATION HAS CHANGED`.

```bash
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A
systemctl restart ssh
```

Then clear the stale entry on any client that has seen the old keys:

```bash
ssh-keygen -R <new-ip>
```

---

## 5. Confirm key access

There is **one** deploy key for all of TheVoidCo's infrastructure. A clone
inherits it in `/root/.ssh/authorized_keys`, so this normally works
immediately:

```bash
ssh -i ops/keys/thevoidco-lxc-id_ed25519 -o IdentitiesOnly=yes \
    -o BatchMode=yes root@<new-ip> 'hostname; ip -4 addr show eth0'
```

If the key is missing, install it:

```bash
ssh-copy-id -i ops/keys/thevoidco-lxc-id_ed25519.pub root@<new-ip>
```

`ip -4 addr show eth0` should show the address you reserved, with
`scope global dynamic` — that confirms DHCP handed it the reserved lease.

---

## 6. Register the host

**`ops/vm.sh`** — uncomment and fill in the three entries:

```bash
[voidpixelatr]="<the address you reserved>"        # VM_HOSTS
[voidpixelatr]="root"                               # VM_USERS
[voidpixelatr]="ops/keys/thevoidco-lxc-id_ed25519" # VM_KEYS — the shared key
```

**`CREDENTIALS.md`** — the key-based host table already lists `voidpixelatr`.
There is **no password** for it: it authenticates with the shared key, so no
`export` line is needed. Never paste the private key anywhere — reference the
path.

---

## 7. Verify

```bash
./ops/vm.sh voidpixelatr 'hostname; uptime; nginx -t'
```

---

## 8. Deploy

```bash
cd ~/Desktop/voidpixelatr
./scripts/deploy.sh <the address you reserved>
```

This rsyncs the site files, installs the vhost and the shared
security-headers snippet, runs `nginx -t` before reloading (so a broken
config never takes the running site down), and smoke-tests the result.

If the address changes, `scripts/deploy.sh` takes it as an argument, so no file
needs editing.

---

## 9. Assess the resources

A live container is not a finished container. VoidPixelatr is a static site, so
the floor — 1 core, 256 MB, 32 GB — should hold; measure under load and
report if it does not. The Proxmox resources are changed by hand in the web
UI, so the handover is a **report**, not an edit.

---

## After the site is live

- The registry row in the umbrella `README.md` changes from **Development** to
  **LAN-only**, with the address in the Domain column.
- `python3 website/scripts/sync-registry.py` refreshes the landing page.
- The vhost's placeholder is substituted at deploy time, so the checked-in
  file never needs editing.
