import { markDisposableFixture } from "./qa-fixture";
markDisposableFixture().catch(error => { console.error(error.message); process.exitCode = 1; });
