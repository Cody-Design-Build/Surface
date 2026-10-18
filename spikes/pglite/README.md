# PGlite spike (LOCAL.md §8, step 1)

Runs the unchanged Supabase migrations in embedded Postgres (PGlite) on one computer, with a small auth shim, then writes records through `push_record` as the local user under the same role and row-level security as the cloud.

    npm i @electric-sql/pglite && node spike.mjs

Result (Oct 18, M-series Mac): all five migrations apply unchanged in about 0.8 s; 200 `push_record` calls take 73 ms (about 0.4 ms each); an invalid select value is rejected by the same rule as the cloud. The PGlite package is 35 MB; a new database folder is 39 MB.
