'use strict';

// Apply database migrations (the server also does this on start).
const { migrate } = require('../src/db/migrate');
const { closePool } = require('../src/db/pool');

migrate()
  .then((applied) => console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.'))
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
