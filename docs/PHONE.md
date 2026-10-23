# Phone field policy

This is the shared phone contract for Surface's CLI, API, web UI, imports, and agents.

## Storage and primary selection

- Use one phone field containing an ordered list of numbers, not separate Mobile, Office, Phone 1, or Phone 2 fields.
- Each entry contains `number` (E.164) and, optionally, `extension` (digits stored as text). Do not add phone-type labels.
- The first entry is primary. There is no separate `primary` flag or field. Every nonempty list therefore has exactly one primary.
- The first number added becomes primary. Additional numbers append without changing it.
- Choosing a primary moves that entry to the front and preserves the relative order of all other entries.
- Removing the primary promotes the next remaining number. Clear the field with `null`; empty fields have no primary.
- Preserve numbers, extensions, duplicates, and list order unless the user explicitly changes them. Do not sort numbers or infer mobile/office type, preferred number, or callability.
- For existing data, the first stored entry is the default, not evidence that the contact has confirmed it as their preferred number.

```yaml
phone:
  - number: "+14155550123" # Primary because it is first
  - number: "+14155550124"
    extension: "004"
```

## Editing and display

The record and grid editors use number rows, primary-star controls when there is more than one number, removal controls, and Add number. Extensions are separate from numbers. No labels or type selectors are shown or required.

Compact cells display the primary as a callable link and `+N more` to reveal additional numbers. Copying, exporting, or editing the field must retain the complete ordered list, not just the compact display.

CLI selection uses a one-based position:

```sh
surface phone primary "Contact name" 2
surface phone primary "Contact name" 2 --field other_phone
```

`surface set` can replace the complete ordered list. CLI/API writes must reject labels and unknown entry keys rather than silently dropping them.

## Cleanup and compatibility

Removing old labels is an explicit data operation: remove only the entry's `label` key. Preserve every number, extension, and position, use revision checks, and retain normal revision history. Do not flatten lists or guess a better primary during cleanup.

Migration 0009 already accepts unlabeled phone entries; this policy does not require replaying or changing that published migration. SQL acceptance is broader than the current application contract: legacy clients must not be used to reintroduce labels. Keep the generated workspace agent instructions aligned with this document.
