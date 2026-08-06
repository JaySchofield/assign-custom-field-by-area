One-off script that infers a market/subzone hierarchy from Terros area
polygons and bulk-updates account custom fields accordingly.

## What it does

1. Fetches every area on the account (`client.area.list`, paged via cursor).
2. Builds a turf polygon for each area and computes geographic containment between
   every pair of areas (`buildContainment`) — i.e. which areas sit inside which.
3. Using that containment data, an area is classified as:
   - **Subzone** — an area that is contained by another area (has no sub-areas of its
     own). Tagged with `subzoneFieldId` and a "depth" (how many levels of nesting it's
     inside), so that deeper areas are submitted before shallower ones.
   - **Market** — a "root container": an area that contains other areas but is not
     itself contained by anything. A middle area in a 3-level stack (contains one area,
     but is itself contained by another) is excluded — only the true top-level area
     counts as a market. Tagged with `marketFieldId`.
4. For each classified area, submits one `client.account.bulk` call that:
   - Filters accounts whose location falls inside the area's polygon (`coordinates`),
     using the account's own additional filters (`area.filters`) if present.
   - Excludes accounts where the target custom field is already set, so re-running the
     script is safe/idempotent.
   - Sets the custom field (`updateCustomField` action) to the area's name.
5. Prints a summary of how many updates were submitted vs. failed.

The subzone and market passes write to different custom fields, so they run together
in a single execution — there's no shared-field race to worry about.

## Configuration

All options are CLI flags (parsed with Node's built-in `node:util.parseArgs`), passed
after `--` when running through `pnpm`/`npx`:

- `--subzone-field-id <id>` — custom field ID to write for subzone areas. Defaults to the
  value hardcoded in `parseCliOptions` in `index.ts`; edit that default directly if you'd
  rather not pass the flag every run. Pass `--subzone-field-id ""` to skip the subzone
  pass entirely.
- `--market-field-id <id>` — custom field ID to write for market (top-level) areas. Same
  deal — defaults to the value hardcoded in `parseCliOptions`, editable there. Omit (or
  pass `""`) to skip the market pass entirely.
- `--dry-run` — logs what each area update _would_ do instead of calling
  `client.account.bulk`. No accounts are touched. There's no native dry-run support in
  the SDK, so this just short-circuits before the API call.
- `--max-updates-per-pass <n>` — caps how many area updates each pass (subzone/market)
  submits. Useful for trying the script against a handful of areas before running it for
  real. Omit for no cap.
- `--only-area-ids <id,id,...>` — restricts processing to just these area IDs, e.g.
  `--only-area-ids Area.abc123,Area.def456`. Containment is still computed over every
  area on the account (so a targeted area's parents/children are classified correctly),
  but only listed areas get submitted. Omit to process every area.
- `--verbose` — logs the full `filter`/`actions` payload sent to (or that would be sent
  to, under `--dry-run`) `client.account.bulk` for each update, for inspecting exactly
  what's being matched/changed.

## Running it

```sh
pnpm install
```

Authenticate with Terros — either export an API key the SDK picks up, or run
`terros auth login` from the CLI, then:

```sh
npx tsx index.ts -- --market-field-id CF.market1
```

(or `npx tsx index.ts -- <flags>` / however your local runner is set up for a plain `.ts`
entrypoint — just make sure flags come after `--` so they reach the script, not the
runner).

The script logs each submitted/failed area update as it runs and prints a final summary.
A non-zero exit occurs if any individual account update fails.

## Testing before a full run

1. Run with `--dry-run` (and optionally `--verbose` to see the exact request payloads)
   — it will log every area update it would submit, with no writes to any account.
   ```sh
   npx tsx index.ts -- --dry-run --verbose
   ```
2. Narrow to a known area or two with `--only-area-ids` (or use
   `--max-updates-per-pass` for an arbitrary small sample) to keep the dry-run output
   readable.
   ```sh
   npx tsx index.ts -- --dry-run --only-area-ids Area.abc123
   ```
3. Once satisfied, drop `--dry-run` with `--only-area-ids`/`--max-updates-per-pass`
   still set to submit just a couple of real updates and confirm the custom field shows
   up correctly in Terros.
4. Drop `--only-area-ids`/`--max-updates-per-pass` for the full run.

## Notes / limitations

- `client.account.bulk` only accepts a single polygon filter and a single action per
  call, so each area/field update requires its own API call — these can't be batched
  further with the current SDK.
- Areas with no name or fewer than 3 coordinates are ignored (can't classify or form a
  polygon).
