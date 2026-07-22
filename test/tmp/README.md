# Temporary migration characterization tests

This directory contains executable migration baselines that are coupled to a legacy implementation boundary and may be replaced after that boundary moves.

They remain part of `npm test`; placing a test here never means it may be skipped while the old implementation is active.

Current exit criteria:

- `auth-http-baseline.test.js`: replace it with equivalent tests against the injected Auth public entry during phase B. Preserve the HTTP status, response-body, token-expiry, and decoded-user assertions.
- `chat-model-transaction.test.js`: replace it with equivalent application-use-case transaction tests when permanent Session deletion moves during phase D. Preserve commit, rollback, client ownership, and release assertions.

A temporary test may be deleted only in the same change that installs and passes its replacement coverage.
