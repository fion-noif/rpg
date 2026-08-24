# Racing Parts Cost Entry & QuickBooks Integration Plan

> **[08/08/2026] Design review update.** Reviewed alternatives (QBO restricted users, off-the-shelf field-service tools, low-code, POS+sync) — custom app confirmed, because the differentiator is the event-scoped worker→customer authorization model. Key decisions folded into the sections below: (1) post **draft Invoices** — Delayed Charge is not exposed by the QuickBooks API; (2) concrete idempotency via deterministic DocNumber + query-before-create; (3) **CDC polling instead of webhooks**; (4) catalog search runs **client-side on the phone**; (5) simplified submission state machine; (6) magic-link worker auth. Implementation milestones added in Section 30.

## 1. Background

The racing team uses QuickBooks Online (currently the Essentials plan)
to manage its accounting, customers, and parts/products.

During a typical race weekend:

-   There may be approximately **10--50 customers**.
-   There may be approximately **10--50 workers**.
-   Each worker normally supports **one customer**, or at most **two
    customers**.
-   Workers need to record kart parts consumed by their assigned
    customers, such as:
    -   Axles
    -   Tires
    -   Chains
    -   Sprockets
    -   Brake components
    -   Bodywork
    -   Other kart parts
-   Some workers speak English and some speak Spanish.
-   The parts catalog is relatively large, so workers need fast search
    rather than browsing a long list.
-   Frequently used parts should be immediately accessible.
-   Workers should not have access to the company's broader QuickBooks
    information.
-   Workers should not need to browse the complete historical customer
    list.
-   QuickBooks should remain the authoritative source for customers and
    the parts catalog so that duplicate master data does not drift over
    time.

The proposed solution is therefore a **custom, mobile-friendly web
application** that sits between race workers and QuickBooks.

Workers do not log in to QuickBooks. They interact only with the racing
application.

------------------------------------------------------------------------

## 2. Primary Objectives

The system should:

1.  Let a worker record a part used for a customer in a few seconds.
2.  Restrict each worker to the one or two customers assigned to them
    for that race weekend.
3.  Support English- and Spanish-speaking workers.
4.  Make a large parts catalog easy to search.
5.  Put frequently used parts at the top of the interface.
6.  Keep QuickBooks as the single source of truth for customers and
    parts.
7.  Prevent workers from seeing accounting information, historical
    customers, bank information, reports, payroll, or other sensitive
    QuickBooks data.
8.  Allow management to review and correct submitted parts usage.
9.  Push approved customer charges into QuickBooks.
10. Avoid maintaining duplicate translations or duplicate master-data
    systems.

------------------------------------------------------------------------

## 3. Core Design Principle

### QuickBooks is the system of record for master data.

QuickBooks owns:

-   Customers
-   Products / parts
-   SKU
-   Product name
-   Product description
-   Sales price
-   Product category, where applicable
-   Active/inactive status

The racing application maintains synchronized, read-only cached copies
of this information.

### The racing application owns operational data.

The custom application owns information specific to race operations,
including:

-   Workers
-   Worker authentication
-   Worker language preference
-   Race weekends/events
-   Worker-to-customer assignments
-   Parts usage
-   Submission timestamps
-   Submission status
-   Approval status
-   Part popularity
-   Audit information

Customers and parts should **not normally be created or edited inside
the racing application**.

This creates a clear ownership boundary and prevents master-data drift.

------------------------------------------------------------------------

## 4. High-Level Architecture

``` text
                     QUICKBOOKS
              ──────────────────────
                  MASTER DATA

                  Customers
                  Products / Parts
                    • SKU
                    • Bilingual name
                    • Description
                    • Price
                    • Category
                    • Active status

                         │
                         │ sync
                         ▼

                RACING APP DATABASE
              ──────────────────────

              Synchronized/read-only:
                  Customers
                  Parts
                  Prices

              App-owned:
                  Workers
                  Race weekends
                  Assignments
                  Part popularity
                  Parts usage
                  Approval state
                  Audit history

                         │
             ┌───────────┴───────────┐
             ▼                       ▼

        WORKER APP                 ADMIN APP

     Assigned customers          Weekend setup
     Popular parts               Assign workers
     Parts search                Review usage
     Add quantities              Correct entries
     Submit usage                Approve/post

             └───────────┬───────────┘
                         │
                         ▼

                     QUICKBOOKS
                  Customer charges /
                      invoices
```

------------------------------------------------------------------------

## 5. Why Workers Should Not Use QuickBooks Directly

Giving 10--50 race workers QuickBooks accounts creates several problems:

-   QuickBooks permissions are broader than this workflow requires.
-   Customer visibility is difficult to restrict precisely to one or two
    assigned customers.
-   Workers could potentially see customer or accounting information
    they do not need.
-   Managing dozens of QuickBooks users every weekend would create
    unnecessary administration.
-   QuickBooks transaction-entry screens are not optimized for rapid
    parts consumption at a racetrack.
-   The worker's task is operational, not bookkeeping.

A purpose-built interface can expose only the exact information
necessary to perform the task.

------------------------------------------------------------------------

## 6. User Roles

### 6.1 Worker

A worker can:

-   Log in to the racing application.
-   Select English or Spanish.
-   See only customers assigned to them for the current event.
-   Search the parts catalog.
-   See popular parts.
-   Add a part and quantity.
-   Review their current submission.
-   Submit parts usage.

A worker cannot:

-   Access QuickBooks.
-   View the full customer database.
-   View historical customers unless explicitly assigned.
-   Modify customers.
-   Modify the master parts catalog.
-   Modify prices.
-   View accounting reports.
-   View bank accounts.
-   View payroll.
-   View company-wide financial information.

### 6.2 Manager / Administrator

An administrator can:

-   Create/configure a race weekend.
-   Assign workers to customers.
-   View all current-weekend customers.
-   Review submitted parts usage.
-   Correct errors.
-   Approve customer charges.
-   Trigger a QuickBooks synchronization.
-   View synchronization status.
-   Post approved transactions to QuickBooks.

Customer and part master-data changes should generally still be
performed in QuickBooks.

------------------------------------------------------------------------

## 7. Race Weekend Model

Each race weekend/event should be represented explicitly.

Example:

``` text
Event:
2026 US Karting Championship - Round 7

Dates:
August 8–9, 2026

Customers:
42

Workers:
37
```

Worker assignments belong to the event rather than being permanent.

Example:

  Worker   Assigned Customer(s)
  -------- ----------------------------
  Mike     Smith Racing
  Carlos   Garcia Racing
  Alex     Miller Racing, Chen Racing
  David    Johnson Racing

This allows assignments to change every weekend without changing the
master customer records.

------------------------------------------------------------------------

## 8. Customer Access Design

Customer access should follow the principle of least privilege.

### Worker with one customer

If Mike is assigned only to Smith Racing, the app should simply show:

``` text
Customer: Smith Racing
```

No customer picker is necessary.

Mike should not see any other customers.

### Worker with two customers

If Alex supports Miller Racing and Chen Racing:

``` text
Select customer:

[ Miller Racing ]   [ Chen Racing ]
```

Only those two customers should be visible.

### Administrator

Administrators can see all customers participating in the event.

This is preferable to letting workers browse all 10--50 weekend
customers, and substantially preferable to exposing the complete
historical QuickBooks customer database.

------------------------------------------------------------------------

## 9. Parts Master Data

QuickBooks Products & Services should function as the master parts
catalog.

A typical QuickBooks part might contain:

``` text
SKU:
AX50-M

Name:
50mm Medium Axle - Eje medio 50mm

Description:
50mm medium racing kart axle - Eje medio para kart de 50mm

Price:
$175

Category:
Axles

Status:
Active
```

The custom application synchronizes these values from QuickBooks.

------------------------------------------------------------------------

## 10. Bilingual Parts Strategy

A separate translation database is not required.

Instead, the QuickBooks product name and/or description can contain both
English and Spanish.

Examples:

``` text
AX50-S
50mm Soft Axle - Eje blando 50mm

AX50-M
50mm Medium Axle - Eje medio 50mm

AX50-H
50mm Hard Axle - Eje duro 50mm

MG-YEL
MG Yellow Tires - Neumáticos MG Amarillos

CH219
#219 Chain - Cadena #219
```

Benefits:

-   One authoritative description.
-   No translation synchronization problem.
-   Both English and Spanish terms are searchable.
-   Administrators control terminology directly in QuickBooks.
-   Workers in either language can identify the same SKU.

The SKU should remain the permanent technical identifier.

**Conventions (decided 08/08/2026):**

-   Use a consistent `English Name - Nombre Español` format so search and
    display logic can rely on it.
-   QuickBooks limits item Name to **100 characters** — keep bilingual
    names within that; overflow Spanish text goes in the Description.
-   Accepted trade-off: item names/descriptions print on QuickBooks
    invoices, so customers will see the bilingual text. For a bilingual
    clientele this is acceptable (arguably a feature); the alternative
    (app-side Spanish aliases) would reintroduce the translation-drift
    problem this design avoids.

------------------------------------------------------------------------

## 11. Application Localization

Although part translations come from QuickBooks, the application
interface itself should support English and Spanish.

Example interface strings:

  English         Spanish
  --------------- -------------------
  Customer        Cliente
  Search parts    Buscar piezas
  Popular parts   Piezas frecuentes
  Quantity        Cantidad
  Add             Añadir
  Remove          Eliminar
  Submit          Enviar
  Parts used      Piezas utilizadas
  Cancel          Cancelar
  Confirm         Confirmar

These are a relatively small set of application strings and can be
maintained directly in the application code.

A worker's language preference can be stored in their profile and
changed from the interface.

------------------------------------------------------------------------

## 12. Parts Search

Because the catalog may be large, workers should not primarily use a
conventional dropdown.

The interface should provide three primary ways to find parts.

### 12.1 Popular Parts

Frequently used parts appear immediately.

Example:

``` text
POPULAR PARTS
─────────────────────────────
MG Yellow Tires            +
50mm Medium Axle           +
#219 Chain                 +
11T Sprocket               +
Brake Pads                 +
```

Popularity can be calculated automatically from historical and/or
current-event usage.

Popularity is operational data owned by the racing application; it does
not need to be stored in QuickBooks.

### 12.2 Search

Workers should be able to type any part of:

-   SKU
-   English name
-   Spanish name
-   Description

For example, all of these searches could find the same item:

``` text
AX50-M
axle
eje
50mm
medium
medio
```

Search should be:

-   Case insensitive.
-   Accent tolerant where practical.
-   Fast and local to the racing application.
-   Able to search SKU, name, and description simultaneously.

**Implementation decision (08/08/2026):** at this catalog scale
(hundreds to low thousands of items), the full active catalog is small
enough to ship to the worker's phone on page load and search entirely
**client-side** with accent-folding. This gives instant zero-latency
search, keeps working through flaky track Wi-Fi (the catalog is already
on the device), and removes a server-side search endpoint from V1.

### 12.3 Categories

Categories can provide another navigation option:

``` text
Tires
Axles
Sprockets
Chains
Brakes
Bodywork
Engine
Hardware
Other
```

If QuickBooks categories are used consistently, these can also be
synchronized from QuickBooks.

------------------------------------------------------------------------

## 13. Optional Barcode / QR Support

Barcode or QR scanning is a useful future enhancement.

A barcode or QR code can correspond to the QuickBooks SKU.

A worker could:

1.  Pick up a part.
2.  Scan its barcode.
3.  Confirm customer.
4.  Enter quantity.
5.  Tap Add.

Example:

``` text
50mm Medium Axle - Eje medio 50mm

Customer:
Smith Racing

Quantity:
[-]  1  [+]

[ ADD ]
```

This could eventually become faster than search for commonly stocked
physical parts.

It is not required for the first version.

------------------------------------------------------------------------

## 14. Worker Interface

The worker application should be optimized for phones.

### Login

**Decision (08/08/2026): magic links / QR codes generated by the
administrator, per worker per event.** No passwords. The admin creates a
worker for the weekend and hands them a link or QR code containing a
signed, event-scoped token; the link logs the worker in on their phone
for the duration of the event and is individually revocable. A short PIN
can be added later as a fallback if links prove awkward trackside.

Alternatives considered: phone number + SMS (adds cost and a delivery
dependency at tracks with poor signal), username/password (too much
friction for 10–50 seasonal workers).

The goal is to minimize authentication friction while still
ensuring that a worker can access only their own assignments.

### Main Screen

Example:

``` text
Carlos Martinez

Español | English

Customer:
Garcia Racing

─────────────────────────────

🔍 Search / Buscar piezas

POPULAR
─────────────────────────────

MG Yellow Tires
Neumáticos MG Amarillos       +

50mm Medium Axle
Eje medio 50mm                +

#219 Chain
Cadena #219                   +

─────────────────────────────

CATEGORIES

Tires / Neumáticos
Axles / Ejes
Chains / Cadenas
Sprockets / Piñones
Brakes / Frenos
Other / Otros
```

------------------------------------------------------------------------

## 15. Cart-Based Entry

Rather than creating a transaction immediately every time a worker taps
a part, the app should use a cart-like workflow.

Example:

``` text
GARCIA RACING

Parts Used
─────────────────────────────

MG Yellow Tires
1 set

50mm Medium Axle
1

11T Sprocket
2

─────────────────────────────

[ ADD MORE ]

[ SUBMIT ]
```

Benefits:

-   Worker can catch mistakes before submission.
-   Multiple parts can be submitted together.
-   Quantity changes are easy.
-   The interface is familiar.
-   Fewer incomplete or accidental transactions are generated.

Whether workers see customer prices can be configurable.

For many workers, showing only part and quantity may be preferable.

------------------------------------------------------------------------

## 16. Submission Workflow

A parts usage record should contain at least:

``` text
Event ID
Customer ID
QuickBooks Customer ID
Worker ID
Part ID
QuickBooks Item ID
SKU
Quantity
Submission timestamp
Status
```

The app may also snapshot relevant information such as item name and
price for audit purposes.

States (simplified 08/08/2026 — the earlier `DRAFT`/`REVIEWED` states
had no distinct behavior; the cart is the draft, and review happens
while `SUBMITTED`):

``` text
SUBMITTED
   ↓          (manager may edit/add/remove while SUBMITTED; edits logged)
APPROVED
   ↓
POSTED_TO_QUICKBOOKS

POST_FAILED   (retryable error state, reachable from APPROVED)
```

------------------------------------------------------------------------

## 17. Management Review

Management should be able to review parts usage by customer rather than
reviewing dozens of isolated transactions.

Example:

``` text
SMITH RACING
────────────────────────────────

MG Yellow Tires             2
50mm Medium Axle            1
11T Sprocket                2
#219 Chain                  1

Submitted by:
Mike
Carlos

[ EDIT ]

[ APPROVE & POST ]
```

Management can:

-   Change quantity.
-   Remove an erroneous part.
-   Add a missing part.
-   Review who submitted each item.
-   Approve the final customer charges.

------------------------------------------------------------------------

## 18. QuickBooks Synchronization

### 18.1 Master-data direction

Master data flows:

``` text
QuickBooks → Racing App
```

This includes:

-   Customers
-   Products/parts
-   SKU
-   Names
-   Descriptions
-   Prices
-   Categories
-   Active/inactive status

The racing app treats these synchronized fields as read-only.

### 18.2 Transaction direction

Approved operational transactions flow:

``` text
Racing App → QuickBooks
```

**Decision (08/08/2026): one draft Invoice per customer per event.**

On "Approve & Post," the app creates a single QuickBooks **Invoice** for
the customer with usage aggregated into one line per SKU. The invoice is
left as a draft (not emailed) so the bookkeeper can review and send it
from QuickBooks.

Why not the alternatives:

-   **Delayed charges** — not exposed by the QuickBooks Online
    Accounting API at all (UI-only feature), so this option is
    infeasible.
-   **Sales receipts** — imply payment at time of sale; customers are
    billed after the weekend.

Invoice-per-customer-per-event also matches the by-customer review
workflow (Section 17) and provides a natural idempotency anchor
(Section 23, Rule 5).

------------------------------------------------------------------------

## 19. Synchronization Strategy

The application should maintain a local cached copy of relevant
QuickBooks data.

It should **not query QuickBooks every time a worker searches for a
part**.

Architecture:

``` text
QuickBooks
    │
    │ synchronization
    ▼
Racing App Database
    │
    │ fast local query
    ▼
Worker's Phone
```

Benefits:

-   Fast search.
-   Reduced QuickBooks API dependency.
-   Better reliability at racetracks.
-   Less API traffic.
-   Ability to continue operating through temporary QuickBooks/API
    connectivity problems.

**Decision (revised 08/09/2026): manual sync only.** Customers and
parts seldom change during a race weekend, so automatic change detection
(webhooks or CDC polling) is unnecessary complexity. Synchronization
runs only when explicitly triggered: the admin **Sync QuickBooks**
button (and a CLI command for operators). The expected rhythm is one
sync when setting up the weekend, and an ad-hoc sync if a part or
customer is added mid-event. If manual sync ever proves error-prone in
practice, CDC polling remains a cheap retrofit — the sync code path is
identical; only the trigger changes.

An administrator should have a manual:

``` text
[ SYNC QUICKBOOKS ]
```

control for situations where a customer or part has just been added.

------------------------------------------------------------------------

## 20. Adding a New Part

A new part should normally be created in QuickBooks.

Example:

``` text
SKU:
AX50-X

Name:
50mm Extra Soft Axle - Eje extra blando 50mm

Price:
$190

Category:
Axles
```

Then:

1.  QuickBooks becomes the authoritative record.
2.  The racing application detects the change automatically, or an
    administrator selects **Sync QuickBooks**.
3.  The part appears in the racing app.
4.  Workers can immediately search for `AX50-X`, `axle`, `eje`,
    `extra soft`, etc.

The part should not need to be separately recreated in the racing app.

------------------------------------------------------------------------

## 21. Adding a New Customer

The same rule applies to customers.

Workflow:

``` text
Create customer in QuickBooks
        ↓
Synchronize
        ↓
Customer appears in admin app
        ↓
Add customer to race weekend
        ↓
Assign worker(s)
        ↓
Only assigned worker(s) see customer
```

This preserves QuickBooks as the customer master.

------------------------------------------------------------------------

## 22. Data Ownership Summary

  Data                               Owner
  ---------------------------------- ------------
  Customer                           QuickBooks
  Customer name                      QuickBooks
  Customer active status             QuickBooks
  Part                               QuickBooks
  SKU                                QuickBooks
  Part name                          QuickBooks
  English/Spanish part description   QuickBooks
  Sales price                        QuickBooks
  Part category                      QuickBooks
  Worker                             Racing app
  Worker language                    Racing app
  Race weekend                       Racing app
  Weekend customer participation     Racing app
  Worker/customer assignment         Racing app
  Part popularity                    Racing app
  Parts usage                        Racing app
  Approval state                     Racing app
  Submission audit trail             Racing app
  Final accounting transaction       QuickBooks

------------------------------------------------------------------------

## 23. Data Integrity Rules

Several rules should be enforced in the application:

### Rule 1 --- QuickBooks IDs are permanent references

Every synchronized customer and part should retain its QuickBooks object
ID.

Do not match records solely by customer name or product name.

### Rule 2 --- Do not duplicate master-data editing

Customer and product master data should not normally be editable in the
racing app.

### Rule 3 --- Never silently recreate missing QuickBooks records

If a synchronized QuickBooks item becomes inactive or disappears, flag
it rather than automatically creating a replacement.

### Rule 4 --- Preserve transaction audit history

After a worker submits usage, the system should preserve:

-   Original worker
-   Original timestamp
-   Original quantity
-   Manager corrections
-   Approval information
-   QuickBooks posting result

### Rule 5 --- Make posting idempotent

Retrying a failed QuickBooks API call must not accidentally create
duplicate customer charges.

**Mechanism (08/08/2026):** QuickBooks has no idempotency keys, so the
app enforces idempotency itself:

1.  Posting granularity is one invoice per customer per event (a
    "charge batch" row in the app DB).
2.  Each batch gets a deterministic `DocNumber`, e.g.
    `RW-{eventCode}-{customerCode}`.
3.  Before creating an invoice, query QuickBooks by that `DocNumber`;
    if one exists, adopt it (store its ID) instead of creating another.
4.  After a successful create, store the returned QuickBooks
    `Invoice.Id` and `SyncToken` on the batch row.

This makes retry-after-timeout safe: the worst case is a redundant
query, never a duplicate charge.

------------------------------------------------------------------------

## 24. Connectivity Considerations

Racetracks can have unreliable internet connectivity.

Because the team already relies on mobile/trackside networking, the
worker workflow should not depend on a live QuickBooks API call for
every action.

At minimum:

-   Parts/customer data should be cached locally on the application
    server.
-   Searches should use the app database.
-   Submitted usage should be stored safely before attempting QuickBooks
    posting.
-   QuickBooks posting should be retryable.
-   Temporary QuickBooks outages should not prevent workers from
    recording usage.

A later version could add progressive-web-app/offline capabilities if
race-site connectivity proves problematic.

------------------------------------------------------------------------

## 25. Recommended Version 1 Scope

Version 1 should remain intentionally focused.

### Include

1.  Worker authentication
2.  English/Spanish application interface
3.  Race weekend/event management
4.  Worker-to-customer assignment
5.  QuickBooks customer synchronization
6.  QuickBooks Products & Services synchronization
7.  Bilingual part names supplied by QuickBooks
8.  Fast parts search
9.  Popular parts
10. Category browsing
11. Quantity selection
12. Cart
13. Parts usage submission
14. Manager review
15. Manager corrections
16. Approval workflow
17. Posting approved transactions to QuickBooks
18. Audit history
19. Manual QuickBooks sync

### Defer

Potential later enhancements:

-   Barcode/QR scanning
-   Physical quantity-on-hand inventory management
-   Purchasing
-   Warehouse management
-   Sophisticated analytics
-   Automatic change detection for master data (CDC polling) — sync is
    manual-only per the 08/09/2026 revision of Section 19
-   Telemetry integration
-   Driver/kart setup management
-   Offline-first operation
-   Push notifications
-   Automated race reports

This keeps the first release small enough to deploy and test during real
race weekends.

------------------------------------------------------------------------

## 26. Potential Future Evolution

Once the core system is proven, the racing application could grow into a
broader race-operations platform.

Possible future entities:

``` text
Team
  │
  ├── Race Weekend
  │     ├── Customer
  │     │     ├── Driver
  │     │     ├── Kart
  │     │     ├── Parts Used
  │     │     ├── Labor
  │     │     └── Charges
  │     │
  │     └── Workers
  │
  ├── Parts
  ├── Setup Data
  └── Telemetry
```

This should not be built into Version 1 unless required. The initial
application should solve the parts-entry problem cleanly first.

------------------------------------------------------------------------

## 27. Recommended Final Architecture

The recommended solution is:

**QuickBooks Online + custom mobile-friendly racing web application**

with the following separation:

### QuickBooks

Use QuickBooks for:

-   Customer master data
-   Parts/products master data
-   Bilingual part names/descriptions
-   SKU
-   Pricing
-   Accounting
-   Final customer transactions
-   Invoices/payments

### Racing Application

Use the custom application for:

-   Race weekends
-   Workers
-   Worker permissions
-   Customer assignments
-   English/Spanish UI
-   Parts search
-   Popular parts
-   Parts usage
-   Cart/submission
-   Management review
-   Approval
-   QuickBooks synchronization

### Worker Experience

The worker's experience should be approximately:

``` text
Login
  ↓
Assigned customer
  ↓
Popular parts / Search
  ↓
Select part
  ↓
Quantity
  ↓
Add to cart
  ↓
Submit
```

A normal parts entry should take only a few seconds.

------------------------------------------------------------------------

## 28. Key Design Decisions Agreed So Far

1.  Build a custom web application rather than exposing QuickBooks
    directly to workers.
2.  QuickBooks remains the authoritative customer database.
3.  QuickBooks Products & Services remains the authoritative parts
    catalog.
4.  "Inventory" in this project means the parts/product list; physical
    quantity-on-hand inventory management is not currently required.
5.  Customer and parts master data flow from QuickBooks to the custom
    app.
6.  Workers do not receive QuickBooks accounts.
7.  Workers see only the one or two customers assigned to them.
8.  Worker/customer assignments are event-specific.
9.  The app supports English and Spanish.
10. Part names/descriptions can contain both languages directly in
    QuickBooks, such as `Axle N - Eje N`.
11. The custom app does not need to maintain separate part translations.
12. Parts search should search bilingual names/descriptions and SKU.
13. Frequently used parts should appear before the full catalog.
14. QuickBooks data should be cached locally for fast and reliable
    searching.
15. Administrators should have a manual QuickBooks synchronization
    option.
16. Workers submit parts usage to the racing application first.
17. Management can review/correct usage before it is posted to
    QuickBooks.
18. The system should maintain an audit trail.
19. Barcode/QR scanning is a useful future enhancement but is not
    required for Version 1.
20. Version 1 should remain focused on reliable, very fast
    parts-to-customer entry and QuickBooks integration.

Added 08/08/2026:

21. Approved charges post as **one draft Invoice per customer per
    event** (Delayed Charge is not available via the QuickBooks API).
22. Idempotent posting via deterministic DocNumber + query-before-create
    (Section 23, Rule 5).
23. Master-data sync is **manual-only** (admin button + CLI); no
    webhooks, no automatic polling (revised 08/09/2026 — master data
    seldom changes during a weekend; CDC polling stays available as a
    cheap retrofit if ever needed).
24. Parts search runs client-side on the worker's phone against the
    synced catalog.
25. Worker authentication uses admin-generated, event-scoped magic
    links / QR codes.
26. Submission states simplified to
    `SUBMITTED → APPROVED → POSTED_TO_QUICKBOOKS` with `POST_FAILED`.
27. QuickBooks Essentials note: items must be non-inventory/service
    type (physical stock tracking is out of scope anyway).

------------------------------------------------------------------------

## 29. Next Design Phase

Before implementation, the next technical design phase should define:

-   QuickBooks API authentication and token lifecycle
-   Exact QuickBooks objects and fields to synchronize
-   QuickBooks transaction type used for approved parts
-   Database schema
-   Synchronization algorithm
-   Webhook/change-detection strategy
-   Worker authentication mechanism
-   Authorization rules
-   Admin workflow
-   Search/indexing implementation
-   API endpoints
-   Idempotency and retry strategy
-   Audit model
-   Deployment architecture
-   Race-site connectivity strategy
-   Security controls
-   Backup/recovery strategy

These decisions can then be converted into an implementation
specification and development plan.

Of the list above, the following are now decided (08/08/2026):
transaction type (draft Invoice per customer per event), change
detection (CDC polling, no webhooks), worker authentication (magic
links), idempotency/retry strategy (Rule 5 mechanism), and
search/indexing (client-side). Hosting and backup are now decided —
AWS, see Section 31 (added 08/08/2026). Still open: database schema
details and API endpoints.

------------------------------------------------------------------------

## 30. Implementation Milestones (added 08/08/2026)

Each milestone is independently demoable. M2 is the minimum "usable at a
real race weekend with QuickBooks posting" line.

### M0 — QuickBooks connectivity spike

No UI. Burns down every external unknown before building on top:

-   OAuth2 against a QuickBooks sandbox company, with token refresh and
    persistence.
-   Pull Customers and Items into a local SQLite database.
-   Create one test draft Invoice via the API using the Rule 5
    idempotency mechanism (deterministic DocNumber, query-before-create).

### M1 — Worker entry prototype

Single hardcoded event; workers/assignments seeded by admin script.

-   Magic-link worker login.
-   Mobile web UI: assigned customer(s) → client-side bilingual search +
    popular parts (hardcoded initially) → cart → submit.
-   English/Spanish UI strings from day one.
-   Usage stored in the app DB; admin CSV export as the posting escape
    hatch (M1 alone is usable at a real weekend with manual bookkeeping).

**Demo: a worker records parts in under 10 seconds on a phone.**

### M2 — Admin review + posting (minimum V1)

-   Admin screens: event setup, customer participation, worker
    assignments, manual sync.
-   Per-customer usage review with edit/add/remove (logged).
-   Approve & Post → idempotent draft Invoice; POST_FAILED surfaced with
    retry.

**Demo: full loop from worker tap to draft invoice in QuickBooks.**

### M3 — Hardening and polish

Popularity computed from usage history, category browsing,
inactive/missing-item flagging (Rule 3), full audit view, worker
language persistence, accent-tolerance tuning with the real catalog.
(Periodic CDC sync removed 08/09/2026 — sync is manual-only, §19.)

### M4 — Deferred

Unchanged from Section 25: barcode/QR, offline-first PWA, analytics,
etc.

Stack intent: one boring web app (e.g. Next.js), direct QuickBooks REST
calls; single small deployment, no queues or microservices — the whole
system is ~50 users on ~30 weekends a year.

Database (updated 08/08/2026): **PostgreSQL from M1 onward** (see
Section 31 — durability requirements on AWS decide this). M0 uses local
SQLite for the connectivity spike only; its plain-SQL schema ports to
Postgres nearly verbatim. Local development uses Postgres in Docker so
dev and prod match.

------------------------------------------------------------------------

## 31. Deployment, Durability & Backup — AWS (added 08/08/2026)

Requirements driving this section:

1.  Deploy on AWS.
2.  **Submitted parts usage must never be lost** — this is the one
    unacceptable failure. (QuickBooks holds the accounting record, but
    unposted submissions exist only in the app.)
3.  Regular backups.
4.  Historical usage is retained indefinitely for future analysis.

### Architecture

``` text
Worker/Admin phones & laptops
        │  HTTPS
        ▼
AWS App Runner (or a single small ECS/Lightsail container)
   one Next.js app: UI + API + sync loop
        │
        ▼
Amazon RDS PostgreSQL (Multi-AZ, storage encrypted)
        │
        ├── automated backups + point-in-time recovery
        └── nightly logical dump → S3 (versioned, lifecycle to Glacier)
```

### Why managed Postgres (not SQLite) in production

The concurrency load is trivial either way; durability is what decides
this. RDS provides synchronous replication to a standby (Multi-AZ),
automated point-in-time recovery, and backups that are not our code —
which is exactly the property "avoid at any cost" demands. SQLite on a
single EC2 volume would make backup correctness our own
responsibility.

### Durability rules (application level)

-   A submission is acknowledged to the worker **only after the
    database transaction commits.** No fire-and-forget.
-   **Client-side outbox:** flaky track Wi-Fi is the most likely loss
    vector, not the database. The phone queues submissions locally
    (localStorage) and retries until the server acknowledges; the UI
    distinguishes "pending" from "confirmed." Submissions carry a
    client-generated UUID so retries are idempotent server-side.
    This is in M1 scope, not deferred to the offline-first PWA work.
-   **Usage records are append-only.** Corrections and deletions are
    soft (new rows / status flags), never destructive — this serves
    both the audit trail (§23 Rule 4) and historical analysis.
-   Data volume is tiny (~tens of thousands of rows/year), so "keep
    everything forever" is the retention policy; no archival pruning.

### Backup plan

1.  **RDS automated backups** with point-in-time recovery, 35-day
    retention (max) — recovers from instance loss or bad deploys.
2.  **Multi-AZ standby** — near-zero data loss on hardware/AZ failure
    (PITR alone can lose up to ~5 minutes of transaction logs).
3.  **Nightly logical dump (`pg_dump`) to a versioned S3 bucket** in a
    different region, lifecycle-transitioned to Glacier after 90 days —
    survives account-level or RDS-level mistakes, and doubles as the
    long-term analysis archive.
4.  **Quarterly restore drill:** restore the latest dump into a scratch
    database and row-count-verify. A backup that has never been
    restored is a hope, not a backup.

### Cost note

Multi-AZ roughly doubles the RDS instance cost (~$30–60/month total at
db.t4g.micro scale). Given the explicit "avoid at any cost" durability
requirement, that is the correct trade. If cost pressure appears later,
dropping to single-AZ keeps PITR (≤5 min loss window) — revisit only
with that trade-off made explicitly.
