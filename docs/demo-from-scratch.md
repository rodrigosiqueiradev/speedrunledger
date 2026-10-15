# SpeedrunLedger demo from scratch (Windows PowerShell, no seed)

Run everything from the root of your clone of this repo. Every handle on the
local PDS must end in `.test`.

You'll use four accounts:

| Account | Role in the demo |
| --- | --- |
| `daisy.test` | Sysadmin: creates the community from a request |
| `mario.test` | Asks for the community and becomes its first moderator |
| `luigi.test` | Second moderator, so mario can't approve his own runs alone |
| `yoshi.test` | Runner who submits runs |

## 1. Start from a clean stack

```powershell
pnpm infra:down --volumes
pnpm infra:up
```

Wait until it prints the three app URLs (Runner, Moderator and Admin).

## 2. Create the accounts

```powershell
foreach ($h in 'daisy','mario','luigi','yoshi') {
  Invoke-RestMethod -Method Post http://localhost:2583/xrpc/com.atproto.server.createAccount `
    -ContentType application/json `
    -Body (@{ handle = "$h.test"; email = "$h@example.test"; password = 'demo-password' } | ConvertTo-Json)
}
```

## 3. Set up the platform (Admin app, as daisy)

1. Copy the setup code, which is the community service's admin token from
   your dev.env:

   ```powershell
   (Select-String '^COMMUNITY_ADMIN_TOKEN=' "$env:USERPROFILE\.local\share\speedrunledger\dev.env").Line.Split('=')[1]
   ```

2. Open http://127.0.0.1:2589 and sign in as `daisy.test` /
   `demo-password`.
3. The app sees there is no platform yet and shows **Set up the platform**.
   Enter `ledger.test` as the platform account handle, paste the setup code,
   and click **Create the platform account**. You are now the first sysadmin.

`ledger.test` is the platform's own account; its repo lists the sysadmins.
This works once per stack. Anyone else who signs in to the Admin app sees
**Not a sysadmin** until you add them under **Sysadmins**.

## 4. Ask for a community (Runner app, as mario)

1. Open http://127.0.0.1:2585 and sign in as `mario.test` / `demo-password`
   (you approve on the PDS's own sign-in and consent pages).
2. Go to **Start a community**. Fill in the game (for example
   *The Legend of Zelda: Ocarina of Time*, 1998, N64) and the founders:
   `mario.test, luigi.test`. Submit.

## 5. Create the community (Admin app, as daisy)

1. Back in the Admin app, **Requests** lists mario's request (reload if it
   isn't there yet).
2. Click **Create community**, enter the handle `oot.test` and the name
   `Zelda: OoT`, and click **Create community**.

The game and founders come from the request.

## 6. Founders accept (Moderator app)

1. Open http://127.0.0.1:2587, sign in as `mario.test`, and click
   **Accept invitation** under **Your communities**.
2. Sign out, sign in as `luigi.test`, and accept too.

Use a private window per account if you'd rather not sign out.

## 7. Add a category and its rules (Moderator app)

Category and rule changes need a majority vote. With two moderators, both
must vote yes.

1. As mario, open the community, go to **Games and categories**, click
   **Propose a category** (for example *Any%*, real time, video required,
   one approval). Submit the proposal.
2. Go to **Proposals** and vote **yes**.
3. As luigi, open **Proposals** (or *Waiting for your vote* on the home page)
   and vote **yes**. The category appears within a few seconds.
4. Back in **Games and categories**, use the category's **Propose rules** link to propose rules
   text, and vote yes with both moderators again.

## 8. Submit a run (Runner app, as yoshi)

1. Sign in to http://127.0.0.1:2585 as `yoshi.test`.
2. Open the game's board and **Submit a run**: the category, a time, and a
   video link (any YouTube URL works). The first submission warns you that
   runs are public.
3. **My runs** shows it as pending.

## 9. Review it (Moderator app)

1. As mario or luigi, open **Review queue**, pick yoshi's run, and choose a
   verdict: verify, retime, request changes, or reject.
2. Verify it, and it shows up on the board in the Runner app. As the first
   verified run in the category, it's also the world record. The community
   announces it as a post from `oot.test`, and yoshi gets a notification.

## Optional extras

- **Second runner.** Create another account (step 2 command with a new
  handle), submit a faster run, verify it, and watch the world record change
  hands on the board.
- **Invite a third moderator.** In the community's **Moderators** tab, use
  **Propose invite**; it passes once a majority votes yes.
- **Ban.** Any single moderator can ban a runner from the **Bans** tab.
- **Freeze.** In the Admin app, open **Communities**, then the community,
  give a reason and click **Freeze community**. The board stays visible but
  new verdicts and votes are blocked; **Unfreeze community** undoes it.
- **Export.** **Export repo** on the same page downloads the community's
  whole repo as a CAR file.
- **Command line.** Everything above also works from `pnpm ledger-admin`
  (`pnpm ledger-admin --help`), which the demo seed uses.

## Start over

```powershell
pnpm infra:down --volumes
```

This deletes every account and record. Run `pnpm infra:up` to start fresh.
