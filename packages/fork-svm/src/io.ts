import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import type { Address } from "@solana/kit";
import { jsonStringify, jsonParse, bigintCodec, bytesCodec, dateCodec } from "@onrail-xyz/utils";
import type { Snapshot } from "./forkSvm.js";

const codecs = [bigintCodec, bytesCodec, dateCodec];

const toPaths = (filepath: string) => {
  const basepath = filepath + (filepath.endsWith("/") ? "" : "/");
  return {
    accountsPath: basepath + "accounts/",
    metaFilename: basepath + "meta.json",
  };
};

const utf8 = { encoding: "utf8" } as const;

export async function writeToDisc(filepath: string, snapshot: Snapshot): Promise<void> {
  const { accountsPath, metaFilename } = toPaths(filepath);
  const { accounts, ...meta } = snapshot;

  await mkdir(accountsPath, { recursive: true });

  const filenames = Object.keys(accounts).map(addr => addr + ".json");
  const stale = (await readdir(accountsPath))
    .filter(name => name.endsWith(".json") && !filenames.includes(name));

  await Promise.all([
    writeFile(metaFilename, jsonStringify(meta, codecs), utf8),
    ...Object.entries(accounts).map(([addr, acc]) =>
      writeFile(accountsPath + addr + ".json", jsonStringify(acc, codecs), utf8)
    ),
    //accounts of a previous snapshot in the same directory would otherwise be read back too
    ...stale.map(name => rm(accountsPath + name)),
  ]);
}

export async function readFromDisc(filepath: string): Promise<Snapshot> {
  const { accountsPath, metaFilename } = toPaths(filepath);

  const [meta, accountFilenames] = await Promise.all([
    readFile(metaFilename, utf8).then(json => jsonParse(json, codecs)) as Promise<any>,
    readdir(accountsPath)
      .then(filenames => filenames.filter(name => name.endsWith(".json")))
      .catch(e => {
        if (e?.code !== "ENOENT")
          throw e;
        return [];
      })
  ]);

  if (typeof meta?.blockhash !== "string" || !meta?.clock)
    throw new Error(`Not a snapshot: ${metaFilename} has no blockhash/clock`);

  const accountEntries = await Promise.all(accountFilenames.map(async filename =>
    readFile(accountsPath + filename, utf8)
      .then(json => jsonParse(json, codecs) as Snapshot["accounts"][Address])
      .then(acc => [filename.slice(0, -".json".length) as Address, acc] as const),
  ));

  return { ...(meta as Omit<Snapshot, "accounts">), accounts: Object.fromEntries(accountEntries) };
}
