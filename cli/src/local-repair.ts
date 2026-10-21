import type { PGlite } from "@electric-sql/pglite";

/** Repair legacy local queues whose identity column lost its sequence dependency.
 * Use supported table DDL, preserving the table, queued payloads and their order.
 * DROP IDENTITY itself fails on this catalog state, so replace only the column.
 */
export async function repairOutboxSequence(db: PGlite) {
  await db.transaction(async tx => {
    const { rows } = await tx.query<{ broken: boolean }>(`
      select a.attidentity <> '' and not exists (
        select 1 from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S'
        where d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass
          and d.refobjid = a.attrelid and d.refobjsubid = a.attnum and d.deptype = 'i'
      ) as broken from pg_attribute a
      where a.attrelid = 'surface_local.outbox'::regclass and a.attname = 'sequence' and not a.attisdropped`);
    if (!rows[0]?.broken) return;
    await tx.exec(`
      lock table surface_local.outbox in access exclusive mode;
      -- Add the plain column first: adding a volatile identity default directly
      -- rewrites the table and can fail on older PGlite toast-index metadata.
      alter table surface_local.outbox add column repaired_sequence bigint;
      update surface_local.outbox set repaired_sequence = sequence;
      alter table surface_local.outbox alter column repaired_sequence set not null;
      alter table surface_local.outbox alter column repaired_sequence add generated always as identity;
      select setval(pg_get_serial_sequence('surface_local.outbox', 'repaired_sequence'),
        greatest(coalesce(max(sequence), 0), 1), coalesce(max(sequence), 0) > 0) from surface_local.outbox;
      alter table surface_local.outbox drop column sequence;
      alter table surface_local.outbox rename column repaired_sequence to sequence;
    `);
  });
}
