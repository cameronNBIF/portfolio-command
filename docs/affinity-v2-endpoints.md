# Affinity REST API v2 — the endpoints A4 uses

Companion to ADR-009. That ADR says *what* the sync does and why; this file says
*how* it talks to Affinity, and records the v1→v2 delta so the analysis is not
repeated.

**Base URL** `https://api.affinity.co/v2` · **Auth** `Authorization: Bearer <key>`
· **Key** Affinity Settings → Manage Apps. v2 access is license-gated; a v1 key
returns 401 here.

**Rate limits** 900 requests per user per minute, plus a monthly account ceiling
that depends on plan tier. Both answer 429. Nothing this sync does approaches
either — see *Cost of a nightly sync* below — but `functions/src/affinity/client.ts`
backs off on 429 and 5xx from the start rather than after the first incident.

---

## The v1 → v2 delta

An earlier field-mapping pass ran against **v1** (`/fields`, `/field-values`,
`/persons`, HTTP basic with an empty username). Its output is not portable:

| | v1 | v2 |
|---|---|---|
| Field id | `5450947` (integer) | `field-5450947` for list and global fields; `affinity-data-location`, `last-email-date` and similar for enriched and relationship-intelligence |
| Auth | basic, empty username | bearer |
| Reading values | `GET /field-values?list_entry_id=…`, **one call per entry** | inline on the list-entries response, 100 entries per page |
| Person fields | `person_id` integer, then `GET /persons/{id}` | hydrated inline: `firstName`, `lastName`, `primaryEmailAddress`, `type` |
| Location fields | nested object | nested object (unchanged) |
| Relationship-intelligence fields | **absent from `/fields`** | first-class, `fieldTypes=relationship-intelligence` |
| Enriched fields | **absent from `/fields`** | first-class, `fieldTypes=enriched` |

The last two rows explain the seven columns that came back as
*"System or enriched field not found in standard /fields API payload"* in the v1
mapping. None of them is missing:

| CSV column | v2 resolution |
|---|---|
| `Name` | `entity.name` — not a field |
| `Website` | `entity.domain` / `entity.domains` — not a field |
| `Date Added` | relationship-intelligence field, or `listEntry.createdAt` |
| `Last Email` | relationship-intelligence |
| `Last Meeting` | relationship-intelligence |
| `Overall Score` | relationship-intelligence (0/76 filled — configured, never used) |
| `CB Investors - Not available for export` | enriched. **Reference only** — Crunchbase investors are not NB co-investors, so this never feeds leverage or the NB co-investment KPI. ADR-012's deal-close form remains the only source. |

---

## Field types

v2 sorts every field into one of four `type` values, and a request that names
none of them returns entities **with no field data at all**:

| `fieldTypes` | What it holds |
|---|---|
| `list` | Fields defined on this list only — Status, Owners, Investment Round, Source of Deal |
| `global` | Fields on the entity across the account — Priority Sector, Risk Assessment, FMV, CEO |
| `enriched` | Affinity/Dealroom firmographic and funding data — Total Funding Amount (USD), CB Investors |
| `relationship-intelligence` | Derived from the team's email and calendar — Last Email, Last Meeting |

Multiple values are **repeated parameters**, not comma-joined:
`?fieldTypes=list&fieldTypes=global&fieldTypes=enriched&fieldTypes=relationship-intelligence`

Array-valued fields append `-multi` (`dropdown-multi`, `person-multi`,
`company-multi`). **An empty array is returned as `null`, not `[]`** — which is
why the sync must treat null and empty as the same absence rather than as a
distinguishable state.

---

## Endpoints

### Roster — the nightly sync's main read

```
GET /v2/lists/328745/list-entries
      ?fieldTypes=list&fieldTypes=global&fieldTypes=enriched
      &fieldTypes=relationship-intelligence&limit=100
```

Returns `{ data: ListEntry[], pagination: { prevUrl, nextUrl } }`. Follow
`nextUrl` verbatim to exhaustion — it carries the cursor and every original
parameter. Requires the **"Export data from Lists"** permission on the key.

`listEntry.id` is the export's **Affinity Row ID**. `listEntry.entity.id` is the
export's **Organization Id**.

### Field metadata

```
GET /v2/lists/328745/fields
```

Per field: `id`, `name`, `type`, `valueType`, `enrichmentSource`, `createdAt`.
Does **not** include dropdown options.

### Dropdown vocabularies — ADR-009's "seed from metadata, not observed data"

```
GET /v2/lists/328745/fields/{fieldId}/dropdown-options
```

Returns `id`, `text`, **`rank`** and `color` per option, for `dropdown`,
`ranked-dropdown` and `status-dropdown` fields. This is the input `ref_funnel_stage`
needs: ADR-009 records ranks 2, 8, 9 and 11 as existing but unobserved in the
exports, and seeding from observed values alone would silently omit them. It is
also what lets `pipeline_deal.funnel_stage_id` return to `NOT NULL` at A4, as its
schema comment requires.

### Stage history — `affinity_field_change`

```
GET /v2/field-value-changes?filter=field.id=field-XXXX&filter=changedAt>2026-08-12T00:00:00Z
```

**Account-wide and filterable.** ADR-009 justified the local mirror on the
grounds that "the endpoint is per-list-entry and a funnel chart would otherwise
fan out to one API call per deal." The per-entry endpoint still exists
(`/lists/{listId}/list-entries/{listEntryId}/field-value-changes`), but the
account-wide one makes full Status-history backfill a handful of paginated calls
rather than one per entry, and the nightly delta a single `changedAt` filter.

The mirror is still worth keeping — ADR-009's intent was query performance and
that is unchanged — but the stated reason is now wrong and the backfill is cheap.
**Amend ADR-009 once the probe confirms this against the live account.**

A dropdown option removed from the field config still appears in history as
`referenceType: deleted-entity` with no `dropdownOptionId`. The sync stores
`displayValue` and must not fail on the missing id.

### Saved views — validation only, not the sync source

```
GET /v2/lists/328745/saved-views
GET /v2/lists/328745/saved-views/{viewId}/list-entries
```

Respects the view's filters and column selection, but **does not preserve sort
order** and supports sheet-type views only.

**Decision (2026-08-12): the sync reads the whole list and derives Pipeline vs
Portfolio membership from `Status`.** ADR-009's central correction was that these
are two saved views of one list and a company keeps its identity across the whole
journey; syncing per view would reintroduce the two-list model at the API layer,
and a company graduating between two nightly runs would read as a disappearance
from one view and an arrival in the other rather than as the Status change it is.
The saved-view endpoints are used to reconcile against the team's CSV exports.

---

## Identifier namespaces

| Concept | v2 | CSV export |
|---|---|---|
| List entry | `listEntry.id` | `Affinity Row ID` |
| Organisation | `listEntry.entity.id` | `Organization Id` |

**Settled, 12 August 2026: same namespace, both of them.** The probe matched
`Organization Id` to `entity.id` on **162 of 162** rows and `Affinity Row ID` to
`listEntry.id` on **162 of 162**, across both exports. ADR-009's earlier caution
— that the two "differ by two orders" and must not be assumed equivalent — was
reading age as namespace: long-lived global organisation records hold low ids
(Introhive 1607682, Lastwall 1783269, Smart Skin 1656466) and recently created
ones hold high (307–313 million). ADR-009 is amended.

`company.website` remains the crosswalk to Visible and to Finance's records —
it is namespace-independent and populated on 80 of 80 portfolio rows.

---

## Cost of a nightly sync

**Measured, 12 August 2026: 348 entries in 4 paginated calls.** The exports show
82 Pipeline and 80 Portfolio rows; both views are Status-filtered, so 186 entries
— Passed, Watchlist, Exited, Intake — appear in neither.

| Call | Count |
|---|---|
| List entries, all four field types | 4 |
| Field metadata | 1 |
| Dropdown options, changed fields only | 0–12 |
| `field-value-changes` delta since last run | 1–2 |
| **Total** | **~6–19** |

The full probe, which pulls every dropdown vocabulary as well, cost **23 calls**.

The v1 hierarchy the earlier mapping described would have been 1 field-metadata
call, one `field-values` call **per entry**, and one `/persons` call per distinct
person reference — several hundred, for the same data. Neither approach breaches
the 900/minute limit; the difference matters for the monthly account ceiling and
for how long a sync holds a connection.

Syncing the whole list rather than the two views is what surfaces the Passed and
Watchlist populations the exports hide — a gain, not a cost: funnel conversion
and drop-off cannot be measured from the survivors alone.

### Two fields exist on entries but not in `/fields`

`GET /lists/{listId}/fields` returns 156 fields. The entry payload carries **158**:
`created-at` ("Date Added") and `time-in-current-status` ("Time in Current Status"),
both 348/348 filled, are absent from the metadata endpoint. A sync that builds its
field list from metadata alone silently drops `date_added`. (`time-in-current-status`
is derived and must not be stored — ADR-002; `v_deal_stage_history` already
computes it.)

Note that syncing the whole list rather than the two views is what surfaces the
Passed and Watchlist populations the exports hide — which is a gain, not a cost:
funnel conversion and drop-off cannot be measured from the survivors alone.

---

## Timezone

Affinity's date-only fields arrive as UTC timestamps anchored to **US Pacific
midnight**. Pin the timezone when extracting a date, or `Deal Flow Stage Changed`,
`Date Added`, `Last Email` and `Last Meeting` land a day early for anyone east of
Pacific — which is everyone here.
