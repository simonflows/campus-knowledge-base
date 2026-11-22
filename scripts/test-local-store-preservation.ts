import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

async function main() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "campus-local-fixture-")
  );
  const localStoreUrl = pathToFileURL(path.resolve("lib/local-store.ts")).href;
  const loaderUrl = pathToFileURL(
    path.resolve("node_modules/tsx/dist/loader.mjs")
  ).href;
  const code = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    const imported = await import(${JSON.stringify(localStoreUrl)});
    const { readLocalStore, mutateLocalStore } = imported.default ?? imported;
    const storePath = '.data/local-store.json';
    await readLocalStore();
    await mutateLocalStore((store) => ({store:{...store, cards:[...store.cards, {...store.cards[0], id:'saved-fixture-card', title:'Saved fixture'}]}, result:null}));
    const before = await fs.readFile(storePath, 'utf8');
    await mutateLocalStore((store) => ({store:{...store, articles:[]}, result:null}));
    assert.equal(await fs.readFile(storePath+'.bak','utf8'), before);
    assert.ok((await readLocalStore()).cards.some((card)=>card.id==='saved-fixture-card'));
    const damaged = '{ intentionally damaged test fixture';
    await fs.writeFile(storePath, damaged);
    await assert.rejects(readLocalStore(), {name:'LocalStoreRecoveryError'});
    await assert.rejects(mutateLocalStore((store)=>({store,result:null})), {name:'LocalStoreRecoveryError'});
    assert.equal(await fs.readFile(storePath,'utf8'), damaged);
    const future = JSON.stringify({seedVersion:999,cards:[{id:'keep-this'}],articles:[]});
    await fs.writeFile(storePath, future);
    await assert.rejects(readLocalStore(), {name:'LocalStoreRecoveryError'});
    assert.equal(await fs.readFile(storePath,'utf8'), future);
    console.log('✓ Isolated local filesystem: saved data and valid .bak retained; corrupted/future files never overwritten');
  `;
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", loaderUrl, "--input-type=module", "-e", code],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          CAMPUS_LOCAL_DEMO: "true",
          NODE_ENV: "development",
        },
      }
    );
    assert.equal(child.status, 0, child.stderr);
    process.stdout.write(child.stdout);
  } finally {
    const resolved = path.resolve(directory);
    assert.ok(
      path.dirname(resolved) === path.resolve(os.tmpdir()) &&
        path.basename(resolved).startsWith("campus-local-fixture-")
    );
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
