# Shut Down button — one-time Pi setup

The pendant's **Settings → Shut Down** button is a soft poweroff: it halts
the Raspberry Pi cleanly so the operator can flip the mains switch without
risking SD-card corruption. The backend exec's `sudo /sbin/poweroff` after
~1.5 seconds (long enough for the WebSocket reply to reach the GUI and the
pendant to switch to its "Safe to power off" overlay).

For this to work, the `ionetic` user on the Pi needs to be allowed to run
`/sbin/poweroff` with `sudo` **without a password**. This is a one-time
deploy step, done by hand on each Pi.

## Adding the sudoers entry

On the Pi, run:

```bash
sudo visudo -f /etc/sudoers.d/gillis-shutdown
```

Paste:

```
ionetic ALL=(root) NOPASSWD: /sbin/poweroff
```

Save and exit (Ctrl+O, Enter, Ctrl+X in nano; `:wq` in vi). The file must
have permissions `0440` — `visudo` enforces this automatically.

Test:

```bash
sudo -n /sbin/poweroff --help
```

`-n` means "non-interactive" — it'll fail loudly if the sudoers rule
isn't picked up, instead of falling back to a password prompt. If you see
the poweroff help output, you're good. **Don't actually shut down here —
just verify the auth.** (The `--help` flag prevents the actual poweroff.)

## Verifying from the GUI side

Once deployed, the Shut Down button in **Settings** should:

1. Open a red confirmation modal when tapped.
2. After confirming, show a full-screen "Shutting down…" overlay with a
   "wait for screen to go dark before flipping mains" warning.
3. Screen goes dark within ~20 seconds as the OS halts.

If the button is greyed out, the machine is mid-run, mid-homing, or mid-
motion — abort/finish that first.

If the screen doesn't go dark within ~30 seconds, the sudoers entry is
likely missing or wrong. Check `/tmp/gillis-server.log` on the Pi via SSH:

```bash
ssh ionetic@Gillis.local "tail -20 /tmp/gillis-server.log"
```

You'll see `[gillis backend] poweroff exec failed:` with the OS error
message if the auth setup is off.

## Security note

This sudoers entry grants the `ionetic` user the ability to halt the
machine without a password — but only the specific binary
`/sbin/poweroff`, nothing else. The pendant is on a closed network and
the GUI sits behind a kiosk Chromium; the operator cannot run arbitrary
commands through it. Halting the Pi is a low-risk privilege compared to
e.g. file system writes.
